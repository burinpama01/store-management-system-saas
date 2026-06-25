import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("StoreOS local print bridge script", () => {
  it("provides a localhost-only bridge command for WiFi printer jobs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scriptPath = join(root, "scripts", "print-bridge.mjs");

    expect(pkg.scripts?.["print:bridge"]).toBe("node scripts/print-bridge.mjs");
    expect(existsSync(scriptPath)).toBe(true);

    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("127.0.0.1");
    expect(source).toContain("STOREOS_PRINT_BRIDGE_ORIGINS");
    expect(source).toContain("function isAllowedPrintOrigin(origin)");
    expect(source).toContain("if (!origin) return false");
    expect(source).toContain("Access-Control-Allow-Private-Network");
    expect(source).toContain("access-control-request-private-network");
    expect(source).toContain("isAllowedNetworkPrinterHost");
    expect(source).toContain("MAX_PRINT_JOB_BYTES");
  });
});
