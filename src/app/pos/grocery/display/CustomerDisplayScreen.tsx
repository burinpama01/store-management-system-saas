"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CUSTOMER_DISPLAY_CHANNEL,
  validateCustomerDisplayMessage,
  type CustomerDisplaySnapshot,
} from "@/modules/grocery-pos/customer-display";
import { QrCode } from "@/shared/components/ui/QrCode";

function money(value: number) {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 2,
  }).format(value);
}

export function CustomerDisplayScreen() {
  const [snapshot, setSnapshot] = useState<CustomerDisplaySnapshot | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (validateCustomerDisplayMessage(event.data)) {
        setSnapshot(event.data);
      }
    };
    return () => channel.close();
  }, []);

  const items = snapshot?.items ?? [];
  const payment = snapshot?.status === "checkout" ? snapshot.payment : undefined;
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
      <section className="customer-display-total" aria-live="polite">
        <p>{statusText}</p>
        <h1>{money(snapshot?.total ?? 0)}</h1>
        {snapshot?.customerName ? <span>{snapshot.customerName}</span> : null}
      </section>

      <section className="customer-display-list">
        {items.length === 0 ? <p className="customer-display-empty">ยังไม่มีสินค้า</p> : null}
        {items.map((item, index) => (
          <div className="customer-display-item" key={`${item.name}-${index}`}>
            <div>
              <strong>{item.name}</strong>
              {item.variantName ? <span>{item.variantName}</span> : null}
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
          display: grid;
          grid-template-rows: auto 1fr auto;
          padding: 32px;
          gap: 24px;
        }
        .customer-display-total {
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-xs);
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
        .customer-display-total span {
          display: inline-block;
          margin-top: 12px;
          color: var(--color-success);
          font-size: 22px;
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
        .customer-display-summary {
          display: flex;
          justify-content: space-between;
          gap: 16px;
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
        @media (max-width: 720px) {
          .customer-display {
            padding: 20px;
          }
          .customer-display-total h1 {
            font-size: 48px;
          }
          .customer-display-item {
            font-size: 20px;
            grid-template-columns: minmax(0, 1fr) auto;
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
