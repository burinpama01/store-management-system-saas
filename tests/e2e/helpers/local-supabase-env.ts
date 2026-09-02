import { execFileSync } from "node:child_process";

// U9 — E2E SAFETY (fail-closed): ตัวอ่าน env ของ local Supabase stack สำหรับ Playwright
// กฎ (non-negotiable):
// 1. e2e ต้องรันกับ local stack (127.0.0.1:54321) เสมอ — .env/.env.local ของแอปชี้ remote
//    จึงห้าม fallback ไป env ใดๆ ของแอป/ของ shell
// 2. ถ้า supabase CLI/stack ไม่พร้อม → throw ที่ config-load (ทดสอบทั้งชุดไม่เริ่ม)
// 3. URL ต้องเป็น loopback เท่านั้น (127.0.0.1 / localhost / ::1) — ไม่ยอม host อื่นเด็ดขาด
// 4. ห้าม log key ในทุกกรณี

export interface LocalSupabaseStatusEnv {
  apiUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const REQUIRED = ["API_URL", "SERVICE_ROLE_KEY"] as const;

function parseStatusEnv(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of raw.matchAll(/^([A-Z_]+)="(.*)"$/gm)) {
    vars[match[1]] = match[2];
  }
  return vars;
}

function requireVar(vars: Record<string, string>, name: string): string {
  const value = vars[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `E2E fail-closed: ${name} หายจาก "supabase status -o env" — ตรวจว่า local stack เปิดอยู่ (supabase start)`
    );
  }
  return value;
}

let cached: LocalSupabaseStatusEnv | null = null;

/**
 * อ่าน + validate env ของ local stack ครั้งเดียวต่อ process (memoize)
 * ใช้ร่วมกันทั้ง playwright.config.ts (webServer env) และ test spec (fixture client)
 */
export function readLocalSupabaseStatusEnv(): LocalSupabaseStatusEnv {
  if (cached) return cached;

  let raw: string;
  try {
    raw = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `E2E fail-closed: เรียก "supabase status -o env" ไม่ได้ — ตรวจว่า supabase CLI และ local stack พร้อม (${detail})`
    );
  }

  const vars = parseStatusEnv(raw);
  for (const name of REQUIRED) requireVar(vars, name);

  // publishable key ใหม่ของ CLI ใช้ PUBLISHABLE_KEY — ANON_KEY เป็นชื่อเก่า (รองรับทั้งคู่)
  const publishableKey = vars.PUBLISHABLE_KEY || vars.ANON_KEY;
  if (!publishableKey || publishableKey.trim() === "") {
    throw new Error(
      'E2E fail-closed: PUBLISHABLE_KEY/ANON_KEY หายจาก "supabase status -o env" — local stack ยังไม่พร้อม'
    );
  }

  const apiUrl = vars.API_URL;
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`E2E fail-closed: API_URL "${apiUrl}" ไม่ใช่ URL ที่ถูกต้อง`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`E2E fail-closed: API_URL ต้องเป็น http/https (ได้รับ "${parsed.protocol}")`);
  }
  // WHATWG URL คืน hostname ของ IPv6 พร้อมวงเล็บ เช่น "[::1]" — ตัดวงเล็บก่อนเทียบ
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `E2E fail-closed: non-loopback URL rejected — API_URL ต้องเป็น 127.0.0.1 / localhost / [::1] เท่านั้น (ได้รับ "${hostname}") — ห้ามรัน e2e ชี้ remote`
    );
  }

  cached = {
    apiUrl,
    publishableKey,
    serviceRoleKey: vars.SERVICE_ROLE_KEY,
  };
  return cached;
}
