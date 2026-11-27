import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canIssueAbbreviatedTaxInvoice,
  canIssueFullTaxInvoice,
  documentPeriod,
  formatDocumentNumber,
  validateTaxParty,
  validateTaxProfile,
} from "@/modules/tax/rules";
import { taxErrorMessage } from "@/modules/tax/repository";
import { DOCUMENT_PREFIX, DOCUMENT_TYPES } from "@/modules/tax/types";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261215120000_tax_profile_b0.sql"), "utf8")
  .toLowerCase()
  .replace(/\s+/g, " ");

const VALID_TAX_ID = "0105536092641";

describe("tax profile validation", () => {
  const base = {
    legalName: " บริษัท ตัวอย่าง จำกัด ",
    taxId: "0-1055-36092-64-1",
    branchCode: "",
    address: " 1 ถนนสุขุมวิท กรุงเทพฯ ",
    vatRegistered: true,
    vatRegisteredAt: "2026-01-15",
    posApprovalNo: " E051234567890 ",
    pricesIncludeVat: true,
    vatRate: 7,
  };

  it("normalizes tax id, defaults branch to head office and trims", () => {
    const result = validateTaxProfile(base);
    expect(result).toHaveProperty("value");
    if ("value" in result) {
      expect(result.value.taxId).toBe(VALID_TAX_ID);
      expect(result.value.branchCode).toBe("00000");
      expect(result.value.legalName).toBe("บริษัท ตัวอย่าง จำกัด");
      expect(result.value.posApprovalNo).toBe("E051234567890");
    }
  });

  it("drops VAT-only fields when not VAT registered", () => {
    const result = validateTaxProfile({ ...base, vatRegistered: false });
    expect("value" in result && result.value.posApprovalNo).toBeNull();
    expect("value" in result && result.value.vatRegisteredAt).toBeNull();
  });

  it("rejects invalid data", () => {
    expect(validateTaxProfile({ ...base, legalName: " " })).toHaveProperty("error");
    expect(validateTaxProfile({ ...base, taxId: "0105536092642" })).toHaveProperty("error");
    expect(validateTaxProfile({ ...base, branchCode: "1" })).toHaveProperty("error");
    expect(validateTaxProfile({ ...base, address: "" })).toHaveProperty("error");
    expect(validateTaxProfile({ ...base, vatRate: 50 })).toHaveProperty("error");
    expect(validateTaxProfile({ ...base, vatRegisteredAt: "15/01/2569" })).toHaveProperty("error");
    // ปี พ.ศ. ในช่อง date = ผิด (ฐานข้อมูลเก็บ ค.ศ.)
    expect(validateTaxProfile({ ...base, vatRegisteredAt: "2569-01-15" })).toHaveProperty("error");
  });
});

describe("tax party validation", () => {
  const base = {
    partyType: "company" as const,
    name: "บริษัท ลูกค้า จำกัด",
    taxId: VALID_TAX_ID,
    branchCode: null,
    address: "กรุงเทพฯ",
    email: null,
    phone: null,
    customerId: null,
    isActive: true,
  };

  it("defaults a company with tax id to head office", () => {
    const result = validateTaxParty(base);
    expect("value" in result && result.value.branchCode).toBe("00000");
  });

  it("does not invent a branch for individuals", () => {
    const result = validateTaxParty({ ...base, partyType: "individual" });
    expect("value" in result && result.value.branchCode).toBeNull();
  });

  it("rejects bad tax id, branch, email and type", () => {
    expect(validateTaxParty({ ...base, taxId: "123" })).toHaveProperty("error");
    expect(validateTaxParty({ ...base, branchCode: "12" })).toHaveProperty("error");
    expect(validateTaxParty({ ...base, email: "not-an-email" })).toHaveProperty("error");
    expect(validateTaxParty({ ...base, partyType: "x" as never })).toHaveProperty("error");
  });
});

describe("document numbering", () => {
  it("uses the Thai (Buddhist) year and Bangkok month", () => {
    expect(documentPeriod(new Date("2026-11-21T03:00:00Z"))).toBe("2569-11");
    // 31 ต.ค. 18:00 UTC = 1 พ.ย. 01:00 เวลาไทย → งวดพฤศจิกายน
    expect(documentPeriod(new Date("2026-10-31T18:00:00Z"))).toBe("2569-11");
  });

  it("formats like the SQL function", () => {
    expect(formatDocumentNumber("tax_invoice", "2569-11", 1)).toBe("TIV6911-0001");
    expect(formatDocumentNumber("credit_note", "2570-01", 12)).toBe("CN7001-0012");
    expect(formatDocumentNumber("receipt", "2569-11", 10001)).toBe("RC6911-10001");
  });

  it("keeps TS prefixes in sync with SQL document_default_prefix()", () => {
    for (const type of DOCUMENT_TYPES) {
      expect(migration).toContain(`when '${type}' then '${DOCUMENT_PREFIX[type].toLowerCase()}'`);
    }
  });
});

describe("tax invoice eligibility", () => {
  it("needs VAT registration for full tax invoices", () => {
    expect(canIssueFullTaxInvoice(null)).toBe(false);
    expect(canIssueFullTaxInvoice({ vatRegistered: true })).toBe(true);
  });

  it("needs VAT + POS approval (ภ.พ.06) for abbreviated tax invoices", () => {
    expect(canIssueAbbreviatedTaxInvoice({ vatRegistered: true, posApprovalNo: null })).toBe(false);
    expect(canIssueAbbreviatedTaxInvoice({ vatRegistered: true, posApprovalNo: "  " })).toBe(false);
    expect(canIssueAbbreviatedTaxInvoice({ vatRegistered: false, posApprovalNo: "E05" })).toBe(false);
    expect(canIssueAbbreviatedTaxInvoice({ vatRegistered: true, posApprovalNo: "E05" })).toBe(true);
  });
});

describe("tax error messages", () => {
  it("maps RLS and unique errors to Thai", () => {
    expect(taxErrorMessage("new row violates row-level security policy")).toContain("เจ้าของหรือแอดมิน");
    expect(taxErrorMessage('duplicate key value violates unique constraint "tax_parties_store_tax_branch_unique_idx"')).toContain("มีผู้ซื้อ");
    expect(taxErrorMessage("weird")).toBe("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("tax B0 migration", () => {
  it("enables RLS on every new table", () => {
    for (const table of ["store_tax_profiles", "document_sequences", "tax_parties"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("lets only owner/admin write the tax identity and nobody delete it", () => {
    expect(migration).toContain("store_tax_profiles_admin_insert");
    expect(migration).toContain("auth_user_role_in_store(organization_id, store_id, 'admin')");
    expect(migration).not.toMatch(/on public\.store_tax_profiles for delete/);
  });

  it("never lets users advance a sequence directly (gap-free numbering)", () => {
    expect(migration).not.toMatch(/on public\.document_sequences for (all|insert|update|delete)/);
    expect(migration).toContain("revoke all on function public.reserve_document_number(uuid, text, timestamptz) from public, anon, authenticated");
    const fn = migration.slice(migration.indexOf("function public.reserve_document_number"));
    expect(fn).toContain("at time zone 'asia/bangkok'");
    expect(fn).toContain("+ 543");
    expect(fn).toContain("on conflict (store_id, doc_type, period) do nothing");
    expect(fn).toContain("set next_no = next_no + 1");
  });

  it("keeps tax parties tenant-safe and unique per tax id + branch", () => {
    expect(migration).toContain("customer must belong to the same organization");
    expect(migration).toContain("tax_parties_store_tax_branch_unique_idx");
  });
});
