"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useState } from "react";
import {
  CUSTOMER_DISPLAY_CHANNEL,
  validateCustomerDisplayMessage,
  type CustomerDisplaySnapshot,
} from "@/modules/grocery-pos/customer-display";
import {
  DEFAULT_CUSTOMER_DISPLAY_SETTINGS,
  type CustomerDisplayAdSlide,
  type CustomerDisplaySettings,
} from "@/modules/settings/customer-display";
import { QrCode } from "@/shared/components/ui/QrCode";

function money(value: number) {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 2,
  }).format(value);
}

function points(value: number) {
  return new Intl.NumberFormat("th-TH", {
    maximumFractionDigits: 0,
  }).format(value);
}

interface AdSlotView {
  key: string;
  label: string;
  slides: CustomerDisplayAdSlide[];
}

function resolveAdSlots(settings: CustomerDisplaySettings): AdSlotView[] {
  if (!settings.adEnabled) return [];
  const slides = [
    ...(settings.topSlotEnabled ? settings.topSlides : []),
    ...(settings.bottomSlotEnabled ? settings.bottomSlides : []),
  ];
  if (!settings.topSlotEnabled && !settings.bottomSlotEnabled) return [];
  if (slides.length === 0) return [];
  if (settings.adLayout === "split") {
    return [
      settings.topSlotEnabled ? { key: "top", label: "ช่องบน", slides: settings.topSlides } : null,
      settings.bottomSlotEnabled ? { key: "bottom", label: "ช่องล่าง", slides: settings.bottomSlides } : null,
    ].filter((slot): slot is AdSlotView => slot !== null && slot.slides.length > 0);
  }
  return [{ key: "single", label: "โปรโมชัน", slides }];
}

function currentSlide(slot: AdSlotView, indexes: Record<string, number>) {
  if (slot.slides.length === 0) return undefined;
  return slot.slides[indexes[slot.key] % slot.slides.length] ?? slot.slides[0];
}

