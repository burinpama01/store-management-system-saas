import { describe, it, expect } from "vitest";
import { validateEnterpriseRequest } from "@/modules/enterprise/repository";

function base(over: Partial<Parameters<typeof validateEnterpriseRequest>[0]> = {}) {
  return {
    companyName: "Caramel Group",
    contactName: "สมชาย ใจดี",
    email: "owner@caramel.co",
    phone: "0812345678",
    branchCount: 10,
    message: "อยากได้ระบบหลายสาขา",
    ...over,
  };
}

describe("validateEnterpriseRequest", () => {
  it("accepts a complete, valid request", () => {
    expect(validateEnterpriseRequest(base())).toEqual({ valid: true, errors: [] });
  });

  it("accepts a minimal request without optional fields", () => {
    const r = validateEnterpriseRequest({
      companyName: "A",
      contactName: "B",
      email: "a@b.co",
      phone: null,
      branchCount: null,
      message: null,
    });
    expect(r.valid).toBe(true);
  });

  it("requires company name, contact name, and a valid email", () => {
    expect(validateEnterpriseRequest(base({ companyName: "  " })).valid).toBe(false);
    expect(validateEnterpriseRequest(base({ contactName: "" })).valid).toBe(false);
    expect(validateEnterpriseRequest(base({ email: "not-an-email" })).valid).toBe(false);
  });

  it("rejects a negative or non-integer branch count", () => {
    expect(validateEnterpriseRequest(base({ branchCount: -1 })).valid).toBe(false);
    expect(validateEnterpriseRequest(base({ branchCount: 1.5 })).valid).toBe(false);
  });

  it("rejects an over-long message", () => {
    expect(validateEnterpriseRequest(base({ message: "x".repeat(2001) })).valid).toBe(false);
  });

  it("collects multiple errors at once", () => {
    const r = validateEnterpriseRequest({ companyName: "", contactName: "", email: "bad", phone: null, branchCount: null, message: null });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});
