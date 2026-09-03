import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_DEFAULT_PRICES } from "@/modules/billing/business-plan";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

type Payload = Record<string, unknown>;

function mockSetTenantPlanSupabase(options: { existingSubscription?: boolean } = {}) {
  const existingSubscription = options.existingSubscription ?? true;
  const subscriptionPayloads: Payload[] = [];
  const auditPayloads: Payload[] = [];
  const maybeSingle = vi.fn(async () => ({
    data: existingSubscription ? { current_period_end: "2026-01-31T00:00:00.000Z" } : null,
    error: null,
  }));
  const selectEq = vi.fn(() => ({ maybeSingle }));
  const updateEq = vi.fn(async () => ({ error: null }));
  const subscriptionsQuery = {
    select: vi.fn(() => ({ eq: selectEq })),
    update: vi.fn((payload: Payload) => {
      subscriptionPayloads.push(payload);
      return { eq: updateEq };
    }),
    upsert: vi.fn(async (payload: Payload) => {
      subscriptionPayloads.push(payload);
      return { error: null };
    }),
  };
  const auditQuery = {
    insert: vi.fn(async (payload: Payload) => {
      auditPayloads.push(payload);
      return { error: null };
    }),
  };
  const client = {
    from: vi.fn((table: string) => {
      if (table === "subscriptions") return subscriptionsQuery;
      if (table === "audit_logs") return auditQuery;
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServiceClient: vi.fn(async () => client),
  }));

  return { auditPayloads, client, subscriptionPayloads, updateEq };
}

