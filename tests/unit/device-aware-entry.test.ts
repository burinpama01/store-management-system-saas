import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectLandingPath } from "@/modules/auth/guards";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("device-aware entry (F0 · Task 4)", () => {
  it("selects the server-provided landing path for the client form factor", () => {
    const cashierTargets = { mobile: "/pos", tablet: "/pos", desktop: "/dashboard" } as const;

    expect(selectLandingPath(cashierTargets, "mobile")).toBe("/pos");
    expect(selectLandingPath(cashierTargets, "tablet")).toBe("/pos");
    expect(selectLandingPath(cashierTargets, "desktop")).toBe("/dashboard");
  });

  it("keeps every form factor on the same path when the role has one landing page", () => {
    const staffTargets = {
      mobile: "/attendance",
      tablet: "/attendance",
      desktop: "/attendance",
    } as const;

    expect(selectLandingPath(staffTargets, "tablet")).toBe("/attendance");
  });

  it("resolves the permission-safe landing map on the server without guessing viewport", () => {
    const guards = read("src/modules/auth/guards.ts");

    // Server resolve ตามสิทธิ์เดิม — ห้ามอ่าน viewport ฝั่ง server
    expect(guards).toContain("landingPathsForCurrentUser");
    expect(guards).toContain('return { mobile: "/pos", tablet: "/pos", desktop: "/dashboard" }');
    expect(guards).not.toContain("window.innerWidth");

    // super_admin / ยังไม่ล็อกอิน ต้องไปทางเดียวกันทุก form factor
    expect(guards).toContain('const fallback = await landingPathForCurrentUser()');
    expect(guards).toContain('return { mobile: "/login", tablet: "/login", desktop: "/login" }');
  });

  it("client picks the form factor with matchMedia once and replaces via router (no server viewport guess)", () => {
    const component = read("src/app/app-entry/DeviceAwareEntry.tsx");
    const page = read("src/app/app-entry/page.tsx");

    expect(component).toContain('"use client"');
    expect(component).toContain("window.matchMedia");
    expect(component).toContain("router.replace(paths[form])");
    // no-JS/timeout fallback ต้องใช้ server default ไม่เดาเอง
    expect(component).toContain("fallback");
    // client boundary: ห้าม import server module (guards.ts ใช้ next/headers + Supabase)
    expect(component).not.toContain("@/modules/auth/guards");
    expect(page).toContain("landingPathsForCurrentUser()");
    expect(page).toContain("<DeviceAwareEntry paths={paths} fallback={paths.desktop} />");
    expect(page).not.toContain("redirect(await landingPathForCurrentUser())");
  });
});
