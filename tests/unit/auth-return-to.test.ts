import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { returnToForLoginRedirect, sanitizeReturnTo } from "@/modules/auth/return-to";

const BS = String.fromCharCode(92);

describe("sanitizeReturnTo", () => {
  it("accepts internal paths with query", () => {
    expect(sanitizeReturnTo("/player/queue-sfjcso")).toBe("/player/queue-sfjcso");
    expect(sanitizeReturnTo("/staff?tab=payroll")).toBe("/staff?tab=payroll");
    expect(sanitizeReturnTo("  /pos  ")).toBe("/pos");
  });

  it("rejects external and protocol-relative targets", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "//evil.com/player",
      `/${BS}evil.com`,
      `/${BS}${BS}evil.com`,
      `${BS}${BS}evil.com`,
      "javascript:alert(1)",
      "player/x",
      "/\t/evil.com",
      "/\n/evil.com",
      "/%2F%2Fevil.com",
      "/%2f%2fevil.com/x",
      "/%5C/evil.com",
      "/%5c/evil.com",
      "/%2F%5C/evil.com",
    ]) {
      expect(sanitizeReturnTo(bad), bad).toBeNull();
    }
  });

  it("rejects auth pages, api, root and junk", () => {
    for (const bad of ["/", "/login", "/login?next=/pos", "/LOGIN", "/register", "/reset-password", "/update-password", "/auth/callback", "/api/hr/cron/payroll", "/%2flogin", "/%2FLOGIN?next=x", "/%2fapi/x", "", null, undefined, 42, `/${"a".repeat(600)}`]) {
      expect(sanitizeReturnTo(bad), String(bad)).toBeNull();
    }
  });

  it("does not block paths that only share a prefix", () => {
    expect(sanitizeReturnTo("/authorize-device")).toBe("/authorize-device");
    expect(sanitizeReturnTo("/apis")).toBe("/apis");
  });

  it("drops the fragment on purpose", () => {
    expect(sanitizeReturnTo("/dashboard#reports")).toBe("/dashboard");
  });

  it("builds next from the redirected request", () => {
    expect(returnToForLoginRedirect("/player/queue-sfjcso", "")).toBe("/player/queue-sfjcso");
    expect(returnToForLoginRedirect("/pos", "?tableBill=1")).toBe("/pos?tableBill=1");
    expect(returnToForLoginRedirect("/api/hr/sales-target", "")).toBeNull();
  });
});

describe("login return-to wiring", () => {
  it("middleware attaches next when redirecting to /login", () => {
    const src = readFileSync("src/server/integrations/supabase/middleware.ts", "utf8");
    expect(src).toMatch(/returnToForLoginRedirect\(request\.nextUrl\.pathname, request\.nextUrl\.search\)/);
    expect(src).toMatch(/url\.searchParams\.set\(RETURN_TO_PARAM, returnTo\)/);
  });

  it("signIn re-validates next on the server before redirecting", () => {
    const src = readFileSync("src/app/(auth)/login/actions.ts", "utf8");
    expect(src).toMatch(/sanitizeReturnTo\(formData\.get\(RETURN_TO_PARAM\)\)/);
    expect(src).toMatch(/if \(returnTo\) redirect\(returnTo\)/);
    expect(src).toMatch(/landing === "\/login" \? "\/dashboard" : landing/);
  });
});
