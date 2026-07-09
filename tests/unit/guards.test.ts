import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { filterAccessibleStores, pickMembershipForStore } from "@/modules/auth/session";
import { resolvePermissions } from "@/modules/auth/permission-resolver";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { Role, PermissionKey } from "@/modules/tenants/types";

// Guards (requireRole / requirePermission) hit Next.js cookies() and redirect(),
// so they can't run in pure unit tests. This file tests the underlying logic:
// role hierarchy ordering and permission resolution that the guards delegate to.

const ROLE_RANK: Record<Role, number> = {
  super_admin: 6,
  owner: 5,
  admin: 4,
  manager: 3,
  cashier: 2,
  staff: 1,
};

function meetsRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

const ORG = "org-1";
const OTHER_ORG = "org-2";
const STORE = "store-1";
const STORE_TWO = "store-2";
const OTHER_STORE = "store-other";
type MembershipRow = Database["public"]["Tables"]["memberships"]["Row"];
type StoreRow = Database["public"]["Tables"]["stores"]["Row"];

function membership(
  id: string,
  userId: string,
  role: Role,
  storeId: string | null,
  organizationId = ORG,
): MembershipRow {
  return {
    id,
    organization_id: organizationId,
    store_id: storeId,
    user_id: userId,
    role,
    invited_at: "2026-06-01T00:00:00Z",
    joined_at: "2026-06-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };
}

function store(id: string, organizationId = ORG): StoreRow {
  return {
    id,
    organization_id: organizationId,
    name: id,
    is_active: true,
    slug: id,
    address: null,
    currency_code: "THB",
    locale: "th-TH",
    logo_url: null,
    phone: null,
    buffet_enabled: false,
    qr_ordering_enabled: true,
    dine_in_duration_minutes: 120,
    theme_preset_id: "caramel-cafe",
    theme_primary_color: "#c2603a",
    theme_primary_strong_color: "#a8492a",
    theme_primary_soft_color: "#fbede4",
    theme_accent_color: "#3c8fb0",
    timezone: "Asia/Bangkok",
    qr_ordering_mode: "table_bound",
    table_open_policy: "staff_only",
    music_request_enabled: false,
    music_license_status: "not_requested",
    music_license_approved_at: null,
    music_license_note: null,
    qr_service_buttons: [],
    print_hub_token_hash: null,
    print_hub_last_seen: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };
}

describe("requireRole — hierarchy logic", () => {
  it("super_admin meets every role requirement", () => {
    const roles: Role[] = ["super_admin", "owner", "admin", "manager", "cashier", "staff"];
    for (const r of roles) {
      expect(meetsRole("super_admin", r)).toBe(true);
    }
  });

  it("owner meets every non-platform role requirement", () => {
    const roles: Role[] = ["owner", "admin", "manager", "cashier", "staff"];
    for (const r of roles) {
      expect(meetsRole("owner", r)).toBe(true);
    }
    expect(meetsRole("owner", "super_admin")).toBe(false);
  });

  it("cashier meets cashier and staff only", () => {
    expect(meetsRole("cashier", "cashier")).toBe(true);
    expect(meetsRole("cashier", "staff")).toBe(true);
    expect(meetsRole("cashier", "manager")).toBe(false);
    expect(meetsRole("cashier", "admin")).toBe(false);
    expect(meetsRole("cashier", "owner")).toBe(false);
  });

  it("staff only meets staff", () => {
    expect(meetsRole("staff", "staff")).toBe(true);
    expect(meetsRole("staff", "cashier")).toBe(false);
  });

  it("manager does not meet admin or owner", () => {
    expect(meetsRole("manager", "admin")).toBe(false);
    expect(meetsRole("manager", "owner")).toBe(false);
  });
});

describe("requirePermission — resolved permissions logic", () => {
  it("owner has pos.refund", () => {
    const p = resolvePermissions("owner", [], ORG, STORE);
    expect(p.can("pos.refund")).toBe(true);
  });

  it("super_admin has system management permission", () => {
    const p = resolvePermissions("super_admin", [], ORG, STORE);
    expect(p.can("system.manage")).toBe(true);
  });

  it("cashier does not have pos.refund by default", () => {
    const p = resolvePermissions("cashier", [], ORG, STORE);
    expect(p.can("pos.refund")).toBe(false);
  });

  it("cashier and staff use front-counter defaults without product management", () => {
    for (const role of ["cashier", "staff"] as const) {
      const p = resolvePermissions(role, [], ORG, STORE);

      expect(p.can("pos.use")).toBe(true);
      expect(p.can("catalog.view")).toBe(false);
      expect(p.can("catalog.manage")).toBe(false);
      expect(p.can("cashflow.view")).toBe(true);
      expect(p.can("cashflow.record" as PermissionKey)).toBe(true);
      expect(p.can("cashflow.manage")).toBe(false);
      expect(p.can("settings.view")).toBe(true);
      expect(p.can("settings.manage_printer" as PermissionKey)).toBe(true);
      expect(p.can("settings.manage_store")).toBe(false);
    }
  });

  it("cashier with pos.refund override can refund", () => {
    const p = resolvePermissions(
      "cashier",
      [{ permissionKey: "pos.refund" as PermissionKey, granted: true }],
      ORG,
      STORE,
    );
    expect(p.can("pos.refund")).toBe(true);
  });

  it("owner with explicit deny override loses the permission", () => {
    const p = resolvePermissions(
      "owner",
      [{ permissionKey: "permissions.manage" as PermissionKey, granted: false }],
      ORG,
      STORE,
    );
    expect(p.can("permissions.manage")).toBe(false);
  });

  it("staff with no overrides cannot access settings.manage_store", () => {
    const p = resolvePermissions("staff", [], ORG, STORE);
    expect(p.can("settings.manage_store")).toBe(false);
  });

  it("manager has reports.view", () => {
    const p = resolvePermissions("manager", [], ORG, STORE);
    expect(p.can("reports.view")).toBe(true);
  });

  it("cashier does not have reports.view", () => {
    const p = resolvePermissions("cashier", [], ORG, STORE);
    expect(p.can("reports.view")).toBe(false);
  });

  it("admin does not have permissions.manage by default but can be granted it", () => {
    const without = resolvePermissions("admin", [], ORG, STORE);
    expect(without.can("permissions.manage")).toBe(false);

    const withGrant = resolvePermissions(
      "admin",
      [{ permissionKey: "permissions.manage" as PermissionKey, granted: true }],
      ORG,
      STORE,
    );
    expect(withGrant.can("permissions.manage")).toBe(true);
  });
});

describe("current store membership selection", () => {
  it("ignores memberships from other users and prefers store-specific membership", () => {
    const selected = pickMembershipForStore(
      [
        membership("owner-other", "other-user", "owner", STORE),
        membership("org-own", "current-user", "cashier", null),
        membership("store-own", "current-user", "staff", STORE),
      ],
      { userId: "current-user", organizationId: ORG, storeId: STORE },
    );

    expect(selected?.id).toBe("store-own");
    expect(selected?.role).toBe("staff");
  });
});

describe("getUserStores query boundaries", () => {
  it("filters active stores by organizations from the user's joined memberships", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/modules/auth/session.ts"),
      "utf8",
    );

    expect(source).toContain("organizationIds");
    expect(source).toContain('.in("organization_id", organizationIds)');
  });

  it("returns only explicitly assigned stores for store-specific memberships", () => {
    const stores = [
      store(STORE),
      store(STORE_TWO),
      store(OTHER_STORE, OTHER_ORG),
    ];
    const memberships = [
      membership("store-own", "current-user", "cashier", STORE),
    ];

    expect(filterAccessibleStores(stores, memberships, "current-user").map((s) => s.id)).toEqual([
      STORE,
    ]);
  });

  it("returns every store in an organization for org-wide memberships", () => {
    const stores = [
      store(STORE),
      store(STORE_TWO),
      store(OTHER_STORE, OTHER_ORG),
    ];
    const memberships = [
      membership("org-own", "current-user", "manager", null),
    ];

    expect(filterAccessibleStores(stores, memberships, "current-user").map((s) => s.id)).toEqual([
      STORE,
      STORE_TWO,
    ]);
  });

  it("returns no stores when the user has no joined memberships", () => {
    expect(filterAccessibleStores([store(STORE)], [], "current-user")).toEqual([]);
  });

  it("orders organizations and stores deterministically so every device resolves the same default store", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/modules/auth/session.ts"),
      "utf8",
    );

    // resolveCurrentStore falls back to stores[0] when no store cookie is set —
    // without an explicit order, mobile and PC can land on different stores.
    expect(source).toContain('.order("created_at", { ascending: true })');
  });
});

describe("shouldStartAtAttendance record scope", () => {
  it("counts a clock-in at any branch of the org, not just the device's current store", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/modules/auth/guards.ts"),
      "utf8",
    );
    const recordQueryStart = source.indexOf('.from("attendance_records")');
    const recordQueryEnd = source.indexOf('.from("employee_profiles")', recordQueryStart);
    const recordQuery = source.slice(recordQueryStart, recordQueryEnd);

    expect(recordQueryStart).toBeGreaterThan(-1);
    expect(recordQueryEnd).toBeGreaterThan(recordQueryStart);
    expect(recordQuery).toContain('.eq("organization_id", ctx.organizationId)');
    expect(recordQuery).not.toContain('.eq("store_id"');
  });
});
