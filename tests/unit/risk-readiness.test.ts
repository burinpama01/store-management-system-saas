import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const scriptPath = join(root, "scripts/risk-readiness.mjs");

function runRiskReadiness(envText: string | null, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "storeos-risk-readiness-"));
  const envPath = join(dir, ".env.local");
  if (envText !== null) {
    writeFileSync(envPath, envText, "utf8");
  }

  return spawnSync(process.execPath, [scriptPath, `--risk-env-file=${envPath}`, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("residual risk readiness script", () => {
  it("reports missing env file without exposing values", () => {
    const result = runRiskReadiness(null);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ENV_FILE=missing");
    expect(result.stdout).toContain("Live Supabase verification requires explicit approval");
    expect(result.stdout).toContain("Provider delivery verification requires real provider tokens");
  });

  it("reports key readiness by name only and never prints secret values", () => {
    const result = runRiskReadiness(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY=super-secret-service-role",
        "TEST_USER_EMAIL=qa@example.com",
        "TEST_USER_PASSWORD=super-secret-password",
        "LINE_CHANNEL_ACCESS_TOKEN=line-secret-token",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NEXT_PUBLIC_SUPABASE_URL=present");
    expect(result.stdout).toContain("SUPABASE_SERVICE_ROLE_KEY=present");
    expect(result.stdout).toContain("TEST_USER_EMAIL=present");
    expect(result.stdout).toContain("TEST_USER_PASSWORD=present");
    expect(result.stdout).toContain("LINE_CHANNEL_ACCESS_TOKEN=present");
    expect(result.stdout).toContain("TELEGRAM_BOT_TOKEN=missing");
    expect(result.stdout).not.toContain("super-secret-service-role");
    expect(result.stdout).not.toContain("super-secret-password");
    expect(result.stdout).not.toContain("line-secret-token");
    expect(result.stderr).toBe("");
  });

  it("strict mode fails closed when residual external readiness is incomplete", () => {
    const result = runRiskReadiness(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY=super-secret-service-role",
        "TEST_USER_EMAIL=qa@example.com",
        "TEST_USER_PASSWORD=super-secret-password",
      ].join("\n"),
      ["--strict"],
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("LINE_CHANNEL_ACCESS_TOKEN=missing");
    expect(result.stdout).toContain("TELEGRAM_BOT_TOKEN=missing");
    expect(result.stdout).toContain("STRICT_STATUS=blocked");
  });

  it("treats comment-only placeholders as missing", () => {
    const result = runRiskReadiness(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY=super-secret-service-role",
        "TEST_USER_EMAIL=qa@example.com",
        "TEST_USER_PASSWORD=super-secret-password",
        "LINE_CHANNEL_ACCESS_TOKEN= # todo",
        "TELEGRAM_BOT_TOKEN=#todo",
      ].join("\n"),
      ["--strict"],
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("LINE_CHANNEL_ACCESS_TOKEN=missing");
    expect(result.stdout).toContain("TELEGRAM_BOT_TOKEN=missing");
    expect(result.stdout).toContain("STRICT_STATUS=blocked");
    expect(result.stdout).not.toContain("super-secret-service-role");
    expect(result.stdout).not.toContain("super-secret-password");
  });
});
