import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import config from "../../vitest.config";
import { getLocalSupabase, readLocalSupabaseEnv } from "../integration/helpers/local-supabase";

// Task U0.5 — Test Infrastructure Bootstrap
// ตรวจว่า vitest discovery หมดจาก workspaces ชั่วคราว (.codex-temp/.worktrees/
// .codex-remote-attachments) และ config ยังคง contract เดิม (node env, globals false,
// alias @ -> ./src) หลังเพิ่ม exclude

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FORBIDDEN_DISCOVERY_DIRS = [
  ".codex-temp",
  ".worktrees",
  ".codex-remote-attachments",
] as const;

const EXCLUDED_BUILD_DIRS = [
  ".codex-temp",
  ".worktrees",
  ".codex-remote-attachments",
  ".next",
  "dist",
  "out",
  "node_modules",
] as const;

let cachedDiscoveredFiles: string[] | null = null;

function listVitestDiscoveredFiles(): string[] {
  // memoize ต่อ process — spawn ลูกเดียวต่อการรัน (spawn ซ้ำแพงทั้ง config load + glob)
  if (cachedDiscoveredFiles) return cachedDiscoveredFiles;
  const vitestCli = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [vitestCli, "list", "--filesOnly"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(
      `vitest list timeout — discovery อาจค้าง (signal ${result.signal})`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `vitest list failed (exit ${result.status}): ${(result.stderr || result.stdout).slice(0, 2000)}`
    );
  }
  cachedDiscoveredFiles = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(line));
  return cachedDiscoveredFiles;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("vitest discovery hygiene (U0.5)", () => {
  it(
    "ไม่ค้นเจอ test จาก .codex-temp/.worktrees/.codex-remote-attachments",
    { timeout: 180_000 },
    async () => {
      const files = listVitestDiscoveredFiles().map(toPosix);
      const offenders = files.filter((file) =>
        file.split("/").some((segment) =>
          (FORBIDDEN_DISCOVERY_DIRS as readonly string[]).includes(segment)
        )
      );
      expect(
        offenders,
        `discovery ต้องไม่มี path จาก ${FORBIDDEN_DISCOVERY_DIRS.join(", ")} แต่เจอ ${offenders.length} ไฟล์\n${offenders.slice(0, 5).join("\n")}`
      ).toEqual([]);
      // เชิงพฤติกรรมด้วย: tests/e2e เป็นของ Playwright ต้องไม่หลุดเข้า vitest suite
      const e2eOffenders = files.filter((file) => /(^|\/)tests\/e2e\//.test(file));
      expect(
        e2eOffenders,
        `discovery ต้องไม่มีไฟล์จาก tests/e2e แต่เจอ ${e2eOffenders.length} ไฟล์`
      ).toEqual([]);
    }
  );

  it("ยังเห็น canonical test ใน tests/ (exclude ไม่กว้างเกิน)", { timeout: 180_000 }, async () => {
    const files = listVitestDiscoveredFiles().map(toPosix);
    expect(
      files.some((file) => file.includes("tests/unit/test-infrastructure.test.ts"))
    ).toBe(true);
  });
});

describe("vitest config contract (U0.5)", () => {
  const rawExclude = config.test?.exclude;
  const exclude: string[] = Array.isArray(rawExclude)
    ? rawExclude.map((entry) => String(entry))
    : rawExclude
      ? [String(rawExclude)]
      : [];

  it("exclude ครอบคลุม temp/workspaces และ build artifacts", () => {
    for (const dir of [...EXCLUDED_BUILD_DIRS, "tests/e2e"]) {
      expect(
        exclude.some((pattern) => pattern.includes(dir)),
        `vitest test.exclude ควรมี pattern ครอบคลุม "${dir}"`
      ).toBe(true);
    }
  });

  it("คง environment node, globals false และ alias @ -> ./src เดิม", () => {
    expect(config.test?.environment).toBe("node");
    expect(config.test?.globals).toBe(false);
    const alias = config.resolve?.alias as Record<string, string> | undefined;
    expect(String(alias?.["@"] ?? "")).toContain("src");
  });
});

const SUPABASE_ENV_KEYS = [
  "LOCAL_SUPABASE_URL",
  "LOCAL_SUPABASE_PUBLISHABLE_KEY",
  "LOCAL_SUPABASE_SERVICE_KEY",
] as const;

const VALID_LOCAL_ENV: Record<string, string> = {
  LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
  LOCAL_SUPABASE_PUBLISHABLE_KEY: "pk_test_local_dummy",
  LOCAL_SUPABASE_SERVICE_KEY: "sk_test_local_dummy",
};

describe("getLocalSupabase guards (U0.5)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of SUPABASE_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SUPABASE_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function setEnv(values: Record<string, string | undefined>): void {
    for (const key of SUPABASE_ENV_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  it("throw ชัดเจนเมื่อ LOCAL_SUPABASE_URL ขาด", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: undefined });
    expect(() => readLocalSupabaseEnv()).toThrow(/LOCAL_SUPABASE_URL/);
  });

  it("throw ชัดเจนเมื่อ LOCAL_SUPABASE_URL เป็นค่าว่าง", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: "" });
    expect(() => readLocalSupabaseEnv()).toThrow(/LOCAL_SUPABASE_URL/);
  });

  it("throw เมื่อ URL parse ไม่ได้เลย", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: "not a url" });
    expect(() => readLocalSupabaseEnv()).toThrow(/URL/);
  });

  it("ยอมรับ https บน loopback host", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: "https://127.0.0.1:54321" });
    expect(() => readLocalSupabaseEnv()).not.toThrow();
  });

  it("throw ชัดเจนเมื่อ LOCAL_SUPABASE_PUBLISHABLE_KEY ขาด", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_PUBLISHABLE_KEY: undefined });
    expect(() => readLocalSupabaseEnv()).toThrow(/LOCAL_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("throw ชัดเจนเมื่อ LOCAL_SUPABASE_SERVICE_KEY ขาด", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_SERVICE_KEY: undefined });
    expect(() => readLocalSupabaseEnv()).toThrow(/LOCAL_SUPABASE_SERVICE_KEY/);
  });

  it("throw \"non-loopback URL rejected\" เมื่อ URL ไม่ใช่ 127.0.0.1/localhost/[::1]", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: "https://example.supabase.co" });
    expect(() => readLocalSupabaseEnv()).toThrow(/non-loopback URL rejected/);
  });

  it("reject protocol ที่ไม่ใช่ http/https (เช่น postgres://)", () => {
    setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: "postgres://127.0.0.1:54322" });
    expect(() => readLocalSupabaseEnv()).toThrow(/protocol/);
  });

  it("สร้าง client ได้จาก loopback URL โดยไม่ยิง network", () => {
    setEnv(VALID_LOCAL_ENV);
    const local = getLocalSupabase();
    expect(local.url).toBe("http://127.0.0.1:54321");
    expect(local.publishableKey).toBe("pk_test_local_dummy");
    expect(local.serviceKey).toBe("sk_test_local_dummy");
    expect(local.client).toBeInstanceOf(SupabaseClient);
    expect(
      (local.client as unknown as { supabaseUrl: string }).supabaseUrl
    ).toBe("http://127.0.0.1:54321");
  });

  it("ไม่ log key ทุกกรณี (ทั้ง success และ error path)", () => {
    const calls: unknown[][] = [];
    const spies = ["log", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation((...args: unknown[]) => {
        calls.push(args);
      })
    );
    try {
      setEnv(VALID_LOCAL_ENV);
      getLocalSupabase();
      setEnv({ ...VALID_LOCAL_ENV, LOCAL_SUPABASE_URL: undefined });
      try {
        readLocalSupabaseEnv();
      } catch {
        // error path ตั้งใจให้ throw
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const printed = calls.flat().map((item) => String(item)).join("\n");
    expect(printed).not.toContain("pk_test_local_dummy");
    expect(printed).not.toContain("sk_test_local_dummy");
  });
});

describe("tests/setup/react.ts import-safety (U0.5)", () => {
  it("โหลดได้แม้รันบน node environment (ไม่มี document)", async () => {
    expect(typeof document).toBe("undefined");
    await expect(import("../setup/react")).resolves.toBeTruthy();
  });
});
