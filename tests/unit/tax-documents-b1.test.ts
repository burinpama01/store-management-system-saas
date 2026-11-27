import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideTaxDocumentsAccess } from "@/modules/tax/access-policy";
import { documentDiscount, isActiveInvoice, splitVatInclusive, taxDocumentErrorMessage } from "@/modules/tax/documents";
import { getPlanFeatures } from "@/modules/billing/types";
import { bahtText } from "@/shared/utils/baht-text";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261216120000_tax_documents_b1.sql"), "utf8")
  .toLowerCase()
  .replace(/\s+/g, " ");

function fnBody(name: string) {
  const start = sql.indexOf(`function public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("$$", start) + 2);
  return sql.slice(start, end);
}

describe("bahtText", () => {
  it.each([
    [0, "ศูนย์บาทถ้วน"],
    [1, "หนึ่งบาทถ้วน"],
    [11, "สิบเอ็ดบาทถ้วน"],
    [21, "ยี่สิบเอ็ดบาทถ้วน"],
    [101, "หนึ่งร้อยเอ็ดบาทถ้วน"],
    [1250.5, "หนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์"],
    [0.25, "ยี่สิบห้าสตางค์"],
    [1_000_000, "หนึ่งล้านบาทถ้วน"],
    [1_000_001, "หนึ่งล้านเอ็ดบาทถ้วน"],
    [21_000_000, "ยี่สิบเอ็ดล้านบาทถ้วน"],
    [535, "ห้าร้อยสามสิบห้าบาทถ้วน"],
  ])("%s → %s", (amount, text) => {
    expect(bahtText(amount)).toBe(text);
  });
});

describe("VAT split (must match SQL round(total * rate / (100 + rate), 2))", () => {
  it("backs VAT out of an inclusive total", () => {
    expect(splitVatInclusive(107, 7)).toEqual({ vatBase: 100, vatAmount: 7 });
    expect(splitVatInclusive(535, 7)).toEqual({ vatBase: 500, vatAmount: 35 });
    expect(splitVatInclusive(99, 7)).toEqual({ vatBase: 92.52, vatAmount: 6.48 });
  });

  it("always sums back to the total", () => {
    for (const total of [1, 9.99, 45, 120.5, 1999, 12345.67]) {
      const { vatBase, vatAmount } = splitVatInclusive(total, 7);
      expect(Math.round((vatBase + vatAmount) * 100) / 100).toBe(total);
    }
  });

  it("shows discount as gross − paid, never negative", () => {
    expect(documentDiscount(250, 225)).toBe(25);
    expect(documentDiscount(200, 210)).toBe(0);
  });
});

describe("active invoice", () => {
  const inv = { id: "a", docType: "receipt_tax_invoice" as const, status: "issued" as const, refDocumentId: null };
  it("is active until a credit note references it", () => {
    expect(isActiveInvoice(inv, [inv])).toBe(true);
    expect(isActiveInvoice(inv, [inv, { docType: "credit_note", status: "issued", refDocumentId: "a" }])).toBe(false);
    expect(isActiveInvoice(inv, [inv, { docType: "credit_note", status: "cancelled", refDocumentId: "a" }])).toBe(true);
    expect(isActiveInvoice({ ...inv, status: "cancelled" }, [])).toBe(false);
  });
});

describe("tax documents access", () => {
  it("requires the Enterprise feature and cashier+", () => {
    expect(decideTaxDocumentsAccess({ hasFeature: false, role: "owner", enabled: true, vatRegistered: true }).allowed).toBe(false);
    expect(decideTaxDocumentsAccess({ hasFeature: true, role: "staff", enabled: true, vatRegistered: true }).allowed).toBe(false);
  });

  it("issues only when switched on and VAT registered; voids only for manager+", () => {
    expect(decideTaxDocumentsAccess({ hasFeature: true, role: "cashier", enabled: true, vatRegistered: true })).toMatchObject({ canIssue: true, canVoid: false });
    expect(decideTaxDocumentsAccess({ hasFeature: true, role: "manager", enabled: true, vatRegistered: true })).toMatchObject({ canIssue: true, canVoid: true });
    expect(decideTaxDocumentsAccess({ hasFeature: true, role: "owner", enabled: false, vatRegistered: true })).toMatchObject({ canIssue: false, canVoid: false });
    expect(decideTaxDocumentsAccess({ hasFeature: true, role: "owner", enabled: true, vatRegistered: false })).toMatchObject({ canIssue: false });
  });

  it("is an Enterprise-only plan feature", () => {
    const base = { status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(), cancelAtPeriodEnd: false } as const;
    expect(getPlanFeatures({ ...base, plan: "enterprise" } as never).taxDocuments).toBe(true);
    expect(getPlanFeatures({ ...base, plan: "premium" } as never).taxDocuments).toBe(false);
  });
});

describe("tax document error messages", () => {
  it("translates RPC errors and hides raw SQL", () => {
    expect(taxDocumentErrorMessage("order must be paid")).toContain("ชำระแล้ว");
    expect(taxDocumentErrorMessage("order already has an issued tax invoice")).toContain("ออกใบกำกับภาษีไปแล้ว");
    expect(taxDocumentErrorMessage("company buyer requires tax id")).toContain("นิติบุคคล");
    expect(taxDocumentErrorMessage("syntax error at or near")).toBe("ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("tax documents B1 migration", () => {
  it("adds a per-store switch that is off by default and an Enterprise-only gate", () => {
    expect(sql).toContain("add column if not exists tax_documents_enabled boolean not null default false");
    expect(fnBody("organization_has_tax_documents")).toContain("s.plan = 'enterprise'");
    const toggle = fnBody("tax_documents_set_enabled");
    expect(toggle).toContain("auth_user_role_in_store(v_org, p_store_id, 'admin')");
    expect(toggle).toContain("vat_registered");
  });

  it("has RLS and no write policies on documents", () => {
    expect(sql).toContain("alter table public.sales_documents enable row level security");
    expect(sql).toContain("alter table public.sales_document_lines enable row level security");
    expect(sql).not.toMatch(/on public\.sales_document(s|_lines) for (all|insert|update|delete)/);
  });

  it("keeps issued documents immutable and undeletable", () => {
    expect(sql).toContain("before update or delete on public.sales_documents");
    expect(sql).toContain("issued sales document is immutable");
    expect(sql).toContain("sales documents cannot be deleted");
    expect(sql).toContain("before update or delete on public.sales_document_lines");
  });

  it("allows one active invoice per order and one active credit note per invoice", () => {
    expect(sql).toContain("sales_documents_one_active_invoice_per_order");
    expect(sql).toContain("sales_documents_one_active_credit_note");
    expect(sql).toContain("check (total_amount = vat_base + vat_amount)");
  });

  it("issues from DB truth with full guards and gap-free numbering", () => {
    const fn = fnBody("issue_tax_invoice_from_order");
    expect(fn).toContain("for update");
    expect(fn).toContain("tax_documents_assert_ready(v_order.organization_id, v_order.store_id, 'cashier')");
    expect(fn).toContain("v_order.status <> 'paid'");
    expect(fn).toContain("prices_include_vat");
    expect(fn).toContain("v_party.store_id <> v_order.store_id");
    expect(fn).toContain("reserve_document_number(v_order.store_id, 'receipt_tax_invoice', now())");
    expect(fn).toContain("coalesce(voided, false) = false");
    expect(fn).toContain("round(v_total * v_profile.vat_rate / (100 + v_profile.vat_rate), 2)");
  });

  it("credit note keeps the invoice's seller and states pre-VAT values (s.86/10)", () => {
    const fn = fnBody("issue_full_credit_note");
    expect(fn).toContain("v_src.seller_snapshot");
    expect(fn).toContain("v_src.vat_base, 0, v_reason");
  });

  it("fails fast on locks and indexes the per-sale lookup", () => {
    expect(sql).toContain("set lock_timeout = '5s'");
    expect(sql).toContain("sales_documents_active_invoice_idx");
    expect(fnBody("issue_tax_invoice_from_order")).toContain("document lines do not match gross amount");
  });

  it("requires manager+ and a reason for credit notes and cancellations", () => {
    expect(fnBody("issue_full_credit_note")).toContain("'manager'");
    expect(fnBody("issue_full_credit_note")).toContain("credit note requires a reason");
    expect(fnBody("cancel_sales_document")).toContain("'manager'");
    expect(fnBody("cancel_sales_document")).toContain("cancel the related credit note first");
  });

  it("locks orders and order items that have an active tax invoice", () => {
    expect(sql).toContain("before update of status, total, subtotal, discount on public.orders");
    expect(sql).toContain("before insert or update or delete on public.order_items");
    const lock = fnBody("order_items_tax_invoice_lock");
    // ไม่แตะ NEW ใน DELETE
    expect(lock).toContain("if tg_op = 'delete' then v_order := old.order_id");
  });

  it("does not let users call internal helpers directly", () => {
    expect(sql).toContain("revoke all on function public.tax_documents_assert_ready(uuid, uuid, text) from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.order_has_active_tax_invoice(uuid) from public, anon, authenticated");
  });
});
