import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const scriptPath = join(root, "scripts/create-test-user.mjs");

function runCreateTestUser(envText: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "storeos-script-safety-"));
  writeFileSync(join(dir, ".env.local"), envText, "utf8");

  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10_000,
  });
}

const remoteEnv = [
  "NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co",
  "SUPABASE_SERVICE_ROLE_KEY=fake-service-role-key",
].join("\n");

describe("script safety guards", () => {
  it("env example documents variables used by safety-sensitive scripts", () => {
    const envExample = read(".env.example");
    const resetSuperAdmin = read("scripts/reset-super-admin.mjs");

    expect(resetSuperAdmin).toContain("NEXT_PUBLIC_APP_URL");
    expect(envExample).toMatch(/^NEXT_PUBLIC_APP_URL=/m);
    expect(envExample).toMatch(/^TEST_USER_EMAIL=/m);
    expect(envExample).toMatch(/^TEST_USER_PASSWORD=/m);
    expect(envExample).toContain("use non-demo values for remote QA");
  });

  it("create-test-user refuses remote Supabase mutations without an explicit confirmation flag", () => {
    const source = read("scripts/create-test-user.mjs");

    expect(source).toContain('args.has("--dry-run")');
    expect(source).toContain('args.has("--confirm-remote")');
    expect(source).toContain("isRemoteTarget && !confirmRemote && !isDryRun");
    expect(source).toContain("Refusing to mutate remote Supabase without --confirm-remote.");
    expect(source).toContain("DRY RUN: no Supabase auth or database writes will be performed.");
  });

  it("create-test-user dry-run inspects remote target without network writes", () => {
    const result = runCreateTestUser(remoteEnv, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DRY RUN: no Supabase auth or database writes will be performed.");
    expect(result.stdout).toContain("Would ensure test user: <set TEST_USER_EMAIL for remote writes>");
    expect(result.stderr).not.toContain("Refusing to mutate remote Supabase");
  });

  it("create-test-user refuses remote writes without explicit confirmation", () => {
    const result = runCreateTestUser(remoteEnv);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to mutate remote Supabase without --confirm-remote.");
  });

  it("create-test-user requires the exact remote host confirmation", () => {
    const result = runCreateTestUser(remoteEnv, ["--confirm-remote", "--target-host=wrong.supabase.co"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Remote confirmation requires --target-host=example.supabase.co.");
  });

  it("create-test-user refuses confirmed remote writes when test credentials are missing", () => {
    const source = read("scripts/create-test-user.mjs");
    const missingCredentialGuard = source.indexOf(
      "Remote test user creation requires TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local.",
    );
    const realClientCreation = source.indexOf("createClient(supabaseUrl");
    const mockClientGate = source.indexOf("createMockSupabase");
    const result = runCreateTestUser(remoteEnv, ["--confirm-remote", "--target-host=example.supabase.co"]);

    expect(missingCredentialGuard).toBeGreaterThanOrEqual(0);
    expect(realClientCreation).toBeGreaterThanOrEqual(0);
    expect(mockClientGate).toBeGreaterThanOrEqual(0);
    expect(missingCredentialGuard).toBeLessThan(realClientCreation);
    expect(missingCredentialGuard).toBeLessThan(mockClientGate);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Remote test user creation requires TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local.",
    );
  });

  it("create-test-user rejects hardcoded demo credentials for remote writes", () => {
    const result = runCreateTestUser(
      [
        remoteEnv,
        "TEST_USER_EMAIL=owner@demo.com",
        "TEST_USER_PASSWORD=Demo1234!",
      ].join("\n"),
      ["--confirm-remote", "--target-host=example.supabase.co"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to use hardcoded demo credentials against remote Supabase.");
  });

  it("create-test-user rolls back database mappings and auth user after a partial mapping failure", () => {
    const result = runCreateTestUser(
      [
        remoteEnv,
        "TEST_USER_EMAIL=qa-owner@example.com",
        "TEST_USER_PASSWORD=Generated-only-test-password-123!",
        "SCRIPT_TEST_SCENARIO=org-fail-after-membership",
      ].join("\n"),
      ["--confirm-remote", "--target-host=example.supabase.co"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("membership mapping failed after user creation: organizations update error: mock organizations update failed");
    expect(result.stderr).toContain('MOCK update memberships set {"user_id":"00000000-0000-0000-0000-000000000001"} where id=["memberships-row-1"]');
    expect(result.stderr).toContain("no organization mapping touched in this attempt");
    expect(result.stderr).toContain("MOCK delete auth user 11111111-1111-1111-1111-111111111111");
  });

  it("create-test-user fails closed when seed mapping has already been moved", () => {
    const result = runCreateTestUser(
      [
        remoteEnv,
        "TEST_USER_EMAIL=qa-owner@example.com",
        "TEST_USER_PASSWORD=Generated-only-test-password-123!",
        "SCRIPT_TEST_SCENARIO=no-seed-mapping",
      ].join("\n"),
      ["--confirm-remote", "--target-host=example.supabase.co"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("membership update touched 0 rows; seed mapping is missing or was already moved");
    expect(result.stderr).toContain("no membership mapping touched in this attempt");
    expect(result.stderr).toContain("no organization mapping touched in this attempt");
    expect(result.stderr).toContain("MOCK delete auth user 11111111-1111-1111-1111-111111111111");
  });

  it("create-test-user rolls back attempted database mappings for an existing user partial failure", () => {
    const result = runCreateTestUser(
      [
        remoteEnv,
        "TEST_USER_EMAIL=qa-owner@example.com",
        "TEST_USER_PASSWORD=Generated-only-test-password-123!",
        "SCRIPT_TEST_SCENARIO=existing-user-org-fail-after-membership",
      ].join("\n"),
      ["--confirm-remote", "--target-host=example.supabase.co"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("membership mapping failed for existing user: organizations update error: mock organizations update failed");
    expect(result.stderr).toContain('MOCK update memberships set {"user_id":"00000000-0000-0000-0000-000000000001"} where id=["memberships-row-1"]');
    expect(result.stderr).toContain("no organization mapping touched in this attempt");
    expect(result.stderr).not.toContain("MOCK delete auth user");
  });
});
