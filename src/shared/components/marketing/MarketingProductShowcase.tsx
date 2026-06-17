type ShowcaseVariant = "hero" | "pricing" | "login";

const PRODUCT_IMAGE: Record<ShowcaseVariant, { src: string; width: number; height: number }> = {
  hero: { src: "/marketing/storeos-pos-hero-light.png", width: 1280, height: 768 },
  pricing: { src: "/marketing/storeos-pos-hero-light.png", width: 1280, height: 768 },
  login: { src: "/marketing/storeos-pos-hero-dark.png", width: 1280, height: 768 },
};

const GLASS_CARDS = [
  { className: "is-pos", title: "POS", detail: "สั่งขาย - ชำระเงิน" },
  { className: "is-stock", title: "สต็อกสินค้า", detail: "คงเหลือ 128 ชิ้น" },
  { className: "is-qr", title: "โต๊ะ 12", detail: "สั่งอาหาร" },
  { className: "is-report", title: "รายงานขาย", detail: "วันนี้ 24,560 บาท" },
];

const TIME_CARD = { className: "is-time", title: "ลงเวลา", detail: "เข้า-ออกงาน" };

// Login keeps three cards positioned by `.reference-auth-showcase`: POS, ลงเวลา, รายงานขาย.
const LOGIN_GLASS_CARDS = [GLASS_CARDS[0], TIME_CARD, GLASS_CARDS[3]];

export function MarketingProductShowcase({
  variant = "hero",
  className = "",
}: Readonly<{
  variant?: ShowcaseVariant;
  className?: string;
}>) {
  const isLogin = variant === "login";
  const image = PRODUCT_IMAGE[variant];

  return (
    <div className={`marketing-product-showcase ${isLogin ? "is-dark" : ""} ${className}`} aria-hidden="true">
      <div className="marketing-product-bg">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative full-bleed hero render, sized via CSS */}
        <img
          className="marketing-product-image"
          src={image.src}
          width={image.width}
          height={image.height}
          alt=""
          loading="eager"
          decoding="async"
          draggable={false}
        />
      </div>
      <div className="marketing-product-glow" aria-hidden="true" />
      {(isLogin ? LOGIN_GLASS_CARDS : GLASS_CARDS).map((card) => (
        <span key={card.title} className={`marketing-glass-card ${card.className}`}>
          <i className={`marketing-card-icon ${card.className}`} aria-hidden="true" />
          <strong>{card.title}</strong>
          <small>{card.detail}</small>
        </span>
      ))}
    </div>
  );
}
