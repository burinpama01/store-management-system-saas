// Task 12/E (v0.34.3) — Command index for the Ctrl+K palette.
// ชั้น 1: deterministic fuzzy search over allowlisted routes (no AI).
// ชั้น 2 (deterministic-first): Thai keyword → command id mapping; the AI-driven
// conversion is intentionally deferred — AI must never invent URLs/actions.
import { classifyFormFactor } from "@/modules/devices/capability";

export type FormFactor = "mobile" | "tablet" | "desktop";

export type CommandItem = Readonly<{
  id: string;
  label: string;
  href: string;
  permission: string;
  formFactors: ReadonlyArray<FormFactor>;
}>;

/** Plan contract (verbatim semantics): permission × formFactor visibility. */
export function visibleCommands(
  commands: ReadonlyArray<CommandItem>,
  can: (permission: string) => boolean,
  formFactor: FormFactor,
): ReadonlyArray<CommandItem> {
  return commands.filter((c) => can(c.permission) && c.formFactors.includes(formFactor));
}

/** Deterministic live filter: substring (case-insensitive), prefix matches ranked first. */
export function fuzzyFilterCommands(
  commands: ReadonlyArray<CommandItem>,
  query: string,
): ReadonlyArray<CommandItem> {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const scored = commands
    .map((c) => {
      const label = c.label.toLowerCase();
      const href = c.href.toLowerCase();
      if (label.startsWith(q)) return { c, score: 0 };
      if (label.includes(q)) return { c, score: 1 };
      if (href.includes(q)) return { c, score: 2 };
      return null;
    })
    .filter((x): x is { c: CommandItem; score: number } => x !== null)
    .sort((a, b) => a.score - b.score);
  return scored.map((x) => x.c);
}

type KeywordRule = Readonly<{ keywords: ReadonlyArray<string>; commandId: string }>;

/**
 * ชั้น 2 (deterministic ก่อน AI เสมอ): Thai/English keyword → command id.
 * Returns null when nothing matches — never guesses a URL.
 */
export function matchCommandFromText(
  text: string,
  commands: ReadonlyArray<CommandItem>,
): CommandItem | null {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const rules: KeywordRule[] = [
    { keywords: ["ขอเพลง", "เพลง", "music"], commandId: "/music-requests" },
    { keywords: ["พิมพ์", "ปริ้น", "ใบเสร็จ", "printer", "print"], commandId: "/settings/receipt" },
    { keywords: ["สต็อก", "ของ", "stock"], commandId: "/stock" },
    { keywords: ["โต๊ะ", "qr order", "qr ordering", "qr"], commandId: "/qr-orders" },
    { keywords: ["บัญชี", "รายรับ", "รายจ่าย", "กระแสเงินสด"], commandId: "/accounting" },
    { keywords: ["รายงาน", "ยอดขาย"], commandId: "/reports" },
    { keywords: ["พนักงาน", "เงินเดือน", "ทีม"], commandId: "/staff" },
    { keywords: ["ลงเวลา", "เข้างาน", "attendance"], commandId: "/attendance" },
    { keywords: ["บุฟเฟต์", "buffet"], commandId: "/buffet" },
    { keywords: ["ลูกค้า", "สมาชิก", "แต้ม"], commandId: "/customers" },
    { keywords: ["เดลิเวอรี", "jdc", "delivery"], commandId: "/delivery" },
    { keywords: ["แจ้งเตือน", "notify", "notification"], commandId: "/notifications" },
    { keywords: ["ตั้งค่า", "setting"], commandId: "/settings" },
    { keywords: ["สาขา", "branch"], commandId: "/settings/branches" },
    { keywords: ["โปรโมชั่น", "แพ็กเกจ", "billing"], commandId: "/settings/billing" },
    { keywords: ["เมนู", "สินค้า", "catalog", "เพิ่มสินค้า"], commandId: "/catalog" },
    { keywords: ["ออกจากร้าน", "เริ่มต้น", "onboarding"], commandId: "/onboarding" },
    { keywords: ["แดชบอร์ด", "ภาพรวม", "dashboard"], commandId: "/dashboard" },
    { keywords: ["pos", "ขาย", "แคชเชียร์"], commandId: "/pos" },
  ];
  for (const rule of rules) {
    if (rule.keywords.some((k) => q.includes(k))) {
      const hit =
        commands.find((c) => c.id === rule.commandId) ??
        commands.find((c) => c.href === rule.commandId) ??
        null;
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Allowlisted dashboard destinations (permission strings mirror the dashboard
 * layout nav; the palette receives already-permission-filtered items from the
 * layout, so this list doubles as documentation and the id source of truth).
 */
export const DASHBOARD_COMMANDS: ReadonlyArray<CommandItem> = [
  { id: "/dashboard", label: "ภาพรวม", href: "/dashboard", permission: "dashboard.view", formFactors: ["mobile", "tablet", "desktop"] },
  { id: "/catalog", label: "เมนูสินค้า", href: "/catalog", permission: "catalog.manage", formFactors: ["mobile", "tablet", "desktop"] },
  { id: "/stock", label: "สต็อก", href: "/stock", permission: "stock.manage", formFactors: ["tablet", "desktop"] },
  { id: "/pos", label: "POS", href: "/pos", permission: "pos.use", formFactors: ["mobile", "tablet", "desktop"] },
  { id: "/customers", label: "ลูกค้า", href: "/customers", permission: "catalog.manage", formFactors: ["desktop"] },
  { id: "/qr-orders", label: "QR Order", href: "/qr-orders", permission: "orders.manage_qr", formFactors: ["tablet", "desktop"] },
  { id: "/delivery", label: "เดลิเวอรี", href: "/delivery", permission: "orders.manage_qr", formFactors: ["tablet", "desktop"] },
  { id: "/music-requests", label: "ขอเพลง", href: "/music-requests", permission: "orders.manage_qr", formFactors: ["desktop"] },
  { id: "/accounting", label: "บัญชี", href: "/accounting", permission: "cashflow.view", formFactors: ["desktop"] },
  { id: "/reports", label: "รายงาน", href: "/reports", permission: "reports.view", formFactors: ["desktop"] },
  { id: "/notifications", label: "แจ้งเตือน", href: "/notifications", permission: "reports.view", formFactors: ["desktop"] },
  { id: "/attendance", label: "การเข้างาน", href: "/attendance", permission: "attendance.clock", formFactors: ["mobile", "tablet", "desktop"] },
  { id: "/staff", label: "พนักงาน", href: "/staff", permission: "attendance.manage", formFactors: ["desktop"] },
  { id: "/buffet", label: "บุฟเฟต์", href: "/buffet", permission: "orders.manage_qr", formFactors: ["desktop"] },
  { id: "/settings", label: "ตั้งค่า", href: "/settings", permission: "settings.view", formFactors: ["desktop"] },
  { id: "/settings/receipt", label: "เครื่องพิมพ์", href: "/settings/receipt", permission: "settings.manage_printer", formFactors: ["desktop"] },
  { id: "/settings/print-hub", label: "Print Hub", href: "/settings/print-hub", permission: "settings.manage_printer", formFactors: ["desktop"] },
  { id: "/settings/devices", label: "อุปกรณ์นี้", href: "/settings/devices", permission: "settings.manage_printer", formFactors: ["desktop"] },
  { id: "/onboarding", label: "ตั้งค่าเริ่มต้น", href: "/onboarding", permission: "settings.manage_store", formFactors: ["mobile", "tablet", "desktop"] },
];

export { classifyFormFactor };