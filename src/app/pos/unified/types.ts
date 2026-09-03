import type { Store, Table } from "@/modules/stores/types";
import type { CommandItem } from "@/modules/assistant/command-index";
import type { VoiceSpeechAdapter } from "@/modules/voice-pos/speech-adapter";
import type { VoiceNavigationAlias } from "@/modules/voice-pos/navigation";
import type { VoiceProductAlias } from "@/modules/voice-pos/cart";
import type { UnifiedKitchenItem } from "./kitchen-types";

// U9 — Store-gated unified POS shell (R2)
// types/gating ฝั่ง server + client ใช้ร่วมกัน ห้ามพึ่ง server-only module

/** พื้นที่ทำงานที่ /pos จะแสดง — "legacy" = PosTerminal เดิมทุกอย่าง */
export type UnifiedPosSurface = "unified" | "legacy";

/**
 * Gate เดียวของ /pos — flag เปิดที่ร้านเท่านั้น (stores.unified_pos_enabled, default false)
 * store row โหลดไม่ได้/ไม่มี flag → legacy เสมอ (fail closed ไปทางพฤติกรรมเดิม)
 */
export function resolveUnifiedPosSurface(
  store?: Pick<Store, "unifiedPosEnabled"> | null,
): UnifiedPosSurface {
  return store?.unifiedPosEnabled ? "unified" : "legacy";
}

/** สรุปโต๊ะที่ shell ใช้ — ตัดข้อมูลที่ U9 ยังไม่แสดงออกให้เหลือน้อยที่สุด */
export interface UnifiedTableSummary {
  readonly id: string;
  readonly number: string;
  readonly label?: string;
  readonly seats?: number;
  readonly status: Table["status"];
  readonly sessionStartedAt?: string;
}

/** Map Table จาก repository → summary ของ shell (pure, ทดสอบได้) */
export function toUnifiedTableSummaries(tables: readonly Table[]): UnifiedTableSummary[] {
  return tables.map((t) => ({
    id: t.id,
    number: t.number,
    label: t.label,
    seats: t.seats,
    status: t.status,
    sessionStartedAt: t.sessionStartedAt,
  }));
}

/** Props ของ shell — readonly ทั้งหมด (typed immutable props ตามแผน U9) */
export interface UnifiedPosWorkspaceProps {
  readonly storeId: string;
  readonly storeName: string;
  readonly tables: readonly UnifiedTableSummary[];
  /**
   * ประสบการณ์ขายเดิม (legacy PosTerminal) ที่ server compose ให้ —
   * U9 ยัง embed ตรง ๆ ในแท็บ "ขาย", U10+ จะแทนที่ด้วย sell workspace ใหม่
   */
  readonly sell: React.ReactNode;
  /**
   * U10 — snapshot คิวครัวตอนโหลดหน้า (server compose) — หลังจากนี้คิวครัว
   * อัปเดตเองผ่าน U3 realtime/polling และ refetch ผ่าน server action จาก server truth
   */
  readonly kitchenInitialItems: readonly UnifiedKitchenItem[];
  /**
   * U14 — stores.voice_command_enabled (default false = ไม่มีปุ่มเสียงเลย)
   * flag นี้อ่านจาก server เท่านั้น ห้าม client เปิดเอง
   */
  readonly voiceEnabled?: boolean;
  /** command ที่ผู้ใช้คนนี้เข้าถึงได้ (server กรองสิทธิ์แล้ว) — เสียงนำทางได้เฉพาะรายการนี้ */
  readonly voiceCommands?: readonly CommandItem[];
  /** คำเรียกที่ร้านสร้างเอง เฉพาะที่เปิดใช้งาน (U16) */
  readonly voiceAliases?: readonly VoiceNavigationAlias[];
  /** คำเรียกเมนูของร้าน เฉพาะที่เปิดใช้งาน (U22) */
  readonly voiceProductAliases?: readonly VoiceProductAlias[];
  /** ฉีด speech adapter สำหรับทดสอบเท่านั้น (ปกติ undefined = ใช้ของเบราว์เซอร์) */
  readonly voiceAdapter?: VoiceSpeechAdapter;
}
