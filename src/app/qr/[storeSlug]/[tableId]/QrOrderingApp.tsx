"use client";

import Image from "next/image";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { Store, Table } from "@/modules/stores/types";
import type { Category, Product, ModifierGroup } from "@/modules/catalog/types";
import {
  emptyCart,
  addToCart,
  removeFromCart,
  updateQuantity,
} from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import {
  submitQrOrderAction,
  getTableOrdersAction,
  requestServiceAction,
  type QrOrderItem,
} from "./actions";
import { PREP_STATUS_LABEL, type QrOrderView, type ServiceRequestType } from "@/modules/qr-ordering/types";
import type { QrMusicEligibility } from "@/modules/music-requests/gates";
import { MusicTab } from "./MusicTab";
import { Button } from "@/shared/components/ui";

interface Props {
  store: Store;
  table: Table;
  categories: Category[];
  products: Product[];
  /** Food tab is usable only while the table has an active session. */
  foodOrderingEnabled?: boolean;
  /** Music tab eligibility (Enterprise + license + QR mode/session). */
  musicEligibility?: QrMusicEligibility;
  /** Session id from the QR URL (`?s=`), forwarded to music actions. */
  querySessionId?: string | null;
}

type AppView = "menu" | "cart" | "success" | "track";

interface ProductModal {
  product: Product;
  selectedVariantId: string | null;
  selectedOptionIds: Map<string, string[]>;
  quantity: number;
  note: string;
}

function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

function computeModalPrice(modal: ProductModal): number {
  const base = modal.product.basePrice;
  const variantAdj = modal.selectedVariantId
    ? (modal.product.variants.find((v) => v.id === modal.selectedVariantId)?.priceAdjustment ?? 0)
    : 0;
  let modAdj = 0;
  modal.selectedOptionIds.forEach((optIds) => {
    for (const optId of optIds) {
      for (const group of modal.product.modifierGroups) {
        const opt = group.options.find((o) => o.id === optId);
        if (opt) modAdj += opt.priceAdjustment;
      }
    }
  });
  return (base + variantAdj + modAdj) * modal.quantity;
}

function buildQrOrderItem(modal: ProductModal): QrOrderItem {
  const modifierOptionIds = [...modal.selectedOptionIds.values()].flat();
  return {
    productId: modal.product.id,
    variantId: modal.selectedVariantId ?? undefined,
    modifierOptionIds,
    quantity: modal.quantity,
    note: modal.note.trim() || undefined,
  };
}

// --- Sub-components ---

function CategoryTabs({
  categories,
  selectedId,
  onSelect,
}: {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
      <button
        onClick={() => onSelect(null)}
        className={`shrink-0 min-h-11 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
          selectedId === null
            ? "bg-orange-500 text-white"
            : "bg-gray-100 text-gray-600"
        }`}
      >
        ทั้งหมด
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          onClick={() => onSelect(cat.id)}
            className={`shrink-0 min-h-11 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
            selectedId === cat.id
              ? "bg-orange-500 text-white"
              : "bg-gray-100 text-gray-600"
          }`}
        >
          {cat.name}
        </button>
      ))}
    </div>
  );
}

function ProductCard({
  product,
  currency,
  onTap,
}: {
  product: Product;
  currency: string;
  onTap: () => void;
}) {
  return (
    <button
      onClick={onTap}
      className="flex flex-col bg-white rounded-xl border border-gray-100 overflow-hidden text-left active:scale-95 transition-transform"
    >
      {product.imageUrl ? (
        <Image
          src={product.imageUrl}
          alt={product.name}
          width={320}
          height={320}
          unoptimized
          referrerPolicy="no-referrer"
          className="w-full aspect-square object-cover"
        />
      ) : (
        <div className="w-full aspect-square bg-gray-50 flex items-center justify-center">
          <span className="text-3xl">🍽️</span>
        </div>
      )}
      <div className="p-2">
        <p className="text-sm font-semibold text-gray-900 line-clamp-2">{product.name}</p>
        <p className="text-sm text-orange-600 font-medium mt-0.5">
          {formatPrice(product.basePrice, currency)}
        </p>
      </div>
    </button>
  );
}

