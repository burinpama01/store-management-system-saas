/**
 * สรุปยอดขายรายวันของร้าน — ตัวประกอบข้อความ (บริสุทธิ์ ไม่แตะฐานข้อมูล ไม่ส่งอะไรออก)
 *
 * ใช้ร่วมกัน 2 ทาง:
 *   1) อีเมลสรุปรายวันถึงเจ้าขององค์กร (cron วันละครั้ง — เฉพาะร้านที่มีออเดอร์ของวันนั้น)
 *   2) ข้อความ LINE/Telegram/Push ตอนพนักงานกดออกงาน (สรุปของวันนั้นถึงเจ้าของ)
 *
 * แยกจาก repository เพื่อให้ทดสอบรูปแบบข้อความ/การปัดเลข/เพดานความยาวได้โดยไม่ต้องมี Supabase
 */

/** ความยาวสูงสุดที่ dispatcher ยอมรับ (validateNotificationPayload) — เกินแล้วข้อความถูกปฏิเสธทั้งก้อน */
export const NOTIFICATION_MESSAGE_MAX_LENGTH = 1000;

export interface DailySummaryPaymentMethod {
  readonly method: string;
  readonly count: number;
  readonly amount: number;
}

export interface DailySummaryProduct {
  readonly name: string;
  readonly quantity: number;
  readonly revenue: number;
}

export interface StoreDailySummary {
  readonly storeId: string;
  readonly storeName: string;
  /** วันของยอดตาม timezone ของสาขา; อีเมลองค์กรอาจรวมสาขาคนละวันปฏิทิน */
  readonly date?: string;
  readonly orderCount: number;
  readonly revenue: number;
  readonly avgOrderValue: number;
  readonly posOrderCount: number;
  readonly qrOrderCount: number;
  readonly deliveryOrderCount: number;
  /** บิลที่ถูกยกเลิก/คืนเงินในวันนั้น — ตัวเลขที่เจ้าของอยากเห็นรองจากยอดขาย */
  readonly voidedCount: number;
  readonly paymentMethods: readonly DailySummaryPaymentMethod[];
  readonly topProducts: readonly DailySummaryProduct[];
}

export interface OrganizationDailySummary {
  readonly organizationId: string;
  readonly organizationName: string;
  /** วันของยอด (YYYY-MM-DD ตามเวลาร้าน) ไม่ใช่วันที่ส่ง */
  readonly date: string;
  readonly stores: readonly StoreDailySummary[];
  readonly orderCount: number;
  readonly revenue: number;
}

const METHOD_LABELS: Record<string, string> = {
  cash: "เงินสด",
  qr_promptpay: "QR PromptPay",
  credit_card: "บัตร",
  bank_transfer: "โอนเงิน",
  other: "อื่น ๆ",
};

export function paymentMethodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method;
}

