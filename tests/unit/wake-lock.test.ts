import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWakeLockSupported } from "@/shared/hooks/useWakeLock";

// iPad จอดับระหว่างเปิดเครื่องเล่นเพลง → Safari หยุดเพลง (2026-11-08)
describe("useWakeLock", () => {
  it("detects support without throwing on old browsers", () => {
    expect(isWakeLockSupported(undefined)).toBe(false);
    expect(isWakeLockSupported({})).toBe(false);
    expect(isWakeLockSupported({ wakeLock: { request: () => Promise.resolve() } })).toBe(true);
  });

  it("re-acquires when the page becomes visible again and releases on cleanup", () => {
    const src = readFileSync("src/shared/hooks/useWakeLock.ts", "utf8");
    expect(src).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(src).toContain('nav.wakeLock!.request("screen")');
    expect(src).toContain("sentinel.release()");
  });

  it("store player and customer lyrics screen keep the screen on", () => {
    expect(readFileSync("src/app/player/[storeSlug]/PlayerApp.tsx", "utf8")).toContain("useWakeLock(started);");
    expect(readFileSync("src/app/qr/[storeSlug]/[tableId]/CustomerScreen.tsx", "utf8")).toContain("useWakeLock(open);");
  });
});
