"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";
import type { Category, Product } from "@/modules/catalog/types";
import type { CustomerProfile } from "@/modules/customers/types";
import type { Cart, Order } from "@/modules/pos/types";
import type { Printer, ReceiptSettings } from "@/modules/stores/types";
import { emptyCart, updateQuantity, removeFromCart } from "@/modules/pos/cart";
import { addBarcodeMatchToGroceryCart } from "@/modules/grocery-pos/cart-adapter";
import {
  publishCustomerDisplaySnapshot,
  resolveCustomerDisplayPublishCart,
  type CustomerDisplayCustomer,
} from "@/modules/grocery-pos/customer-display";
import {
  buildGroceryCatalogVersion,
  buildGroceryOfflineOrderOperation,
  enqueueGroceryOfflineOrder,
  getGroceryOfflineSyncState,
  installGroceryPosOfflineSync,
  isGroceryOfflineSupported,
  resolveGroceryPosDeviceId,
  type GroceryOfflineOrderOperation,
  type GroceryOfflineSyncState,
} from "@/modules/grocery-pos/offline-sync";
import { applyScannerKey, type ScannerBufferState } from "@/modules/grocery-pos/scanner";
import {
  closeGroceryOrderPaymentAction,
  createGroceryOrderAction,
  evaluateGroceryCouponAction,
  lookupGroceryBarcodeAction,
  searchGroceryCustomersAction,
  voidGroceryOrderAction,
} from "./actions";
import type { Json } from "@/server/integrations/supabase/database.types";

interface GroceryPosTerminalProps {
  storeId: string;
  storeName: string;
  categories: Category[];
  products: Product[];
  receiptSettings: ReceiptSettings | null;
  currency: string;
  printers: Printer[];
  printerLoadError: string | null;
  offlineEnabled: boolean;
  offlineUnavailableMessage: string | null;
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function buildCouponPreviewCart(cart: Cart, couponDiscount: number): Cart {
  if (couponDiscount <= 0) return cart;
  const discount = roundMoney(cart.discount + couponDiscount);
  return {
    ...cart,
    discount,
    discountNote: cart.discountNote ? `${cart.discountNote}; Coupon` : "Coupon",
    total: roundMoney(Math.max(0, cart.subtotal - discount)),
  };
}

function findLocalBarcodeMatch(products: Product[], barcode: string) {
  const normalized = barcode.trim().toLowerCase();
  for (const product of products) {
    if (product.barcode?.toLowerCase() === normalized) return { product, variant: null, barcode };
    for (const variant of product.variants) {
      if (variant.barcode?.toLowerCase() === normalized || variant.sku?.toLowerCase() === normalized) {
        return { product, variant, barcode };
      }
    }
  }
  return null;
}

function defaultOfflineSyncState(): GroceryOfflineSyncState {
  return {
    supported: false,
    online: true,
    pendingOperations: 0,
    failedOperations: 0,
    lastSyncedAt: null,
    lastError: null,
  };
}

function isLikelyNetworkError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /network|fetch|offline|load failed|failed to fetch/i.test(message);
}

