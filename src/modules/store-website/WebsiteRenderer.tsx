/* eslint-disable @next/next/no-img-element -- รูปจาก storage ของร้าน (ไม่ได้ตั้ง remotePatterns ให้ next/image) */
import type { CSSProperties } from "react";
import type { PosterElement, WebsiteBlock, WebsiteDocument, WebsiteTheme } from "./schema";
import { isBannerActive } from "./schema";
import { DELIVERY_APP_LABELS, SOCIAL_LABELS } from "./templates";
import type { WebsiteRenderData } from "./repository";
import type { FestivalView } from "./festivals";
import { FestivalOverlay } from "./FestivalOverlay";

/**
 * ตัวเรนเดอร์เว็บไซต์ร้าน — คอมโพเนนต์แสดงผลล้วน (ไม่ดึงข้อมูลเอง)
 * ใช้ทั้งหน้าเว็บสาธารณะ /s/[slug] และพรีวิวในหลังร้าน
 * ข้อความทั้งหมดเรนเดอร์เป็นข้อความธรรมดา (React escape ให้) — ไม่มี dangerouslySetInnerHTML
 */

const money = (value: number) => new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);

const FONT: Record<WebsiteTheme["font"], string> = {
  sans: '"IBM Plex Sans Thai", system-ui, sans-serif',
  rounded: '"Mitr", "IBM Plex Sans Thai", system-ui, sans-serif',
  serif: 'Georgia, "Noto Serif Thai", serif',
};
const RADIUS: Record<WebsiteTheme["radius"], string> = { sm: "6px", md: "12px", lg: "22px" };

function themeVars(theme: WebsiteTheme): CSSProperties {
  return {
    ["--w-primary" as string]: theme.primary,
    ["--w-accent" as string]: theme.accent,
    ["--w-bg" as string]: theme.background,
    ["--w-surface" as string]: theme.surface,
    ["--w-text" as string]: theme.text,
    ["--w-radius" as string]: RADIUS[theme.radius],
    background: theme.background,
    color: theme.text,
    fontFamily: FONT[theme.font],
  };
}

function linkHref(link: { kind: string; url?: string }, memberUrl: string | null): string | null {
  switch (link.kind) {
    case "menu":
      return "#menu";
    case "passes":
      return "#passes";
    case "member":
      return memberUrl;
    case "url":
      return link.url || null;
    default:
      return null;
  }
}

function Card({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: "var(--w-surface)", borderRadius: "var(--w-radius)", padding: 16, ...style }}>{children}</div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>{children}</h2>;
}

