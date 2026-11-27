import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebsiteRenderer } from "@/modules/store-website/WebsiteRenderer";
import { WEBSITE_TEMPLATES, documentFromTemplate } from "@/modules/store-website/templates";
import type { WebsiteRenderData } from "@/modules/store-website/repository";

/**
 * เรนเดอร์ทุกเทมเพลตด้วยข้อมูลตัวอย่าง — ใช้ตรวจว่าเรนเดอร์ได้ไม่พัง
 * ตั้ง WEBSITE_PREVIEW_OUT=<โฟลเดอร์> เพื่อเขียนไฟล์ HTML ไว้เปิดดูด้วยตา (ไม่เขียนตอนรันเทสต์ปกติ)
 */
const data: WebsiteRenderData = {
  store: { id: "s1", name: "each other II", slug: "eachother", logoUrl: null, address: "123 ถนนนิมมาน เชียงใหม่", phone: "081-234-5678", closingTime: "20:00:00" },
  products: [
    { id: "00000000-0000-4000-8000-000000000001", name: "อเมริกาโน่", price: 45, imageUrl: null, categoryName: "กาแฟ" },
    { id: "00000000-0000-4000-8000-000000000002", name: "ลาเต้", price: 55, imageUrl: null, categoryName: "กาแฟ" },
    { id: "00000000-0000-4000-8000-000000000003", name: "ครัวซองต์", price: 65, imageUrl: null, categoryName: "เบเกอรี่" },
  ],
  passPlans: [{ id: "p1", name: "แพ็กอเมริกาโน่ 10 แก้ว", credits: 10, price: 350, validDays: 90 }],
  memberUrl: "/member/eachother?code=abc",
};

describe("เรนเดอร์เทมเพลต", () => {
  it("ทุกเทมเพลตเรนเดอร์ได้และมีชื่อร้าน เมนู แพ็ก", () => {
    const out = process.env.WEBSITE_PREVIEW_OUT;
    if (out) mkdirSync(out, { recursive: true });
    for (const template of WEBSITE_TEMPLATES) {
      const doc = documentFromTemplate(template, data.store.name);
      const banner = doc.blocks.find((b) => b.type === "banner");
      if (banner && banner.type === "banner") banner.subtitle = "ซื้อออนไลน์ได้เลย";
      const html = renderToStaticMarkup(<WebsiteRenderer document={doc} data={data} today="2026-11-15" />);
      expect(html).toContain("each other II");
      expect(html).toContain("อเมริกาโน่");
      if (out) {
        writeFileSync(
          join(out, `${template.id}.html`),
          `<!doctype html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${template.name}</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&family=Mitr:wght@400;600&display=swap" rel="stylesheet"></head><body style="margin:0">${html}</body></html>`,
        );
      }
    }
  });
});
