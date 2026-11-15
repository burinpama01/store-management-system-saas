import { WEBSITE_DOCUMENT_VERSION, type WebsiteBlock, type WebsiteDocument, type WebsiteTheme } from "./schema";

export type TemplateBusiness = "cafe" | "restaurant" | "grocery";
export type TemplateStyle = "minimal" | "cute" | "luxury";

export interface WebsiteTemplate {
  id: string;
  name: string;
  business: TemplateBusiness;
  style: TemplateStyle;
  description: string;
  theme: WebsiteTheme;
}

export const BUSINESS_LABELS: Record<TemplateBusiness, string> = {
  cafe: "คาเฟ่",
  restaurant: "ร้านอาหาร",
  grocery: "ร้านของชำ",
};

export const STYLE_LABELS: Record<TemplateStyle, string> = {
  minimal: "มินิมอล",
  cute: "น่ารัก",
  luxury: "หรูหรา",
};

const THEMES: Record<TemplateStyle, Omit<WebsiteTheme, "primary" | "accent">> = {
  minimal: { style: "minimal", background: "#f7f5f1", surface: "#ffffff", text: "#1d1b18", font: "sans", radius: "md" },
  cute: { style: "cute", background: "#fff4f8", surface: "#ffffff", text: "#4a2b3a", font: "rounded", radius: "lg" },
  luxury: { style: "luxury", background: "#0f0d0a", surface: "#1c1813", text: "#f2e6c9", font: "serif", radius: "sm" },
};

function theme(style: TemplateStyle, primary: string, accent: string): WebsiteTheme {
  return { ...THEMES[style], primary, accent };
}

/** เทมเพลตตั้งต้น S0 — 3 ประเภทร้าน × สไตล์ที่เข้ากัน (คลังเพิ่มรายเดือนเป็น S4) */
export const WEBSITE_TEMPLATES: WebsiteTemplate[] = [
  { id: "cafe-minimal", name: "คาเฟ่มินิมอล", business: "cafe", style: "minimal", description: "โทนกาแฟอุ่น เรียบ อ่านง่าย", theme: theme("minimal", "#6b4226", "#c08a5b") },
  { id: "cafe-cute", name: "คาเฟ่น่ารัก", business: "cafe", style: "cute", description: "พาสเทล ปุ่มกลม ฟอนต์มน", theme: theme("cute", "#e05a8a", "#ffb84d") },
  { id: "restaurant-luxury", name: "ร้านอาหารหรูหรา", business: "restaurant", style: "luxury", description: "ทอง-ดำ ตัวหนังสือเซอริฟ", theme: theme("luxury", "#c9a227", "#e8cf8f") },
  { id: "restaurant-minimal", name: "ร้านอาหารมินิมอล", business: "restaurant", style: "minimal", description: "รูปเมนูใหญ่ สีส้มอบอุ่น", theme: theme("minimal", "#c0392b", "#e67e22") },
  { id: "grocery-minimal", name: "ร้านของชำ", business: "grocery", style: "minimal", description: "เขียวสด ตารางสินค้า", theme: theme("minimal", "#1f9d55", "#f4b400") },
  { id: "grocery-cute", name: "ร้านของชำน่ารัก", business: "grocery", style: "cute", description: "สีสดใส ใกล้บ้าน", theme: theme("cute", "#2f9e44", "#fd7e14") },
];

export function findTemplate(id: string): WebsiteTemplate | null {
  return WEBSITE_TEMPLATES.find((template) => template.id === id) ?? null;
}

let seq = 0;
export function newBlockId(type: string): string {
  seq = (seq + 1) % 100000;
  return `${type}-${Date.now().toString(36)}${seq.toString(36)}`.slice(0, 40);
}

/** บล็อกเปล่าแต่ละชนิด (ใช้ตอนกด “เพิ่มบล็อก”) */
export function emptyBlock(type: WebsiteBlock["type"], storeName = "ร้านของเรา"): WebsiteBlock {
  const id = newBlockId(type);
  switch (type) {
    case "hero":
      return { id, type, title: storeName, subtitle: "", imageUrl: "", showOpenStatus: true };
    case "banner":
      return { id, type, title: "โปรโมชันเดือนนี้", subtitle: "", imageUrl: "", link: { kind: "none", url: "" }, startsOn: "", endsOn: "" };
    case "passes":
      return { id, type, title: "แพ็กสุดคุ้ม ซื้อล่วงหน้า" };
    case "menu":
      return { id, type, title: "เมนูแนะนำ", mode: "featured", productIds: [], showPrices: true };
    case "member":
      return { id, type, title: "สมาชิก", description: "สะสมแต้ม ดูระดับ แพ็ก และโค้ดพิเศษของคุณ" };
    case "info":
      return { id, type, showAddress: true, showPhone: true, hoursText: "", mapUrl: "" };
    case "social":
      return { id, type, links: [] };
    case "delivery_apps":
      return { id, type, title: "สั่งผ่านแอปเดลิเวอรี", apps: [] };
    case "text":
      return { id, type, title: "เกี่ยวกับร้าน", body: "" };
  }
}

/** เอกสารเริ่มต้นจากเทมเพลต — ลำดับบล็อกต่างกันตามประเภทร้าน */
export function documentFromTemplate(template: WebsiteTemplate, storeName: string): WebsiteDocument {
  const order: WebsiteBlock["type"][] =
    template.business === "grocery"
      ? ["hero", "banner", "menu", "delivery_apps", "member", "info", "social"]
      : template.business === "restaurant"
        ? ["hero", "menu", "banner", "delivery_apps", "member", "info", "social"]
        : ["hero", "banner", "passes", "menu", "member", "info", "social"];
  const blocks = order.map((type) => emptyBlock(type, storeName));
  const menu = blocks.find((b) => b.type === "menu");
  if (menu && menu.type === "menu" && template.business === "grocery") {
    menu.mode = "all";
    menu.title = "สินค้าในร้าน";
  }
  return { version: WEBSITE_DOCUMENT_VERSION, theme: template.theme, blocks };
}

export const BLOCK_LABELS: Record<WebsiteBlock["type"], string> = {
  hero: "🖼️ ปกร้าน",
  banner: "🏷️ แบนเนอร์โปรโมชัน",
  passes: "🎟️ แพ็กล่วงหน้า",
  menu: "🍽️ เมนู / สินค้า",
  member: "⭐ สมาชิก",
  info: "📍 ที่อยู่ เวลาเปิด",
  social: "💬 โซเชียล",
  delivery_apps: "🛵 แอปเดลิเวอรี",
  text: "📝 ข้อความ",
};

export const DELIVERY_APP_LABELS: Record<string, { name: string; color: string }> = {
  grab: { name: "GrabFood", color: "#00b14f" },
  lineman: { name: "LINE MAN", color: "#06c755" },
  foodpanda: { name: "foodpanda", color: "#d70f64" },
  robinhood: { name: "Robinhood", color: "#7b2ff7" },
  shopeefood: { name: "ShopeeFood", color: "#ee4d2d" },
  jdc: { name: "JDC Delivery", color: "#1d1b18" },
};

export const SOCIAL_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  line: "LINE",
  tiktok: "TikTok",
  youtube: "YouTube",
  website: "เว็บไซต์",
};