export function GroceryPosTerminal({
  storeId,
  storeName,
  categories,
  products,
  receiptSettings,
  currency,
  printers,
  printerLoadError,
  offlineEnabled,
  offlineUnavailableMessage,
}: GroceryPosTerminalProps) {
  const [cart, setCart] = useState<Cart>(() => emptyCart(storeId));
  const [scanValue, setScanValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerProfile[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerProfile | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<{
    couponId: string | null;
    code: string;
    discount: number;
  } | null>(null);
  const [checkoutOrder, setCheckoutOrder] = useState<Order | null>(null);
  const [cashReceived, setCashReceived] = useState("");
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [offlineSyncState, setOfflineSyncState] = useState<GroceryOfflineSyncState>(() => defaultOfflineSyncState());
  const [isPending, startTransition] = useTransition();
  const scannerState = useRef<ScannerBufferState>({ value: "", updatedAtMs: 0 });
  const paidDisplayCartRef = useRef<Cart | null>(null);
  const paidCustomerNameRef = useRef<string | undefined>(undefined);
  const paidCustomerRef = useRef<CustomerDisplayCustomer | null>(null);

  const productCount = products.length;
  const categoryCount = categories.length;
  const defaultPrinter = printers.find((printer) => printer.isDefault) ?? printers[0] ?? null;

  const visibleProducts = useMemo(() => products.slice(0, 18), [products]);
  const catalogVersion = useMemo(() => buildGroceryCatalogVersion({ products }), [products]);
  const displayCart = useMemo(
    () => buildCouponPreviewCart(cart, appliedCoupon?.discount ?? 0),
    [appliedCoupon?.discount, cart],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setDeviceId(resolveGroceryPosDeviceId(storeId));
    });
    if (!offlineEnabled) {
      queueMicrotask(() => {
        if (!cancelled) {
          setOfflineSyncState({
            supported: false,
            online: typeof navigator === "undefined" ? true : navigator.onLine,
            pendingOperations: 0,
            failedOperations: 0,
            lastSyncedAt: null,
            lastError: offlineUnavailableMessage,
          });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    const cleanup = installGroceryPosOfflineSync({
      storeId,
      onStatus: setOfflineSyncState,
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [offlineEnabled, offlineUnavailableMessage, storeId]);

  useEffect(() => {
    const status = checkoutOrder?.status === "paid" ? "paid" : checkoutOrder ? "checkout" : displayCart.items.length > 0 ? "scanning" : "idle";
    publishCustomerDisplaySnapshot(resolveCustomerDisplayPublishCart({
      liveCart: displayCart,
      paidCart: paidDisplayCartRef.current,
      status,
    }), {
      status,
      customerName: status === "paid" ? paidCustomerNameRef.current : selectedCustomer?.name,
      customer: status === "paid" ? paidCustomerRef.current : selectedCustomer
        ? {
            name: selectedCustomer.name,
            pointsBalance: selectedCustomer.pointsBalance,
          }
        : null,
    });
  }, [checkoutOrder, displayCart, selectedCustomer]);

  function resetCheckoutDraft() {
    setAppliedCoupon(null);
    setCheckoutOrder(null);
    setCheckoutMessage(null);
    paidDisplayCartRef.current = null;
    paidCustomerNameRef.current = undefined;
    paidCustomerRef.current = null;
  }

  async function refreshOfflineSyncState() {
    setOfflineSyncState(await getGroceryOfflineSyncState(storeId));
  }

  async function queueOfflineOrder(operation: GroceryOfflineOrderOperation, reason: string) {
    if (!offlineEnabled) {
      setCheckoutMessage(offlineUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับ Offline POS");
      return;
    }
    if (!isGroceryOfflineSupported()) {
      setCheckoutMessage("เครื่องนี้ไม่รองรับ offline queue");
      return;
    }

    await enqueueGroceryOfflineOrder(operation);
    await refreshOfflineSyncState();
    setCheckoutOrder(null);
    setCashReceived("");
    setCart(emptyCart(storeId));
    setCouponCode("");
    setAppliedCoupon(null);
    setCheckoutMessage(`${reason} บันทึกในเครื่องแล้ว จะ sync อัตโนมัติเมื่อออนไลน์`);
  }

  function addBarcode(barcode: string) {
    const localMatch = findLocalBarcodeMatch(products, barcode);
    if (localMatch) {
      resetCheckoutDraft();
      setCart((current) => addBarcodeMatchToGroceryCart(current, localMatch));
      setMessage(`เพิ่ม ${localMatch.product.name} แล้ว`);
      setScanValue("");
      return;
    }

    startTransition(async () => {
      const result = await lookupGroceryBarcodeAction(barcode);
      const match = result.match;
      if (result.error || !match) {
        setMessage(result.error ?? "ไม่พบสินค้าจากบาร์โค้ดนี้");
        return;
      }
      resetCheckoutDraft();
      setCart((current) => addBarcodeMatchToGroceryCart(current, match));
      setMessage(`เพิ่ม ${match.product.name} แล้ว`);
      setScanValue("");
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const result = applyScannerKey(scannerState.current, { key: event.key, timeMs: Date.now() });
    scannerState.current = result.state;
    if (result.barcode) {
      event.preventDefault();
      addBarcode(result.barcode);
    }
  }

  function handleManualSubmit() {
    const barcode = scanValue.trim();
    if (!barcode) return;
    addBarcode(barcode);
  }

  function handleCustomerSearch() {
    const query = customerQuery.trim();
    if (query.length < 2) {
      setCheckoutMessage("พิมพ์ชื่อลูกค้าหรือเบอร์โทรอย่างน้อย 2 ตัวอักษร");
      return;
    }

    startTransition(async () => {
      const result = await searchGroceryCustomersAction(query);
      if (result.error) {
        setCustomerResults([]);
        setCheckoutMessage(result.error);
        return;
      }
      setCustomerResults(result.customers);
      setCheckoutMessage(result.customers.length > 0 ? null : "ไม่พบลูกค้าที่ค้นหา");
    });
  }

  function selectCustomer(customer: CustomerProfile) {
    setSelectedCustomer(customer);
    setCustomerQuery(customer.name);
    setCustomerResults([]);
    setAppliedCoupon(null);
    setCheckoutOrder(null);
    setCheckoutMessage(`เลือกลูกค้า ${customer.name}`);
  }

  function handleApplyCoupon() {
    const code = couponCode.trim();
    if (cart.items.length === 0) {
      setCheckoutMessage("ต้องมีสินค้าในตะกร้าก่อนใช้คูปอง");
      return;
    }
    if (!code) {
      setCheckoutMessage("กรุณากรอกรหัสคูปอง");
      return;
    }

    startTransition(async () => {
      const result = await evaluateGroceryCouponAction(code, cart, selectedCustomer?.id);
      if (result.error) {
        setAppliedCoupon(null);
        setCheckoutMessage(result.error);
        return;
      }
      setAppliedCoupon({
        couponId: result.couponId,
        code: result.normalizedCode ?? code,
        discount: result.discount,
      });
      setCheckoutOrder(null);
      setCheckoutMessage(`ใช้คูปอง ${result.normalizedCode ?? code} สำเร็จ`);
    });
  }

  function handleCreateOrder() {
    if (cart.items.length === 0) {
      setCheckoutMessage("ยังไม่มีสินค้าในตะกร้า");
      return;
    }
    if (couponCode.trim() && !appliedCoupon) {
      setCheckoutMessage("กรุณากดใช้คูปองก่อนสร้างออร์เดอร์");
      return;
    }

    startTransition(async () => {
      const operation = buildGroceryOfflineOrderOperation({
        storeId,
        deviceId: deviceId || resolveGroceryPosDeviceId(storeId),
        catalogVersion,
        cart,
        customerId: selectedCustomer?.id ?? null,
        couponCode: appliedCoupon?.code ?? null,
        clientCouponDiscountAmount: appliedCoupon?.discount ?? 0,
        note: "Grocery POS",
      });

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (!offlineEnabled) {
          setCheckoutMessage(offlineUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับ Offline POS");
          return;
        }
        await queueOfflineOrder(operation, "ขณะนี้ offline");
        return;
      }

      let result: Awaited<ReturnType<typeof createGroceryOrderAction>>;
      try {
        result = await createGroceryOrderAction({
          cart,
          customerId: selectedCustomer?.id ?? null,
          couponCode: appliedCoupon?.code ?? null,
          clientCouponDiscountAmount: appliedCoupon?.discount ?? 0,
          idempotencyKey: operation.idempotencyKey,
          note: "Grocery POS",
          sync: offlineEnabled
            ? {
                deviceId: operation.deviceId,
                catalogVersion: operation.catalogVersion,
                operationPayload: operation as unknown as Json,
              }
            : undefined,
        });
      } catch (error) {
        if (isLikelyNetworkError(error)) {
          await queueOfflineOrder(operation, "เชื่อมต่อ server ไม่สำเร็จ");
          return;
        }
        setCheckoutOrder(null);
        setCheckoutMessage(error instanceof Error ? error.message : "สร้างออร์เดอร์ไม่สำเร็จ");
        return;
      }

      if (result.error || !result.order) {
        setCheckoutOrder(null);
        setCheckoutMessage(result.error ?? "สร้างออร์เดอร์ไม่สำเร็จ");
        return;
      }

      setCheckoutOrder(result.order);
      setCashReceived(String(result.order.total));
      setCheckoutMessage(`สร้างออร์เดอร์ ${result.order.orderNumber} แล้ว`);
    });
  }

  function handleCashPayment() {
    if (!checkoutOrder) {
      setCheckoutMessage("ต้องสร้างออร์เดอร์ก่อนรับชำระเงิน");
      return;
    }
    const received = Number(cashReceived || checkoutOrder.total);
    if (!Number.isFinite(received) || received < checkoutOrder.total) {
      setCheckoutMessage("ยอดรับเงินสดไม่ถูกต้อง");
      return;
    }

    startTransition(async () => {
      const result = await closeGroceryOrderPaymentAction({
        orderId: checkoutOrder.id,
        payment: {
          method: "cash",
          amount: checkoutOrder.total,
          receivedAmount: received,
          changeAmount: roundMoney(received - checkoutOrder.total),
        },
        idempotencyKey: `${checkoutOrder.id}:cash:${Date.now()}`,
      });

      if (result.error || !result.order) {
        setCheckoutMessage(result.error ?? "ปิดการขายไม่สำเร็จ");
        return;
      }

      paidDisplayCartRef.current = displayCart;
      paidCustomerNameRef.current = selectedCustomer?.name;
      paidCustomerRef.current = selectedCustomer
        ? {
            name: selectedCustomer.name,
            pointsEarned: result.order.loyaltyPointsEarned,
            pointsBalance:
              typeof selectedCustomer.pointsBalance === "number"
                ? selectedCustomer.pointsBalance + (result.order.loyaltyPointsEarned ?? 0) - (result.order.loyaltyPointsRedeemed ?? 0)
                : selectedCustomer.pointsBalance,
          }
        : null;
      publishCustomerDisplaySnapshot(displayCart, {
        status: "paid",
        customerName: selectedCustomer?.name,
        customer: paidCustomerRef.current,
      });
      setCheckoutOrder(result.order);
      setCheckoutMessage(`ชำระเงินแล้ว เงินทอน ${money(received - checkoutOrder.total, currency)}`);
      setCart(emptyCart(storeId));
      setCouponCode("");
      setAppliedCoupon(null);
      setCashReceived("");
      setSelectedCustomer(null);
      setCustomerQuery("");
    });
  }

  function handleVoidOrder() {
    if (!checkoutOrder) {
      setCheckoutMessage("ยังไม่มีออร์เดอร์ให้ยกเลิก");
      return;
    }

    startTransition(async () => {
      const result = await voidGroceryOrderAction(checkoutOrder.id, "ยกเลิกจาก Grocery POS");
      if (result.error) {
        setCheckoutMessage(result.error);
        return;
      }

      setCheckoutOrder(null);
      setAppliedCoupon(null);
      setCashReceived("");
      setCheckoutMessage("ยกเลิกออร์เดอร์แล้ว");
    });
  }

  return (
    <main className="grocery-pos-shell">
      <header className="grocery-pos-header">
        <div>
          <p className="grocery-pos-eyebrow">Dedicated Grocery POS</p>
          <h1>{storeName}</h1>
          <p>
            สแกนสินค้าเร็วสำหรับร้านของชำ แยกจาก POS โต๊ะ/บุฟเฟต์เดิม แต่ใช้ cart/order/printing contract เดียวกัน
          </p>
        </div>
        <div className="grocery-pos-actions">
          <a className="grocery-pos-link" href="/pos/grocery/display">
            เปิดจอคู่ร้านของชำ
          </a>
          <a className="grocery-pos-link secondary" href="/pos">
            กลับ POS เดิม
          </a>
        </div>
      </header>

      <section className="grocery-pos-sync" aria-label="offline sync status">
        <div>
          <strong>{offlineSyncState.online ? "Online" : "Offline"}</strong>
          <span>
            device {deviceId ? deviceId.slice(0, 18) : "loading"} · pending {offlineSyncState.pendingOperations} · failed{" "}
            {offlineSyncState.failedOperations}
          </span>
        </div>
        {offlineEnabled ? null : <p>{offlineUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับ Offline POS"}</p>}
        {offlineEnabled && offlineSyncState.lastError ? <p>{offlineSyncState.lastError}</p> : null}
      </section>

      <section className="grocery-pos-scan" aria-label="barcode scanner">
        <label htmlFor="grocery-barcode">Barcode / SKU</label>
        <div className="grocery-pos-scan-row">
          <input
            id="grocery-barcode"
            value={scanValue}
            onChange={(event) => setScanValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ยิงบาร์โค้ดหรือพิมพ์ SKU"
            autoFocus
          />
          <button type="button" onClick={handleManualSubmit} disabled={isPending}>
            เพิ่มสินค้า
          </button>
        </div>
        {message ? <p className="grocery-pos-message">{message}</p> : null}
      </section>

      <div className="grocery-pos-grid">
        <section className="grocery-pos-panel">
          <div className="grocery-pos-panel-head">
            <h2>สินค้าเร็ว</h2>
            <span>
              {productCount} สินค้า / {categoryCount} หมวด
            </span>
          </div>
          <div className="grocery-pos-products">
            {visibleProducts.map((product) => (
              <button
                type="button"
                key={product.id}
                onClick={() => {
                  resetCheckoutDraft();
                  setCart((current) => addBarcodeMatchToGroceryCart(current, { product, variant: null, barcode: product.barcode ?? product.id }));
                }}
              >
                <strong>{product.name}</strong>
                <span>{money(product.basePrice, currency)}</span>
              </button>
            ))}
          </div>
        </section>

        <aside className="grocery-pos-panel grocery-pos-cart">
          <div className="grocery-pos-panel-head">
            <h2>ตะกร้า</h2>
            <span>{cart.items.length} รายการ</span>
          </div>
          <div className="grocery-pos-cart-list">
            {cart.items.length === 0 ? <p className="grocery-pos-empty">ยังไม่มีสินค้า</p> : null}
            {cart.items.map((item) => (
              <div className="grocery-pos-cart-item" key={item.key}>
                <div>
                  <strong>{item.productName}</strong>
                  <span>{item.variant?.name ?? "ชิ้น"}</span>
                </div>
                <div className="grocery-pos-qty">
                  <button
                    type="button"
                    onClick={() => {
                      resetCheckoutDraft();
                      setCart((current) => updateQuantity(current, item.key, item.quantity - 1));
                    }}
                  >
                    -
                  </button>
                  <b>{item.quantity}</b>
                  <button
                    type="button"
                    onClick={() => {
                      resetCheckoutDraft();
                      setCart((current) => updateQuantity(current, item.key, item.quantity + 1));
                    }}
                  >
                    +
                  </button>
                </div>
                <span>{money(item.totalPrice, currency)}</span>
                <button
                  type="button"
                  onClick={() => {
                    resetCheckoutDraft();
                    setCart((current) => removeFromCart(current, item.key));
                  }}
                >
                  ลบ
                </button>
              </div>
            ))}
          </div>
          <footer className="grocery-pos-total">
            <span>รวม</span>
            <strong>{money(displayCart.total, currency)}</strong>
          </footer>
          {appliedCoupon ? (
            <p className="grocery-pos-printer">
              คูปอง {appliedCoupon.code}: -{money(appliedCoupon.discount, currency)}
            </p>
          ) : null}
          <p className="grocery-pos-printer">
            ใบเสร็จ: {receiptSettings ? "พร้อมตั้งค่า" : "ใช้ค่าเริ่มต้น"} / เครื่องพิมพ์:{" "}
            {printerLoadError ?? defaultPrinter?.name ?? "Browser print"}
          </p>
        </aside>
      </div>

      <section className="grocery-pos-checkout" aria-label="checkout rewards">
        <div className="grocery-pos-panel">
          <div className="grocery-pos-panel-head">
            <h2>ลูกค้า</h2>
            <span>
              {selectedCustomer
                ? `${selectedCustomer.name} / ${selectedCustomer.pointsBalance ?? 0} แต้ม`
                : "ไม่ระบุ"}
            </span>
          </div>
          <div className="grocery-pos-inline">
            <input
              value={customerQuery}
              onChange={(event) => setCustomerQuery(event.target.value)}
              placeholder="ค้นชื่อลูกค้าหรือเบอร์โทร"
            />
            <button type="button" onClick={handleCustomerSearch} disabled={isPending}>
              ค้นหา
            </button>
          </div>
          {customerResults.length > 0 ? (
            <div className="grocery-pos-customer-results">
              {customerResults.map((customer) => (
                <button type="button" key={customer.id} onClick={() => selectCustomer(customer)}>
                  <strong>{customer.name}</strong>
                  <span>
                    {customer.phone ?? customer.email ?? "ไม่มีข้อมูลติดต่อ"} / {customer.pointsBalance ?? 0} แต้ม
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="grocery-pos-panel">
          <div className="grocery-pos-panel-head">
            <h2>คูปอง</h2>
            <span>{appliedCoupon ? `-${money(appliedCoupon.discount, currency)}` : "ยังไม่ใช้"}</span>
          </div>
          <div className="grocery-pos-inline">
            <input
              value={couponCode}
              onChange={(event) => {
                setCouponCode(event.target.value);
                setAppliedCoupon(null);
              }}
              placeholder="รหัสคูปอง"
            />
            <button type="button" onClick={handleApplyCoupon} disabled={isPending}>
              ใช้คูปอง
            </button>
          </div>
        </div>

        <div className="grocery-pos-panel">
          <div className="grocery-pos-panel-head">
            <h2>ชำระเงิน</h2>
            <span>{checkoutOrder?.orderNumber ?? "ยังไม่สร้างออร์เดอร์"}</span>
          </div>
          <button className="grocery-pos-primary" type="button" onClick={handleCreateOrder} disabled={isPending || cart.items.length === 0}>
            สร้างออร์เดอร์
          </button>
          <button type="button" onClick={handleVoidOrder} disabled={isPending || !checkoutOrder || checkoutOrder.status === "paid"}>
            ยกเลิกออร์เดอร์
          </button>
          <div className="grocery-pos-inline">
            <input
              value={cashReceived}
              onChange={(event) => setCashReceived(event.target.value)}
              placeholder={money(displayCart.total, currency)}
              inputMode="decimal"
            />
            <button type="button" onClick={handleCashPayment} disabled={isPending || !checkoutOrder}>
              รับเงินสด
            </button>
          </div>
          {checkoutMessage ? <p className="grocery-pos-message">{checkoutMessage}</p> : null}
        </div>
      </section>

      <style jsx>{`
        .grocery-pos-shell {
          min-height: 100vh;
          background: var(--color-bg);
          color: var(--color-text-primary);
          padding: 22px;
        }
        .grocery-pos-header,
        .grocery-pos-scan,
        .grocery-pos-sync,
        .grocery-pos-panel {
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-xs);
        }
        .grocery-pos-header {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          padding: 20px;
        }
        .grocery-pos-eyebrow {
          margin: 0 0 4px;
          color: var(--color-brand);
          font-weight: 800;
          text-transform: uppercase;
          font-size: 12px;
        }
        h1,
        h2,
        p {
          margin: 0;
        }
        h1 {
          font-size: 28px;
        }
        .grocery-pos-link,
        button {
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-surface);
          color: var(--color-text-primary);
          font-weight: 700;
          padding: 10px 12px;
          text-decoration: none;
          cursor: pointer;
        }
        .grocery-pos-actions {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .grocery-pos-link,
        .grocery-pos-scan-row button {
          background: var(--color-brand);
          color: var(--color-text-inverse);
          border-color: var(--color-brand);
        }
        .grocery-pos-link.secondary {
          background: var(--color-surface);
          color: var(--color-text-primary);
          border-color: var(--color-border);
        }
        .grocery-pos-scan {
          margin-top: 14px;
          padding: 16px;
        }
        .grocery-pos-sync {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-top: 14px;
          padding: 12px 16px;
          color: var(--color-text-secondary);
        }
        .grocery-pos-sync div {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .grocery-pos-sync strong {
          color: var(--color-brand);
        }
        .grocery-pos-sync p {
          color: var(--color-warning);
        }
        .grocery-pos-scan label {
          display: block;
          font-weight: 800;
          margin-bottom: 8px;
        }
        .grocery-pos-scan-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
        }
        .grocery-pos-scan input {
          min-height: 46px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          font-size: 18px;
          padding: 8px 12px;
        }
        .grocery-pos-message {
          margin-top: 8px;
          color: var(--color-text-secondary);
        }
        .grocery-pos-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
          gap: 14px;
          margin-top: 14px;
        }
        .grocery-pos-panel {
          padding: 16px;
          min-width: 0;
        }
        .grocery-pos-panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .grocery-pos-products {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(145px, 1fr));
          gap: 10px;
        }
        .grocery-pos-products button {
          min-height: 82px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: space-between;
          text-align: left;
        }
        .grocery-pos-cart-list {
          display: grid;
          gap: 8px;
        }
        .grocery-pos-empty {
          color: var(--color-text-secondary);
        }
        .grocery-pos-cart-item {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto auto;
          align-items: center;
          gap: 8px;
          border-bottom: 1px solid var(--color-border);
          padding: 8px 0;
        }
        .grocery-pos-cart-item span {
          color: var(--color-text-secondary);
          font-size: 13px;
        }
        .grocery-pos-qty {
          display: inline-grid;
          grid-template-columns: 34px 32px 34px;
          align-items: center;
          text-align: center;
        }
        .grocery-pos-qty button {
          padding: 6px;
        }
        .grocery-pos-total {
          display: flex;
          justify-content: space-between;
          border-top: 2px solid var(--color-text-primary);
          margin-top: 14px;
          padding-top: 12px;
          font-size: 20px;
        }
        .grocery-pos-printer {
          margin-top: 10px;
          color: var(--color-text-secondary);
          font-size: 13px;
        }
        .grocery-pos-checkout {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px;
          margin-top: 14px;
        }
        .grocery-pos-inline {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
        }
        .grocery-pos-inline input {
          min-height: 42px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 8px 10px;
        }
        .grocery-pos-primary {
          width: 100%;
          background: var(--color-brand);
          color: var(--color-text-inverse);
          border-color: var(--color-brand);
          margin-bottom: 10px;
        }
        .grocery-pos-primary + button {
          width: 100%;
          margin-bottom: 10px;
        }
        .grocery-pos-customer-results {
          display: grid;
          gap: 8px;
          margin-top: 10px;
        }
        .grocery-pos-customer-results button {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          text-align: left;
        }
        .grocery-pos-customer-results span {
          color: var(--color-text-secondary);
          font-size: 13px;
        }
        @media (max-width: 860px) {
          .grocery-pos-shell {
            padding: 12px;
          }
          .grocery-pos-header,
          .grocery-pos-scan-row,
          .grocery-pos-grid,
          .grocery-pos-checkout,
          .grocery-pos-inline {
            grid-template-columns: 1fr;
          }
          .grocery-pos-header {
            display: grid;
          }
          .grocery-pos-cart-item {
            grid-template-columns: minmax(0, 1fr) auto;
          }
        }
      `}</style>
    </main>
  );
}