function Block({ block, theme, data, today }: { block: WebsiteBlock; theme: WebsiteTheme; data: WebsiteRenderData; today: string }) {
  switch (block.type) {
    case "hero":
      return (
        <header
          className={theme.style === "luxury" ? "w-lux-hero" : undefined}
          style={{
            position: "relative",
            overflow: "hidden",
            minHeight: 200,
            borderRadius: "0 0 var(--w-radius) var(--w-radius)",
            padding: "28px 20px",
            color: "#fff",
            background: block.imageUrl
              ? `linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.6)), url("${encodeURI(block.imageUrl)}") center/cover`
              : `linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.45)), linear-gradient(135deg, var(--w-primary), var(--w-accent))`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
          }}
        >
          {data.store.logoUrl && (
            <img src={data.store.logoUrl} alt="" width={56} height={56} style={{ width: 56, height: 56, borderRadius: 14, objectFit: "cover", marginBottom: 10, background: "#fff" }} />
          )}
          <h1 style={{ fontSize: 28, lineHeight: 1.2, fontWeight: 800, margin: 0 }}>{block.title || data.store.name}</h1>
          {block.subtitle && <p style={{ margin: "6px 0 0", opacity: 0.92 }}>{block.subtitle}</p>}
          {block.showOpenStatus && data.store.closingTime && (
            <span style={{ marginTop: 10, alignSelf: "flex-start", fontSize: 12, padding: "2px 10px", borderRadius: 99, background: "rgba(255,255,255,.22)" }}>
              ปิดร้าน {data.store.closingTime.slice(0, 5)} น.
            </span>
          )}
        </header>
      );
    case "banner": {
      if (!isBannerActive(block, today)) return null;
      const href = linkHref(block.link, data.memberUrl);
      // สัดส่วนคงที่ = รูปตามขนาดแนะนำโชว์ครบ · auto = สูงตามข้อความ (แบนเนอร์เก่าที่ยังไม่ตั้งค่า)
      const aspect = block.aspect ?? "auto";
      const hasText = Boolean(block.title || block.subtitle);
      const inner = (
        <div
          style={{
            borderRadius: "var(--w-radius)",
            overflow: "hidden",
            color: "#fff",
            ...(aspect === "auto" ? { minHeight: 120 } : { aspectRatio: aspect.replace(":", " / ") }),
            padding: hasText ? 16 : 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            backgroundColor: "var(--w-surface)",
            backgroundImage: block.imageUrl
              ? hasText
                ? `linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,.55)), ${cssUrl(block.imageUrl)}`
                : cssUrl(block.imageUrl)
              : "linear-gradient(180deg, rgba(0,0,0,0) 25%, rgba(0,0,0,.4)), linear-gradient(120deg, var(--w-accent), var(--w-primary))",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
          role={block.imageUrl && !hasText ? "img" : undefined}
          aria-label={block.imageUrl && !hasText ? "โปรโมชันของร้าน" : undefined}
        >
          {block.title && <p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{block.title}</p>}
          {block.subtitle && <p style={{ margin: "2px 0 0", fontSize: 14, opacity: 0.92 }}>{block.subtitle}</p>}
        </div>
      );
      return href ? (
        <a href={href} style={{ display: "block", textDecoration: "none" }} rel={block.link.kind === "url" ? "noopener noreferrer nofollow" : undefined}>
          {inner}
        </a>
      ) : (
        inner
      );
    }
    case "passes":
      if (data.passPlans.length === 0) return null;
      return (
        <section id="passes">
          <SectionTitle>{block.title}</SectionTitle>
          <div style={{ display: "grid", gap: 10 }}>
            {data.passPlans.map((plan) => (
              <Card key={plan.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 26 }} aria-hidden="true">🎟️</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ display: "block" }}>{plan.name}</b>
                  <span style={{ fontSize: 13, opacity: 0.75 }}>
                    {plan.credits} สิทธิ์ · ตกสิทธิ์ละ ฿{money(plan.price / plan.credits)}
                    {plan.validDays ? ` · ใช้ได้ ${plan.validDays} วัน` : ""}
                  </span>
                </span>
                <b style={{ color: "var(--w-primary)", fontSize: 18 }}>฿{money(plan.price)}</b>
              </Card>
            ))}
          </div>
          {data.memberUrl && (
            <a href={data.memberUrl} style={{ display: "block", marginTop: 10, textAlign: "center", padding: 12, borderRadius: "var(--w-radius)", background: "var(--w-primary)", color: "#fff", fontWeight: 700, textDecoration: "none" }}>
              ซื้อแพ็กออนไลน์ (เข้าสู่ระบบสมาชิก)
            </a>
          )}
        </section>
      );
    case "menu": {
      const products =
        block.mode === "featured" && block.productIds.length > 0
          ? block.productIds.map((id) => data.products.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => Boolean(p))
          : block.mode === "featured"
            ? data.products.slice(0, 8)
            : data.products;
      if (products.length === 0) return null;
      return (
        <section id="menu">
          <SectionTitle>{block.title}</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
            {products.map((p) => (
              <Card key={p.id} style={{ padding: 0, overflow: "hidden" }}>
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt={p.name} loading="lazy" style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", display: "block" }} />
                ) : (
                  <div style={{ aspectRatio: "4 / 3", background: "linear-gradient(135deg, var(--w-accent), var(--w-primary))", opacity: 0.25 }} />
                )}
                <div style={{ padding: "8px 10px" }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{p.name}</p>
                  {block.showPrices && <p style={{ margin: 0, color: "var(--w-primary)", fontWeight: 700 }}>฿{money(p.price)}</p>}
                </div>
              </Card>
            ))}
          </div>
          {data.orderUrl && (
            <a href={data.orderUrl} style={{ display: "block", marginTop: 12, textAlign: "center", padding: 12, borderRadius: "var(--w-radius)", background: "var(--w-primary)", color: "#fff", fontWeight: 700, textDecoration: "none" }}>
              สั่งออนไลน์ · รับที่ร้าน / ส่งถึงบ้าน
            </a>
          )}
        </section>
      );
    }
    case "member":
      if (!data.memberUrl) return null;
      return (
        <Card style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 28 }} aria-hidden="true">⭐</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b style={{ display: "block" }}>{block.title}</b>
            <span style={{ fontSize: 13, opacity: 0.75 }}>{block.description}</span>
          </span>
          <a href={data.memberUrl} style={{ padding: "8px 14px", borderRadius: "var(--w-radius)", background: "var(--w-primary)", color: "#fff", fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>
            เข้าสู่ระบบ
          </a>
        </Card>
      );
    case "info": {
      const lines: string[] = [];
      if (block.showAddress && data.store.address) lines.push(`📍 ${data.store.address}`);
      if (block.hoursText) lines.push(`🕘 ${block.hoursText}`);
      const phone = block.showPhone && data.store.phone ? data.store.phone : null;
      if (lines.length === 0 && !phone && !block.mapUrl) return null;
      return (
        <Card>
          {lines.map((line) => (
            <p key={line} style={{ margin: "0 0 6px", whiteSpace: "pre-line" }}>{line}</p>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            {phone && (
              <a href={`tel:${phone.replace(/[^0-9+]/g, "")}`} style={{ padding: "8px 14px", borderRadius: "var(--w-radius)", border: "1px solid var(--w-primary)", color: "var(--w-primary)", textDecoration: "none", fontWeight: 600 }}>
                📞 โทร
              </a>
            )}
            {block.mapUrl && (
              <a href={block.mapUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ padding: "8px 14px", borderRadius: "var(--w-radius)", background: "var(--w-primary)", color: "#fff", textDecoration: "none", fontWeight: 600 }}>
                🗺️ นำทาง
              </a>
            )}
          </div>
        </Card>
      );
    }
    case "social":
      if (block.links.length === 0) return null;
      return (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {block.links.map((link) => (
            <a key={`${link.platform}-${link.url}`} href={link.url} target="_blank" rel="noopener noreferrer nofollow" style={{ padding: "8px 14px", borderRadius: 99, background: "var(--w-surface)", color: "var(--w-text)", textDecoration: "none", fontSize: 14, fontWeight: 600 }}>
              {SOCIAL_LABELS[link.platform] ?? link.platform}
            </a>
          ))}
        </div>
      );
    case "delivery_apps":
      if (block.apps.length === 0) return null;
      return (
        <section>
          <SectionTitle>{block.title}</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
            {block.apps.map((entry) => {
              const meta = DELIVERY_APP_LABELS[entry.app];
              return (
                <a key={entry.app} href={entry.url} target="_blank" rel="noopener noreferrer nofollow" style={{ padding: 12, borderRadius: "var(--w-radius)", background: meta?.color ?? "#333", color: "#fff", textAlign: "center", fontWeight: 700, textDecoration: "none" }}>
                  {meta?.name ?? entry.app}
                </a>
              );
            })}
          </div>
        </section>
      );
    case "text":
      if (!block.title && !block.body) return null;
      return (
        <Card>
          {block.title && <SectionTitle>{block.title}</SectionTitle>}
          {block.body && <p style={{ margin: 0, whiteSpace: "pre-line" }}>{block.body}</p>}
        </Card>
      );
    case "poster":
      return <PosterView block={block} />;
    case "showcase3d":
      return <Showcase3D block={block} data={data} />;
  }
}

const SHOWCASE_CARD_W = 120;

/**
 * โชว์เมนูแบบ 3D (S4) — วงล้อการ์ดหมุนด้วย CSS 3D ล้วน (ไม่โหลด WebGL/three.js)
 * เบาบนมือถือสเปกต่ำ ไม่ต้องรัน JS · แตะ/ชี้ค้างเพื่อหยุดหมุน · ตั้งลดการเคลื่อนไหว = แสดงเป็นแถวปกติ
 */
function Showcase3D({ block, data }: { block: Extract<WebsiteBlock, { type: "showcase3d" }>; data: WebsiteRenderData }) {
  const picked =
    block.productIds.length > 0
      ? block.productIds.map((id) => data.products.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => Boolean(p))
      : data.products.filter((p) => p.imageUrl).slice(0, 8);
  if (picked.length === 0) return null;
  const n = picked.length;
  // รัศมีวงล้อให้การ์ดเรียงชิดกันพอดี (+ช่องไฟ 14px)
  const radius = n >= 3 ? Math.round(SHOWCASE_CARD_W / 2 / Math.tan(Math.PI / n) + 14) : 0;
  const card = (p: (typeof picked)[number]) => (
    <>
      {p.imageUrl ? (
        <img src={p.imageUrl} alt="" loading="lazy" draggable={false} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }} />
      ) : (
        <div style={{ aspectRatio: "1 / 1", background: "linear-gradient(135deg, var(--w-accent), var(--w-primary))" }} />
      )}
      <div style={{ padding: "6px 8px" }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</p>
        {block.showPrices && <p style={{ margin: 0, fontSize: 13, color: "var(--w-primary)", fontWeight: 700 }}>฿{money(p.price)}</p>}
      </div>
    </>
  );
  const cardStyle: CSSProperties = { background: "var(--w-surface)", borderRadius: "var(--w-radius)", overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,.18)" };
  return (
    <section>
      {block.title && <SectionTitle>{block.title}</SectionTitle>}
      {n >= 3 && (
        <div className="w3d-stage" role="img" aria-label={picked.map((p) => p.name).join(" · ")}>
          <div className="w3d-ring" style={{ ["--w3d-r" as string]: `-${radius}px`, animationDuration: `${Math.max(14, n * 3)}s` }}>
            {picked.map((p, i) => (
              <div key={p.id} className="w3d-card" style={{ ...cardStyle, transform: `rotateY(${(360 / n) * i}deg) translateZ(${radius}px)` }}>
                {card(p)}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={n >= 3 ? "w3d-flat" : undefined} style={{ display: n >= 3 ? undefined : "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${SHOWCASE_CARD_W}px, 1fr))`, gap: 10 }}>
        {picked.map((p) => (
          <div key={p.id} style={cardStyle}>{card(p)}</div>
        ))}
      </div>
    </section>
  );
}

const ASPECT_RATIO: Record<string, string> = { "1:1": "1 / 1", "4:5": "4 / 5", "16:9": "16 / 9" };

/** url(...) ใน CSS: encodeURI แล้วหนีวงเล็บ/เครื่องหมายคำพูดด้วย (ลิงก์ผ่าน safeUrl แล้ว) */
export function cssUrl(url: string): string {
  return `url("${encodeURI(url).replace(/[()'"]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}")`;
}

/** ชิ้นงานหนึ่งชิ้นบนโปสเตอร์ — ตำแหน่ง/ขนาดเป็น % จึงย่อขยายตามจอได้ (ใช้ร่วมกับตัวแก้ในหลังร้าน) */
export function PosterElementView({ element }: { element: PosterElement }) {
  const box: CSSProperties = {
    position: "absolute",
    left: `${element.x}%`,
    top: `${element.y}%`,
    width: `${element.w}%`,
    transform: `translate(-50%, -50%) rotate(${element.rotate}deg)`,
    pointerEvents: "none",
  };
  if (element.kind === "image") {
    if (!element.imageUrl) return null;
    return <img src={element.imageUrl} alt="" draggable={false} style={{ ...box, display: "block", height: "auto", borderRadius: 6 }} />;
  }
  if (element.kind === "sticker") {
    // ขนาดสติกเกอร์ = ความกว้างชิ้นงาน (หน่วย cqw = % ของกว้างโปสเตอร์)
    return <span style={{ ...box, fontSize: `${element.w * 0.8}cqw`, lineHeight: 1, textAlign: "center" }}>{element.sticker ?? "⭐"}</span>;
  }
  return (
    <span
      style={{
        ...box,
        fontSize: `${element.size ?? 6}cqw`,
        color: element.color ?? "#1f2328",
        fontWeight: element.bold ? 800 : 500,
        textAlign: element.align ?? "center",
        lineHeight: 1.2,
        whiteSpace: "pre-line",
        overflowWrap: "anywhere",
      }}
    >
      {element.text ?? ""}
    </span>
  );
}

export function PosterView({ block }: { block: Extract<WebsiteBlock, { type: "poster" }> }) {
  return (
    <div
      role="img"
      aria-label={block.elements.filter((e) => e.kind === "text" && e.text).map((e) => e.text).join(" · ") || "โปสเตอร์ของร้าน"}
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: ASPECT_RATIO[block.aspect] ?? "4 / 5",
        containerType: "inline-size",
        overflow: "hidden",
        borderRadius: "var(--w-radius)",
        backgroundColor: block.background,
        backgroundImage: block.backgroundImageUrl ? cssUrl(block.backgroundImageUrl) : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {block.elements.map((element) => (
        <PosterElementView key={element.id} element={element} />
      ))}
    </div>
  );
}

export function WebsiteRenderer({
  document,
  data,
  today,
  festival = null,
  editorMode = false,
}: {
  document: WebsiteDocument;
  data: WebsiteRenderData;
  today: string;
  /** พรีวิวในหลังร้าน: ใส่ data-block-id ให้แตะบล็อกเพื่อแก้ (หน้าสาธารณะไม่ใส่) */
  editorMode?: boolean;
  /** ชั้นตกแต่งเทศกาล (S1) — null = ไม่มี */
  festival?: FestivalView | null;
}) {
  const visible = document.blocks.filter((block) => !block.hidden);
  return (
    <div style={{ ...themeVars(document.theme), minHeight: "100%", position: "relative" }} data-website-style={document.theme.style} data-festival={festival?.key}>
      {festival && <FestivalOverlay festival={festival} />}
      <style>{`
        .w-lux-hero::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,230,170,.22),transparent);animation:wshine 4s ease-in-out infinite}
        @keyframes wshine{to{left:130%}}
        @media (prefers-reduced-motion: reduce){.w-lux-hero::after{animation:none;display:none}}
        .w3d-stage{position:relative;height:250px;perspective:900px;overflow:hidden;touch-action:pan-y}
        .w3d-ring{position:absolute;left:50%;top:24px;width:${SHOWCASE_CARD_W}px;margin-left:-${SHOWCASE_CARD_W / 2}px;transform-style:preserve-3d;transform:translateZ(var(--w3d-r)) rotateY(0deg);animation:w3dspin 24s linear infinite}
        .w3d-card{position:absolute;inset:0 0 auto 0}
        .w3d-stage:hover .w3d-ring,.w3d-stage:active .w3d-ring{animation-play-state:paused}
        @keyframes w3dspin{to{transform:translateZ(var(--w3d-r)) rotateY(-360deg)}}
        .w3d-flat{display:none}
        @media (prefers-reduced-motion: reduce){.w3d-stage{display:none}.w3d-flat{display:grid}}
      `}</style>
      <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 32 }}>
        {visible.map((block, index) => (
          <div key={block.id} data-block-id={editorMode ? block.id : undefined} style={block.type === "hero" && index === 0 ? undefined : { padding: "14px 16px 0" }}>
            <Block block={block} theme={document.theme} data={data} today={today} />
          </div>
        ))}
        <p style={{ textAlign: "center", fontSize: 12, opacity: 0.5, marginTop: 28 }}>เว็บไซต์ร้านโดย StoreOS</p>
      </div>
    </div>
  );
}
