import type { Metadata } from "next";
import { cache } from "react";
import { getPublishedWebsite as loadPublishedWebsite } from "@/modules/store-website/repository";
import { WebsiteRenderer } from "@/modules/store-website/WebsiteRenderer";

/**
 * เว็บไซต์ร้านสาธารณะ — แคช ISR 5 นาที + สร้างใหม่ทันทีเมื่อร้านกดเผยแพร่ (revalidatePath)
 * ไม่อ่าน cookie/session เพื่อให้แคชได้ (บทเรียนโควตา Vercel/Supabase) ข้อมูลเฉพาะคนอยู่หน้าสมาชิกเดิม
 */
export const revalidate = 300;

// metadata กับหน้าใช้ข้อมูลชุดเดียวกัน — ดึงครั้งเดียวต่อการสร้างหน้า (ไม่ยิงฐานข้อมูลซ้ำ 2 รอบ)
const getPublishedWebsite = cache(loadPublishedWebsite);

function bangkokToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const site = await getPublishedWebsite(slug);
  if (!site) return { title: "ร้านยังไม่เปิดเว็บไซต์", robots: { index: false } };
  const hero = site.document.blocks.find((block) => block.type === "hero" && !block.hidden);
  const title = site.data.store.name;
  const description =
    (hero && hero.type === "hero" && hero.subtitle) || `เมนู โปรโมชัน สมาชิก และแพ็กของ ${site.data.store.name}`;
  const image = (hero && hero.type === "hero" && hero.imageUrl) || site.data.store.logoUrl || undefined;
  return {
    title,
    description,
    alternates: { canonical: `/s/${slug}` },
    openGraph: { title, description, type: "website", images: image ? [{ url: image }] : undefined },
    twitter: { card: image ? "summary_large_image" : "summary", title, description, images: image ? [image] : undefined },
  };
}

export default async function StoreWebsitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = slug.length <= 40 ? await getPublishedWebsite(slug) : null;
  if (!site) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "#f7f5f1", color: "#1d1b18", fontFamily: "system-ui, sans-serif" }}>
        <div>
          <p style={{ fontSize: 40, margin: 0 }} aria-hidden="true">🏪</p>
          <h1 style={{ fontSize: 20 }}>ร้านนี้ยังไม่เปิดเว็บไซต์</h1>
          <p style={{ color: "#6b665d" }}>ลองติดต่อร้านผ่านช่องทางอื่น หรือกลับมาใหม่ภายหลัง</p>
        </div>
      </main>
    );
  }
  return (
    <main style={{ minHeight: "100vh", background: site.document.theme.background }}>
      <WebsiteRenderer document={site.document} data={site.data} today={bangkokToday()} />
    </main>
  );
}
