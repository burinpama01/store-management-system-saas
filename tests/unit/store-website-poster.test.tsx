import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAX_POSTER_ELEMENTS, parseWebsiteDocument, posterBlockSchema } from "@/modules/store-website/schema";
import { WEBSITE_TEMPLATES, documentFromTemplate, emptyBlock } from "@/modules/store-website/templates";
import { WebsiteRenderer } from "@/modules/store-website/WebsiteRenderer";
import type { WebsiteRenderData } from "@/modules/store-website/repository";

const read = (path: string) => readFileSync(path, "utf8");
const poster = emptyBlock("poster");
const data: WebsiteRenderData = {
  store: { id: "s1", name: "each other II", slug: "eachother", logoUrl: null, address: null, phone: null, closingTime: null },
  products: [],
  passPlans: [],
  memberUrl: null,
};

describe("S3 โปสเตอร์วางอิสระ", () => {
  it("บล็อกโปสเตอร์เริ่มต้นผ่าน schema และใส่ในเอกสารได้", () => {
    expect(posterBlockSchema.safeParse(poster).success).toBe(true);
    const doc = documentFromTemplate(WEBSITE_TEMPLATES[0], "ร้าน");
    expect(parseWebsiteDocument({ ...doc, blocks: [...doc.blocks, poster] }).error).toBeNull();
  });

  it("กันข้อมูลแปลก: สติกเกอร์นอกชุด, ลิงก์รูป javascript:, ตำแหน่งเกิน 100, ชิ้นงานเกินจำนวน, รหัสซ้ำ", () => {
    if (poster.type !== "poster") throw new Error("expected poster");
    const el = poster.elements[0];
    expect(posterBlockSchema.safeParse({ ...poster, elements: [{ ...el, kind: "sticker", sticker: "💩" }] }).success).toBe(false);
    expect(posterBlockSchema.safeParse({ ...poster, elements: [{ ...el, kind: "image", imageUrl: "javascript:alert(1)" }] }).success).toBe(false);
    expect(posterBlockSchema.safeParse({ ...poster, backgroundImageUrl: "data:image/png;base64,AAA" }).success).toBe(false);
    expect(posterBlockSchema.safeParse({ ...poster, elements: [{ ...el, x: 120 }] }).success).toBe(false);
    const many = Array.from({ length: MAX_POSTER_ELEMENTS + 1 }, (_, i) => ({ ...el, id: `e${i}` }));
    expect(posterBlockSchema.safeParse({ ...poster, elements: many }).success).toBe(false);
    expect(posterBlockSchema.safeParse({ ...poster, elements: [el, el] }).success).toBe(false);
  });

  it("เรนเดอร์เป็น % + cqw (ย่อขยายตามจอ) และข้อความเป็นข้อความธรรมดา", () => {
    if (poster.type !== "poster") throw new Error("expected poster");
    const evil = { ...poster, elements: [{ ...poster.elements[0], text: "<script>x</script>" }] };
    const doc = { ...documentFromTemplate(WEBSITE_TEMPLATES[0], "ร้าน"), blocks: [evil] };
    const html = renderToStaticMarkup(<WebsiteRenderer document={doc} data={data} today="2026-11-16" editorMode />);
    expect(html).toContain(`data-block-id="${poster.id}"`);
    expect(renderToStaticMarkup(<WebsiteRenderer document={doc} data={data} today="2026-11-16" />)).not.toContain("data-block-id");
    expect(html).toContain("container-type:inline-size");
    expect(html).toContain("cqw");
    expect(html).not.toContain("<script>x</script>");
    const out = process.env.WEBSITE_PREVIEW_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      const full = renderToStaticMarkup(<WebsiteRenderer document={{ ...doc, blocks: [poster] }} data={data} today="2026-11-16" />);
      writeFileSync(join(out, "poster.html"), `<!doctype html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;font-family:sans-serif">${full}</body></html>`);
    }
  });
});

describe("S3 ตัวแก้", () => {
  const editor = read("src/app/(dashboard)/website/WebsiteEditor.tsx");
  it("มีเลิกทำ/ทำซ้ำ (รวมการแก้ต่อเนื่อง) ลากจัดลำดับ สลับพรีวิวมือถือ/คอม และแตะพรีวิวเพื่อแก้", () => {
    expect(editor).toContain("if (now - h.lastAt > 600)");
    expect(editor).toContain('aria-label="เลิกทำ"');
    expect(editor).toContain("onDragStart");
    expect(editor).toContain('setDevice("desktop")');
    expect(editor).toContain('closest("[data-block-id]")');
  });
  it("ตัวแก้โปสเตอร์ลากด้วย pointer events (ใช้ได้ทั้งเมาส์และนิ้ว) และเลื่อนด้วยคีย์บอร์ดได้", () => {
    const posterEditor = read("src/app/(dashboard)/website/PosterEditor.tsx");
    expect(posterEditor).toContain("setPointerCapture");
    expect(posterEditor).toContain("touch-none");
    expect(posterEditor).toContain("ArrowLeft");
  });
});