function ModifierGroupSelector({
  group,
  selectedOptionIds,
  onChange,
}: {
  group: ModifierGroup;
  selectedOptionIds: string[];
  onChange: (optionIds: string[]) => void;
}) {
  const isSingle = group.selectionType === "single";

  function toggleOption(optId: string) {
    if (isSingle) {
      onChange([optId]);
    } else {
      if (selectedOptionIds.includes(optId)) {
        onChange(selectedOptionIds.filter((id) => id !== optId));
      } else {
        onChange([...selectedOptionIds, optId]);
      }
    }
  }

  return (
    <div className="mb-4">
      <p className="text-sm font-semibold text-gray-800 mb-1">
        {group.name}
        {group.isRequired && <span className="text-red-500 ml-1">*</span>}
      </p>
      <div className="space-y-1">
        {group.options.map((opt) => {
          const checked = selectedOptionIds.includes(opt.id);
          return (
            <label
              key={opt.id}
              className={`min-h-11 flex items-center justify-between px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                checked ? "border-orange-400 bg-orange-50" : "border-gray-200 bg-white"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type={isSingle ? "radio" : "checkbox"}
                  checked={checked}
                  onChange={() => toggleOption(opt.id)}
                  className="accent-orange-500"
                />
                <span className="text-sm text-gray-800">{opt.name}</span>
              </div>
              {opt.priceAdjustment !== 0 && (
                <span className="text-xs text-gray-500">
                  {opt.priceAdjustment > 0 ? "+" : ""}
                  {opt.priceAdjustment}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ProductModal({
  modal,
  currency,
  onClose,
  onAdd,
  onChange,
}: {
  modal: ProductModal;
  currency: string;
  onClose: () => void;
  onAdd: () => void;
  onChange: (patch: Partial<ProductModal>) => void;
}) {
  const { product } = modal;
  const price = computeModalPrice(modal);

  // Validate required groups
  const missingRequired = product.modifierGroups
    .filter((g) => g.isRequired)
    .some((g) => (modal.selectedOptionIds.get(g.id) ?? []).length === 0);

  const missingVariant = product.variants.length > 0 && !modal.selectedVariantId;
  const canAdd = !missingRequired && !missingVariant;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white rounded-t-2xl max-h-[90vh] flex flex-col">
        {product.imageUrl && (
          <Image
            src={product.imageUrl}
            alt={product.name}
            width={384}
            height={160}
            unoptimized
            referrerPolicy="no-referrer"
            className="w-full h-40 object-cover rounded-t-2xl"
          />
        )}
        <div className="p-4 flex-1 overflow-y-auto">
          <h2 className="text-lg font-bold text-gray-900">{product.name}</h2>
          {product.description && (
            <p className="text-sm text-gray-500 mt-1">{product.description}</p>
          )}

          {product.variants.length > 0 && (
            <div className="mt-4 mb-4">
              <p className="text-sm font-semibold text-gray-800 mb-1">
                 ขนาด / ตัวเลือก <span className="text-red-500">*</span>
              </p>
              <div className="space-y-1">
                {product.variants.map((v) => (
                  <label
                    key={v.id}
                    className={`min-h-11 flex items-center justify-between px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                      modal.selectedVariantId === v.id
                        ? "border-orange-400 bg-orange-50"
                        : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={modal.selectedVariantId === v.id}
                        onChange={() => onChange({ selectedVariantId: v.id })}
                        className="accent-orange-500"
                      />
                      <span className="text-sm text-gray-800">{v.name}</span>
                    </div>
                    {v.priceAdjustment !== 0 && (
                      <span className="text-xs text-gray-500">
                        {v.priceAdjustment > 0 ? "+" : ""}
                        {v.priceAdjustment}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {product.modifierGroups.map((group) => (
            <ModifierGroupSelector
              key={group.id}
              group={group}
              selectedOptionIds={modal.selectedOptionIds.get(group.id) ?? []}
              onChange={(ids) => {
                const next = new Map(modal.selectedOptionIds);
                next.set(group.id, ids);
                onChange({ selectedOptionIds: next });
              }}
            />
          ))}

          <div className="mt-2">
             <p className="text-sm font-semibold text-gray-800 mb-1">หมายเหตุ (ไม่บังคับ)</p>
            <input
              type="text"
              value={modal.note}
              onChange={(e) => onChange({ note: e.target.value })}
              placeholder="เช่น ไม่เผ็ด"
              className="w-full min-h-11 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
              maxLength={100}
            />
          </div>
        </div>

        <div className="p-4 border-t border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <button
                aria-label="ลดจำนวน"
                onClick={() => onChange({ quantity: Math.max(1, modal.quantity - 1) })}
                className="min-w-11 min-h-11 rounded-full bg-gray-100 text-gray-600 font-bold flex items-center justify-center"
              >
                −
              </button>
              <span className="text-base font-semibold w-6 text-center">{modal.quantity}</span>
              <button
                aria-label="เพิ่มจำนวน"
                onClick={() => onChange({ quantity: Math.min(99, modal.quantity + 1) })}
                className="min-w-11 min-h-11 rounded-full bg-orange-500 text-white font-bold flex items-center justify-center"
              >
                +
              </button>
            </div>
            <span className="text-base font-bold text-gray-900">{formatPrice(price, currency)}</span>
          </div>
          <button
            onClick={onAdd}
            disabled={!canAdd}
            className="w-full min-h-11 py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-40 bg-orange-500 active:bg-orange-600 transition-colors"
          >
            เพิ่มลงออร์เดอร์
          </button>
        </div>
      </div>
    </div>
  );
}

function CartView({
  cart,
  currency,
  onBack,
  onRemove,
  onQuantityChange,
  onSubmit,
  isPending,
}: {
  cart: Cart;
  currency: string;
  onBack: () => void;
  onRemove: (key: string) => void;
  onQuantityChange: (key: string, qty: number) => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-gray-100">
        <button aria-label="กลับไปหน้าเมนู" onClick={onBack} className="text-gray-500 min-w-11 min-h-11 flex items-center justify-center">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-base font-bold text-gray-900">ออร์เดอร์ของคุณ</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {cart.items.map((item) => (
          <div key={item.key} className="flex gap-3">
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">{item.productName}</p>
              {item.variant && (
                <p className="text-xs text-gray-500">{item.variant.name}</p>
              )}
              {item.modifiers.length > 0 && (
                <p className="text-xs text-gray-500">
                  {item.modifiers.map((m) => m.option.name).join(", ")}
                </p>
              )}
              {item.note && <p className="text-xs text-gray-400 italic">{item.note}</p>}
              <p className="text-sm text-orange-600 font-medium mt-0.5">
                {formatPrice(item.totalPrice, currency)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onQuantityChange(item.key, item.quantity - 1)}
                aria-label={`ลดจำนวน ${item.productName}`}
                className="min-w-11 min-h-11 rounded-full bg-gray-100 text-gray-600 font-bold text-sm flex items-center justify-center"
              >
                −
              </button>
              <span className="text-sm font-semibold w-4 text-center">{item.quantity}</span>
              <button
                onClick={() => onQuantityChange(item.key, Math.min(99, item.quantity + 1))}
                aria-label={`เพิ่มจำนวน ${item.productName}`}
                className="min-w-11 min-h-11 rounded-full bg-orange-500 text-white font-bold text-sm flex items-center justify-center"
              >
                +
              </button>
              <button
                onClick={() => onRemove(item.key)}
                aria-label={`ลบ ${item.productName}`}
                className="min-w-11 min-h-11 rounded-full bg-red-50 text-red-400 text-sm flex items-center justify-center ml-1"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-gray-100">
        <div className="flex justify-between items-center mb-4">
          <span className="text-base font-bold text-gray-900">ยอดรวม</span>
          <span className="text-base font-bold text-gray-900">{formatPrice(cart.total, currency)}</span>
        </div>
        <Button
          loading={isPending}
          loadingText="กำลังส่งออร์เดอร์..."
          onClick={onSubmit}
          disabled={cart.items.length === 0}
          className="w-full min-h-11 py-3 rounded-xl bg-orange-500 text-white font-semibold text-sm disabled:opacity-40 active:bg-orange-600 transition-colors"
        >
          ส่งออร์เดอร์
        </Button>
        <p className="text-xs text-gray-400 text-center mt-2">
          ชำระเงินที่เคาน์เตอร์เมื่อรับประทานเสร็จ
        </p>
      </div>
    </div>
  );
}

function SuccessScreen({
  orderNumber,
  onTrack,
  onOrderMore,
}: {
  orderNumber: string;
  onTrack: () => void;
  onOrderMore: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">ส่งออร์เดอร์แล้ว</h2>
      <p className="text-sm text-gray-500 mb-1">เลขออร์เดอร์ของคุณ</p>
      <p className="text-2xl font-bold text-orange-500 mb-4">{orderNumber}</p>
      <p className="text-sm text-gray-400 mb-6">ร้านกำลังเตรียมออร์เดอร์ของคุณ</p>
      <button onClick={onTrack} className="w-full max-w-xs min-h-11 py-3 rounded-xl bg-orange-500 text-white font-semibold text-sm active:bg-orange-600 transition-colors">
        ติดตามออร์เดอร์
      </button>
      <button onClick={onOrderMore} className="w-full max-w-xs min-h-11 py-3 mt-2 rounded-xl bg-gray-100 text-gray-700 font-semibold text-sm">
        สั่งเพิ่ม
      </button>
    </div>
  );
}

const PREP_BADGE_STYLE: Record<string, string> = {
  new: "bg-orange-100 text-orange-700",
  preparing: "bg-blue-100 text-blue-700",
  served: "bg-green-100 text-green-700",
  done: "bg-gray-100 text-gray-500",
};

function TrackView({
  orders,
  currency,
  loading,
  onRefresh,
  onBack,
  onService,
  serviceMsg,
  servicePending,
}: {
  orders: QrOrderView[];
  currency: string;
  loading: boolean;
  onRefresh: () => void;
  onBack: () => void;
  onService: (type: ServiceRequestType, reason?: string, okMsg?: string) => void;
  serviceMsg: string | null;
  servicePending: boolean;
}) {
  const unpaidTotal = orders
    .filter((o) => o.status !== "paid" && o.status !== "voided" && o.status !== "cancelled")
    .reduce((s, o) => s + o.total, 0);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-gray-100">
        <button aria-label="กลับไปหน้าเมนู" onClick={onBack} className="text-gray-500 min-w-11 min-h-11 flex items-center justify-center">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-base font-bold text-gray-900 flex-1">ออร์เดอร์ของฉัน</h2>
        <button onClick={onRefresh} aria-label="รีเฟรช" className="text-gray-400 min-w-11 min-h-11 flex items-center justify-center">
          <svg className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {orders.length === 0 ? (
          <p className="text-sm text-gray-400 text-center mt-8">
            {loading ? "กำลังโหลด..." : "ยังไม่มีออร์เดอร์"}
          </p>
        ) : (
          orders.map((order) => (
            <div key={order.id} className="rounded-xl border border-gray-100 bg-white p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-gray-900">#{order.orderNumber}</p>
                {order.status === "paid" ? (
                  <span className="rounded-full px-2.5 py-1 text-xs font-semibold bg-green-100 text-green-700">ชำระแล้ว</span>
                ) : (
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${PREP_BADGE_STYLE[order.prepStatus] ?? "bg-gray-100 text-gray-600"}`}>
                    {PREP_STATUS_LABEL[order.prepStatus]}
                  </span>
                )}
              </div>
              <ul className="mt-2 space-y-1">
                {order.items.map((it) => (
                  <li key={it.id} className="flex justify-between text-sm text-gray-600">
                    <span>
                      {it.quantity}× {it.productName}
                      {it.variantName ? ` (${it.variantName})` : ""}
                    </span>
                    <span>{formatPrice(it.totalPrice, currency)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex justify-between border-t border-gray-50 pt-2 text-sm font-semibold text-gray-900">
                <span>รวม</span>
                <span>{formatPrice(order.total, currency)}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-4 border-t border-gray-100 space-y-2">
        {orders.length > 0 && (
          <div className="flex justify-between text-sm font-bold text-gray-900">
            <span>ยอดที่ต้องชำระ</span>
            <span>{formatPrice(unpaidTotal, currency)}</span>
          </div>
        )}
        {serviceMsg && <p className="text-xs text-green-600 text-center">{serviceMsg}</p>}
        {menuOpen ? (
          <div className="space-y-2">
            <Button
              onClick={() => { onService("call_staff", undefined, "เรียกพนักงานแล้ว กำลังไปหาคุณ"); setMenuOpen(false); }}
              loading={servicePending}
              className="w-full min-h-11 py-3 rounded-xl bg-amber-100 text-amber-800 font-semibold text-sm disabled:opacity-50"
            >
              🙋 เรียกพนักงานทั่วไป
            </Button>
            <Button
              onClick={() => { onService("request_bill", undefined, "แจ้งขอเช็คบิลแล้ว"); setMenuOpen(false); }}
              loading={servicePending}
              className="w-full min-h-11 py-3 rounded-xl bg-purple-100 text-purple-800 font-semibold text-sm disabled:opacity-50"
            >
              🧾 ขอเช็คบิล
            </Button>
            <Button
              onClick={() => { onService("call_staff", "เกิดปัญหา", "แจ้งปัญหาให้พนักงานแล้ว"); setMenuOpen(false); }}
              loading={servicePending}
              className="w-full min-h-11 py-3 rounded-xl bg-red-100 text-red-800 font-semibold text-sm disabled:opacity-50"
            >
              ⚠️ เกิดปัญหา
            </Button>
            <button onClick={() => setMenuOpen(false)} className="w-full min-h-11 py-2 text-xs text-gray-400">
              ยกเลิก
            </button>
          </div>
        ) : (
          <Button
            onClick={() => setMenuOpen(true)}
            loading={servicePending}
            className="w-full min-h-11 py-3 rounded-xl bg-amber-500 text-white font-semibold text-sm disabled:opacity-50"
          >
            🔔 เรียกพนักงาน
          </Button>
        )}
        <p className="text-xs text-gray-400 text-center">กดเรียกพนักงานเพื่อขอเช็คบิล แจ้งปัญหา หรือสอบถาม</p>
      </div>
    </div>
  );
}

// --- Main component ---

export default function QrOrderingApp({
  store,
  table,
  categories,
  products,
  foodOrderingEnabled = true,
  musicEligibility,
  querySessionId = null,
}: Props) {
  const musicTabAvailable = !!musicEligibility?.canViewQueue;
  const [mainTab, setMainTab] = useState<"food" | "music">(
    foodOrderingEnabled ? "food" : musicTabAvailable ? "music" : "food",
  );
  const [view, setView] = useState<AppView>("menu");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(() => emptyCart(store.id));
  const [productModal, setProductModal] = useState<ProductModal | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // --- Order tracking + service requests ---
  const storageKey = `qr-orders:${store.id}:${table.id}`;
  const [myOrderIds, setMyOrderIds] = useState<string[]>([]);
  const [trackedOrders, setTrackedOrders] = useState<QrOrderView[]>([]);
  const [trackLoading, setTrackLoading] = useState(false);
  const [serviceMsg, setServiceMsg] = useState<string | null>(null);
  const [servicePending, startServiceTransition] = useTransition();

  useEffect(() => {
    let ids: string[] | null = null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) ids = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    if (ids && ids.length > 0) {
      startServiceTransition(() => setMyOrderIds(ids));
    }
  }, [storageKey]);

  const persistOrderIds = useCallback(
    (ids: string[]) => {
      setMyOrderIds(ids);
      try {
        localStorage.setItem(storageKey, JSON.stringify(ids));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const refreshTracked = useCallback(
    (ids: string[]) => {
      startServiceTransition(async () => {
        if (ids.length === 0) {
          setTrackedOrders([]);
          return;
        }
        setTrackLoading(true);
        const res = await getTableOrdersAction(store.id, table.id, ids);
        setTrackedOrders(res.orders);
        setTrackLoading(false);
      });
    },
    [store.id, table.id],
  );

  // Refresh statuses while viewing the tracking screen (poll every 15s).
  useEffect(() => {
    if (view !== "track") return;
    refreshTracked(myOrderIds);
    const id = setInterval(() => refreshTracked(myOrderIds), 15000);
    return () => clearInterval(id);
  }, [view, myOrderIds, refreshTracked]);

  function callService(type: ServiceRequestType, reason?: string, okMsg?: string) {
    setServiceMsg(null);
    startServiceTransition(async () => {
      const res = await requestServiceAction(store.id, table.id, type, reason);
      setServiceMsg(res.error ? res.error : (okMsg ?? "แจ้งพนักงานแล้ว กำลังไปหาคุณ"));
    });
  }

  const visibleProducts =
    selectedCategoryId === null
      ? products
      : products.filter((p) => p.categoryId === selectedCategoryId);

  function openProductModal(product: Product) {
    const defaultVariantId =
      product.variants.length === 1 ? product.variants[0].id : null;
    const defaultOptions = new Map<string, string[]>();
    for (const group of product.modifierGroups) {
      const defaultOpt = group.options.find((o) => o.isDefault);
      if (defaultOpt) defaultOptions.set(group.id, [defaultOpt.id]);
    }
    setProductModal({
      product,
      selectedVariantId: defaultVariantId,
      selectedOptionIds: defaultOptions,
      quantity: 1,
      note: "",
    });
  }

  function handleAddToCart() {
    if (!productModal) return;
    const item = buildQrOrderItem(productModal);
    const { product } = productModal;

    const variant = item.variantId
      ? product.variants.find((v) => v.id === item.variantId) ?? null
      : null;

    const allOptions = product.modifierGroups.flatMap((g) => g.options);
    const modifiers: { groupId: string; groupName: string; option: (typeof allOptions)[number] }[] = [];
    for (const optId of item.modifierOptionIds) {
      const opt = allOptions.find((o) => o.id === optId);
      const group = product.modifierGroups.find((g) => g.options.some((o) => o.id === optId));
      if (!opt || !group) {
        setSubmitError("เมนูมีการเปลี่ยนแปลง กรุณาโหลดหน้าใหม่");
        return;
      }
      modifiers.push({ groupId: group.id, groupName: group.name, option: opt });
    }

    setCart((prev) =>
      addToCart(prev, { product, variant, modifiers, quantity: productModal.quantity, note: productModal.note.trim() || undefined }),
    );
    setProductModal(null);
  }

  function handleSubmit() {
    setSubmitError(null);
    const qrItems: QrOrderItem[] = cart.items.map((item) => ({
      productId: item.productId,
      variantId: item.variant?.id,
      modifierOptionIds: item.modifiers.map((m) => m.option.id),
      quantity: item.quantity,
      note: item.note,
    }));

    startTransition(async () => {
      const result = await submitQrOrderAction(
        store.id,
        table.id,
        qrItems,
      );
      if (result.error) {
        setSubmitError(result.error);
        return;
      }
      if (result.orderId) {
        persistOrderIds([...new Set([result.orderId, ...myOrderIds])]);
      }
      setOrderNumber(result.orderNumber);
      setCart(emptyCart(store.id));
      setView("success");
    });
  }

  const cartCount = cart.items.reduce((s, i) => s + i.quantity, 0);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-sm mx-auto">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-gray-400">โต๊ะ {table.label ?? table.number}</p>
          <h1 className="text-base font-bold text-gray-900 truncate">{store.name}</h1>
        </div>
        {myOrderIds.length > 0 && view !== "track" && view !== "success" && (
          <button
            onClick={() => setView("track")}
            className="shrink-0 min-h-11 px-3 rounded-full bg-orange-50 text-orange-600 text-xs font-semibold"
          >
            ออร์เดอร์ของฉัน
          </button>
        )}
      </header>

      {/* Food / Music tab switcher (only when the music tab is available) */}
      {musicTabAvailable && (
        <div className="flex border-b border-gray-100 bg-white">
          <button
            onClick={() => setMainTab("food")}
            className={`flex-1 min-h-11 py-3 text-sm font-semibold transition-colors ${
              mainTab === "food" ? "text-orange-600 border-b-2 border-orange-500" : "text-gray-400"
            }`}
          >
            สั่งอาหาร
          </button>
          <button
            onClick={() => setMainTab("music")}
            className={`flex-1 min-h-11 py-3 text-sm font-semibold transition-colors ${
              mainTab === "music" ? "text-orange-600 border-b-2 border-orange-500" : "text-gray-400"
            }`}
          >
            ขอเพลง
          </button>
        </div>
      )}

      {mainTab === "music" && musicEligibility ? (
        <MusicTab
          storeId={store.id}
          tableId={table.id}
          querySessionId={querySessionId}
          eligibility={musicEligibility}
        />
      ) : !foodOrderingEnabled ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="mb-3 text-4xl">🍽️</div>
          <p className="text-sm font-semibold text-gray-700">ยังไม่ได้เปิดโต๊ะสำหรับสั่งอาหาร</p>
          <p className="mt-2 text-sm text-gray-400">
            กรุณาให้พนักงานเปิดโต๊ะเพื่อเริ่มสั่งอาหาร{musicTabAvailable ? " หรือไปที่แท็บ “ขอเพลง”" : ""}
          </p>
        </div>
      ) : view === "success" && orderNumber ? (
        <SuccessScreen
          orderNumber={orderNumber}
          onTrack={() => setView("track")}
          onOrderMore={() => setView("menu")}
        />
      ) : view === "track" ? (
        <TrackView
          orders={trackedOrders}
          currency={store.currencyCode}
          loading={trackLoading}
          onRefresh={() => refreshTracked(myOrderIds)}
          onBack={() => setView("menu")}
          onService={callService}
          serviceMsg={serviceMsg}
          servicePending={servicePending}
        />
      ) : view === "cart" ? (
        <CartView
          cart={cart}
          currency={store.currencyCode}
          onBack={() => setView("menu")}
          onRemove={(key) => setCart((prev) => removeFromCart(prev, key))}
          onQuantityChange={(key, qty) => setCart((prev) => updateQuantity(prev, key, qty))}
          onSubmit={handleSubmit}
          isPending={isPending}
        />
      ) : (
        <>
          {/* Category tabs */}
          <div className="bg-white px-4 pt-3 pb-2 sticky top-0 z-10 border-b border-gray-100">
            <CategoryTabs
              categories={categories}
              selectedId={selectedCategoryId}
              onSelect={setSelectedCategoryId}
            />
          </div>

          {/* Product grid */}
          <div className="flex-1 p-4">
            {visibleProducts.length === 0 ? (
              <p className="text-sm text-gray-400 text-center mt-8">ไม่มีรายการในหมวดนี้</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {visibleProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    currency={store.currencyCode}
                    onTap={() => openProductModal(product)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Cart bar */}
          {cartCount > 0 && (
            <div className="sticky bottom-0 p-4 bg-white border-t border-gray-100">
              {submitError && (
                <p className="text-xs text-red-500 text-center mb-2">{submitError}</p>
              )}
              <button
                onClick={() => setView("cart")}
                className="w-full min-h-11 py-3 px-4 rounded-xl bg-orange-500 text-white font-semibold text-sm flex items-center justify-between active:bg-orange-600 transition-colors"
              >
                <span className="bg-white text-orange-500 text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {cartCount}
                </span>
                <span>ดูออร์เดอร์</span>
                <span>{formatPrice(cart.total, store.currencyCode)}</span>
              </button>
            </div>
          )}
        </>
      )}

      {/* Product modal */}
      {productModal && (
        <ProductModal
          modal={productModal}
          currency={store.currencyCode}
          onClose={() => setProductModal(null)}
          onAdd={handleAddToCart}
          onChange={(patch) => setProductModal((prev) => prev ? { ...prev, ...patch } : null)}
        />
      )}
    </div>
  );
}
