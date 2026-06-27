/**
 * ทดสอบส่งอีเมลผ่าน Resend (เหมือนที่ฟีเจอร์ Enterprise ใช้จริง)
 *
 * ต้องมี RESEND_API_KEY และ ENTERPRISE_FROM_EMAIL — อ่านจาก .env.local หรือ env ปัจจุบัน
 * วิธีดึง env จาก Vercel ลงมา (รันเอง):  vercel env pull .env.local --environment=production
 *
 * ใช้:  node scripts/send-test-email.mjs recipient@example.com
 *       (ไม่ใส่ปลายทาง = ส่งหา ENTERPRISE_FROM_EMAIL เอง)
 */

import { readFileSync } from "node:fs";

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (process.env[key] === undefined) {
        process.env[key] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // ไฟล์ไม่มีก็ข้าม — อาจตั้ง env แบบ inline มาแล้ว
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.ENTERPRISE_FROM_EMAIL || process.env.EMAIL_FROM;
const to = process.argv[2] || (from && from.match(/<(.+)>/)?.[1]) || from;

if (!apiKey || !from) {
  console.error("❌ ไม่พบ RESEND_API_KEY หรือ ENTERPRISE_FROM_EMAIL");
  console.error("   ลองรัน: vercel env pull .env.local --environment=production");
  process.exit(1);
}
if (!to) {
  console.error("❌ ไม่มีอีเมลปลายทาง — ใส่เป็น argument: node scripts/send-test-email.mjs you@example.com");
  process.exit(1);
}

console.log(`📤 กำลังส่งทดสอบ  from="${from}"  to="${to}" ...`);

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    from,
    to: [to],
    subject: "StoreOS — ทดสอบส่งอีเมล Enterprise",
    html: '<div style="font-family:system-ui,sans-serif"><h2>ทดสอบสำเร็จ ✅</h2><p>นี่คืออีเมลทดสอบจากระบบคำขอ Enterprise ของ StoreOS</p></div>',
    text: "ทดสอบสำเร็จ ✅ — อีเมลทดสอบจากระบบคำขอ Enterprise ของ StoreOS",
  }),
});

const bodyText = await res.text();
if (res.ok) {
  let id = "";
  try { id = JSON.parse(bodyText).id ?? ""; } catch {}
  console.log(`✅ ส่งสำเร็จ (HTTP ${res.status})${id ? `  id=${id}` : ""}`);
  console.log("   เช็คกล่องจดหมาย (รวมโฟลเดอร์ Spam) ของปลายทาง");
} else {
  console.error(`❌ ส่งไม่สำเร็จ (HTTP ${res.status})`);
  console.error("   " + bodyText.slice(0, 500));
  if (/domain is not verified|not verified/i.test(bodyText)) {
    console.error("   → โดเมนของ ENTERPRISE_FROM_EMAIL ยังไม่ verify ใน resend.com → Domains");
  }
  if (/testing emails to your own/i.test(bodyText)) {
    console.error("   → โหมด sandbox: ส่งได้เฉพาะอีเมลเจ้าของบัญชี Resend จนกว่าจะ verify domain");
  }
  process.exit(1);
}
