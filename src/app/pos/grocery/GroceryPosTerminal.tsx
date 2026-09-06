"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import type { Category, Product, ProductUnit } from "@/modules/catalog/types";
import type { CustomerProfile } from "@/modules/customers/types";
import type { Cart, Order } from "@/modules/pos/types";
import type { Printer, ReceiptSettings } from "@/modules/stores/types";
import { buildReceiptData } from "@/modules/printing/types";
import { printReceiptWithFallback, type ReceiptPrintResult } from "@/modules/printing/receipt-printer";
import { emptyCart, updateQuantity, removeFromCart, applyOrderDiscount, repriceCartForTier } from "@/modules/pos/cart";
import { PRICE_TIER_LABELS, PRICE_TIERS, resolveTierBasePrice, resolveUnitTierPrice, type PriceTier } from "@/modules/pos/pricing";
import { addBarcodeMatchToGroceryCart, type GroceryBarcodeMatch } from "@/modules/grocery-pos/cart-adapter";
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
import { Button } from "@/shared/components/ui";
import { formatPoints } from "@/shared/utils/points";
import {
  closeGroceryOrderPaymentAction,
  createGroceryOrderAction,
  evaluateGroceryCouponAction,
  listGroceryOrdersHistoryAction,
  lookupGroceryBarcodeAction,
  quickAddGroceryProductAction,
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
  canManageCatalog: boolean;
  canDiscount: boolean;
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

function printSuccessMessage(base: string, result: ReceiptPrintResult, printerLoadError?: string | null): string {
  if (printerLoadError) {
    return `${base} (โหลดการตั้งค่าเครื่องพิมพ์ไม่สำเร็จ: ${printerLoadError} จึงใช้ช่องทางสำรอง)`;
  }
  if (result.hubOnline === false) {
    return "ส่งเข้าคิวแล้ว แต่ Hub (เครื่องแคชเชียร์) ออฟไลน์ — จะพิมพ์เมื่อเปิดเครื่อง";
  }
  if (!result.fallbackFromPrinter) return base;
  return `${base} (เครื่อง ${result.fallbackFromPrinter.name} ใช้ไม่ได้ จึงใช้ช่องทางสำรอง)`;
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

function findLocalBarcodeMatch(products: Product[], barcode: string): GroceryBarcodeMatch | null {
  const normalized = barcode.trim().toLowerCase();
  for (const product of products) {
    if (product.barcode?.toLowerCase() === normalized) {
      return { product, variant: product.variants[0] ?? null, unit: null, barcode };
    }
    for (const variant of product.variants) {
      if (variant.barcode?.toLowerCase() === normalized || variant.sku?.toLowerCase() === normalized) {
        return { product, variant, unit: null, barcode };
      }
    }
    for (const unit of product.units ?? []) {
      if (unit.barcode?.toLowerCase() === normalized) {
        return { product, variant: product.variants[0] ?? null, unit, barcode };
      }
    }
  }
  return null;
}

function searchLocalProducts(products: Product[], query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return products
    .filter(
      (product) =>
        product.name.toLowerCase().includes(q) ||
        product.barcode?.toLowerCase().includes(q) ||
        product.variants.some(
          (variant) => variant.sku?.toLowerCase().includes(q) || variant.barcode?.toLowerCase().includes(q),
        ) ||
        (product.units ?? []).some((unit) => unit.barcode?.toLowerCase().includes(q)),
    )
    .slice(0, 30);
}

function productStockLabel(product: Product): string | null {
  const tracked = product.variants.filter(
    (variant) => variant.trackStock && typeof variant.stockQuantity === "number",
  );
  if (tracked.length === 0) return null;
  const total = tracked.reduce((sum, variant) => sum + (variant.stockQuantity ?? 0), 0);
  return `${total}`;
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

interface QuickAddUnitDraft {
  name: string;
  quantity: string;
  price: string;
  priceWholesale: string;
  barcode: string;
}

interface QuickAddDraft {
  name: string;
  barcode: string;
  basePrice: string;
  priceWholesale: string;
  priceAgent: string;
  priceRegular: string;
  unitLabel: string;
  initialStock: string;
  units: QuickAddUnitDraft[];
}

function emptyQuickAddDraft(): QuickAddDraft {
  return {
    name: "",
    barcode: "",
    basePrice: "",
    priceWholesale: "",
    priceAgent: "",
    priceRegular: "",
    unitLabel: "ชิ้น",
    initialStock: "",
    units: [],
  };
}

/** ราคาไม่บังคับ: ว่าง = ใช้ราคาปลีก, กรอกแล้วต้องเป็นตัวเลข ≥ 0 เท่านั้น (กันพิมพ์ผิดแล้วราคาหายเงียบ ๆ) */
function parsePriceInput(value: string, label: string): { value: number | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return { value: null, error: `${label}ไม่ถูกต้อง` };
  return { value: parsed, error: null };
}

/** ช่องจำนวนที่พิมพ์ทับ/ลบทั้งหมดได้ — commit เฉพาะค่าที่เป็นตัวเลข ≥ 1, เว้นว่างแล้ว blur = คืนค่าเดิม */
function QtyInput({ quantity, onCommit }: { quantity: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState(String(quantity));
  useEffect(() => {
    setDraft(String(quantity));
  }, [quantity]);
  return (
    <input
      className="grocery-pos-qty-input"
      inputMode="numeric"
      value={draft}
      onChange={(event) => {
        const value = event.target.value;
        if (!/^\d*$/.test(value)) return;
        setDraft(value);
        const parsed = Number(value);
        if (value !== "" && parsed >= 1) onCommit(parsed);
      }}
      onBlur={() => {
        if (draft === "" || Number(draft) < 1) setDraft(String(quantity));
      }}
    />
  );
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  paid: "ชำระแล้ว",
  pending_payment: "รอชำระ",
  open: "เปิดอยู่",
  voided: "ยกเลิก",
  cancelled: "ยกเลิก",
  refunded: "คืนเงิน",
  draft: "ร่าง",
};

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
  canManageCatalog,
  canDiscount,
}: GroceryPosTerminalProps) {
  const router = useRouter();
  const [cart, setCart] = useState<Cart>(() => emptyCart(storeId));
  const [scanValue, setScanValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [priceTier, setPriceTier] = useState<PriceTier>("retail");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerProfile[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerProfile | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<{
    couponId: string | null;
    code: string;
    discount: number;
  } | null>(null);
  const [billDiscountType, setBillDiscountType] = useState<"amount" | "percentage">("amount");
  const [billDiscountValue, setBillDiscountValue] = useState("");
  const [checkoutOrder, setCheckoutOrder] = useState<Order | null>(null);
  const [cashReceived, setCashReceived] = useState("");
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [isPrintingReceipt, setIsPrintingReceipt] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [offlineSyncState, setOfflineSyncState] = useState<GroceryOfflineSyncState>(() => defaultOfflineSyncState());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOrders, setHistoryOrders] = useState<Order[]>([]);
  const [historyFromDate, setHistoryFromDate] = useState("");
  const [historyToDate, setHistoryToDate] = useState("");
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddDraft, setQuickAddDraft] = useState<QuickAddDraft>(() => emptyQuickAddDraft());
  const [quickAddMessage, setQuickAddMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const scannerState = useRef<ScannerBufferState>({ value: "", updatedAtMs: 0 });
  const paidDisplayCartRef = useRef<Cart | null>(null);
  const paidCustomerNameRef = useRef<string | undefined>(undefined);
  const paidCustomerRef = useRef<CustomerDisplayCustomer | null>(null);

  const productCount = products.length;
  const categoryCount = categories.length;
  const defaultPrinter = printers.find((printer) => printer.isDefault) ?? printers[0] ?? null;

  const visibleProducts = useMemo(() => products.slice(0, 18), [products]);
  const searchResults = useMemo(() => searchLocalProducts(products, scanValue), [products, scanValue]);
  const catalogVersion = useMemo(() => buildGroceryCatalogVersion({ products }), [products]);
  const displayCart = useMemo(
    () => buildCouponPreviewCart(cart, appliedCoupon?.discount ?? 0),
    [appliedCoupon?.discount, cart],
  );
  const cashReceivedNumber = Number(cashReceived || 0);
  const changePreview =
    Number.isFinite(cashReceivedNumber) && cashReceivedNumber > displayCart.total
      ? roundMoney(cashReceivedNumber - displayCart.total)
      : 0;

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

  function addMatch(match: GroceryBarcodeMatch, quantity = 1) {
    resetCheckoutDraft();
    setCart((current) => addBarcodeMatchToGroceryCart(current, match, { quantity, priceTier }));
    const unitInfo = match.unit ? ` (${match.unit.name})` : "";
    setMessage(`เพิ่ม ${match.product.name}${unitInfo} แล้ว`);
    setScanValue("");
  }

  function addProduct(product: Product, unit: ProductUnit | null) {
    addMatch({
      product,
      variant: product.variants[0] ?? null,
      unit,
      barcode: unit?.barcode ?? product.barcode ?? product.id,
    });
  }

  function addBarcode(barcode: string) {
    const localMatch = findLocalBarcodeMatch(products, barcode);
    if (localMatch) {
      addMatch(localMatch);
      return;
    }

    startTransition(async () => {
      const result = await lookupGroceryBarcodeAction(barcode);
      const match = result.match;
      if (result.error || !match) {
        setMessage(result.error ?? "ไม่พบสินค้าจากบาร์โค้ดนี้");
        return;
      }
      addMatch({
        product: match.product,
        variant: match.variant ?? match.product.variants[0] ?? null,
        unit: match.unit ?? null,
        barcode,
      });
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

  function changePriceTier(tier: PriceTier) {
    setPriceTier(tier);
    resetCheckoutDraft();
    setCart((current) => repriceCartForTier(current, products, tier));
    setMessage(`ใช้${PRICE_TIER_LABELS[tier]}กับทั้งบิลแล้ว`);
  }

  function setLineQuantity(key: string, quantity: number) {
    if (!Number.isFinite(quantity)) return;
    const next = Math.max(0, Math.min(9999, Math.floor(quantity)));
    resetCheckoutDraft();
    setCart((current) => updateQuantity(current, key, next));
  }

  function handleApplyBillDiscount() {
    const value = Number(billDiscountValue);
    if (!Number.isFinite(value) || value < 0) {
      setCheckoutMessage("มูลค่าส่วนลดไม่ถูกต้อง");
      return;
    }
    resetCheckoutDraft();
    setCart((current) =>
      applyOrderDiscount(current, { type: billDiscountType, value, note: "ส่วนลดท้ายบิล" }),
    );
    setCheckoutMessage(value > 0 ? "ใส่ส่วนลดท้ายบิลแล้ว" : "ล้างส่วนลดท้ายบิลแล้ว");
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
    setPriceTier(customer.priceTier);
    setCart((current) => repriceCartForTier(current, products, customer.priceTier));
    setCheckoutMessage(`เลือกลูกค้า ${customer.name} (${PRICE_TIER_LABELS[customer.priceTier]})`);
  }

  function clearCustomer() {
    setSelectedCustomer(null);
    setCustomerQuery("");
    setCustomerResults([]);
    setAppliedCoupon(null);
    setCheckoutOrder(null);
    setPriceTier("retail");
    setCart((current) => repriceCartForTier(current, products, "retail"));
    setCheckoutMessage("ล้างลูกค้าแล้ว กลับเป็นราคาปลีก");
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
      const result = await evaluateGroceryCouponAction(code, cart, selectedCustomer?.id, priceTier);
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
        priceTier,
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
          priceTier,
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
      const paidPointsEarned = result.order.loyaltyPointsEarned;
      const hasPaidPointMovement = typeof paidPointsEarned === "number" && paidPointsEarned > 0;
      paidCustomerRef.current = selectedCustomer
        ? {
            name: selectedCustomer.name,
            pointsEarned: paidPointsEarned,
            pointsBalance: hasPaidPointMovement ? result.order.loyaltyPointsBalance : undefined,
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
      setBillDiscountValue("");
      setCashReceived("");
      setSelectedCustomer(null);
      setCustomerQuery("");
      setPriceTier("retail");
      if (receiptSettings?.autoPrintReceipt) {
        void handlePrintReceipt(result.order);
      }
    });
  }

  async function handlePrintReceipt(orderArg?: Order, options: { reprint?: boolean } = {}) {
    const order = orderArg ?? checkoutOrder;
    if (!order || order.status !== "paid") {
      setCheckoutMessage("ต้องชำระเงินก่อนพิมพ์ใบเสร็จ");
      return;
    }

    const settings: ReceiptSettings = receiptSettings ?? {
      id: "",
      storeId,
      organizationId: "",
      storeName,
      showTaxId: false,
      showQrPayment: false,
      autoPrintReceipt: false,
      autoPrintStationTickets: false,
      paperWidth: "80mm",
      printCopies: 1,
      showVatBreakdown: false,
      vatRate: 7,
      updatedAt: new Date().toISOString(),
    };
    const receiptData = {
      ...buildReceiptData(order, settings),
      storeName: settings.storeName || storeName,
      showQrPayment: false,
      // ใบซ้ำต้องมีป้าย REPRINT บนกระดาษ ไม่งั้นแยกจากใบจริงไม่ออก
      isReprint: options.reprint === true,
      loyaltyPointsEarned: order.loyaltyPointsEarned,
      loyaltyPointsBalance: order.loyaltyPointsBalance,
      printedAt: new Date().toISOString(),
    };

    setIsPrintingReceipt(true);
    setCheckoutMessage("กำลังพิมพ์ใบเสร็จ...");
    try {
      const result = await printReceiptWithFallback({
        printers,
        preferredPrinterId: defaultPrinter?.id ?? null,
        escpos: receiptData,
        browser: receiptData,
      });
      setCheckoutMessage(printSuccessMessage("พิมพ์ใบเสร็จแล้ว", result, printerLoadError));
    } catch (error) {
      setCheckoutMessage(error instanceof Error ? error.message : "พิมพ์ใบเสร็จไม่สำเร็จ");
    } finally {
      setIsPrintingReceipt(false);
    }
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

  function loadHistory(fromDate?: string, toDate?: string) {
    startTransition(async () => {
      setHistoryMessage("กำลังโหลด...");
      const result = await listGroceryOrdersHistoryAction({
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        limit: 100,
      });
      if (result.error) {
        setHistoryOrders([]);
        setHistoryMessage(result.error);
        return;
      }
      setHistoryOrders(result.orders);
      setHistoryMessage(result.orders.length === 0 ? "ไม่พบบิลในช่วงวันที่นี้" : null);
    });
  }

  function openHistory() {
    setHistoryOpen(true);
    loadHistory(historyFromDate, historyToDate);
  }

  function updateQuickAddUnit(index: number, patch: Partial<QuickAddUnitDraft>) {
    setQuickAddDraft((draft) => ({
      ...draft,
      units: draft.units.map((unit, i) => (i === index ? { ...unit, ...patch } : unit)),
    }));
  }

  function handleQuickAddSubmit() {
    const basePrice = Number(quickAddDraft.basePrice);
    if (!quickAddDraft.name.trim()) {
      setQuickAddMessage("กรุณากรอกชื่อสินค้า");
      return;
    }
    if (!Number.isFinite(basePrice) || basePrice < 0) {
      setQuickAddMessage("ราคาปลีกไม่ถูกต้อง");
      return;
    }
    const units: Array<{
      name: string;
      quantity: number;
      price: number;
      priceWholesale: number | null;
      barcode: string | null;
    }> = [];
    for (const draft of quickAddDraft.units) {
      if (!draft.name.trim()) continue;
      const quantity = Number(draft.quantity);
      const price = Number(draft.price);
      if (!Number.isInteger(quantity) || quantity < 2) {
        setQuickAddMessage(`หน่วย "${draft.name}" ต้องระบุจำนวนชิ้นต่อหน่วยตั้งแต่ 2 ขึ้นไป`);
        return;
      }
      if (!draft.price.trim() || !Number.isFinite(price) || price < 0) {
        setQuickAddMessage(`หน่วย "${draft.name}" ราคาไม่ถูกต้อง`);
        return;
      }
      const unitWholesale = parsePriceInput(draft.priceWholesale, `หน่วย "${draft.name}" ราคาส่ง`);
      if (unitWholesale.error) {
        setQuickAddMessage(unitWholesale.error);
        return;
      }
      units.push({
        name: draft.name,
        quantity,
        price,
        priceWholesale: unitWholesale.value,
        barcode: draft.barcode.trim() || null,
      });
    }
    const priceWholesale = parsePriceInput(quickAddDraft.priceWholesale, "ราคาส่ง");
    const priceAgent = parsePriceInput(quickAddDraft.priceAgent, "ราคาตัวแทน");
    const priceRegular = parsePriceInput(quickAddDraft.priceRegular, "ราคาลูกค้าประจำ");
    const priceError = priceWholesale.error ?? priceAgent.error ?? priceRegular.error;
    if (priceError) {
      setQuickAddMessage(priceError);
      return;
    }

    const initialStockValue = quickAddDraft.initialStock.trim();
    const initialStock = initialStockValue ? Number(initialStockValue) : null;
    if (initialStock !== null && (!Number.isFinite(initialStock) || initialStock < 0)) {
      setQuickAddMessage("จำนวนสต๊อกเริ่มต้นไม่ถูกต้อง");
      return;
    }

    startTransition(async () => {
      const result = await quickAddGroceryProductAction({
        name: quickAddDraft.name,
        barcode: quickAddDraft.barcode.trim() || null,
        basePrice,
        unitLabel: quickAddDraft.unitLabel.trim() || null,
        priceWholesale: priceWholesale.value,
        priceAgent: priceAgent.value,
        priceRegular: priceRegular.value,
        initialStock,
        units,
      });
      if (!result.ok) {
        setQuickAddMessage(result.error ?? "เพิ่มสินค้าไม่สำเร็จ");
        return;
      }
      setQuickAddMessage(null);
      setQuickAddOpen(false);
      setQuickAddDraft(emptyQuickAddDraft());
      setMessage(`เพิ่มสินค้า ${quickAddDraft.name} แล้ว กำลังรีเฟรชรายการสินค้า...`);
      router.refresh();
    });
  }

  function renderUnitChips(product: Product) {
    const units = product.units ?? [];
    if (units.length === 0) return null;
    return (
      <span className="grocery-pos-unit-chips">
        <button
          type="button"
          className="grocery-pos-unit-chip"
          onClick={(event) => {
            event.stopPropagation();
            addProduct(product, null);
          }}
        >
          {product.unitLabel || "ชิ้น"} {money(resolveTierBasePrice(product, priceTier), currency)}
        </button>
        {units.map((unit) => (
          <button
            type="button"
            key={unit.id}
            className="grocery-pos-unit-chip pack"
            onClick={(event) => {
              event.stopPropagation();
              addProduct(product, unit);
            }}
          >
            {unit.name} ({unit.quantity}) {money(resolveUnitTierPrice(unit, priceTier), currency)}
          </button>
        ))}
      </span>
    );
  }

  return (
    <main className="grocery-pos-shell">
      <header className="grocery-pos-header">
        <div>
          <p className="grocery-pos-eyebrow">POS ขายส่ง / ร้านของชำ</p>
          <h1>{storeName}</h1>
          <p>
            ยิงบาร์โค้ดหรือค้นหาชื่อสินค้า รองรับราคาหลายหน่วย (โหล/แพ็ค) และราคาหลายระดับลูกค้า
          </p>
        </div>
        <div className="grocery-pos-actions">
          {canManageCatalog ? (
            <button type="button" className="grocery-pos-link" onClick={() => setQuickAddOpen(true)}>
              + เพิ่มสินค้าเร็ว
            </button>
          ) : null}
          <button type="button" className="grocery-pos-link" onClick={openHistory}>
            ประวัติบิล
          </button>
          <a className="grocery-pos-link secondary" href="/pos/grocery/display">
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
        <div className="grocery-pos-tier-picker">
          <span>ระดับราคา:</span>
          {PRICE_TIERS.map((tier) => (
            <button
              type="button"
              key={tier}
              className={priceTier === tier ? "grocery-pos-tier active" : "grocery-pos-tier"}
              disabled={!!selectedCustomer}
              onClick={() => changePriceTier(tier)}
            >
              {PRICE_TIER_LABELS[tier]}
            </button>
          ))}
        </div>
        {offlineEnabled ? null : <p>{offlineUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับ Offline POS"}</p>}
        {offlineEnabled && offlineSyncState.lastError ? <p>{offlineSyncState.lastError}</p> : null}
      </section>

      <section className="grocery-pos-scan" aria-label="product search">
        <label htmlFor="grocery-barcode">ค้นหาสินค้า (ชื่อ / รหัส / บาร์โค้ด)</label>
        <div className="grocery-pos-scan-row">
          <input
            id="grocery-barcode"
            value={scanValue}
            onChange={(event) => setScanValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ยิงบาร์โค้ด พิมพ์ชื่อสินค้า หรือ SKU"
            autoFocus
          />
          <Button loading={isPending} onClick={handleManualSubmit}>
            เพิ่มสินค้า
          </Button>
        </div>
        {message ? <p className="grocery-pos-message">{message}</p> : null}
        {searchResults.length > 0 ? (
          <div className="grocery-pos-search-results">
            {searchResults.map((product) => {
              const stock = productStockLabel(product);
              return (
                <div
                  className="grocery-pos-search-row"
                  key={product.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => addProduct(product, null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addProduct(product, null);
                  }}
                >
                  <div className="grocery-pos-search-info">
                    <strong>{product.name}</strong>
                    <span>
                      {money(resolveTierBasePrice(product, priceTier), currency)} / {product.unitLabel || "ชิ้น"}
                      {stock !== null ? ` · คงเหลือ ${stock}` : ""}
                      {product.barcode ? ` · ${product.barcode}` : ""}
                    </span>
                  </div>
                  {renderUnitChips(product)}
                </div>
              );
            })}
          </div>
        ) : null}
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
              <div className="grocery-pos-product-card" key={product.id}>
                <button type="button" onClick={() => addProduct(product, null)}>
                  <strong>{product.name}</strong>
                  <span>{money(resolveTierBasePrice(product, priceTier), currency)}</span>
                </button>
                {renderUnitChips(product)}
              </div>
            ))}
          </div>
        </section>

        <aside className="grocery-pos-panel grocery-pos-cart">
          <div className="grocery-pos-panel-head">
            <h2>ตะกร้า ({PRICE_TIER_LABELS[priceTier]})</h2>
            <span>{cart.items.length} รายการ</span>
          </div>
          <div className="grocery-pos-cart-list">
            {cart.items.length === 0 ? <p className="grocery-pos-empty">ยังไม่มีสินค้า</p> : null}
            {cart.items.map((item) => (
              <div className="grocery-pos-cart-item" key={item.key}>
                <div>
                  <strong>{item.productName}</strong>
                  <span>
                    {item.unit ? `${item.unit.name} (${item.unit.quantity} ชิ้น)` : item.variant?.name ?? "ชิ้น"}
                    {" · "}
                    {money(item.unitPrice, currency)}/หน่วย
                  </span>
                </div>
                <div className="grocery-pos-qty">
                  <button
                    type="button"
                    onClick={() => setLineQuantity(item.key, item.quantity - 1)}
                  >
                    -
                  </button>
                  <QtyInput
                    quantity={item.quantity}
                    onCommit={(next) => setLineQuantity(item.key, next)}
                  />
                  <button
                    type="button"
                    onClick={() => setLineQuantity(item.key, item.quantity + 1)}
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

          {canDiscount ? (
            <div className="grocery-pos-discount-row">
              <select
                value={billDiscountType}
                onChange={(event) => setBillDiscountType(event.target.value === "percentage" ? "percentage" : "amount")}
              >
                <option value="amount">ส่วนลด (บาท)</option>
                <option value="percentage">ส่วนลด (%)</option>
              </select>
              <input
                value={billDiscountValue}
                onChange={(event) => setBillDiscountValue(event.target.value)}
                placeholder="0"
                inputMode="decimal"
              />
              <Button onClick={handleApplyBillDiscount}>ใช้ส่วนลด</Button>
            </div>
          ) : null}

          <footer className="grocery-pos-summary">
            <div>
              <span>ยอดรวมย่อย</span>
              <span>{money(displayCart.subtotal, currency)}</span>
            </div>
            {displayCart.discount > 0 ? (
              <div>
                <span>ส่วนลด{displayCart.discountNote ? ` (${displayCart.discountNote})` : ""}</span>
                <span>-{money(displayCart.discount, currency)}</span>
              </div>
            ) : null}
            <div className="grocery-pos-total">
              <span>รวมสุทธิ</span>
              <strong>{money(displayCart.total, currency)}</strong>
            </div>
            {receiptSettings?.showVatBreakdown && receiptSettings.vatRate > 0 ? (
              <div className="grocery-pos-vat-hint">
                <span>รวม VAT {receiptSettings.vatRate}% แล้ว</span>
                <span>
                  {money(
                    roundMoney((displayCart.total * receiptSettings.vatRate) / (100 + receiptSettings.vatRate)),
                    currency,
                  )}
                </span>
              </div>
            ) : null}
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
                ? `${selectedCustomer.name} / ${PRICE_TIER_LABELS[selectedCustomer.priceTier]}`
                : "ไม่ระบุ (ขายหน้าร้าน)"}
            </span>
          </div>
          <div className="grocery-pos-inline">
            <input
              value={customerQuery}
              onChange={(event) => setCustomerQuery(event.target.value)}
              placeholder="ค้นชื่อลูกค้าหรือเบอร์โทร"
            />
            <Button loading={isPending} onClick={handleCustomerSearch}>
              ค้นหา
            </Button>
          </div>
          {selectedCustomer ? (
            <div className="grocery-pos-selected-customer">
              <span>
                {formatPoints(selectedCustomer.pointsBalance)} แต้ม · {PRICE_TIER_LABELS[selectedCustomer.priceTier]}
              </span>
              <button type="button" onClick={clearCustomer}>
                ล้างลูกค้า
              </button>
            </div>
          ) : null}
          {customerResults.length > 0 ? (
            <div className="grocery-pos-customer-results">
              {customerResults.map((customer) => (
                <button type="button" key={customer.id} onClick={() => selectCustomer(customer)}>
                  <strong>{customer.name}</strong>
                  <span>
                    {customer.phone ?? customer.email ?? "ไม่มีข้อมูลติดต่อ"} · {PRICE_TIER_LABELS[customer.priceTier]} ·{" "}
                    {formatPoints(customer.pointsBalance)} แต้ม
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
            <Button loading={isPending} onClick={handleApplyCoupon}>
              ใช้คูปอง
            </Button>
          </div>
        </div>

        <div className="grocery-pos-panel">
          <div className="grocery-pos-panel-head">
            <h2>ชำระเงิน</h2>
            <span>{checkoutOrder?.orderNumber ?? "ยังไม่สร้างออร์เดอร์"}</span>
          </div>
          <Button className="grocery-pos-primary" loading={isPending} onClick={handleCreateOrder} disabled={cart.items.length === 0}>
            สร้างออร์เดอร์ {money(displayCart.total, currency)}
          </Button>
          <Button loading={isPending} onClick={handleVoidOrder} disabled={!checkoutOrder || checkoutOrder.status === "paid"}>
            ยกเลิกออร์เดอร์
          </Button>
          <div className="grocery-pos-inline">
            <input
              value={cashReceived}
              onChange={(event) => setCashReceived(event.target.value)}
              placeholder={money(displayCart.total, currency)}
              inputMode="decimal"
            />
            <Button loading={isPending} onClick={handleCashPayment} disabled={!checkoutOrder}>
              รับเงินสด
            </Button>
          </div>
          {changePreview > 0 ? (
            <p className="grocery-pos-change">เงินทอน {money(changePreview, currency)}</p>
          ) : null}
          <Button
            loading={isPending || isPrintingReceipt}
            onClick={() => handlePrintReceipt()}
            disabled={!checkoutOrder || checkoutOrder.status !== "paid"}
            loadingText={isPrintingReceipt ? "กำลังพิมพ์..." : undefined}
          >
            พิมพ์ใบเสร็จ
          </Button>
          {checkoutMessage ? <p className="grocery-pos-message">{checkoutMessage}</p> : null}
        </div>
      </section>

      {historyOpen ? (
        <div className="grocery-pos-modal-backdrop" role="dialog" aria-label="ประวัติบิล">
          <div className="grocery-pos-modal">
            <div className="grocery-pos-panel-head">
              <h2>ประวัติบิล</h2>
              <button type="button" onClick={() => setHistoryOpen(false)}>
                ปิด
              </button>
            </div>
            <div className="grocery-pos-history-filter">
              <label>
                จากวันที่
                <input type="date" value={historyFromDate} onChange={(event) => setHistoryFromDate(event.target.value)} />
              </label>
              <label>
                ถึงวันที่
                <input type="date" value={historyToDate} onChange={(event) => setHistoryToDate(event.target.value)} />
              </label>
              <Button loading={isPending} onClick={() => loadHistory(historyFromDate, historyToDate)}>
                ค้นหา
              </Button>
            </div>
            {historyMessage ? <p className="grocery-pos-message">{historyMessage}</p> : null}
            <div className="grocery-pos-history-list">
              {historyOrders.map((order) => (
                <div className="grocery-pos-history-row" key={order.id}>
                  <div>
                    <strong>{order.orderNumber}</strong>
                    <span>
                      {new Date(order.createdAt).toLocaleString("th-TH", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {" · "}
                      {order.items.length} รายการ · {ORDER_STATUS_LABELS[order.status] ?? order.status}
                    </span>
                  </div>
                  <strong>{money(order.total, currency)}</strong>
                  <Button
                    loading={isPrintingReceipt}
                    disabled={order.status !== "paid"}
                    onClick={() => handlePrintReceipt(order, { reprint: true })}
                  >
                    พิมพ์ซ้ำ
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {quickAddOpen ? (
        <div className="grocery-pos-modal-backdrop" role="dialog" aria-label="เพิ่มสินค้าเร็ว">
          <div className="grocery-pos-modal">
            <div className="grocery-pos-panel-head">
              <h2>เพิ่มสินค้าเร็ว</h2>
              <button type="button" onClick={() => setQuickAddOpen(false)}>
                ปิด
              </button>
            </div>
            <div className="grocery-pos-quickadd-grid">
              <label>
                ชื่อสินค้า *
                <input
                  value={quickAddDraft.name}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, name: event.target.value }))}
                  placeholder="เช่น น้ำปลาตราปู 700ml"
                />
              </label>
              <label>
                บาร์โค้ด
                <input
                  value={quickAddDraft.barcode}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, barcode: event.target.value }))}
                  placeholder="ยิงบาร์โค้ดได้เลย"
                />
              </label>
              <label>
                ราคาปลีก/หน่วย *
                <input
                  value={quickAddDraft.basePrice}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, basePrice: event.target.value }))}
                  inputMode="decimal"
                  placeholder="70"
                />
              </label>
              <label>
                หน่วยนับ
                <input
                  value={quickAddDraft.unitLabel}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, unitLabel: event.target.value }))}
                  placeholder="ชิ้น / ขวด / ถุง"
                />
              </label>
              <label>
                ราคาส่ง
                <input
                  value={quickAddDraft.priceWholesale}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, priceWholesale: event.target.value }))}
                  inputMode="decimal"
                  placeholder="เว้นว่าง = ใช้ราคาปลีก"
                />
              </label>
              <label>
                ราคาตัวแทน
                <input
                  value={quickAddDraft.priceAgent}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, priceAgent: event.target.value }))}
                  inputMode="decimal"
                  placeholder="เว้นว่าง = ใช้ราคาปลีก"
                />
              </label>
              <label>
                ราคาลูกค้าประจำ
                <input
                  value={quickAddDraft.priceRegular}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, priceRegular: event.target.value }))}
                  inputMode="decimal"
                  placeholder="เว้นว่าง = ใช้ราคาปลีก"
                />
              </label>
              <label>
                สต๊อกเริ่มต้น
                <input
                  value={quickAddDraft.initialStock}
                  onChange={(event) => setQuickAddDraft((d) => ({ ...d, initialStock: event.target.value }))}
                  inputMode="numeric"
                  placeholder="เว้นว่าง = ไม่ติดตามสต๊อก"
                />
              </label>
            </div>

            <div className="grocery-pos-panel-head" style={{ marginTop: 12 }}>
              <h2 style={{ fontSize: 15 }}>หน่วยแพ็ค (โหล/ลัง)</h2>
              <button
                type="button"
                onClick={() =>
                  setQuickAddDraft((d) => ({
                    ...d,
                    units: [...d.units, { name: "โหล", quantity: "12", price: "", priceWholesale: "", barcode: "" }],
                  }))
                }
              >
                + เพิ่มหน่วย
              </button>
            </div>
            {quickAddDraft.units.map((unit, index) => (
              <div className="grocery-pos-quickadd-unit" key={index}>
                <input
                  value={unit.name}
                  onChange={(event) => updateQuickAddUnit(index, { name: event.target.value })}
                  placeholder="ชื่อหน่วย เช่น โหล"
                />
                <input
                  value={unit.quantity}
                  onChange={(event) => updateQuickAddUnit(index, { quantity: event.target.value })}
                  inputMode="numeric"
                  placeholder="จำนวนชิ้น"
                />
                <input
                  value={unit.price}
                  onChange={(event) => updateQuickAddUnit(index, { price: event.target.value })}
                  inputMode="decimal"
                  placeholder="ราคาปลีก/หน่วย"
                />
                <input
                  value={unit.priceWholesale}
                  onChange={(event) => updateQuickAddUnit(index, { priceWholesale: event.target.value })}
                  inputMode="decimal"
                  placeholder="ราคาส่ง"
                />
                <input
                  value={unit.barcode}
                  onChange={(event) => updateQuickAddUnit(index, { barcode: event.target.value })}
                  placeholder="บาร์โค้ดแพ็ค"
                />
                <button
                  type="button"
                  onClick={() =>
                    setQuickAddDraft((d) => ({ ...d, units: d.units.filter((_, i) => i !== index) }))
                  }
                >
                  ลบ
                </button>
              </div>
            ))}

            {quickAddMessage ? <p className="grocery-pos-message">{quickAddMessage}</p> : null}
            <Button className="grocery-pos-primary" loading={isPending} onClick={handleQuickAddSubmit}>
              บันทึกสินค้า
            </Button>
          </div>
        </div>
      ) : null}

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
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
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
        .grocery-pos-tier-picker {
          font-size: 13px;
        }
        .grocery-pos-tier {
          padding: 6px 10px;
          font-size: 13px;
        }
        .grocery-pos-tier.active {
          background: var(--color-brand);
          color: var(--color-text-inverse);
          border-color: var(--color-brand);
        }
        .grocery-pos-tier:disabled {
          opacity: 0.55;
          cursor: not-allowed;
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
        .grocery-pos-search-results {
          margin-top: 10px;
          display: grid;
          gap: 6px;
          max-height: 320px;
          overflow-y: auto;
        }
        .grocery-pos-search-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 8px 10px;
          cursor: pointer;
        }
        .grocery-pos-search-row:hover {
          border-color: var(--color-brand);
        }
        .grocery-pos-search-info {
          display: grid;
        }
        .grocery-pos-search-info span {
          color: var(--color-text-secondary);
          font-size: 13px;
        }
        .grocery-pos-unit-chips {
          display: inline-flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .grocery-pos-unit-chip {
          font-size: 12px;
          padding: 4px 8px;
          border-radius: 999px;
        }
        .grocery-pos-unit-chip.pack {
          background: var(--color-brand);
          color: var(--color-text-inverse);
          border-color: var(--color-brand);
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
          grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
          gap: 10px;
        }
        .grocery-pos-product-card {
          display: grid;
          gap: 6px;
        }
        .grocery-pos-product-card > button {
          min-height: 72px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: space-between;
          text-align: left;
          width: 100%;
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
          grid-template-columns: 32px 52px 32px;
          align-items: center;
          text-align: center;
          gap: 2px;
        }
        .grocery-pos-qty button {
          padding: 6px;
        }
        /* :global — element ถูก render จาก QtyInput (คนละ component จึงไม่ได้ scoped class) */
        :global(.grocery-pos-qty-input) {
          min-height: 34px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          text-align: center;
          font-weight: 700;
          width: 100%;
        }
        .grocery-pos-discount-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 8px;
          margin-top: 12px;
        }
        .grocery-pos-discount-row select,
        .grocery-pos-discount-row input {
          min-height: 40px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 6px 10px;
        }
        .grocery-pos-summary {
          border-top: 2px solid var(--color-text-primary);
          margin-top: 14px;
          padding-top: 10px;
          display: grid;
          gap: 4px;
        }
        .grocery-pos-summary > div {
          display: flex;
          justify-content: space-between;
          color: var(--color-text-secondary);
          font-size: 14px;
        }
        .grocery-pos-summary .grocery-pos-total {
          color: var(--color-text-primary);
          font-size: 20px;
        }
        .grocery-pos-vat-hint {
          font-size: 12px;
        }
        .grocery-pos-change {
          margin-top: 8px;
          color: var(--color-brand);
          font-weight: 800;
          font-size: 18px;
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
        .grocery-pos-selected-customer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
          color: var(--color-text-secondary);
          font-size: 13px;
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
          flex-wrap: wrap;
        }
        .grocery-pos-customer-results span {
          color: var(--color-text-secondary);
          font-size: 13px;
        }
        .grocery-pos-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
          z-index: 60;
        }
        .grocery-pos-modal {
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: 18px;
          width: min(760px, 100%);
          max-height: 88vh;
          overflow-y: auto;
        }
        .grocery-pos-history-filter {
          display: flex;
          gap: 10px;
          align-items: end;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }
        .grocery-pos-history-filter label {
          display: grid;
          gap: 4px;
          font-size: 13px;
          color: var(--color-text-secondary);
        }
        .grocery-pos-history-filter input {
          min-height: 40px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 6px 10px;
        }
        .grocery-pos-history-list {
          display: grid;
          gap: 8px;
        }
        .grocery-pos-history-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
          align-items: center;
          gap: 10px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 8px 10px;
        }
        .grocery-pos-history-row span {
          color: var(--color-text-secondary);
          font-size: 13px;
          display: block;
        }
        .grocery-pos-quickadd-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .grocery-pos-quickadd-grid label {
          display: grid;
          gap: 4px;
          font-size: 13px;
          color: var(--color-text-secondary);
        }
        .grocery-pos-quickadd-grid input,
        .grocery-pos-quickadd-unit input {
          min-height: 40px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 6px 10px;
        }
        .grocery-pos-quickadd-unit {
          display: grid;
          grid-template-columns: 1.2fr 0.8fr 1fr 1fr 1.2fr auto;
          gap: 8px;
          margin-bottom: 8px;
        }
        @media (max-width: 860px) {
          .grocery-pos-shell {
            padding: 12px;
          }
          .grocery-pos-header,
          .grocery-pos-scan-row,
          .grocery-pos-grid,
          .grocery-pos-checkout,
          .grocery-pos-inline,
          .grocery-pos-quickadd-grid,
          .grocery-pos-quickadd-unit {
            grid-template-columns: 1fr;
          }
          .grocery-pos-header {
            display: grid;
          }
          .grocery-pos-cart-item {
            grid-template-columns: minmax(0, 1fr) auto;
          }
          .grocery-pos-history-row {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}
