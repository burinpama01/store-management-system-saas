import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// U0.5 — helper สำหรับ integration test กับ Supabase local stack (supabase start)
// กฎ:
// - อ่าน env เฉพาะตอน runtime จาก process.env (ไม่อ่านไฟล์ .env เอง, ไม่ fallback ไป remote URL ของแอป)
// - env ขาดต้อง throw โดยอธิบายชื่อตัวแปรที่ขาด
// - URL ต้องเป็น loopback เท่านั้น (127.0.0.1 / localhost / ::1) — อื่นๆ throw "non-loopback URL rejected"
// - ห้าม log key ทุกกรณี

export interface LocalSupabaseEnv {
  url: string;
  publishableKey: string;
  serviceKey: string;
}

export interface LocalSupabase extends LocalSupabaseEnv {
  /** client ที่ใช้ service key (สำหรับ seed/cleanup ฝั่ง admin ใน integration test) */
  client: SupabaseClient;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing ${name} — integration tests กับ local Supabase ต้องตั้ง ${name} ก่อนรัน (เช่น export ${name}=... หรือตั้งใน CI env) และห้ามชี้ไป remote ของแอป`
    );
  }
  return value;
}

/**
 * Validate และอ่านค่า env ของ local Supabase พร้อมกัน ตอน runtime เท่านั้น
 * (export แยกไว้เพื่อให้ unit test ยิง guard ได้โดยไม่แตะ network)
 */
export function readLocalSupabaseEnv(env: NodeJS.ProcessEnv = process.env): LocalSupabaseEnv {
  const url = requireEnv(env, "LOCAL_SUPABASE_URL");
  const publishableKey = requireEnv(env, "LOCAL_SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = requireEnv(env, "LOCAL_SUPABASE_SERVICE_KEY");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("LOCAL_SUPABASE_URL ไม่ใช่ URL ที่ถูกต้อง (ต้องเป็น loopback เช่น http://127.0.0.1:54321)");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `LOCAL_SUPABASE_URL ต้องใช้ protocol http/https (ได้รับ "${parsed.protocol}")`
    );
  }
  // WHATWG URL คืน hostname ของ IPv6 พร้อมวงเล็บ เช่น "[::1]" — ตัดวงเล็บก่อนเทียบ
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `non-loopback URL rejected — LOCAL_SUPABASE_URL ต้องเป็น 127.0.0.1 / localhost / [::1] เท่านั้น (ได้รับ hostname "${hostname}")`
    );
  }

  return { url, publishableKey, serviceKey };
}

/**
 * คืน config + Supabase client ของ local stack (ไม่มี network call ตอนสร้าง)
 * publishableKey ถูก expose ไว้ให้ test สร้าง client ฝั่ง user-context เองเมื่อจำเป็น
 */
export function getLocalSupabase(env: NodeJS.ProcessEnv = process.env): LocalSupabase {
  const { url, publishableKey, serviceKey } = readLocalSupabaseEnv(env);
  const client = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return { url, publishableKey, serviceKey, client };
}