function CustomerDisplayAdSlot({ slide, slotLabel }: { slide?: CustomerDisplayAdSlide; slotLabel: string }) {
  if (!slide) {
    return (
      <div className="customer-display-ad-slot">
        <div className="customer-display-ad-content">
          <span>โปรโมชันวันนี้</span>
          <strong>สมัครสมาชิก รับแต้มทุกบิล</strong>
          <p>สแกน QR หน้าร้านเพื่อสะสมแต้มและรับคูปองพิเศษ</p>
        </div>
      </div>
    );
  }

  return (
    <div className="customer-display-ad-slot">
      {slide.mediaType === "video" ? (
        <video
          className={`customer-display-ad-media customer-display-ad-media--${slide.fit}`}
          src={slide.url}
          autoPlay
          muted
          loop
          playsInline
        />
      ) : (
        <img
          className={`customer-display-ad-media customer-display-ad-media--${slide.fit}`}
          src={slide.url}
          alt={slide.title || slotLabel}
        />
      )}
      {(slide.title || slide.description) ? (
        <div className="customer-display-ad-content customer-display-ad-content--overlay">
          {slide.title ? <strong>{slide.title}</strong> : null}
          {slide.description ? <p>{slide.description}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function CustomerDisplayScreen({ adSettings }: { adSettings?: CustomerDisplaySettings | null }) {
  const [snapshot, setSnapshot] = useState<CustomerDisplaySnapshot | null>(null);
  const [slideIndexes, setSlideIndexes] = useState<Record<string, number>>({});
  const effectiveAdSettings = adSettings ?? DEFAULT_CUSTOMER_DISPLAY_SETTINGS;
  const adSlots = useMemo(() => resolveAdSlots(effectiveAdSettings), [effectiveAdSettings]);
  const showAdPanel = adSlots.length > 0;

  useEffect(() => {
    const channel = new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (validateCustomerDisplayMessage(event.data)) {
        setSnapshot(event.data);
      }
    };
    return () => channel.close();
  }, []);

  useEffect(() => {
    if (adSlots.every((slot) => slot.slides.length <= 1)) return;
    const timer = window.setInterval(() => {
      setSlideIndexes((current) => {
        const next = { ...current };
        for (const slot of adSlots) {
          if (slot.slides.length > 1) next[slot.key] = ((current[slot.key] ?? 0) + 1) % slot.slides.length;
        }
        return next;
      });
    }, effectiveAdSettings.slideIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [adSlots, effectiveAdSettings.slideIntervalSeconds]);

  const items = snapshot?.items ?? [];
  const payment = snapshot?.status === "checkout" ? snapshot.payment : undefined;
  const customer = snapshot?.customer ?? (snapshot?.customerName ? { name: snapshot.customerName } : undefined);
  const hasCustomerPoints = customer?.pointsEarned !== undefined || customer?.pointsBalance !== undefined;
  const statusText = useMemo(() => {
    switch (snapshot?.status) {
      case "checkout":
        return "ตรวจสอบยอดชำระ";
      case "paid":
        return "ชำระเงินแล้ว";
      case "scanning":
        return "กำลังสแกนสินค้า";
      default:
        return "พร้อมรับรายการ";
    }
  }, [snapshot?.status]);

  return (
    <main className="customer-display">
      <section className={`customer-display-layout ${showAdPanel ? "" : "customer-display-layout--no-ad"}`}>
        <div className="customer-display-main">
          <section className="customer-display-total" aria-live="polite">
            <div>
              <p>{statusText}</p>
              <h1>{money(snapshot?.total ?? 0)}</h1>
            </div>
            {customer ? (
              <aside className="customer-display-customer" aria-label="ข้อมูลลูกค้า">
                <span>ลูกค้า</span>
                {customer.name ? <strong>{customer.name}</strong> : null}
                {hasCustomerPoints ? (
                  <div className="customer-display-points">
                    {customer.pointsEarned !== undefined ? <b>ได้รับ +{points(customer.pointsEarned)}</b> : null}
                    {customer.pointsBalance !== undefined ? <b>คงเหลือ {points(customer.pointsBalance)}</b> : null}
                  </div>
                ) : null}
              </aside>
            ) : null}
          </section>

          <section className="customer-display-list">
            {items.length === 0 ? <p className="customer-display-empty">ยังไม่มีสินค้า</p> : null}
            {items.map((item, index) => (
              <div className="customer-display-item" key={`${item.name}-${index}`}>
                <div>
                  <strong>{item.name}</strong>
                  {item.variantName ? <span>{item.variantName}</span> : null}
                  {item.options.length > 0 ? (
                    <ul className="customer-display-options" aria-label="ตัวเลือกสินค้า">
                      {item.options.map((option) => (
                        <li key={option}>{option}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <b>x{item.quantity}</b>
                <span>{money(item.totalPrice)}</span>
              </div>
            ))}
          </section>

          <footer className="customer-display-summary">
            <span>ยอดสินค้า {money(snapshot?.subtotal ?? 0)}</span>
            <span>ส่วนลด {money(snapshot?.discount ?? 0)}</span>
          </footer>
        </div>

        {showAdPanel ? (
          <aside
            className={`customer-display-ad-panel ${
              effectiveAdSettings.adLayout === "split" ? "customer-display-ad-split" : ""
            }`}
            aria-label="โฆษณา"
          >
            {adSlots.map((slot) => (
              <CustomerDisplayAdSlot key={slot.key} slide={currentSlide(slot, slideIndexes)} slotLabel={slot.label} />
            ))}
          </aside>
        ) : null}
      </section>

      {payment ? (
        <section className="customer-display-qr-layer" aria-label="QR พร้อมเพย์ล็อกยอด" role="dialog">
          <div className="customer-display-qr-dialog">
            <p className="customer-display-qr-kicker">QR พร้อมเพย์ล็อกยอด</p>
            <QrCode value={payment.promptPayPayload} size={280} />
            <div>
              <span>ยอดที่ต้องจ่าย</span>
              <strong>{money(payment.amount)}</strong>
            </div>
          </div>
        </section>
      ) : null}

      <style jsx>{`
        .customer-display {
          min-height: 100vh;
          background: var(--color-bg);
          color: var(--color-text-primary);
          padding: 24px;
        }
        .customer-display-layout {
          min-height: calc(100vh - 48px);
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(280px, 32vw);
          gap: 24px;
        }
        .customer-display-layout--no-ad {
          grid-template-columns: 1fr;
        }
        .customer-display-main {
          min-height: 0;
          display: grid;
          grid-template-rows: auto 1fr auto;
          gap: 24px;
        }
        .customer-display-total {
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-xs);
          display: flex;
          justify-content: space-between;
          gap: 20px;
          padding: 24px;
        }
        .customer-display-total p,
        .customer-display-total h1 {
          margin: 0;
        }
        .customer-display-total p {
          color: var(--color-brand);
          font-weight: 800;
          font-size: 22px;
        }
        .customer-display-total h1 {
          font-size: 72px;
          line-height: 1;
          margin-top: 10px;
        }
        .customer-display-customer {
          min-width: min(260px, 38%);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg);
          padding: 16px;
          text-align: right;
        }
        .customer-display-customer span {
          display: block;
          color: var(--color-text-secondary);
          font-size: 14px;
          font-weight: 700;
        }
        .customer-display-customer strong {
          display: block;
          margin-top: 4px;
          color: var(--color-success);
          font-size: 22px;
          overflow-wrap: anywhere;
        }
        .customer-display-customer small {
          display: block;
          margin-top: 2px;
          color: var(--color-text-secondary);
        }
        .customer-display-points {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 12px;
        }
        .customer-display-points b {
          border: 1px solid var(--color-border);
          border-radius: 999px;
          background: var(--color-surface);
          color: var(--color-text-primary);
          font-size: 16px;
          padding: 5px 10px;
        }
        .customer-display-list {
          display: grid;
          align-content: start;
          gap: 14px;
          overflow: auto;
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-xs);
          padding: 20px;
        }
        .customer-display-item {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
          gap: 18px;
          align-items: center;
          border-bottom: 1px solid var(--color-border);
          padding-bottom: 14px;
          font-size: 24px;
        }
        .customer-display-item strong {
          display: block;
          overflow-wrap: anywhere;
        }
        .customer-display-item span,
        .customer-display-empty,
        .customer-display-summary {
          color: var(--color-text-secondary);
        }
        .customer-display-item div span {
          display: block;
          font-size: 18px;
          margin-top: 2px;
        }
        .customer-display-options {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          list-style: none;
          margin: 10px 0 0;
          padding: 0;
        }
        .customer-display-options li {
          border: 1px solid var(--color-border);
          border-radius: 999px;
          background: var(--color-bg);
          color: var(--color-text-secondary);
          font-size: 15px;
          line-height: 1.2;
          padding: 5px 9px;
        }
        .customer-display-summary {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          font-size: 20px;
        }
        .customer-display-ad-panel {
          position: relative;
          overflow: hidden;
          display: grid;
          align-content: stretch;
          gap: 12px;
          min-height: 100%;
          border: 1px solid color-mix(in srgb, var(--color-brand) 40%, var(--color-border));
          border-radius: var(--radius-lg);
          background:
            linear-gradient(155deg, color-mix(in srgb, var(--color-brand) 72%, #0f172a) 0%, #1f2937 58%, #111827 100%);
          box-shadow: var(--shadow-xs);
          color: #ffffff;
          padding: 12px;
        }
        .customer-display-ad-split {
          grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
        }
        .customer-display-ad-slot {
          position: relative;
          display: grid;
          align-content: end;
          min-height: 0;
          overflow: hidden;
          border-radius: calc(var(--radius-lg) - 6px);
          background:
            linear-gradient(155deg, color-mix(in srgb, var(--color-brand) 72%, #0f172a) 0%, #1f2937 58%, #111827 100%);
          padding: 24px;
        }
        .customer-display-ad-slot::before {
          content: "";
          position: absolute;
          inset: 18px 18px auto auto;
          width: 90px;
          aspect-ratio: 1;
          border: 1px solid color-mix(in srgb, #ffffff 35%, transparent);
          border-radius: 50%;
        }
        .customer-display-ad-media {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          background: #111827;
        }
        .customer-display-ad-media--cover {
          object-fit: cover;
        }
        .customer-display-ad-media--contain {
          object-fit: contain;
        }
        .customer-display-ad-content {
          position: relative;
          z-index: 1;
          display: grid;
          gap: 12px;
        }
        .customer-display-ad-content--overlay {
          border-radius: var(--radius-md);
          background: color-mix(in srgb, #000000 42%, transparent);
          padding: 14px;
          backdrop-filter: blur(4px);
        }
        .customer-display-ad-content span {
          color: color-mix(in srgb, #ffffff 78%, var(--color-brand));
          font-size: 18px;
          font-weight: 800;
        }
        .customer-display-ad-content strong {
          max-width: 12ch;
          font-size: 44px;
          line-height: 1.05;
        }
        .customer-display-ad-content p {
          max-width: 28ch;
          margin: 0;
          color: color-mix(in srgb, #ffffff 82%, var(--color-brand));
          font-size: 20px;
        }
        .customer-display-qr-layer {
          position: fixed;
          inset: 0;
          z-index: 20;
          display: grid;
          place-items: center;
          background: color-mix(in srgb, var(--color-bg) 74%, transparent);
          padding: 28px;
        }
        .customer-display-qr-dialog {
          display: grid;
          justify-items: center;
          gap: 18px;
          width: min(420px, 100%);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          background: var(--color-surface);
          box-shadow: var(--shadow-lg);
          padding: 28px;
          text-align: center;
        }
        .customer-display-qr-kicker {
          margin: 0;
          color: var(--color-brand);
          font-size: 22px;
          font-weight: 800;
        }
        .customer-display-qr-dialog span {
          display: block;
          color: var(--color-text-secondary);
          font-size: 18px;
        }
        .customer-display-qr-dialog strong {
          display: block;
          margin-top: 4px;
          color: var(--color-text-primary);
          font-size: 48px;
          line-height: 1;
        }
        @media (max-width: 960px) {
          .customer-display-layout {
            grid-template-columns: 1fr;
          }
          .customer-display-ad-panel {
            min-height: 260px;
          }
          .customer-display-ad-content strong {
            max-width: 18ch;
            font-size: 36px;
          }
        }
        @media (max-width: 720px) {
          .customer-display {
            padding: 20px;
          }
          .customer-display-layout {
            min-height: calc(100vh - 40px);
          }
          .customer-display-total {
            display: grid;
          }
          .customer-display-total h1 {
            font-size: 48px;
          }
          .customer-display-customer {
            min-width: 0;
            text-align: left;
          }
          .customer-display-points {
            justify-content: flex-start;
          }
          .customer-display-item {
            font-size: 20px;
            grid-template-columns: minmax(0, 1fr) auto;
          }
          .customer-display-item > span {
            grid-column: 1 / -1;
            justify-self: end;
          }
          .customer-display-ad-panel {
            padding: 10px;
          }
          .customer-display-ad-slot {
            padding: 18px;
          }
          .customer-display-qr-dialog {
            padding: 22px;
          }
          .customer-display-qr-dialog strong {
            font-size: 38px;
          }
        }
      `}</style>
    </main>
  );
}