function mockCreateBranchActionDependencies(options: {
  billingAllowed?: boolean;
  insertError?: { code: string; message: string };
  insertThrows?: Error;
} = {}) {
  const billingAllowed = options.billingAllowed ?? true;
  const canUseFeature = vi.fn(() => billingAllowed);
  const insertedPayloads: Payload[] = [];
  const single = vi.fn(async () => ({
    data: options.insertError ? null : { id: "store-branch-1" },
    error: options.insertError ?? null,
  }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const insert = vi.fn((payload: Payload) => {
    if (options.insertThrows) throw options.insertThrows;
    insertedPayloads.push(payload);
    return { select };
  });
  const client = {
    from: vi.fn((table: string) => {
      if (table === "stores") return { insert };
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  const createSupabaseServiceClient = vi.fn(async () => client);

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi.fn(async () => ({
      ctx: { organizationId: "org-1", storeId: "store-1", userId: "user-1" },
      resolved: { can: vi.fn((key: string) => key === "settings.manage_store") },
    })),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn(async () => ({
      plan: "enterprise",
      status: "active",
      currentPeriodEnd: "2099-12-31T23:59:59Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    })),
  }));
  vi.doMock("@/modules/billing/types", async () => {
    const actual = await vi.importActual<typeof import("@/modules/billing/types")>(
      "@/modules/billing/types",
    );
    return {
      ...actual,
      canUseFeature,
      explainFeatureLock: vi.fn(() => "แพ็กเกจปัจจุบันยังไม่รองรับหลายสาขา"),
    };
  });
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServiceClient,
  }));
  const revalidatePath = vi.fn();
  vi.doMock("next/cache", () => ({ revalidatePath }));

  return { canUseFeature, client, createSupabaseServiceClient, insert, insertedPayloads, revalidatePath };
}

function branchNameFormData(name: string) {
  const formData = new FormData();
  formData.set("name", name);
  return formData;
}

describe("enterprise branch UX contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("next/navigation");
    vi.unmock("next/cache");
    vi.unmock("@/modules/auth/guards");
    vi.unmock("@/modules/billing/billing-service");
    vi.unmock("@/modules/billing/types");
    vi.unmock("@/server/integrations/supabase/server");
  });

  it("platform Enterprise override activates the tenant without a billing expiry", () => {
    const repository = read("src/modules/system/repository.ts");
    const guards = read("src/modules/auth/guards.ts");
    const billingPage = read("src/app/(dashboard)/settings/billing/page.tsx");
    const billingManager = read("src/app/(dashboard)/settings/billing/BillingManager.tsx");
    const tenantPage = read("src/app/system/tenants/[id]/page.tsx");

    expect(repository).toContain("ENTERPRISE_PERIOD_END");
    expect(repository).toContain('input.plan === "enterprise"');
    expect(repository).toContain("const nextPeriodEnd");
    expect(repository).toContain('status: "active"');
    expect(repository).toContain("current_period_start: now");
    expect(repository).toContain("current_period_end: nextPeriodEnd");
    expect(guards).toContain("hasBillingAccess(state)");
    expect(billingPage).toContain("hasBillingAccess(billingState)");
    // ตรรกะย้ายไป modules/billing/status-display.ts แล้ว (บั๊กเดิมเกิดจากตัดสินในไฟล์นี้เอง)
    expect(billingManager).toContain("describeSubscriptionDisplay");
    expect(billingManager).toContain("Enterprise contract");
    expect(read("src/modules/billing/status-display.ts")).toContain("ไม่มีกำหนดหมดอายุ");
    // ห้ามกลับไปตัดสิน "ทดลองใช้" จาก status อีก — เป็นต้นเหตุที่ป้ายสถานะแสดงสลับกัน
    expect(billingManager).not.toContain('status === "trialing"');
    // สัญญา Enterprise ซ่อน UI ต่ออายุ ส่วนสิทธิ์ทดลองฟรี (trialing) ยังเลือกซื้อแพ็กเกจต่อได้
    expect(billingManager).toContain("!isEnterpriseContract &&");
    expect(tenantPage).toContain("formatSubscriptionEnd");
  });

  it("adds an Enterprise branch management entry point and keeps branch writes organization-scoped", () => {
    const layout = read("src/app/(dashboard)/settings/layout.tsx");
    const page = read("src/app/(dashboard)/settings/branches/page.tsx");
    const actions = read("src/app/(dashboard)/settings/branches/actions.ts");
    const manager = read("src/app/(dashboard)/settings/branches/BranchManager.tsx");
    const repository = read("src/modules/stores/repository.ts");

    expect(layout).toContain("/settings/branches");
    expect(layout).toContain("สาขา");
    expect(page).toContain('"multiBranchReporting"');
    expect(page).toContain("listActiveStores");
    expect(page).toContain("BranchManager");
    expect(actions).toContain('resolved.can("settings.manage_store")');
    expect(actions).toContain('"multiBranchReporting"');
    expect(actions).toContain("createBranchStoreForAction");
    expect(actions).toContain("revalidatePath(\"/settings/branches\")");
    expect(manager).toContain("เพิ่มสาขา");
    expect(manager).toContain("เปิดใช้งานอยู่");
    expect(manager).not.toContain("<code>store_id</code>");
    expect(manager).not.toContain("<code>organization_id</code>");
    expect(manager).not.toContain("<code>selected_store_id</code>");
    expect(actions).toContain("createSupabaseServiceClient");
    expect(actions).toContain(".eq(\"organization_id\", input.organizationId)");
    expect(repository).not.toContain("createSupabaseServiceClient");
    expect(repository).not.toContain("export async function createBranchStore");
  });

  it("creates branches through the validated backend service path after action-level guards", async () => {
    const mocks = mockCreateBranchActionDependencies();
    const { createBranchAction } = await import("@/app/(dashboard)/settings/branches/actions");

    await expect(
      createBranchAction({ error: null }, branchNameFormData("สาขาเชียงใหม่")),
    ).resolves.toEqual({ error: null, ok: true });

    expect(mocks.createSupabaseServiceClient).toHaveBeenCalledOnce();
    expect(mocks.client.from).toHaveBeenCalledWith("stores");
    expect(mocks.insertedPayloads[0]).toMatchObject({
      organization_id: "org-1",
      name: "สาขาเชียงใหม่",
      currency_code: "THB",
      timezone: "Asia/Bangkok",
      locale: "th-TH",
      is_active: true,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/branches");
  });

  it("sanitizes unknown database errors before they reach the branch form", async () => {
    mockCreateBranchActionDependencies({
      insertError: {
        code: "23502",
        message: 'null value in column "organization_id" of relation "stores" violates not-null constraint',
      },
    });
    const { createBranchAction } = await import("@/app/(dashboard)/settings/branches/actions");

    const result = await createBranchAction({ error: null }, branchNameFormData("สาขาเชียงใหม่"));

    expect(result.error).toBe("เพิ่มสาขาไม่สำเร็จ กรุณาลองอีกครั้ง");
    expect(result.error).not.toMatch(/store_id|organization_id|selected_store_id|stores/);
  });

  it("sanitizes thrown branch creation errors before they reach the form", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateBranchActionDependencies({
      insertThrows: new Error('branch insert failed for organization_id on stores'),
    });
    const { createBranchAction } = await import("@/app/(dashboard)/settings/branches/actions");

    const result = await createBranchAction({ error: null }, branchNameFormData("สาขาเชียงใหม่"));

    expect(result.error).toBe("เพิ่มสาขาไม่สำเร็จ กรุณาลองอีกครั้ง");
    expect(result.error).not.toMatch(/store_id|organization_id|selected_store_id|stores/);
    expect(consoleError).toHaveBeenCalledWith(
      "[branches] create branch failed",
      expect.any(Error),
    );
  });

  it("does not call the branch service path when the package gate is locked", async () => {
    const mocks = mockCreateBranchActionDependencies({ billingAllowed: false });
    const { createBranchAction } = await import("@/app/(dashboard)/settings/branches/actions");

    await expect(
      createBranchAction({ error: null }, branchNameFormData("สาขาเชียงใหม่")),
    ).resolves.toEqual({ error: "แพ็กเกจปัจจุบันยังไม่รองรับหลายสาขา" });

    expect(mocks.createSupabaseServiceClient).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("maps plain Supabase errors instead of showing the generic fallback", async () => {
    const { mapError } = await import("@/shared/utils/error");

    expect(
      mapError({
        code: "42501",
        message: 'new row violates row-level security policy for table "stores"',
      }).userMessage,
    ).toBe("You do not have permission to perform this action.");
    expect(
      mapError({
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }).userMessage,
    ).toBe("A record with this value already exists.");
  });

  it("does not show active no-expiry copy for inactive Enterprise billing states", async () => {
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ refresh: vi.fn() }),
      useSearchParams: () => new URLSearchParams("expired=1"),
    }));
    const { BillingManager } = await import("@/app/(dashboard)/settings/billing/BillingManager");

    const html = renderToStaticMarkup(
      React.createElement(BillingManager, {
        orgName: "Example",
        plan: "enterprise",
        currentPeriodEnd: "2099-12-31T23:59:59Z",
        expires: false,
        isActive: false,
        prices: {
          starter: { "30d": 690, "1y": 6900 },
          standard: { "30d": 1290, "1y": 12900 },
          premium: { "30d": 2290, "1y": 22900 },
        },
        businessPrices: BUSINESS_DEFAULT_PRICES,
        canManage: true,
        paymentConfigured: true,
        recipientName: "StoreOS",
        slipVerificationReady: true,
        freeTrialAvailable: false,
      }),
    );

    expect(html).toContain("ติดต่อผู้ดูแลแพลตฟอร์ม");
    expect(html).not.toContain("ใช้งานอยู่ · ไม่มีกำหนดหมดอายุ");
  });

  // บั๊กที่เจ้าของระบบเจอบนมือถือ 2026-09-03 — หน้าแพ็กเกจแสดงสลับกัน:
  // org ที่ไม่มีวันหมดอายุขึ้นว่า "ทดลองใช้ เหลือ 0 วัน" ส่วน org ที่หมดจริงขึ้นว่า "ไม่มีกำหนดหมดอายุ"
  // ต้นเหตุ: UI เดาจาก status === "trialing" ซึ่ง 8 แถวบน prod ค้างค่านี้จากแคมเปญเก่า
  it("Enterprise สัญญาไม่มีวันหมดอายุต้องไม่ขึ้นว่าทดลองใช้ แม้ current_period_end จะเป็นอดีต", async () => {
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ refresh: vi.fn() }),
      useSearchParams: () => new URLSearchParams(),
    }));
    const { BillingManager } = await import("@/app/(dashboard)/settings/billing/BillingManager");

    const html = renderToStaticMarkup(
      React.createElement(BillingManager, {
        orgName: "Each Other",
        plan: "enterprise",
        // ข้อมูลจริงของ org นี้: หมดไปแล้วตามวันที่ แต่ไม่ใช่สิทธิ์แบบมีกำหนด
        currentPeriodEnd: "2026-07-21T00:00:00Z",
        promoTrial: false,
        expires: false,
        isActive: true,
        prices: {
          starter: { "30d": 690, "1y": 6900 },
          standard: { "30d": 1290, "1y": 12900 },
          premium: { "30d": 2290, "1y": 22900 },
        },
        businessPrices: BUSINESS_DEFAULT_PRICES,
        canManage: true,
        paymentConfigured: true,
        recipientName: "StoreOS",
        slipVerificationReady: true,
        freeTrialAvailable: false,
      }),
    );

    expect(html).toContain("ใช้งานอยู่ · ไม่มีกำหนดหมดอายุ");
    expect(html).not.toContain("ทดลองใช้");
    // สัญญาไม่มีกำหนด ต้องไม่โชว์แถววันหมดอายุให้สับสน
    expect(html).not.toContain("ใช้งานได้ถึง");
  });

  it("Enterprise แบบมีกำหนดต้องโชว์วันหมดอายุจริง ไม่ใช่ 'ไม่มีกำหนดหมดอายุ'", async () => {
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ refresh: vi.fn() }),
      useSearchParams: () => new URLSearchParams(),
    }));
    const { BillingManager } = await import("@/app/(dashboard)/settings/billing/BillingManager");

    const html = renderToStaticMarkup(
      React.createElement(BillingManager, {
        orgName: "proud.cafe",
        plan: "enterprise",
        currentPeriodEnd: "2026-10-02T00:00:00Z",
        promoTrial: false,
        expires: true,
        isActive: true,
        prices: {
          starter: { "30d": 690, "1y": 6900 },
          standard: { "30d": 1290, "1y": 12900 },
          premium: { "30d": 2290, "1y": 22900 },
        },
        businessPrices: BUSINESS_DEFAULT_PRICES,
        canManage: true,
        paymentConfigured: true,
        recipientName: "StoreOS",
        slipVerificationReady: true,
        freeTrialAvailable: false,
      }),
    );

    expect(html).toContain("ใช้งานได้ถึง");
    expect(html).not.toContain("ไม่มีกำหนดหมดอายุ");
    expect(html).not.toContain("ทดลองใช้");
  });

  it("โปรทดลองฟรีจริง (promo_trial_code) ต้องขึ้นว่าทดลองใช้", async () => {
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ refresh: vi.fn() }),
      useSearchParams: () => new URLSearchParams(),
    }));
    const { BillingManager } = await import("@/app/(dashboard)/settings/billing/BillingManager");

    const html = renderToStaticMarkup(
      React.createElement(BillingManager, {
        orgName: "SKY",
        plan: "enterprise",
        currentPeriodEnd: "2099-01-01T00:00:00Z",
        promoTrial: true,
        expires: true,
        isActive: true,
        prices: {
          starter: { "30d": 690, "1y": 6900 },
          standard: { "30d": 1290, "1y": 12900 },
          premium: { "30d": 2290, "1y": 22900 },
        },
        businessPrices: BUSINESS_DEFAULT_PRICES,
        canManage: true,
        paymentConfigured: true,
        recipientName: "StoreOS",
        slipVerificationReady: true,
        freeTrialAvailable: false,
      }),
    );

    expect(html).toContain("ทดลองใช้");
    expect(html).not.toContain("ไม่มีกำหนดหมดอายุ");
  });

  it("writes a fixed no-expiry billing period for Enterprise platform overrides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    const supabase = mockSetTenantPlanSupabase();
    const { setTenantPlan } = await import("@/modules/system/repository");

    await expect(
      setTenantPlan({
        organizationId: "org-1",
        plan: "enterprise",
        actorUserId: "admin-1",
      }),
    ).resolves.toEqual({ ok: true, error: null });

    expect(supabase.subscriptionPayloads).toHaveLength(1);
    expect(supabase.subscriptionPayloads[0]).toMatchObject({
      plan: "enterprise",
      status: "active",
      cancel_at_period_end: false,
      current_period_start: "2026-06-21T00:00:00.000Z",
      current_period_end: "2099-12-31T23:59:59Z",
      updated_at: "2026-06-21T00:00:00.000Z",
    });
    expect(supabase.updateEq).toHaveBeenCalledWith("organization_id", "org-1");
    expect(supabase.client.from).toHaveBeenCalledWith("audit_logs");
    expect(supabase.auditPayloads[0]).toMatchObject({
      organization_id: "org-1",
      actor_user_id: "admin-1",
      action: "tenant.plan_change",
      reason: "plan → enterprise ไม่มีวันหมดอายุ (platform override)",
    });
  });

  it("resets downgraded tenants to a fresh finite billing period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    const supabase = mockSetTenantPlanSupabase();
    const { setTenantPlan } = await import("@/modules/system/repository");

    await expect(
      setTenantPlan({
        organizationId: "org-1",
        plan: "standard",
        actorUserId: "admin-1",
      }),
    ).resolves.toEqual({ ok: true, error: null });

    expect(supabase.subscriptionPayloads).toHaveLength(1);
    expect(supabase.subscriptionPayloads[0]).toMatchObject({
      plan: "standard",
      status: "active",
      cancel_at_period_end: false,
      current_period_start: "2026-06-21T00:00:00.000Z",
      current_period_end: "2026-07-21T00:00:00.000Z",
      updated_at: "2026-06-21T00:00:00.000Z",
    });
    expect(supabase.subscriptionPayloads[0]).not.toMatchObject({
      current_period_end: "2099-12-31T23:59:59Z",
    });
    expect(supabase.updateEq).toHaveBeenCalledWith("organization_id", "org-1");
    expect(supabase.client.from).toHaveBeenCalledWith("audit_logs");
    expect(supabase.auditPayloads[0]).toMatchObject({
      organization_id: "org-1",
      actor_user_id: "admin-1",
      action: "tenant.plan_change",
      reason: "plan → standard (platform override)",
    });
  });

  it("creates missing Enterprise subscriptions with the same fixed no-expiry billing period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    const supabase = mockSetTenantPlanSupabase({ existingSubscription: false });
    const { setTenantPlan } = await import("@/modules/system/repository");

    await expect(
      setTenantPlan({
        organizationId: "org-1",
        plan: "enterprise",
        actorUserId: "admin-1",
      }),
    ).resolves.toEqual({ ok: true, error: null });

    expect(supabase.subscriptionPayloads).toHaveLength(1);
    expect(supabase.subscriptionPayloads[0]).toMatchObject({
      organization_id: "org-1",
      plan: "enterprise",
      status: "active",
      cancel_at_period_end: false,
      current_period_start: "2026-06-21T00:00:00.000Z",
      current_period_end: "2099-12-31T23:59:59Z",
      updated_at: "2026-06-21T00:00:00.000Z",
    });
    expect(supabase.client.from).toHaveBeenCalledWith("audit_logs");
    expect(supabase.auditPayloads[0]).toMatchObject({
      organization_id: "org-1",
      actor_user_id: "admin-1",
      action: "tenant.plan_change",
      reason: "plan → enterprise ไม่มีวันหมดอายุ (platform override)",
    });
  });
});
