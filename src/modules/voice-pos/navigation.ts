// U14 — Voice Tier A navigation (R2) · ตัวตัดสินปลายทางแบบ allowlist ล้วน
// pure ทั้งไฟล์ — ห้าม import React/router/supabase (ผู้เรียกเป็นคนลงมือทำจริง)
//
// สัญญาที่ล็อกไว้:
//   - ปลายทางมีได้แค่ 3 แบบ: แท็บของ POS รวม / โฟกัสในหน้า / route จาก command index เดิม
//   - "ห้ามสร้าง URL หรือ action ขึ้นเอง" — route ต้องมาจาก command index เท่านั้น
//   - flag ปิด หรือไม่มีสิทธิ์ → คืนเหตุผลที่ block ไม่ใช่เงียบ
//   - ข้อความประกาศไม่มีคำพูดของผู้ใช้อยู่ในนั้น (screen reader อ่านได้โดยไม่เปิดเผย transcript)

import {
  matchCommandFromText,
  type CommandItem,
} from "@/modules/assistant/command-index";
import type { VoiceParseResult } from "./types";

export type VoicePosTabId = "sell" | "tables" | "kitchen" | "bills";
export type VoicePosFocusAction = "search" | "cart";

export type VoiceNavigationTarget =
  | { readonly kind: "tab"; readonly tabId: VoicePosTabId }
  | { readonly kind: "focus"; readonly action: VoicePosFocusAction }
  | { readonly kind: "route"; readonly commandId: string; readonly href: string };

export type VoiceNavigationBlockedReason =
  | "feature_disabled"
  | "not_navigate"
  | "not_executable"
  | "permission_denied"
  | "no_match";

export type VoiceNavigationOutcome =
  | { readonly status: "navigate"; readonly target: VoiceNavigationTarget; readonly announcement: string }
  | { readonly status: "blocked"; readonly reason: VoiceNavigationBlockedReason; readonly announcement: string };

export interface VoiceNavigationContext {
  /** stores.voice_command_enabled — ปิด = ไม่ทำอะไรเลย */
  readonly voiceEnabled: boolean;
  /** command ที่ผู้ใช้คนนี้เข้าถึงได้จริง (server กรองสิทธิ์มาแล้ว) */
  readonly allowedCommands: readonly CommandItem[];
  /** รายการทั้งหมดไว้แยกแยะ "ไม่มีสิทธิ์" ออกจาก "ไม่รู้จักคำสั่ง" */
  readonly allCommands: readonly CommandItem[];
}

/** ชื่อแท็บที่พูดได้ — ต้องตรงทั้งคำ (กัน "รายงานยอดขาย" ไปโดนแท็บ "ขาย") */
const TAB_ALIASES: ReadonlyArray<readonly [VoicePosTabId, readonly string[]]> = [
  ["sell", ["ขาย", "หน้าขาย", "แคชเชียร์", "sell", "pos"]],
  ["tables", ["โต๊ะ", "ผังโต๊ะ", "tables", "table"]],
  ["kitchen", ["ครัว", "คิวครัว", "kitchen"]],
  ["bills", ["บิล", "บิลและการพิมพ์", "bills", "bill"]],
];

const TAB_LABEL: Record<VoicePosTabId, string> = {
  sell: "ขาย",
  tables: "โต๊ะ",
  kitchen: "ครัว",
  bills: "บิล",
};

/** โฟกัสภายในหน้า — ผู้เรียกเป็นคนหา element จริง (ไม่มี DOM ในไฟล์นี้) */
const FOCUS_ALIASES: ReadonlyArray<readonly [VoicePosFocusAction, readonly string[]]> = [
  ["search", ["ค้นหา", "ช่องค้นหา", "หาสินค้า", "search"]],
  ["cart", ["ตะกร้า", "ช่องตะกร้า", "รายการขาย", "cart"]],
];

const FOCUS_LABEL: Record<VoicePosFocusAction, string> = {
  search: "ช่องค้นหา",
  cart: "ตะกร้า",
};

/** คำนำหน้าที่พูดติดมาแต่ไม่ใช่ชื่อปลายทาง */
const QUERY_PREFIXES: readonly string[] = ["แท็บ", "หน้า", "ที่", "ไป", "เมนู"];

/** ตัดคำนำหน้าออกจนเหลือชื่อปลายทางล้วน (deterministic, วนซ้ำจนไม่เหลือ) */
export function stripNavigationPrefixes(query: string): string {
  let text = query.trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of QUERY_PREFIXES) {
      if (text.startsWith(prefix) && text.length > prefix.length) {
        text = text.slice(prefix.length).trim();
        stripped = true;
      }
    }
  }
  return text;
}

function blocked(reason: VoiceNavigationBlockedReason, announcement: string): VoiceNavigationOutcome {
  return { status: "blocked", reason, announcement };
}

/**
 * แปลงผล parse → ปลายทางที่ทำได้จริง
 * ลำดับ: flag → ชนิด intent → แท็บ → โฟกัส → command index (สิทธิ์) → ไม่รู้จัก
 */
export function resolveVoiceNavigation(
  result: VoiceParseResult,
  context: VoiceNavigationContext,
): VoiceNavigationOutcome {
  if (!context.voiceEnabled) {
    return blocked("feature_disabled", "ร้านนี้ยังไม่เปิดสั่งงานด้วยเสียง");
  }
  if (result.intent.type !== "navigate") {
    return blocked(
      "not_navigate",
      result.resultCode === "forbidden_command"
        ? "คำสั่งนี้ต้องทำบนหน้าจอ"
        : "คำสั่งนี้ยังไม่รองรับด้วยเสียงในรอบนี้",
    );
  }
  // ความมั่นใจต่ำ/preview = ไม่เปิดหน้าให้อัตโนมัติ
  if (result.decision !== "execute") {
    return blocked("not_executable", "ฟังไม่ชัด — ยังไม่เปิดหน้าให้อัตโนมัติ ลองพูดใหม่อีกครั้ง");
  }

  const query = stripNavigationPrefixes(result.intent.query);
  if (!query) return blocked("no_match", "ยังไม่รองรับคำสั่งนี้ — เลือกจากแท็บบนหน้าจอได้");

  for (const [tabId, aliases] of TAB_ALIASES) {
    if (aliases.includes(query)) {
      return { status: "navigate", target: { kind: "tab", tabId }, announcement: `เปิดแท็บ${TAB_LABEL[tabId]}แล้ว` };
    }
  }

  for (const [action, aliases] of FOCUS_ALIASES) {
    if (aliases.includes(query)) {
      return {
        status: "navigate",
        target: { kind: "focus", action },
        announcement: `ไปที่${FOCUS_LABEL[action]}แล้ว`,
      };
    }
  }

  // route ต้องมาจาก command index เดิมเท่านั้น — ห้ามประกอบ URL เอง
  const allowed = matchCommandFromText(query, context.allowedCommands);
  if (allowed) {
    return {
      status: "navigate",
      target: { kind: "route", commandId: allowed.id, href: allowed.href },
      announcement: `กำลังเปิด${allowed.label}`,
    };
  }

  const existsButDenied = matchCommandFromText(query, context.allCommands);
  if (existsButDenied) {
    return blocked("permission_denied", "บัญชีนี้ยังไม่มีสิทธิ์เข้าหน้านั้น");
  }

  return blocked("no_match", "ยังไม่รองรับคำสั่งนี้ — เลือกจากแท็บบนหน้าจอได้");
}