export function baht(amount: number): string {
  return `฿${amount.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** วันที่แบบไทยอ่านง่าย เช่น "8 ก.ย. 2569" — รับ YYYY-MM-DD ที่คิด timezone มาแล้ว จึงอ่านเป็น UTC */
export function formatSummaryDate(dateIso: string): string {
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateIso;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

export function totalsOfStores(stores: readonly StoreDailySummary[]): {
  orderCount: number;
  revenue: number;
} {
  let orderCount = 0;
  let revenue = 0;
  for (const store of stores) {
    orderCount += store.orderCount;
    revenue += store.revenue;
  }
  return { orderCount, revenue: Math.round(revenue * 100) / 100 };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function channelLine(store: StoreDailySummary): string {
  const parts: string[] = [];
  if (store.posOrderCount > 0) parts.push(`POS ${store.posOrderCount}`);
  if (store.qrOrderCount > 0) parts.push(`QR ${store.qrOrderCount}`);
  if (store.deliveryOrderCount > 0) parts.push(`เดลิเวอรี ${store.deliveryOrderCount}`);
  return parts.join(" · ");
}

/**
 * ข้อความสั้นสำหรับ LINE/Telegram/Push — ตัดให้อยู่ในเพดาน 1000 ตัวอักษรเสมอ
 * (ยาวเกินแล้ว dispatcher ปฏิเสธทั้งข้อความ ไม่ใช่ตัดให้)
 */
export function buildDailySummaryMessage(
  store: StoreDailySummary,
  date: string,
  options?: { readonly trigger?: string },
): string {
  const lines: string[] = [
    `สรุปยอดวันที่ ${formatSummaryDate(date)}`,
    `ยอดขาย ${baht(store.revenue)} · ${store.orderCount} บิล · เฉลี่ย ${baht(store.avgOrderValue)}`,
  ];

  const channels = channelLine(store);
  if (channels) lines.push(`ช่องทาง: ${channels}`);

  if (store.paymentMethods.length > 0) {
    lines.push(
      `การชำระ: ${store.paymentMethods
        .map((m) => `${paymentMethodLabel(m.method)} ${baht(m.amount)}`)
        .join(" · ")}`,
    );
  }
  if (store.topProducts.length > 0) {
    lines.push(
      `ขายดี: ${store.topProducts
        .slice(0, 3)
        .map((p) => `${p.name} ×${p.quantity}`)
        .join(", ")}`,
    );
  }
  if (store.voidedCount > 0) lines.push(`ยกเลิก/คืนเงิน ${store.voidedCount} บิล`);
  if (options?.trigger) lines.push(options.trigger);

  const message = lines.join("\n");
  return message.length <= NOTIFICATION_MESSAGE_MAX_LENGTH
    ? message
    : `${message.slice(0, NOTIFICATION_MESSAGE_MAX_LENGTH - 1)}…`;
}

/** เนื้ออีเมลแบบข้อความล้วน — ใช้เป็น text ของอีเมล และเป็นตัวตั้งของ HTML */
export function buildDailySummaryText(summary: OrganizationDailySummary): string {
  const lines: string[] = [
    `สรุปยอดขายประจำวันที่ ${formatSummaryDate(summary.date)}`,
    `${summary.organizationName} — ${summary.stores.length} ร้านที่มีการขาย`,
    "",
    `ยอดรวมทุกร้าน ${baht(summary.revenue)} · ${summary.orderCount} บิล`,
    "",
  ];

  for (const store of summary.stores) {
    lines.push(`■ ${store.storeName} · ${formatSummaryDate(store.date ?? summary.date)}`);
    lines.push(`   ยอดขาย ${baht(store.revenue)} · ${store.orderCount} บิล · เฉลี่ย ${baht(store.avgOrderValue)}`);
    const channels = channelLine(store);
    if (channels) lines.push(`   ช่องทาง: ${channels}`);
    if (store.paymentMethods.length > 0) {
      lines.push(
        `   การชำระ: ${store.paymentMethods
          .map((m) => `${paymentMethodLabel(m.method)} ${baht(m.amount)} (${m.count})`)
          .join(" · ")}`,
      );
    }
    if (store.topProducts.length > 0) {
      lines.push("   ขายดี:");
      for (const product of store.topProducts) {
        lines.push(`     • ${product.name} ×${product.quantity} = ${baht(product.revenue)}`);
      }
    }
    if (store.voidedCount > 0) lines.push(`   ยกเลิก/คืนเงิน ${store.voidedCount} บิล`);
    lines.push("");
  }

  lines.push("ดูรายละเอียดเพิ่มเติมได้ที่ StoreOS > รายงาน");
  return lines.join("\n").trimEnd();
}

/** อีเมลฉบับเต็ม — แยกการ์ดต่อร้าน อ่านบนมือถือได้ */
export function buildDailySummaryEmail(summary: OrganizationDailySummary): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `สรุปยอดขาย ${formatSummaryDate(summary.date)} · ${baht(summary.revenue)} (${summary.orderCount} บิล)`;

  const storeBlocks = summary.stores
    .map((store) => {
      const channels = channelLine(store);
      const rows: string[] = [
        `<tr><td style="padding:2px 0;color:#6b7280">ยอดขาย</td><td style="padding:2px 0;text-align:right;font-weight:700">${escapeHtml(baht(store.revenue))}</td></tr>`,
        `<tr><td style="padding:2px 0;color:#6b7280">จำนวนบิล</td><td style="padding:2px 0;text-align:right">${store.orderCount}</td></tr>`,
        `<tr><td style="padding:2px 0;color:#6b7280">เฉลี่ยต่อบิล</td><td style="padding:2px 0;text-align:right">${escapeHtml(baht(store.avgOrderValue))}</td></tr>`,
      ];
      if (channels) {
        rows.push(
          `<tr><td style="padding:2px 0;color:#6b7280">ช่องทาง</td><td style="padding:2px 0;text-align:right">${escapeHtml(channels)}</td></tr>`,
        );
      }
      for (const method of store.paymentMethods) {
        rows.push(
          `<tr><td style="padding:2px 0;color:#6b7280">${escapeHtml(paymentMethodLabel(method.method))}</td><td style="padding:2px 0;text-align:right">${escapeHtml(baht(method.amount))} (${method.count})</td></tr>`,
        );
      }
      if (store.voidedCount > 0) {
        rows.push(
          `<tr><td style="padding:2px 0;color:#b91c1c">ยกเลิก/คืนเงิน</td><td style="padding:2px 0;text-align:right;color:#b91c1c">${store.voidedCount} บิล</td></tr>`,
        );
      }

      const products = store.topProducts.length
        ? `<p style="margin:10px 0 0;font-size:13px;color:#374151"><b>ขายดี:</b> ${store.topProducts
            .map((p) => `${escapeHtml(p.name)} ×${p.quantity}`)
            .join(", ")}</p>`
        : "";

      return [
        `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:0 0 12px">`,
        `<h3 style="margin:0 0 8px;font-size:15px;color:#111827">${escapeHtml(store.storeName)} · ${escapeHtml(formatSummaryDate(store.date ?? summary.date))}</h3>`,
        `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows.join("")}</table>`,
        products,
        `</div>`,
      ].join("");
    })
    .join("");

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">`,
    `<h2 style="margin:0 0 4px;font-size:18px;color:#111827">สรุปยอดขายประจำวัน</h2>`,
    `<p style="margin:0 0 14px;font-size:13px;color:#6b7280">${escapeHtml(summary.organizationName)} · ${escapeHtml(formatSummaryDate(summary.date))}</p>`,
    `<div style="background:#f9fafb;border-radius:12px;padding:14px;margin:0 0 14px">`,
    `<p style="margin:0;font-size:13px;color:#6b7280">ยอดรวมทุกร้าน</p>`,
    `<p style="margin:2px 0 0;font-size:24px;font-weight:800;color:#111827">${escapeHtml(baht(summary.revenue))}</p>`,
    `<p style="margin:2px 0 0;font-size:13px;color:#6b7280">${summary.orderCount} บิล · ${summary.stores.length} ร้าน</p>`,
    `</div>`,
    storeBlocks,
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />`,
    `<p style="font-size:12px;color:#6b7280">StoreOS · อีเมลนี้ส่งเฉพาะวันที่ร้านมีการขาย — ปิดได้ที่ ตั้งค่า &gt; การแจ้งเตือน</p>`,
    `</div>`,
  ].join("");

  return { subject, html, text: buildDailySummaryText(summary) };
}
