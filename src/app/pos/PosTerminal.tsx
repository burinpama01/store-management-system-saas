"use client";

import { PrintQueueAlert } from "@/modules/printing/PrintQueueAlert";
import { memo, useCallback, useEffect, useMemo, type KeyboardEvent, type ReactNode, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { ConnectionBadge } from "@/shared/components/ConnectionBadge";
import { POS_TOPBAR_ACTIONS_ID } from "@/modules/pos/topbar-slot";
import { onPosCommand } from "@/modules/pos/section-bus";
// การจับคู่คำพูดกับชื่อตัวเลือกอยู่ในโมดูล voice-pos (ทดสอบแยกได้ และ normalize
// ภาษาไทย/เปอร์เซ็นต์อยู่ที่เดียวกับตัวแปลงตัวเลขของ parser)
import { matchesVoiceChoicePhrase, normalizeVoiceChoicePhrase } from "@/modules/voice-pos/parser";
import type { Category, Product, ProductVariant, ModifierOption, ModifierGroup } from "@/modules/catalog/types";
import type { Cart, CartItem, DiscountType, Order, PaymentMethod, SavedOrderTicket } from "@/modules/pos/types";
import {
  emptyCart,
  addToCart,
  updateQuantity,
  removeFromCart,
  applyDiscount,
  applyOrderDiscount,
  applyItemDiscount,
  removeItemDiscount,
} from "@/modules/pos/cart";
import type { AddToCartInput } from "@/modules/pos/cart";
import {
  checkoutAndPayAction,
  collectPaymentAction,
  searchPosCustomersAction,
  evaluatePosCouponAction,
  listSavedTicketsAction,
  saveSavedTicketAction,
  deleteSavedTicketAction,
  getReceiptLoyaltyClaimAction,
  listOrdersHistoryAction,
  listTodayOrdersAction,
  changeOrderPaymentMethodAction,
  voidOrderAction,
  addItemsToTableAction,
  type RewardProductLine,
} from "./actions";
import { useSearchParams } from "next/navigation";
import { signOut } from "../(dashboard)/actions";
import type { CustomerProfile } from "@/modules/customers/types";
import type { Printer, ReceiptSettings } from "@/modules/stores/types";
import { printReceiptWithFallback, type ReceiptPrintResult } from "@/modules/printing/receipt-printer";
import { buildDefaultModifierSelections } from "@/modules/pos/default-modifiers";
import { CashSessionPanel } from "./CashSessionPanel";
import type { CashSession } from "@/modules/cashflow/types";
import { QrCode } from "@/shared/components/ui/QrCode";
import { LocalizedLoading, Button, SubmitButton, ModalDialog, useConfirm } from "@/shared/components/ui";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { formatPoints } from "@/shared/utils/points";
import { PrinterConnectionPanel } from "@/modules/printing/PrinterConnectionPanel";
import { TableBillModal } from "./TableBillModal";
import { TableOpenModal } from "./TableOpenModal";
import { useRegisterVoiceCart, type VoiceCartApi } from "./unified/voice-cart-bridge";
import {
  publishCustomerDisplaySnapshot,
  resolveCustomerDisplayPublishCart,
  type CustomerDisplayCustomer,
  type CustomerDisplayPayment,
} from "@/modules/grocery-pos/customer-display";

// ─── Types ────────────────────────────────────────────────────────

type Phase = "ordering" | "payment" | "receipt";
type TicketDraft = Pick<SavedOrderTicket, "tableId" | "tableNumber" | "customerName" | "note" | "buffetSessionId">;
type DiscountDraft = { mode: DiscountType; amount: string; percentage: string; note: string };
type HistoryRangeMode = "today" | "7d" | "30d" | "custom";
type BillHistoryRange = { mode: HistoryRangeMode; fromDate: string; toDate: string };
type AppliedCoupon = { couponId: string; code: string; discount: number };
type ReceiptOrder = {
  orderNumber: string;
  items: CartItem[];
  subtotal: number;
  discount: number;
  discountNote?: string;
  total: number;
  method: string;
  receivedAmount?: number;
  changeAmount?: number;
  loyaltyPointsEarned?: number;
  loyaltyPointsBalance?: number;
  /** QR รับแต้มท้ายใบเสร็จ (เฉพาะบิลที่ยังไม่ผูกลูกค้า) — ดึงหลังจ่ายเงินสำเร็จ */
  loyaltyClaim?: { url: string; code: string; points: number; expiresAt: string };
  /** true = กำลังรอ QR รับแต้มจาก server อยู่ (พิมพ์อัตโนมัติต้องรอก่อน ไม่งั้นได้ใบที่ไม่มี QR) */
  loyaltyClaimPending?: boolean;
  /** สร้าง QR ไม่สำเร็จ — หยุดพิมพ์เพื่อไม่ส่งใบที่ขาดสิทธิ์รับแต้มให้ลูกค้า */
  loyaltyClaimError?: string;
};

const EMPTY_TICKET_DRAFT: TicketDraft = {
  tableId: undefined,
  tableNumber: "",
  customerName: "",
  note: "",
  buffetSessionId: undefined,
};

const EMPTY_DISCOUNT_DRAFT: DiscountDraft = { mode: "amount", amount: "", percentage: "", note: "" };

interface PickerState {
  product: Product;
  selectedVariant: ProductVariant | null;
  selectedModifiers: Record<string, ModifierOption[]>;
}

interface Props {
  storeId: string;
  storeName: string;
  categories: Category[];
  products: Product[];
  receiptSettings: ReceiptSettings | null;
  exitHref?: string | null;
  cashSession: CashSession | null;
  cashSalesPreview: number;
  /** เงินสดเข้า-ออกจริงตั้งแต่เปิดรอบ (รวมรายรับ/จ่ายเงินสดมือ) — พรีวิว "เงินที่ควรมี" */
  cashMovementPreview: number;
  currency: string;
  canDiscount: boolean;
  canRecordCashflow: boolean;
  storeTimezone: string;
  printers: Printer[];
  printerLoadError: string | null;
  couponEnabled: boolean;
  couponUnavailableMessage: string | null;
  loyaltyEnabled: boolean;
  loyaltyUnavailableMessage: string | null;
  customerDisplayEnabled: boolean;
  customerDisplayUnavailableMessage: string | null;
}

const POS_TICKET_STORAGE_PREFIX = "storeos.pos.tickets";

// ─── Helpers ──────────────────────────────────────────────────────

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

function priceStr(n: number) {
  return `฿${n.toLocaleString("th-TH")}`;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function buildCouponPreviewCart(cart: Cart, couponDiscount: number): Cart {
  const normalizedDiscount = roundMoney(Math.max(0, Math.min(couponDiscount, Math.max(0, cart.subtotal - cart.discount))));
  if (normalizedDiscount <= 0) return cart;
  const discount = roundMoney(cart.discount + normalizedDiscount);
  return {
    ...cart,
    discount,
    discountNote: cart.discountNote ? `${cart.discountNote}; Coupon` : "Coupon",
    total: roundMoney(Math.max(0, cart.subtotal - discount)),
  };
}

// Append a redeemed product reward as a ฿0 line. The server re-validates the voucher
// and rebuilds the line authoritatively from the catalog at checkout.
function appendRewardLine(cart: Cart, reward: RewardProductLine): Cart {
  if (cart.items.some((item) => item.rewardVoucherCode === reward.voucherCode)) return cart;
  const rewardItem: CartItem = {
    key: `reward:${reward.voucherCode}`,
    productId: reward.productId,
    productName: reward.productName,
    categoryId: "",
    variant: null,
    modifiers: [],
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
    rewardVoucherCode: reward.voucherCode,
    note: "🎁 ของรางวัล",
  };
  return { ...cart, items: [...cart.items, rewardItem] };
}

function productInitials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || "OS";
}

function PosProductImage({ product }: { product: Product }) {
  if (product.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={product.imageUrl}
        alt={`รูปเมนู ${product.name}`}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-100 text-sm font-bold text-slate-500">
      {productInitials(product.name)}
    </div>
  );
}

const PosProductTile = memo(function PosProductTile({
  product,
  disabled,
  onSelect,
}: {
  product: Product;
  disabled: boolean;
  onSelect: (product: Product) => void;
}) {
  const handleSelect = useCallback(() => onSelect(product), [onSelect, product]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleSelect}
      className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] text-left shadow-[var(--shadow-xs)] transition-all hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-sm)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-55"
    >
      <div className="aspect-[4/3] border-b border-gray-100">
        <PosProductImage product={product} />
      </div>
      <div className="p-3">
        <p className="text-sm font-medium text-gray-900 leading-snug line-clamp-2">
          {product.name}
        </p>
        <p className="mt-1.5 text-sm font-semibold text-gray-700 tabular-nums">
          {priceStr(product.basePrice)}
        </p>
        {product.variants.length > 0 && (
          <p className="text-xs text-gray-400 mt-0.5">{product.variants.length} ขนาด</p>
        )}
      </div>
    </button>
  );
});

function changeStr(received: number, total: number) {
  const change = received - total;
  if (change < 0) return null;
  return `เงินทอน ${priceStr(change)}`;
}

function dateInputValue(date = new Date(), timeZone = "Asia/Bangkok") {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    if (timeZone !== "Asia/Bangkok") return dateInputValue(date, "Asia/Bangkok");
  }
  return date.toISOString().slice(0, 10);
}

function addDateInputDays(dateString: string, days: number) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function createHistoryRange(mode: Exclude<HistoryRangeMode, "custom">, timeZone = "Asia/Bangkok", anchor = new Date()): BillHistoryRange {
  const toDate = dateInputValue(anchor, timeZone);
  const daysBack = mode === "30d" ? 29 : mode === "7d" ? 6 : 0;
  const fromDate = daysBack > 0 ? addDateInputDays(toDate, -daysBack) : toDate;
  return { mode, fromDate, toDate };
}

function normalizeHistoryRange(range: BillHistoryRange, timeZone = "Asia/Bangkok"): BillHistoryRange {
  const fromDate = range.fromDate || dateInputValue(new Date(), timeZone);
  const toDate = range.toDate || fromDate;
  if (fromDate <= toDate) return { ...range, fromDate, toDate };
  return { ...range, fromDate: toDate, toDate: fromDate };
}

function historyRangeLabel(range: BillHistoryRange) {
  if (range.mode === "today") return "วันนี้";
  if (range.mode === "7d") return "7 วันล่าสุด";
  if (range.mode === "30d") return "30 วันล่าสุด";
  return `${range.fromDate} ถึง ${range.toDate}`;
}

function discountDraftFromCart(cart: Cart): DiscountDraft {
  const mode = cart.discountType === "percentage" ? "percentage" : "amount";
  const discountValue = cart.discountValue ?? cart.discount;
  return {
    mode,
    amount: mode === "amount" && cart.discount > 0 ? String(discountValue) : "",
    percentage: mode === "percentage" && cart.discount > 0 ? String(discountValue) : "",
    note: cart.discountNote ?? "",
  };
}

function discountDraftFromItem(item: CartItem): DiscountDraft {
  const mode = item.discountType === "percentage" ? "percentage" : "amount";
  const discountValue = item.discountValue ?? item.discount ?? 0;
  return {
    mode,
    amount: mode === "amount" && (item.discount ?? 0) > 0 ? String(discountValue) : "",
    percentage: mode === "percentage" && (item.discount ?? 0) > 0 ? String(discountValue) : "",
    note: item.discountNote ?? "",
  };
}

function ticketStorageKey(storeId: string) {
  return `${POS_TICKET_STORAGE_PREFIX}.${storeId}`;
}

function createTicketId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTicketNumber(date = new Date()) {
  return `T${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}-${String(date.getTime()).slice(-4)}`;
}

function readSavedTickets(storeId: string): SavedOrderTicket[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ticketStorageKey(storeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedOrderTicket[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((ticket) => ticket?.cart?.storeId === storeId && Array.isArray(ticket.cart.items));
  } catch {
    return [];
  }
}

function writeSavedTickets(storeId: string, tickets: SavedOrderTicket[]) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(ticketStorageKey(storeId), JSON.stringify(tickets));
    return true;
  } catch {
    return false;
  }
}

function mergeSavedTickets(...groups: SavedOrderTicket[][]) {
  const tickets = new Map<string, SavedOrderTicket>();
  for (const group of groups) {
    for (const ticket of group) {
      if (!ticket?.id || !ticket?.cart || tickets.has(ticket.id)) continue;
      tickets.set(ticket.id, ticket);
    }
  }
  return [...tickets.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 30);
}

function ticketMetaLabel(ticket: SavedOrderTicket) {
  const parts = [
    ticket.tableNumber ? `โต๊ะ ${ticket.tableNumber}` : null,
    ticket.customerName || null,
    ticket.note || null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "ยังไม่มีข้อมูลโต๊ะ/ลูกค้า";
}

function ticketItemSummary(ticket: SavedOrderTicket) {
  const items = ticket.cart.items.slice(0, 3).map((item) => {
    const details = [
      item.variant?.name,
      ...item.modifiers.map(modifierDetail),
      item.note ? `หมายเหตุ: ${item.note}` : null,
    ].filter(Boolean);
    const suffix = details.length > 0 ? ` (${details.join(" · ")})` : "";
    return `${item.quantity}x ${item.productName}${suffix}`;
  });
  const hiddenCount = ticket.cart.items.length - items.length;
  if (hiddenCount > 0) items.push(`+${hiddenCount} รายการอื่น`);
  return items.join(" · ") || "ยังไม่มีรายการสินค้า";
}

function orderItemSummary(order: Order) {
  const items = order.items.slice(0, 3).map((item) => {
    const details = [
      item.variantName,
      ...item.modifiers.map(modifierDetail),
      item.note ? `หมายเหตุ: ${item.note}` : null,
    ].filter(Boolean);
    const suffix = details.length > 0 ? ` (${details.join(" · ")})` : "";
    return `${item.quantity}x ${item.productName}${suffix}`;
  });
  const hiddenCount = order.items.length - items.length;
  if (hiddenCount > 0) items.push(`+${hiddenCount} รายการอื่น`);
  return items.join(" · ") || "ไม่มีรายละเอียดรายการ";
}

function ticketTimeLabel(iso?: string) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function historyPaymentLabel(order: Order) {
  const paid = order.payments.find((payment) => payment.status === "completed") ?? order.payments[0];
  if (!paid) return order.status === "paid" ? "ชำระแล้ว" : "ยังไม่ชำระ";
  if (paid.method === "cash") return "เงินสด";
  if (paid.method === "qr_promptpay") return "QR พร้อมเพย์";
  return paid.method;
}

function modifierDetail(modifier: CartItem["modifiers"][number]) {
  const price = modifier.option.priceAdjustment;
  const suffix = price !== 0 ? ` (${price > 0 ? "+" : ""}${price})` : "";
  return `${modifier.modifierGroupName}: ${modifier.option.name}${suffix}`;
}

// ─── Modifier Picker ──────────────────────────────────────────────

function ModifierGroupPicker({
  group,
  selected,
  onToggle,
}: {
  group: ModifierGroup;
  selected: ModifierOption[];
  onToggle: (opt: ModifierOption) => void;
}) {
  const max = group.selectionType === "single" ? 1 : group.maxSelections;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-gray-600">
        {group.name}
        {group.isRequired && <span className="text-red-500 ml-1">*</span>}
        <span className="ml-1 text-gray-400 font-normal text-xs">
          ({group.selectionType === "single" ? "เลือก 1" : "หลายอัน"})
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {group.options.map((opt) => (
          <ModifierOptionButton
            key={opt.id}
            option={opt}
            selected={selected.some((item) => item.id === opt.id)}
            disabled={
              group.selectionType === "multiple" &&
              selected.length >= max &&
              !selected.some((item) => item.id === opt.id)
            }
            onToggle={() => onToggle(opt)}
          />
        ))}
      </div>
    </div>
  );
}

function ModifierOptionButton({
  option,
  selected,
  disabled,
  onToggle,
}: {
  option: ModifierOption;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`min-h-11 px-3 py-2 text-sm rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        selected
          ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
          : "border-gray-300 text-gray-700 hover:border-gray-500"
      }`}
    >
      {option.name}
      {option.priceAdjustment !== 0 && (
        <span className="ml-1 opacity-70">
          {option.priceAdjustment > 0 ? "+" : ""}
          {option.priceAdjustment}
        </span>
      )}
    </button>
  );
}

// ─── Product Picker Modal ─────────────────────────────────────────

/** U21 — จับคู่ชื่อตัวเลือกจากคำพูด: ตัดช่องว่าง/วงเล็บ/ตัวพิมพ์ ไม่มี fuzzy ที่เดาผิดได้ */
function ProductPickerModal({
  picker,
  onAdd,
  onClose,
}: {
  picker: PickerState;
  onAdd: (input: AddToCartInput) => void;
  onClose: () => void;
}) {
  const { product } = picker;
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(
    product.variants.length === 1 ? product.variants[0] : picker.selectedVariant,
  );
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, ModifierOption[]>>(
    picker.selectedModifiers,
  );
  const [note, setNote] = useState("");

  const unitPrice =
    product.basePrice +
    (selectedVariant?.priceAdjustment ?? 0) +
    Object.values(selectedModifiers).flat().reduce((s, o) => s + o.priceAdjustment, 0);

  const requiredGroupsMet = product.modifierGroups
    .filter((g) => g.isRequired)
    .every((g) => (selectedModifiers[g.id]?.length ?? 0) >= Math.max(1, g.minSelections));

  const variantRequired = product.variants.length > 0 && !selectedVariant;
  const canAdd = !variantRequired && requiredGroupsMet;

  function handleAdd() {
    onAdd({
      product,
      variant: selectedVariant,
      modifiers: Object.entries(selectedModifiers).flatMap(([groupId, options]) => {
        const group = product.modifierGroups.find((g) => g.id === groupId)!;
        return options.map((option) => ({ groupId, groupName: group.name, option }));
      }),
      note: note.trim() || undefined,
    });
    onClose();
  }

  function toggleModifier(group: ModifierGroup, option: ModifierOption) {
    setSelectedModifiers((prev) => {
      const current = prev[group.id] ?? [];
      if (group.selectionType === "single") {
        return { ...prev, [group.id]: [option] };
      }
      const selected = current.some((item) => item.id === option.id);
      if (selected) {
        return { ...prev, [group.id]: current.filter((item) => item.id !== option.id) };
      }
      if (current.length >= group.maxSelections) return prev;
      return { ...prev, [group.id]: [...current, option] };
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[80vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{product.name}</h3>
            <p className="text-xs text-gray-400">{priceStr(unitPrice)}</p>
          </div>
          <button onClick={onClose} className="min-w-11 min-h-11 text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {product.variants.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-gray-600">
                ขนาด / ตัวเลือก
                <span className="text-red-500 ml-1">*</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {product.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedVariant(v)}
                    className={`min-h-11 px-3 py-2 text-sm rounded border transition-colors ${
                      selectedVariant?.id === v.id
                        ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                        : "border-gray-300 text-gray-700 hover:border-gray-500"
                    }`}
                  >
                    {v.name}
                    {v.priceAdjustment !== 0 && (
                      <span className="ml-1 opacity-70">
                        {v.priceAdjustment > 0 ? "+" : ""}
                        {v.priceAdjustment}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {product.modifierGroups.map((group) => (
            <ModifierGroupPicker
              key={group.id}
              group={group}
              selected={selectedModifiers[group.id] ?? []}
              onToggle={(opt) => toggleModifier(group, opt)}
            />
          ))}
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-gray-600">หมายเหตุรายการ</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              rows={2}
              placeholder="เช่น ไม่หวาน แยกน้ำแข็ง รีบเสิร์ฟ"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[var(--tenant-primary)] focus:outline-none"
            />
          </label>
        </div>
        <div className="p-4 border-t border-gray-100">
          <button
            type="button"
            disabled={!canAdd}
            onClick={handleAdd}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-40"
          >
            เพิ่มในออร์เดอร์ — {priceStr(unitPrice)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Cart Panel ───────────────────────────────────────────────────

function CartPanel({
  cart,
  displayCart,
  appliedCoupon,
  selectedCustomerName,
  onOpenCustomerTools,
  onUpdateQty,
  onRemove,
  onCheckout,
  onClear,
  onApplyItemDiscount,
  onClearItemDiscount,
  itemDiscountResetKey,
  canDiscount,
  onOpenDiscountTools,
  activeTicket,
  isTicketSyncPending,
  savedTicketCount,
  billHistoryCount,
  ticketMessage,
  printStatusMessage,
  onSaveTicket,
  onOpenTickets,
  onOpenBillHistory,
  onClose,
}: {
  cart: Cart;
  displayCart?: Cart;
  appliedCoupon?: AppliedCoupon | null;
  /** ชื่อลูกค้าที่ผูกกับบิลนี้ — โชว์บนปุ่มเพื่อไม่ให้ข้อมูลหายไปกับการพับ */
  selectedCustomerName?: string | null;
  onOpenCustomerTools: () => void;
  onUpdateQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onCheckout: () => void;
  onClear: () => void;
  onApplyItemDiscount: (key: string, type: DiscountType, value: number, note?: string) => void;
  onClearItemDiscount: (key: string) => void;
  itemDiscountResetKey: number;
  canDiscount: boolean;
  onOpenDiscountTools: () => void;
  activeTicket: SavedOrderTicket | null;
  isTicketSyncPending: boolean;
  savedTicketCount: number;
  billHistoryCount: number;
  ticketMessage: string | null;
  printStatusMessage: string | null;
  onSaveTicket: () => void;
  onOpenTickets: () => void;
  onOpenBillHistory: () => void;
  onClose?: () => void;
}) {
  const summaryCart = displayCart ?? cart;

  return (
    <div className="flex flex-col h-full">
      {/* หัวแผงเป็นแถวเดียว — เดิมซ้อนสามแถว (ชื่อ / ปุ่มนับ 2 ปุ่ม / ปุ่มบันทึกตั๋ว)
          กินความสูงพอ ๆ กับช่องรายการเอง ปุ่มยังครบเท่าเดิม แค่เรียงในแถวเดียวกัน */}
      <div className="space-y-2 border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="shrink-0 text-sm font-semibold text-gray-800">ออร์เดอร์</span>
          {activeTicket && (
            <span className="min-w-0 truncate text-[11px] text-amber-600">
              · แก้ {activeTicket.ticketNumber}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onOpenTickets}
              title="ตั๋วที่เปิดค้างไว้"
              className="min-h-11 rounded-lg border border-amber-200 bg-amber-50 px-2 text-xs font-semibold text-amber-800"
            >
              ตั๋ว
              <span className="ml-1 rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] text-amber-700">
                {savedTicketCount}
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenBillHistory}
              title="ประวัติบิล"
              className="min-h-11 rounded-lg border border-gray-200 bg-gray-50 px-2 text-xs font-semibold text-gray-700"
            >
              บิล
              <span className="ml-1 rounded-full bg-white px-1.5 py-0.5 text-[10px] text-gray-500">
                {billHistoryCount}
              </span>
            </button>
            <Button
              loading={isTicketSyncPending}
              loadingText="..."
              disabled={cart.items.length === 0}
              onClick={onSaveTicket}
              title={activeTicket ? "บันทึกตั๋วกลับ" : "บันทึกตั๋วใหม่"}
              className="min-h-11 rounded-lg border border-amber-300 bg-amber-100 px-2 text-xs font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {activeTicket ? "เก็บตั๋ว" : "เก็บตั๋ว"}
            </Button>
            {cart.items.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                title="ล้างออร์เดอร์"
                className="min-h-11 px-2 text-xs text-red-400 hover:text-red-600"
              >
                ล้าง
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 px-2 text-xs text-gray-500 hover:text-gray-800 lg:hidden"
              >
                ปิด
              </button>
            )}
          </div>
        </div>
        {(ticketMessage || printStatusMessage) && (
          <div className="space-y-1">
            {ticketMessage && (
              <p aria-live="polite" className="text-xs text-amber-700">
                {ticketMessage}
              </p>
            )}
            {printStatusMessage && (
              <p aria-live="polite" className="text-xs text-teal-700">
                {printStatusMessage}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {cart.items.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs text-gray-400">
            ยังไม่มีรายการ
          </div>
        ) : (
          <ul className="divide-y divide-gray-50 px-3 py-1">
            {cart.items.map((item) => (
              <CartItemRow
                key={`${item.key}-${itemDiscountResetKey}`}
                item={item}
                onUpdateQty={onUpdateQty}
                onRemove={onRemove}
                onApplyItemDiscount={onApplyItemDiscount}
                onClearItemDiscount={onClearItemDiscount}
                canDiscount={canDiscount}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-gray-100 px-4 py-3 space-y-2">
        {/* ลูกค้า/คูปอง/จอลูกค้า พับเป็นปุ่มเดียว — แผงเต็มกินความสูงจนช่องรายการ
            ในออร์เดอร์แคบเกินใช้งาน (ปกติแคชเชียร์แตะไม่บ่อย เพราะลูกค้ารับแต้ม
            เองผ่าน QR ท้ายใบเสร็จอยู่แล้ว) สถานะที่เลือกไว้ยังโชว์บนปุ่ม */}
        <button
          type="button"
          onClick={onOpenCustomerTools}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-left transition-colors hover:bg-slate-100 motion-reduce:transition-none"
        >
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold text-slate-600">ลูกค้า / คูปอง / จอลูกค้า</span>
            <span className="block truncate text-[11px] text-slate-500">
              {selectedCustomerName || appliedCoupon
                ? [selectedCustomerName, appliedCoupon ? `คูปอง ${appliedCoupon.code}` : null]
                    .filter(Boolean)
                    .join(" · ")
                : "แตะเพื่อผูกลูกค้า ใช้คูปอง หรือเปิดจอลูกค้า"}
            </span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-xs text-slate-400">
            ›
          </span>
        </button>
        {canDiscount && (
          /* ส่วนลดท้ายบิลพับเป็นปุ่มเช่นกัน — ฟอร์มเต็ม (บาท/% + เหตุผล) ย้ายไป sheet
             ปุ่มยังโชว์ยอดที่ลดไว้แล้ว จึงไม่ต้องเปิดดูเพื่อรู้ว่ามีส่วนลดอยู่ */
          <button
            type="button"
            onClick={onOpenDiscountTools}
            disabled={cart.items.length === 0 && cart.discount === 0}
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-teal-100 bg-teal-50/50 px-3 py-2 text-left transition-colors hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          >
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold text-teal-900">ส่วนลดท้ายบิล</span>
              <span className="block truncate text-[11px] text-teal-700">
                {cart.discount > 0
                  ? `-${priceStr(cart.discount)}${cart.discountNote ? ` · ${cart.discountNote}` : ""}`
                  : "ลดจากยอดรวมทั้งออร์เดอร์"}
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-xs text-teal-400">
              ›
            </span>
          </button>
        )}
        <div className="flex justify-between text-xs text-gray-500">
          <span>ยอดรวม</span>
          <span className="tabular-nums">{priceStr(summaryCart.subtotal)}</span>
        </div>
        {cart.discount > 0 && (
          <div className="flex justify-between text-xs text-green-600">
            <span>ส่วนลดท้ายบิล</span>
            <span className="tabular-nums">-{priceStr(cart.discount)}</span>
          </div>
        )}
        {appliedCoupon && (
          <div className="flex justify-between text-xs text-green-600">
            <span>คูปอง {appliedCoupon.code}</span>
            <span className="tabular-nums">-{priceStr(appliedCoupon.discount)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-semibold text-gray-900 pt-1 border-t border-gray-100">
          <span>รวมทั้งหมด</span>
          <span className="tabular-nums">{priceStr(summaryCart.total)}</span>
        </div>
        <button
          type="button"
          disabled={cart.items.length === 0}
          onClick={onCheckout}
          className="btn-primary mt-2 w-full disabled:cursor-not-allowed disabled:opacity-40"
        >
          ชำระเงิน
        </button>
      </div>
    </div>
  );
}

/**
 * ฟอร์มส่วนลดท้ายบิล — อยู่ใน sheet ไม่ใช่ท้ายแผงออร์เดอร์ เพราะฟอร์มเต็ม
 * (เลือกบาท/% + ช่องกรอก + เหตุผล) กินความสูงจนช่องรายการเหลือไม่กี่บรรทัด
 */
function BillDiscountPanel({
  cart,
  discountMode,
  discountAmount,
  discountPercentage,
  discountNote,
  onDiscountDraftChange,
  onApplyDiscount,
  onClose,
}: {
  cart: Cart;
  discountMode: DiscountType;
  discountAmount: string;
  discountPercentage: string;
  discountNote: string;
  onDiscountDraftChange: (patch: Partial<DiscountDraft>) => void;
  onApplyDiscount: (type: DiscountType, value: number, note?: string) => void;
  onClose: () => void;
}) {
  const discountInputValue = discountMode === "percentage" ? discountPercentage : discountAmount;
  const parsedDiscountValue = Number(discountInputValue);
  const percentagePreview =
    discountMode === "percentage" && Number.isFinite(parsedDiscountValue)
      ? Math.min(cart.subtotal, Math.max(0, cart.subtotal * (parsedDiscountValue / 100)))
      : 0;
  const canApplyDiscount =
    cart.items.length > 0 &&
    discountInputValue.trim() !== "" &&
    Number.isFinite(parsedDiscountValue) &&
    parsedDiscountValue > 0 &&
    (discountMode === "amount" || parsedDiscountValue <= 100);

  function handleApplyDiscount() {
    if (!canApplyDiscount) return;
    onApplyDiscount(discountMode, parsedDiscountValue, discountNote.trim() || undefined);
    onClose();
  }

  function handleClearDiscount() {
    onApplyDiscount("amount", 0);
    onClose();
  }

  return (
    <div className="space-y-2">
      {cart.discount > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-900">
          <span className="min-w-0 truncate">
            ลดอยู่ <span className="font-semibold tabular-nums">-{priceStr(cart.discount)}</span>
            {cart.discountNote ? ` · ${cart.discountNote}` : ""}
          </span>
          <button
            type="button"
            onClick={handleClearDiscount}
            className="min-h-9 shrink-0 rounded-lg px-2 text-[11px] font-semibold text-red-500 hover:text-red-600"
          >
            ล้างส่วนลด
          </button>
        </div>
      )}
<div className="space-y-2">
        <div
          role="group"
          aria-label="ประเภทส่วนลด"
          className="grid grid-cols-2 gap-1 rounded-lg border border-teal-100 bg-white p-1"
        >
          <button
            type="button"
            aria-pressed={discountMode === "amount"}
            onClick={() => onDiscountDraftChange({ mode: "amount" })}
            className={`min-h-10 rounded-md px-3 text-xs font-semibold transition-colors ${
              discountMode === "amount"
                ? "bg-teal-700 text-white"
                : "text-teal-800 hover:bg-teal-50"
            }`}
          >
            บาท
          </button>
          <button
            type="button"
            aria-pressed={discountMode === "percentage"}
            onClick={() => onDiscountDraftChange({ mode: "percentage" })}
            className={`min-h-10 rounded-md px-3 text-xs font-semibold transition-colors ${
              discountMode === "percentage"
                ? "bg-teal-700 text-white"
                : "text-teal-800 hover:bg-teal-50"
            }`}
          >
            %
          </button>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          {discountMode === "amount" ? (
            <input
              type="number"
              inputMode="decimal"
              min="0"
              max={cart.subtotal}
              step="0.01"
              value={discountAmount}
              onChange={(event) => onDiscountDraftChange({ amount: event.target.value })}
              placeholder="0"
              aria-label="จำนวนส่วนลด"
              disabled={cart.items.length === 0}
              className="min-h-11 w-full rounded-lg border border-teal-100 bg-white px-3 text-sm font-semibold tabular-nums text-gray-900 placeholder:text-gray-300 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-300"
            />
          ) : (
            <input
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="0.01"
              value={discountPercentage}
              onChange={(event) => onDiscountDraftChange({ percentage: event.target.value })}
              placeholder="0"
              aria-label="เปอร์เซ็นต์ส่วนลด"
              disabled={cart.items.length === 0}
              className="min-h-11 w-full rounded-lg border border-teal-100 bg-white px-3 text-sm font-semibold tabular-nums text-gray-900 placeholder:text-gray-300 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-300"
            />
          )}
          <button
            type="button"
            disabled={!canApplyDiscount}
            onClick={handleApplyDiscount}
            className="min-h-11 rounded-lg border border-teal-200 bg-white px-3 text-xs font-semibold text-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ใช้ส่วนลด
          </button>
        </div>
        {discountMode === "percentage" && percentagePreview > 0 && parsedDiscountValue <= 100 && (
          <p className="text-[11px] text-teal-700">
            ลดประมาณ <span className="font-semibold tabular-nums">{priceStr(percentagePreview)}</span>
          </p>
        )}
        <input
          value={discountNote}
          onChange={(event) => onDiscountDraftChange({ note: event.target.value })}
          placeholder="เหตุผล/โปรโมชัน"
          aria-label="เหตุผลส่วนลด"
          disabled={cart.items.length === 0}
          className="min-h-10 w-full rounded-lg border border-teal-100 bg-white px-3 text-xs text-gray-700 placeholder:text-gray-300 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-300"
        />
      </div>
    </div>
  );
}

function CustomerCouponPanel({
  cart,
  loyaltyEnabled,
  loyaltyUnavailableMessage,
  couponEnabled,
  couponUnavailableMessage,
  customerDisplayEnabled,
  customerDisplayUnavailableMessage,
  customerQuery,
  customerResults,
  selectedCustomer,
  couponCode,
  appliedCoupon,
  message,
  isPending,
  onCustomerQueryChange,
  onSearchCustomer,
  onSelectCustomer,
  onClearCustomer,
  onCouponCodeChange,
  onApplyCoupon,
  onClearCoupon,
}: {
  cart: Cart;
  loyaltyEnabled: boolean;
  loyaltyUnavailableMessage: string | null;
  couponEnabled: boolean;
  couponUnavailableMessage: string | null;
  customerDisplayEnabled: boolean;
  customerDisplayUnavailableMessage: string | null;
  customerQuery: string;
  customerResults: CustomerProfile[];
  selectedCustomer: CustomerProfile | null;
  couponCode: string;
  appliedCoupon: AppliedCoupon | null;
  message: string | null;
  isPending: boolean;
  onCustomerQueryChange: (value: string) => void;
  onSearchCustomer: () => void;
  onSelectCustomer: (customer: CustomerProfile) => void;
  onClearCustomer: () => void;
  onCouponCodeChange: (value: string) => void;
  onApplyCoupon: () => void;
  onClearCoupon: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/80 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-600">ลูกค้า / คูปอง / จอลูกค้า</p>
        {customerDisplayEnabled ? (
          <a
            href="/pos/display"
            target="_blank"
            rel="noreferrer"
            className="min-h-8 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700"
          >
            จอลูกค้า
          </a>
        ) : (
          <span
            title={customerDisplayUnavailableMessage ?? undefined}
            className="rounded-lg border border-slate-100 bg-white px-2 py-1 text-[11px] font-semibold text-slate-300"
          >
            จอลูกค้า
          </span>
        )}
      </div>

      {loyaltyEnabled ? (
        selectedCustomer ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-2 text-xs">
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-800">{selectedCustomer.name}</p>
              <p className="text-[11px] text-slate-500">
                {selectedCustomer.phone ?? "ไม่มีเบอร์"} · แต้ม {formatPoints(selectedCustomer.pointsBalance)}
              </p>
            </div>
            <button type="button" onClick={onClearCustomer} className="min-h-9 px-2 text-[11px] font-semibold text-red-500">
              ล้าง
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <input
                value={customerQuery}
                onChange={(event) => onCustomerQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSearchCustomer();
                }}
                placeholder="ค้นชื่อลูกค้าหรือเบอร์โทร"
                className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 placeholder:text-slate-400"
              />
              <button
                type="button"
                disabled={isPending || customerQuery.trim().length === 0}
                onClick={onSearchCustomer}
                className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ค้นหา
              </button>
            </div>
            {customerResults.length > 0 && (
              <div className="max-h-28 space-y-1 overflow-y-auto">
                {customerResults.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => onSelectCustomer(customer)}
                    className="min-h-10 w-full rounded-lg border border-slate-100 bg-white px-2 py-1 text-left text-xs text-slate-700"
                  >
                    <span className="block truncate font-semibold">{customer.name}</span>
                    <span className="block text-[11px] text-slate-500">
                      {customer.phone ?? customer.email ?? "ไม่มีข้อมูลติดต่อ"} · แต้ม {formatPoints(customer.pointsBalance)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        <p className="rounded-lg bg-white px-2 py-2 text-[11px] text-slate-400">
          {loyaltyUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับสะสมแต้ม"}
        </p>
      )}

      {couponEnabled ? (
        <div className="space-y-1.5">
          {appliedCoupon ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-green-50 px-2 py-2 text-xs text-green-700">
              <span className="truncate font-semibold">ใช้คูปอง {appliedCoupon.code} -{priceStr(appliedCoupon.discount)}</span>
              <button type="button" onClick={onClearCoupon} className="min-h-9 px-2 text-[11px] font-semibold text-red-500">
                ล้าง
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <input
                value={couponCode}
                onChange={(event) => onCouponCodeChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onApplyCoupon();
                }}
                disabled={cart.items.length === 0}
                placeholder="รหัสคูปอง"
                className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs uppercase text-slate-800 placeholder:normal-case placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-100"
              />
              <button
                type="button"
                disabled={isPending || cart.items.length === 0 || couponCode.trim().length === 0}
                onClick={onApplyCoupon}
                className="min-h-10 rounded-lg border border-green-200 bg-white px-2 text-[11px] font-semibold text-green-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ใช้คูปอง
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="rounded-lg bg-white px-2 py-2 text-[11px] text-slate-400">
          {couponUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับคูปอง"}
        </p>
      )}

      {message && (
        <p aria-live="polite" className="text-[11px] text-slate-600">
          {message}
        </p>
      )}
    </div>
  );
}

function PosUtilitySheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      sheetRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/35"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={sheetRef}
        data-pos-utility-sheet="true"
        className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[420px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg px-3 text-xs font-semibold text-gray-500 hover:text-gray-800"
          >
            ปิด
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </div>
  );
}

function TicketPanel({
  cart,
  savedTickets,
  activeTicketId,
  activeTicket,
  ticketDraft,
  ticketMessage,
  printStatusMessage,
  isTicketSyncPending,
  isPrintingTicket,
  onSaveTicket,
  onPrintTicket,
  onLoadTicket,
  onDeleteTicket,
  onTicketDraftChange,
}: {
  cart: Cart;
  savedTickets: SavedOrderTicket[];
  activeTicketId: string | null;
  activeTicket: SavedOrderTicket | null;
  ticketDraft: TicketDraft;
  ticketMessage: string | null;
  printStatusMessage: string | null;
  isTicketSyncPending: boolean;
  isPrintingTicket: boolean;
  onSaveTicket: () => void;
  onPrintTicket: () => void;
  onLoadTicket: (ticket: SavedOrderTicket) => void;
  onDeleteTicket: (ticketId: string) => void;
  onTicketDraftChange: (patch: Partial<TicketDraft>) => void;
}) {
  const [ticketSearch, setTicketSearch] = useState("");
  const normalizedSearch = ticketSearch.trim().toLowerCase();
  const filteredSavedTickets = normalizedSearch
    ? savedTickets.filter((ticket) => [
      ticket.ticketNumber,
      ticket.label,
      ticket.tableNumber,
      ticket.customerName,
      ticket.note,
      ticket.syncState,
    ].some((value) => (value ?? "").toLowerCase().includes(normalizedSearch)))
    : savedTickets;

  return (
    <div className="relative space-y-4" aria-busy={isTicketSyncPending}>
      {isTicketSyncPending && (
        <LocalizedLoading
          variant="overlay"
          message="กำลังซิงค์ตั๋ว"
          detail="อัปเดตเฉพาะระบบตั๋ว หน้าขายยังไม่ต้องโหลดใหม่"
        />
      )}
      <fieldset disabled={isTicketSyncPending} aria-disabled={isTicketSyncPending} className="space-y-4 disabled:opacity-60">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] font-semibold text-gray-500">
          โต๊ะ
          <input
            value={ticketDraft.tableNumber ?? ""}
            onChange={(event) => onTicketDraftChange({ tableNumber: event.target.value })}
            placeholder="เช่น 12"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-xs font-normal text-gray-800"
          />
        </label>
        <label className="text-[11px] font-semibold text-gray-500">
          ลูกค้า
          <input
            value={ticketDraft.customerName ?? ""}
            onChange={(event) => onTicketDraftChange({ customerName: event.target.value })}
            placeholder="ชื่อลูกค้า"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-xs font-normal text-gray-800"
          />
        </label>
        <label className="col-span-2 text-[11px] font-semibold text-gray-500">
          note
          <input
            value={ticketDraft.note ?? ""}
            onChange={(event) => onTicketDraftChange({ note: event.target.value })}
            placeholder="หมายเหตุของตั๋ว"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-xs font-normal text-gray-800"
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          loading={isTicketSyncPending}
          loadingText="กำลังบันทึก..."
          disabled={cart.items.length === 0}
          onClick={onSaveTicket}
          className="min-h-11 rounded-lg border border-amber-200 px-3 text-xs font-semibold text-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {activeTicket ? "บันทึกทับตั๋ว" : "บันทึกตั๋ว"}
        </Button>
        <Button
          loading={isPrintingTicket}
          loadingText="กำลังพิมพ์..."
          disabled={cart.items.length === 0}
          onClick={onPrintTicket}
          className="min-h-11 rounded-lg border border-gray-300 px-3 text-xs font-semibold text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          พิมพ์ใบสั่ง
        </Button>
      </div>
      <p className="text-[11px] text-gray-500">ใบสั่งออเดอร์ ไม่ใช่ใบเสร็จ</p>
      {ticketMessage && (
        <p aria-live="polite" className="text-xs text-amber-700">
          {ticketMessage}
        </p>
      )}
      {printStatusMessage && (
        <p aria-live="polite" className="text-xs text-teal-700">
          {printStatusMessage}
        </p>
      )}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-gray-500">ตั๋วที่บันทึก</p>
          <input
            value={ticketSearch}
            onChange={(event) => setTicketSearch(event.target.value)}
            placeholder="ค้นหาตั๋ว/โต๊ะ/ลูกค้า"
            className="min-h-9 w-36 rounded-lg border border-gray-200 px-2 text-[11px]"
          />
        </div>
        {filteredSavedTickets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 py-4 text-center text-xs text-gray-400">
            ยังไม่มีตั๋วที่บันทึก
          </p>
        ) : (
          <ul className="max-h-[45dvh] space-y-1 overflow-y-auto pr-1">
            {filteredSavedTickets.map((ticket) => (
              <li key={ticket.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => onLoadTicket(ticket)}
                  className={`min-h-11 flex-1 rounded-lg border px-3 py-2 text-left text-xs ${
                    ticket.id === activeTicketId
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : "border-gray-200 text-gray-700 hover:border-gray-300"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2 font-semibold">
                    <span>{ticket.ticketNumber}</span>
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                      {ticket.syncState === "sync_failed" ? "sync fail" : ticket.syncState === "local" ? "local" : "synced"}
                    </span>
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    {ticket.cart.items.length} รายการ · {priceStr(ticket.cart.total)}
                  </span>
                  <span className="block text-[11px] leading-snug text-gray-600">
                    {ticketItemSummary(ticket)}
                  </span>
                  <span className="block truncate text-[11px] text-gray-500">
                    {ticketMetaLabel(ticket)}
                  </span>
                  <span className="block text-[10px] text-gray-400">
                    แก้ล่าสุด {ticketTimeLabel(ticket.updatedAt)} · sync {ticketTimeLabel(ticket.lastSyncedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={isTicketSyncPending}
                  onClick={() => onDeleteTicket(ticket.id)}
                  className="min-h-11 rounded-lg px-2 text-[11px] text-red-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={ticket.tableId ? `ลบตั๋วและเคลียร์โต๊ะ ${ticket.ticketNumber}` : `ลบตั๋ว ${ticket.ticketNumber}`}
                >
                  ลบ
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </fieldset>
    </div>
  );
}

function BillHistoryPanel({
  orders,
  isPending,
  historyRange,
  storeTimezone,
  onHistoryRangeChange,
  onRefresh,
  onPrint,
  onVoid,
  onChangePayment,
  historyMode = "compact",
}: {
  orders: Order[];
  isPending: boolean;
  historyRange: BillHistoryRange;
  storeTimezone: string;
  onHistoryRangeChange: (range: BillHistoryRange) => void;
  onRefresh: (range?: BillHistoryRange) => void;
  onPrint: (order: Order) => void;
  onVoid: (order: Order) => void;
  onChangePayment: (order: Order) => void;
  historyMode?: "compact" | "sheet";
}) {
  const compactBillHistoryLimit = 8;
  const visibleOrders = historyMode === "sheet" ? orders : orders.slice(0, compactBillHistoryLimit);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);

  return (
    <div className="relative space-y-1.5 rounded-lg border border-gray-100 bg-gray-50 p-2" aria-busy={isPending}>
      {isPending && (
        <LocalizedLoading
          variant="overlay"
          message="กำลังโหลดประวัติบิล"
          detail="โหลดเฉพาะรายการบิลในช่วงที่เลือก"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-gray-600">บิลย้อนหลัง</p>
          <p className="text-[10px] text-gray-400">{historyRangeLabel(historyRange)}</p>
        </div>
        <button
          type="button"
          onClick={() => onRefresh()}
          disabled={isPending}
          className="min-h-8 rounded border border-gray-200 bg-white px-2 text-[11px] text-gray-600 disabled:opacity-50"
        >
          {isPending ? "กำลังโหลด..." : "รีเฟรช"}
        </button>
      </div>
      {historyMode === "sheet" && (
        <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-2">
          <div className="grid grid-cols-3 gap-1" role="group" aria-label="ช่วงประวัติบิล">
            <button
              type="button"
              value="today"
              onClick={() => onHistoryRangeChange(createHistoryRange("today", storeTimezone))}
              className={`min-h-9 rounded-lg px-2 text-[11px] font-semibold ${
                historyRange.mode === "today" ? "bg-teal-700 text-white" : "bg-gray-50 text-gray-600"
              }`}
            >
              วันนี้
            </button>
            <button
              type="button"
              value="7d"
              onClick={() => onHistoryRangeChange(createHistoryRange("7d", storeTimezone))}
              className={`min-h-9 rounded-lg px-2 text-[11px] font-semibold ${
                historyRange.mode === "7d" ? "bg-teal-700 text-white" : "bg-gray-50 text-gray-600"
              }`}
            >
              7 วัน
            </button>
            <button
              type="button"
              value="30d"
              onClick={() => onHistoryRangeChange(createHistoryRange("30d", storeTimezone))}
              className={`min-h-9 rounded-lg px-2 text-[11px] font-semibold ${
                historyRange.mode === "30d" ? "bg-teal-700 text-white" : "bg-gray-50 text-gray-600"
              }`}
            >
              30 วัน
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] font-semibold text-gray-500">
              จากวันที่
              <input
                type="date"
                value={historyRange.fromDate}
                onChange={(event) => onHistoryRangeChange(normalizeHistoryRange({ ...historyRange, mode: "custom", fromDate: event.target.value }, storeTimezone))}
                className="mt-1 min-h-10 w-full rounded-lg border border-gray-200 px-2 text-xs text-gray-700"
              />
            </label>
            <label className="text-[10px] font-semibold text-gray-500">
              ถึงวันที่
              <input
                type="date"
                value={historyRange.toDate}
                onChange={(event) => onHistoryRangeChange(normalizeHistoryRange({ ...historyRange, mode: "custom", toDate: event.target.value }, storeTimezone))}
                className="mt-1 min-h-10 w-full rounded-lg border border-gray-200 px-2 text-xs text-gray-700"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => onRefresh(historyRange)}
            disabled={isPending}
            className="min-h-10 w-full rounded-lg border border-teal-100 bg-teal-50 px-3 text-xs font-semibold text-teal-800 disabled:opacity-50"
          >
            ดูบิลช่วงนี้
          </button>
        </div>
      )}
      {orders.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-gray-400">ยังไม่มีบิลในช่วงนี้</p>
      ) : (
        <ul className={`${historyMode === "sheet" ? "max-h-[60dvh]" : "max-h-28"} space-y-1 overflow-y-auto pr-1`}>
          {visibleOrders.map((order) => (
            <li key={order.id} className="rounded-lg border border-gray-200 bg-white p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-gray-800">{order.orderNumber}</p>
                  <p className="text-[11px] text-gray-500">
                    {order.tableNumber ? `โต๊ะ ${order.tableNumber} · ` : ""}{historyPaymentLabel(order)} · {priceStr(order.total)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-gray-600">
                    {orderItemSummary(order)}
                  </p>
                </div>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                  order.status === "paid" ? "bg-green-50 text-green-700" : order.status === "voided" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"
                }`}>
                  {order.status}
                </span>
              </div>
              <div className="mt-2 space-y-1">
                <button
                  type="button"
                  onClick={() => setDetailOrder(order)}
                  className="min-h-9 w-full rounded border border-teal-100 bg-teal-50 px-2 text-[11px] font-semibold text-teal-800"
                >
                  ดูรายละเอียด
                </button>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => onPrint(order)}
                    className="min-h-9 rounded border border-gray-200 px-2 text-[11px] text-gray-700"
                  >
                    พิมพ์ซ้ำ
                  </button>
                  <button
                    type="button"
                    disabled={order.status === "paid" || order.status === "voided"}
                    onClick={() => onVoid(order)}
                    className="min-h-9 rounded border border-red-100 px-2 text-[11px] text-red-500 disabled:opacity-40"
                  >
                    ยกเลิก
                  </button>
                </div>
                {/* บิลที่จ่ายแล้วยกเลิกจากตรงนี้ไม่ได้ ทางแก้เดียวเมื่อลงช่องทางผิด
                    (เช่น ลูกค้าโอนแต่กดเงินสด) คือแก้ช่องทางชำระของบิลนั้น */}
                {order.status === "paid" && (
                  <button
                    type="button"
                    onClick={() => onChangePayment(order)}
                    className="min-h-9 w-full rounded border border-amber-200 bg-amber-50 px-2 text-[11px] font-semibold text-amber-800"
                  >
                    แก้ช่องทางชำระ
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {detailOrder && (
        <BillDetailModal
          order={detailOrder}
          storeTimezone={storeTimezone}
          onClose={() => setDetailOrder(null)}
        />
      )}
    </div>
  );
}

const CHANGEABLE_PAYMENT_METHODS: PaymentMethod[] = [
  "cash",
  "qr_promptpay",
  "bank_transfer",
  "credit_card",
  "other",
];

/**
 * แก้ช่องทางชำระของบิลที่จ่ายแล้ว — ใช้ตอนพนักงานลงผิดประเภท (ลูกค้าโอนแต่กดเงินสด)
 * ยอดขายไม่เปลี่ยน เปลี่ยนแค่ประเภทเงินที่รับ ระบบจะปรับเงินสดในลิ้นชักให้เอง
 */
function ChangePaymentModal({
  order,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  order: Order;
  isPending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (method: PaymentMethod, reason: string) => void;
}) {
  const currentMethod = order.payments[0]?.method;
  const [method, setMethod] = useState<PaymentMethod>(
    CHANGEABLE_PAYMENT_METHODS.find((option) => option !== currentMethod) ?? "bank_transfer",
  );
  const [reason, setReason] = useState("");

  return (
    <ModalDialog
      open
      title={`แก้ช่องทางชำระ ${order.orderNumber}`}
      description={`ยอด ${priceStr(order.total)} บาท · ตอนนี้บันทึกเป็น ${currentMethod ? paymentMethodLabel(currentMethod) : "ไม่ทราบ"}`}
      onClose={onClose}
      size="sm"
    >
      <div className="space-y-3">
        <div className="grid gap-1">
          {CHANGEABLE_PAYMENT_METHODS.filter((option) => option !== currentMethod).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMethod(option)}
              className={`min-h-10 rounded-lg border px-3 text-left text-sm ${
                method === option
                  ? "border-teal-600 bg-teal-50 font-semibold text-teal-800"
                  : "border-gray-200 text-gray-700"
              }`}
            >
              {paymentMethodLabel(option)}
            </button>
          ))}
        </div>
        <label className="block text-xs font-semibold text-gray-600">
          เหตุผล (บันทึกไว้ตรวจย้อนหลัง)
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="เช่น ลูกค้าโอน แต่กดเงินสด"
            className="mt-1 min-h-10 w-full rounded-lg border border-gray-200 px-2 text-sm"
          />
        </label>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
          แก้ได้เฉพาะบิลในรอบเงินสดที่เปิดอยู่ · เงินสดในลิ้นชักจะถูกปรับให้อัตโนมัติ
          และบันทึกไว้ในบัญชีรายวัน · หลังแก้เสร็จ ระบบจะพิมพ์ใบใหม่ที่มีป้าย REPRINT ให้ทันที
        </p>
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <p className="font-semibold">แก้ช่องทางชำระไม่สำเร็จ</p>
            <p className="mt-1 text-xs leading-relaxed">สาเหตุ: {error}</p>
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 flex-1 rounded-lg border border-gray-200 text-sm text-gray-600"
          >
            ยกเลิก
          </button>
          <Button
            className="flex-1"
            loading={isPending}
            onClick={() => onSubmit(method, reason.trim())}
          >
            บันทึกช่องทางใหม่
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}

function paymentMethodLabel(method: string) {
  if (method === "cash") return "เงินสด";
  if (method === "qr_promptpay") return "QR พร้อมเพย์";
  if (method === "credit_card") return "บัตรเครดิต";
  if (method === "bank_transfer") return "โอนธนาคาร";
  return method;
}

function BillDetailModal({
  order,
  storeTimezone,
  onClose,
}: {
  order: Order;
  storeTimezone: string;
  onClose: () => void;
}) {
  const dateLabel = (() => {
    try {
      return new Intl.DateTimeFormat("th-TH", {
        timeZone: storeTimezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(order.createdAt));
    } catch {
      return order.createdAt;
    }
  })();
  const cashPayment = order.payments.find((payment) => payment.method === "cash");
  const statusClass =
    order.status === "paid"
      ? "bg-green-50 text-green-700"
      : order.status === "voided"
        ? "bg-red-50 text-red-600"
        : "bg-amber-50 text-amber-700";

  return (
    <ModalDialog open title={`บิล ${order.orderNumber}`} onClose={onClose} size="md">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-gray-500">{dateLabel}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass}`}>{order.status}</span>
        </div>
        {order.tableNumber && <p className="text-xs text-gray-500">โต๊ะ {order.tableNumber}</p>}
        {order.note && <p className="text-xs text-gray-600">หมายเหตุ: {order.note}</p>}

        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {order.items.map((item) => {
            const details = [
              item.variantName,
              ...item.modifiers.map(modifierDetail),
              item.note ? `หมายเหตุ: ${item.note}` : null,
            ].filter(Boolean);
            return (
              <div key={item.id} className="p-2">
                <div className="flex justify-between gap-2">
                  <span className="font-medium text-gray-800">
                    {item.quantity}x {item.productName}
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-700">{priceStr(item.totalPrice)}</span>
                </div>
                {details.length > 0 && (
                  <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{details.join(" · ")}</p>
                )}
                <p className="text-[11px] text-gray-400">
                  @ {priceStr(item.unitPrice)}
                  {item.discount ? ` · ส่วนลด -${priceStr(item.discount)}` : ""}
                </p>
              </div>
            );
          })}
        </div>

        <div className="space-y-0.5">
          <div className="flex justify-between text-xs text-gray-600">
            <span>ยอดรวม</span>
            <span className="tabular-nums">{priceStr(order.subtotal)}</span>
          </div>
          {order.discount > 0 && (
            <div className="flex justify-between text-xs text-gray-600">
              <span>ส่วนลด</span>
              <span className="tabular-nums">-{priceStr(order.discount)}</span>
            </div>
          )}
          {order.couponDiscountAmount ? (
            <div className="flex justify-between text-xs text-gray-600">
              <span>คูปอง</span>
              <span className="tabular-nums">-{priceStr(order.couponDiscountAmount)}</span>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-gray-100 pt-1 text-sm font-semibold text-gray-900">
            <span>สุทธิ</span>
            <span className="tabular-nums">{priceStr(order.total)}</span>
          </div>
        </div>

        {order.payments.length > 0 && (
          <div className="space-y-0.5 rounded-lg border border-gray-200 p-2 text-xs">
            {order.payments.map((payment) => (
              <div key={payment.id} className="flex justify-between text-gray-700">
                <span>
                  {paymentMethodLabel(payment.method)}
                  {payment.status !== "completed" ? ` (${payment.status})` : ""}
                </span>
                <span className="tabular-nums">{priceStr(payment.amount)}</span>
              </div>
            ))}
            {cashPayment?.receivedAmount !== undefined && (
              <div className="flex justify-between text-gray-400">
                <span>รับเงิน</span>
                <span className="tabular-nums">{priceStr(cashPayment.receivedAmount)}</span>
              </div>
            )}
            {cashPayment?.changeAmount !== undefined && (
              <div className="flex justify-between text-gray-400">
                <span>เงินทอน</span>
                <span className="tabular-nums">{priceStr(cashPayment.changeAmount)}</span>
              </div>
            )}
          </div>
        )}

        {(order.loyaltyPointsEarned || order.loyaltyPointsRedeemed) ? (
          <p className="text-[11px] text-gray-500">
            {order.loyaltyPointsEarned ? `ได้แต้ม +${formatPoints(order.loyaltyPointsEarned)} ` : ""}
            {order.loyaltyPointsRedeemed ? `ใช้แต้ม -${formatPoints(order.loyaltyPointsRedeemed)}` : ""}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function CartItemRow({
  item,
  onUpdateQty,
  onRemove,
  onApplyItemDiscount,
  onClearItemDiscount,
  canDiscount,
}: {
  item: CartItem;
  onUpdateQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onApplyItemDiscount: (key: string, type: DiscountType, value: number, note?: string) => void;
  onClearItemDiscount: (key: string) => void;
  canDiscount: boolean;
}) {
  const itemDiscountFingerprint = [
    item.key,
    item.discount ?? 0,
    item.discountType ?? "",
    item.discountValue ?? 0,
    item.discountNote ?? "",
  ].join("|");
  const [itemDiscountFormOpen, setItemDiscountFormOpen] = useState(false);
  const [itemDiscountDraftState, setItemDiscountDraftState] = useState<{
    fingerprint: string;
    draft: DiscountDraft;
  }>(() => ({
    fingerprint: itemDiscountFingerprint,
    draft: discountDraftFromItem(item),
  }));
  const itemDiscountDraft =
    itemDiscountDraftState.fingerprint === itemDiscountFingerprint
      ? itemDiscountDraftState.draft
      : discountDraftFromItem(item);
  const itemDiscountInputValue =
    itemDiscountDraft.mode === "percentage"
      ? itemDiscountDraft.percentage
      : itemDiscountDraft.amount;
  const parsedItemDiscountValue = Number(itemDiscountInputValue);
  const itemLineSubtotal = item.unitPrice * item.quantity;
  const itemDiscountPreview =
    itemDiscountDraft.mode === "percentage" && Number.isFinite(parsedItemDiscountValue)
      ? Math.min(itemLineSubtotal, Math.max(0, itemLineSubtotal * (parsedItemDiscountValue / 100)))
      : 0;
  const canApplyItemDiscount =
    canDiscount &&
    itemDiscountInputValue.trim() !== "" &&
    Number.isFinite(parsedItemDiscountValue) &&
    parsedItemDiscountValue > 0 &&
    (itemDiscountDraft.mode === "percentage"
      ? parsedItemDiscountValue <= 100
      : parsedItemDiscountValue <= itemLineSubtotal);

  function updateItemDiscountDraft(patch: Partial<DiscountDraft>) {
    setItemDiscountDraftState({
      fingerprint: itemDiscountFingerprint,
      draft: { ...itemDiscountDraft, ...patch },
    });
  }

  function handleApplyItemDiscount() {
    if (!canApplyItemDiscount) return;
    onApplyItemDiscount(
      item.key,
      itemDiscountDraft.mode,
      parsedItemDiscountValue,
      itemDiscountDraft.note.trim() || undefined,
    );
    setItemDiscountFormOpen(false);
  }

  function handleClearItemDiscount() {
    onClearItemDiscount(item.key);
    setItemDiscountFormOpen(false);
  }

  return (
    <li className="py-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">
            {item.productName}
            {item.variant && <span className="text-gray-500 ml-1">({item.variant.name})</span>}
          </p>
          {item.modifiers.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {item.modifiers.map((modifier) => (
                <p key={`${item.key}-${modifier.modifierGroupId}-${modifier.option.id}`} className="text-xs text-gray-500">
                  + {modifierDetail(modifier)}
                </p>
              ))}
            </div>
          )}
          {item.note && (
            <p className="mt-1 text-xs text-amber-700">
              หมายเหตุ: {item.note}
            </p>
          )}
          {(item.discount ?? 0) > 0 && (
            <p className="mt-1 text-xs text-teal-700">
              ส่วนลดรายการนี้ -{priceStr(item.discount ?? 0)}
              {item.discountNote ? ` · ${item.discountNote}` : ""}
            </p>
          )}
        </div>
        <span className="text-sm tabular-nums text-gray-700 shrink-0">
          {priceStr(item.totalPrice)}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-gray-400">
          {priceStr(item.unitPrice)} × {item.quantity}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center border border-gray-200 rounded">
            <button
              type="button"
              onClick={() => onUpdateQty(item.key, item.quantity - 1)}
              className="min-w-11 min-h-11 flex items-center justify-center text-gray-500 hover:bg-gray-50 text-sm"
            >
              −
            </button>
            <span className="w-7 text-center text-xs tabular-nums">{item.quantity}</span>
            <button
              type="button"
              onClick={() => onUpdateQty(item.key, item.quantity + 1)}
              className="min-w-11 min-h-11 flex items-center justify-center text-gray-500 hover:bg-gray-50 text-sm"
            >
              +
            </button>
          </div>
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            className="min-h-11 px-3 text-xs text-red-400 hover:text-red-600"
          >
            ลบ
          </button>
        </div>
        {canDiscount && (
          <div className="basis-full">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={itemDiscountFormOpen}
                onClick={() => setItemDiscountFormOpen((open) => !open)}
                className="min-h-9 rounded-lg border border-teal-100 bg-teal-50 px-2 text-[11px] font-semibold text-teal-800"
              >
                {itemDiscountFormOpen
                  ? "ปิด"
                  : (item.discount ?? 0) > 0
                    ? "แก้ส่วนลดรายการนี้"
                    : "เรียกส่วนลดรายการนี้"}
              </button>
              {(item.discount ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={handleClearItemDiscount}
                  className="min-h-9 rounded-lg px-2 text-[11px] font-semibold text-red-500 hover:text-red-600"
                >
                  ล้างส่วนลดรายการนี้
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {canDiscount && itemDiscountFormOpen && (
        <div className="space-y-2 rounded-lg border border-teal-100 bg-teal-50/60 p-2">
          <div
            role="group"
            aria-label="ประเภทส่วนลดรายการ"
            className="grid grid-cols-2 gap-1 rounded-lg border border-teal-100 bg-white p-1"
          >
            <button
              type="button"
              aria-pressed={itemDiscountDraft.mode === "amount"}
              onClick={() => updateItemDiscountDraft({ mode: "amount" })}
              className={`min-h-10 rounded-md px-3 text-xs font-semibold transition-colors ${
                itemDiscountDraft.mode === "amount"
                  ? "bg-teal-700 text-white"
                  : "text-teal-800 hover:bg-teal-50"
              }`}
            >
              บาท
            </button>
            <button
              type="button"
              aria-pressed={itemDiscountDraft.mode === "percentage"}
              onClick={() => updateItemDiscountDraft({ mode: "percentage" })}
              className={`min-h-10 rounded-md px-3 text-xs font-semibold transition-colors ${
                itemDiscountDraft.mode === "percentage"
                  ? "bg-teal-700 text-white"
                  : "text-teal-800 hover:bg-teal-50"
              }`}
            >
              %
            </button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            {itemDiscountDraft.mode === "amount" ? (
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max={item.unitPrice * item.quantity}
                step="0.01"
                value={itemDiscountDraft.amount}
                onChange={(event) => updateItemDiscountDraft({ amount: event.target.value })}
                placeholder="0"
                aria-label="จำนวนส่วนลดรายการ"
                className="min-h-11 w-full rounded-lg border border-teal-100 bg-white px-3 text-sm font-semibold tabular-nums text-gray-900 placeholder:text-gray-300"
              />
            ) : (
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={itemDiscountDraft.percentage}
                onChange={(event) => updateItemDiscountDraft({ percentage: event.target.value })}
                placeholder="0"
                aria-label="เปอร์เซ็นต์ส่วนลดรายการ"
                className="min-h-11 w-full rounded-lg border border-teal-100 bg-white px-3 text-sm font-semibold tabular-nums text-gray-900 placeholder:text-gray-300"
              />
            )}
            <button
              type="button"
              disabled={!canApplyItemDiscount}
              onClick={handleApplyItemDiscount}
              className="min-h-11 rounded-lg border border-teal-200 bg-white px-3 text-xs font-semibold text-teal-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ใช้ส่วนลด
            </button>
          </div>
          {itemDiscountDraft.mode === "percentage" &&
            itemDiscountPreview > 0 &&
            parsedItemDiscountValue <= 100 && (
              <p className="text-[11px] text-teal-700">
                ลดประมาณ <span className="font-semibold tabular-nums">{priceStr(itemDiscountPreview)}</span>
              </p>
            )}
          <input
            value={itemDiscountDraft.note}
            onChange={(event) => updateItemDiscountDraft({ note: event.target.value })}
            placeholder="เหตุผล/โปรโมชัน"
            aria-label="เหตุผลส่วนลดรายการ"
            className="min-h-10 w-full rounded-lg border border-teal-100 bg-white px-3 text-xs text-gray-700 placeholder:text-gray-300"
          />
        </div>
      )}
    </li>
  );
}

// ─── Payment Panel ────────────────────────────────────────────────

function PaymentPanel({
  cart,
  onConfirm,
  onBack,
  onShowPromptPayOnCustomerDisplay,
  isPending,
  error,
  hasPendingOrder,
  promptpayId,
  customerDisplayEnabled,
  customerDisplayUnavailableMessage,
  cashSessionRequired,
}: {
  cart: Cart;
  onConfirm: (method: "cash" | "qr_promptpay", received?: number, opts?: { qrPaymentVerified?: boolean }) => void;
  onBack: () => void;
  onShowPromptPayOnCustomerDisplay: (payment: CustomerDisplayPayment) => void;
  isPending: boolean;
  error: string | null;
  hasPendingOrder: boolean;
  promptpayId?: string;
  customerDisplayEnabled: boolean;
  customerDisplayUnavailableMessage: string | null;
  cashSessionRequired: boolean;
}) {
  const [method, setMethod] = useState<"cash" | "qr_promptpay">("cash");
  const [received, setReceived] = useState<string>("");
  const [qrPaymentVerified, setQrPaymentVerified] = useState(false);
  const [customerDisplayNotice, setCustomerDisplayNotice] = useState<string | null>(null);

  const receivedNum = parseFloat(received) || 0;
  const change = method === "cash" ? receivedNum - cart.total : null;
  const cashReady = method !== "cash" || (!cashSessionRequired && receivedNum >= cart.total);
  const qrReady = method !== "qr_promptpay" || (!!promptpayId && qrPaymentVerified);

  let promptPayPayload: string | null = null;
  if (method === "qr_promptpay" && promptpayId && cart.total > 0) {
    try {
      promptPayPayload = buildPromptPayPayload({ recipientId: promptpayId, amount: cart.total });
    } catch {
      promptPayPayload = null;
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
        <button
          onClick={onBack}
          disabled={hasPendingOrder}
          title={hasPendingOrder ? "สร้างออร์เดอร์แล้ว กรุณาชำระเงินให้จบก่อน" : undefined}
          className="min-h-11 px-3 text-gray-400 hover:text-gray-700 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← กลับ
        </button>
        <span className="text-sm font-semibold text-gray-800">ชำระเงิน</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="bg-gray-50 rounded-lg p-3 text-center">
          <p className="text-xs text-gray-500">ยอดที่ต้องชำระ</p>
          <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">
            {priceStr(cart.total)}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-600">วิธีชำระ</p>
          <div className="grid grid-cols-2 gap-2">
            {(["cash", "qr_promptpay"] as const).map((m) => (
              <button
                key={m}
                type="button"
                 onClick={() => {
                   setMethod(m);
                   setQrPaymentVerified(false);
                   setCustomerDisplayNotice(null);
                 }}
                className={`min-h-11 py-2.5 text-xs font-medium rounded-lg border transition-colors ${
                  method === m
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                    : "border-gray-300 text-gray-700 hover:border-gray-500"
                }`}
              >
                {m === "cash" ? "เงินสด" : "QR พร้อมเพย์"}
              </button>
            ))}
          </div>
        </div>

        {method === "cash" && (
          <div className="space-y-1.5">
            {cashSessionRequired && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                ต้องเปิดรอบเงินสดก่อนรับเงินสด
              </p>
            )}
            <label className="block text-xs font-semibold text-gray-600">รับเงินมา (บาท)</label>
            <input
              type="number"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
              min={cart.total}
              step="1"
              placeholder={String(cart.total)}
              className="w-full px-3 py-2 text-lg font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-400 tabular-nums"
              autoFocus
            />
            {change !== null && change >= 0 && (
              <p className="text-sm font-semibold text-green-600 text-center">
                {changeStr(receivedNum, cart.total)}
              </p>
            )}
            {change !== null && change < 0 && (
              <p className="text-xs text-red-500 text-center">รับเงินไม่พอ</p>
            )}
            <div className="grid grid-cols-4 gap-1.5 pt-1">
              {[20, 50, 100, 500, 1000].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setReceived(String(Math.ceil(cart.total / preset) * preset))}
                  className="min-h-11 py-2 px-2 text-xs border border-gray-200 rounded hover:bg-gray-50"
                >
                  ฿{preset}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setReceived(String(cart.total))}
                className="min-h-11 py-2 px-2 text-xs border border-blue-200 text-blue-600 rounded hover:bg-blue-50"
              >
                พอดี
              </button>
            </div>
          </div>
        )}

        {method === "qr_promptpay" && (
          <div className="flex flex-col items-center gap-2 py-4">
            {promptPayPayload ? (
              <>
                <QrCode value={promptPayPayload} size={200} />
                <p className="text-sm font-semibold text-gray-700">ให้ลูกค้าสแกนเพื่อชำระ {priceStr(cart.total)}</p>
                <p className="text-xs text-gray-400">PromptPay จาก ตั้งค่า › ใบเสร็จ: {promptpayId}</p>
                <button
                  type="button"
                  onClick={() => {
                    onShowPromptPayOnCustomerDisplay({
                      method: "qr_promptpay",
                      amount: cart.total,
                      promptPayPayload,
                    });
                    setCustomerDisplayNotice("ส่ง QR ล็อกยอดไปจอลูกค้าแล้ว");
                  }}
                  disabled={!customerDisplayEnabled}
                  title={
                    customerDisplayEnabled
                      ? undefined
                      : customerDisplayUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับจอลูกค้า"
                  }
                  className="min-h-11 w-full rounded-lg border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] px-3 text-sm font-semibold text-[var(--tenant-primary-strong)] transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  แสดง QR บนจอลูกค้า
                </button>
                {customerDisplayNotice ? (
                  <p className="text-xs font-semibold text-green-700" role="status">
                    {customerDisplayNotice}
                  </p>
                ) : null}
                {!customerDisplayEnabled && customerDisplayUnavailableMessage ? (
                  <p className="text-xs text-amber-700">{customerDisplayUnavailableMessage}</p>
                ) : null}
                <label className="mt-2 flex min-h-11 items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 text-xs font-semibold text-green-700">
                  <input
                    type="checkbox"
                    checked={qrPaymentVerified}
                    onChange={(event) => setQrPaymentVerified(event.target.checked)}
                  />
                  ยืนยันว่าได้รับเงิน QR แล้ว
                </label>
              </>
            ) : (
              <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-4 text-center text-xs text-amber-700">
                ยังไม่ได้ตั้งค่าเลข PromptPay ของร้าน — ไปที่ ตั้งค่า › ใบเสร็จ เพื่อเพิ่มเลขพร้อมเพย์
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            {error}
          </p>
        )}
        {hasPendingOrder && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
            สร้างออร์เดอร์แล้ว หากชำระเงินไม่สำเร็จให้ลองยืนยันอีกครั้ง ห้ามกลับไปแก้ตะกร้าระหว่างรอปิดบิล
          </p>
        )}
      </div>

      <div className="p-4 border-t border-gray-100">
        <Button
          variant="primary"
          loading={isPending}
          loadingText="กำลังชำระเงิน..."
          disabled={!cashReady || !qrReady || (method === "qr_promptpay" && !promptPayPayload)}
          onClick={() =>
            onConfirm(
              method,
              method === "cash" ? receivedNum : undefined,
              { qrPaymentVerified: method === "qr_promptpay" ? qrPaymentVerified : undefined },
            )
          }
          className="w-full disabled:opacity-40"
        >
          ยืนยันการชำระ
        </Button>
      </div>
    </div>
  );
}

// ─── Receipt Panel ────────────────────────────────────────────────

/**
 * Cross-tab guard so one order's receipt isn't auto-printed twice when the POS
 * is open in multiple tabs/windows on the same device (localStorage is shared).
 * Returns true only for the tab that wins the claim.
 */
/** เวลาที่ใช้ขึ้นคำเตือนเมื่อ QR รับแต้มช้า — ไม่ปลดล็อกการพิมพ์จนกว่าจะรู้ผล */
const AUTO_PRINT_CLAIM_WAIT_MS = 4000;

function claimReceiptAutoPrint(orderNumber: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const key = `pos-autoprint:${orderNumber}`;
    const now = Date.now();
    const prev = localStorage.getItem(key);
    if (prev && now - Number(prev) < 5 * 60_000) return false;
    localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

function ReceiptPanel({
  order,
  receiptSettings,
  storeName,
  printers,
  preferredPrinterId,
  printerLoadError,
  onNewOrder,
}: {
  order: ReceiptOrder;
  receiptSettings: ReceiptSettings | null;
  storeName: string;
  printers: Printer[];
  preferredPrinterId: string | null;
  printerLoadError: string | null;
  onNewOrder: () => void;
}) {
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printNotice, setPrintNotice] = useState<string | null>(null);
  const autoPrintedRef = useRef(false);

  async function handlePrint() {
    setPrintError(null);
    setPrintNotice(null);
    if (order.loyaltyClaimPending) {
      setPrintError("กำลังรอ QR รับแต้มจากระบบ กรุณารอสักครู่");
      return;
    }
    if (order.loyaltyClaimError) {
      setPrintError(`QR รับแต้มไม่พร้อม: ${order.loyaltyClaimError} กรุณาพิมพ์ซ้ำจากประวัติบิล`);
      return;
    }
    setIsPrinting(true);
    try {
      const settings: ReceiptSettings = receiptSettings ?? {
        id: "",
        storeId: "",
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
        storeName: settings.storeName,
        address: settings.address,
        phone: settings.phone,
        taxId: settings.taxId,
        showTaxId: settings.showTaxId,
        orderNumber: order.orderNumber,
        items: order.items.map((item) => ({
          name: item.productName,
          variantName: item.variant?.name,
          modifierNames: item.modifiers?.map(modifierDetail) ?? [],
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          discount: item.discount,
          discountType: item.discountType,
          discountValue: item.discountValue,
          discountNote: item.discountNote,
          note: item.note,
        })),
        subtotal: order.subtotal,
        discount: order.discount,
        discountNote: order.discountNote,
        total: order.total,
        payments: [{
          method: order.method,
          amount: order.total,
          receivedAmount: order.receivedAmount,
          changeAmount: order.changeAmount,
        }],
        paymentStatus: "paid" as const,
        loyaltyPointsEarned: order.loyaltyPointsEarned,
        loyaltyPointsBalance: order.loyaltyPointsBalance,
        // QR รับแต้ม — มีเฉพาะบิลที่ยังไม่ผูกลูกค้า
        loyaltyClaim: order.loyaltyClaim,
        vatRate: settings.showVatBreakdown && settings.vatRate > 0 ? settings.vatRate : undefined,
        footerText: settings.footerText,
        headerText: settings.headerText,
        showQrPayment: false,
        promptpayId: settings.promptpayId,
        // รูปที่ร้านอัปโหลดไว้ (โลโก้หัวใบ / QR ท้ายใบ) ต้องส่งไปกับข้อมูลใบเสร็จด้วย
        // ไม่งั้น renderer ไม่มีอะไรให้วาด — ใบเสร็จจาก POS จึงออกมาไม่มีรูปทั้งที่ตั้งค่าไว้แล้ว
        logoUrl: settings.logoUrl,
        footerImageUrl: settings.footerImageUrl,
        footerImageLabel: settings.footerImageLabel,
        hideFooterImageWithSystemQr: settings.hideFooterImageWithSystemQr,
        paperWidth: settings.paperWidth,
        printCopies: settings.printCopies,
        printedAt: new Date().toISOString(),
      };
      const result = await printReceiptWithFallback({
        printers,
        preferredPrinterId,
        escpos: {
          storeName: receiptData.storeName,
          address: receiptData.address,
          phone: receiptData.phone,
          headerText: receiptData.headerText,
          orderNumber: receiptData.orderNumber,
          items: receiptData.items.map((it) => ({
            name: it.name,
            variantName: it.variantName,
            modifierNames: it.modifierNames,
            quantity: it.quantity,
            totalPrice: it.totalPrice,
            discount: it.discount,
            discountNote: it.discountNote,
          })),
          subtotal: receiptData.subtotal,
          discount: receiptData.discount,
          discountNote: receiptData.discountNote,
          total: receiptData.total,
          payments: receiptData.payments,
          loyaltyPointsEarned: receiptData.loyaltyPointsEarned,
          loyaltyPointsBalance: receiptData.loyaltyPointsBalance,
          footerText: receiptData.footerText,
          paperWidth: receiptData.paperWidth,
          printedAt: receiptData.printedAt,
        },
        browser: receiptData,
      });
      setPrintNotice(printSuccessMessage("พิมพ์ใบเสร็จแล้ว", result, printerLoadError));
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "พิมพ์ไม่สำเร็จ");
    } finally {
      setIsPrinting(false);
    }
  }

  // QR รับแต้มถูกขอจาก server แบบไม่บล็อกหลังจ่ายเงิน ถ้าพิมพ์ทันทีใบเสร็จจะออกมา
  // "ไม่มี QR" ทั้งที่ข้อความชวนสแกนพิมพ์ไปแล้ว จึงรอผล QR ก่อนเสมอ
  // เมื่อเกินเวลานี้จะแจ้งสถานะให้แคชเชียร์ทราบ แต่ยังไม่ปล่อยใบเสร็จที่ข้อมูลไม่ครบ
  const [claimWaitElapsed, setClaimWaitElapsed] = useState(false);
  useEffect(() => {
    if (!order.loyaltyClaimPending) return;
    const timer = setTimeout(() => setClaimWaitElapsed(true), AUTO_PRINT_CLAIM_WAIT_MS);
    return () => clearTimeout(timer);
  }, [order.loyaltyClaimPending]);

  // Auto-print the receipt once when the store has it enabled (fires on the
  // payment-success receipt screen). The ref guards against a double print.
  useEffect(() => {
    if (!receiptSettings?.autoPrintReceipt || autoPrintedRef.current) return;
    if (order.loyaltyClaimPending) return;
    if (order.loyaltyClaimError) return;
    autoPrintedRef.current = true;
    // Only auto-print if another tab/window on this device hasn't already.
    // handlePrint is fire-and-forget async — its setState runs off-cycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (claimReceiptAutoPrint(order.orderNumber)) void handlePrint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.loyaltyClaimPending, order.loyaltyClaimError, claimWaitElapsed]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100 text-center">
        <span className="text-sm font-semibold text-green-600">ชำระเงินสำเร็จ</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="text-center">
          <p className="text-xs text-gray-400">เลขออร์เดอร์</p>
          <p className="text-lg font-mono font-bold text-gray-900">{order.orderNumber}</p>
        </div>
        <ul className="divide-y divide-gray-50 text-sm">
          {order.items.map((item) => (
            <li key={item.key} className="py-2">
              <div className="flex justify-between gap-2">
                <span className="text-gray-700">
                  {item.productName}
                  {item.variant && <span className="text-gray-400"> ({item.variant.name})</span>}
                  <span className="ml-1 text-gray-400">×{item.quantity}</span>
                </span>
                <span className="tabular-nums shrink-0">{priceStr(item.totalPrice)}</span>
              </div>
              {item.modifiers.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {item.modifiers.map((modifier) => (
                    <p key={`${item.key}-receipt-${modifier.modifierGroupId}-${modifier.option.id}`} className="text-xs text-gray-500">
                      + {modifierDetail(modifier)}
                    </p>
                  ))}
                </div>
              )}
              {item.note && (
                <p className="mt-1 text-xs text-amber-700">หมายเหตุ: {item.note}</p>
              )}
              {(item.discount ?? 0) > 0 && (
                <p className="mt-1 text-xs text-teal-700">
                  ส่วนลดรายการ -{priceStr(item.discount ?? 0)}
                  {item.discountNote ? ` · ${item.discountNote}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
        <div className="pt-2 border-t border-gray-100 flex justify-between font-semibold">
          <span>รวม</span>
          <span className="tabular-nums">{priceStr(order.total)}</span>
        </div>
        {order.method === "cash" && order.receivedAmount !== undefined && (
          <p className="text-sm text-gray-600 font-medium text-center">
            รับเงิน {priceStr(order.receivedAmount)}
          </p>
        )}
        {order.changeAmount !== undefined && order.changeAmount >= 0 && (
          <p className="text-sm text-green-600 font-medium text-center">
            เงินทอน {priceStr(order.changeAmount)}
          </p>
        )}
        {(order.loyaltyPointsEarned ?? 0) > 0 && (
          <p className="text-sm text-teal-700 font-medium text-center">
            ได้รับแต้ม +{formatPoints(order.loyaltyPointsEarned)}
            {order.loyaltyPointsBalance !== undefined
              ? ` · แต้มคงเหลือ ${formatPoints(order.loyaltyPointsBalance)}`
              : ""}
          </p>
        )}
        {printError && (
          <p className="text-xs text-red-500 text-center">{printError}</p>
        )}
        {order.loyaltyClaimError && !printError && (
          <p role="alert" className="text-xs font-medium text-red-600 text-center">
            QR รับแต้มไม่พร้อม: {order.loyaltyClaimError} กรุณาพิมพ์ซ้ำจากประวัติบิล
          </p>
        )}
        {order.loyaltyClaimPending && claimWaitElapsed && !printError && (
          <p role="status" className="text-xs font-medium text-amber-700 text-center">
            กำลังรอ QR รับแต้มจากระบบ ใบเสร็จจะพิมพ์เมื่อ QR พร้อม
          </p>
        )}
        {printNotice && (
          <p className="text-xs text-amber-700 text-center">{printNotice}</p>
        )}
      </div>
      <div className="p-4 border-t border-gray-100 space-y-2">
        <button
          type="button"
          onClick={handlePrint}
          disabled={isPrinting || order.loyaltyClaimPending || Boolean(order.loyaltyClaimError)}
          className="w-full min-h-11 py-2.5 text-sm font-semibold text-gray-900 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          {isPrinting ? "กำลังพิมพ์..." : "พิมพ์ใบเสร็จ"}
        </button>
        <button
          type="button"
          onClick={onNewOrder}
          className="btn-primary w-full"
        >
          ออร์เดอร์ใหม่
        </button>
      </div>
    </div>
  );
}

// ─── Main POS Terminal ────────────────────────────────────────────

export function PosTerminal({
  storeId,
  storeName,
  categories,
  products,
  receiptSettings,
  exitHref,
  cashSession,
  cashSalesPreview,
  cashMovementPreview,
  currency,
  canDiscount,
  canRecordCashflow,
  storeTimezone,
  printers,
  printerLoadError,
  couponEnabled,
  couponUnavailableMessage,
  loyaltyEnabled,
  loyaltyUnavailableMessage,
  customerDisplayEnabled,
  customerDisplayUnavailableMessage,
}: Props) {
  const [cart, setCart] = useState<Cart>(() => emptyCart(storeId));
  const [discountDraft, setDiscountDraft] = useState<DiscountDraft>(EMPTY_DISCOUNT_DRAFT);
  const [discountFormOpen, setDiscountFormOpen] = useState(false);
  const [itemDiscountResetKey, setItemDiscountResetKey] = useState(0);
  const [phase, setPhase] = useState<Phase>("ordering");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    categories[0]?.id ?? null,
  );
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  // Deep link /pos?tableBill=<id> → เปิดบิลโต๊ะนั้นทันที
  const searchParams = useSearchParams();
  const initialTableBillId = searchParams.get("tableBill");
  const [showTableBill, setShowTableBill] = useState(() => Boolean(initialTableBillId));
  const [billTableId, setBillTableId] = useState<string | null>(() => initialTableBillId);
  /** เลขโต๊ะของ billTableId (รู้เมื่อมาจากหน้าเปิดโต๊ะ — deep link ไม่รู้) */
  const [billTableNumber, setBillTableNumber] = useState<string | null>(null);
  const [showTableOpen, setShowTableOpen] = useState(false);
  /** เมนูโต๊ะ — เดิมเป็นสองปุ่มบนแถบหัว (เปิดโต๊ะ / เช็คบิลโต๊ะ) เบียดที่ปุ่มอื่น */
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  /** ที่วางปุ่มบนแถบหัวของ shell รวม — null = หน้า POS เดี่ยว (ใช้แถบหัวของตัวเอง) */
  const [topbarHost, setTopbarHost] = useState<HTMLElement | null>(null);

  // shell รวมเตรียมที่ว่างไว้บนแถบแท็บให้ปุ่มของหน้าขายไปอยู่แถวเดียวกัน — เดิมแถบหัว
  // ของ POS เป็นแถวที่สองซ้อนใต้แถบแท็บ เสียความสูงไปเปล่า ๆ ถ้าไม่มีที่วาง (เปิด POS
  // เดี่ยวแบบเดิม) ก็ยังวาดแถบหัวของตัวเองเหมือนเดิม
  useEffect(() => {
    setTopbarHost(document.getElementById(POS_TOPBAR_ACTIONS_ID));
  }, []);

  // เปิดโต๊ะ/เช็คบิลโต๊ะ ถูกยุบไปอยู่ใน dialog "โต๊ะ / ครัว / บิล" ของ shell รวม
  // ซึ่งอยู่คนละต้นไม้กับ PosTerminal — คำสั่งจึงวิ่งมาทาง section-bus
  useEffect(() => onPosCommand((command) => {
    if (command === "open-table") setShowTableOpen(true);
    if (command === "settle-table") setShowTableBill(true);
  }), []);
  /** โต๊ะที่กำลังเพิ่มรายการเข้า (ส่งเข้าครัว) จากบิลโต๊ะ */
  const [dineInTable, setDineInTable] = useState<{ id: string; number: string } | null>(null);
  const [orderPanelOpen, setOrderPanelOpen] = useState(false);
  const [printerConnectionOpen, setPrinterConnectionOpen] = useState(false);
  const [preferredPrinterId, setPreferredPrinterId] = useState<string | null>(null);
  const [ticketPanelOpen, setTicketPanelOpen] = useState(false);
  const [billHistoryPanelOpen, setBillHistoryPanelOpen] = useState(false);
  const [customerToolsOpen, setCustomerToolsOpen] = useState(false);
  const [savedTickets, setSavedTickets] = useState<SavedOrderTicket[]>([]);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState<TicketDraft>(EMPTY_TICKET_DRAFT);
  const [ticketMessage, setTicketMessage] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  // บิลที่กำลังจะแก้ช่องทางชำระ (null = ไม่ได้เปิด dialog)
  const [changePaymentOrder, setChangePaymentOrder] = useState<Order | null>(null);
  const [changePaymentError, setChangePaymentError] = useState<string | null>(null);
  const [printStatusMessage, setPrintStatusMessage] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerProfile[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerProfile | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);
  const [customerCouponMessage, setCustomerCouponMessage] = useState<string | null>(null);
  const [billHistory, setBillHistory] = useState<Order[]>([]);
  const [historyRange, setHistoryRange] = useState<BillHistoryRange>(() => createHistoryRange("today", storeTimezone));
  const [isBillHistoryPending, setIsBillHistoryPending] = useState(false);
  const [isPrintingTicket, setIsPrintingTicket] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<{ orderId: string; orderNumber: string } | null>(null);
  const [receipt, setReceipt] = useState<ReceiptOrder | null>(null);
  const preferredPrinterIdForPrint = printers.some((printer) => printer.id === preferredPrinterId) ? preferredPrinterId : null;
  const [isPending, startTransition] = useTransition();
  const [isTicketSyncPending, startTicketTransition] = useTransition();
  const historyRequestIdRef = useRef(0);
  const checkoutIdempotencyKeyRef = useRef<string | null>(null);
  const cartRef = useRef(cart);
  const paidDisplayCartRef = useRef<Cart | null>(null);
  const paidCustomerNameRef = useRef<string | undefined>(undefined);
  const paidCustomerRef = useRef<CustomerDisplayCustomer | null>(null);

  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  const filteredProducts = useMemo(() => {
    // โหมดเพิ่มรายการเข้าโต๊ะ (ส่งครัว) ใช้ไปป์ไลน์ QR → แสดงเฉพาะเมนูที่ขายผ่าน QR ได้
    const base = dineInTable
      ? products.filter((p) => p.isActive && p.availableForQr)
      : products.filter((p) => p.isActive && p.availableForPos);
    return selectedCategoryId ? base.filter((p) => p.categoryId === selectedCategoryId) : base;
  }, [products, selectedCategoryId, dineInTable]);
  const cartLocked = phase !== "ordering" || pendingOrder !== null;
  const activeTicket = activeTicketId ? (savedTickets.find((ticket) => ticket.id === activeTicketId) ?? null) : null;
  const utilitySheetOpen =
    ticketPanelOpen || billHistoryPanelOpen || customerToolsOpen || discountFormOpen || tableMenuOpen;
  const displayCart = useMemo(
    () => buildCouponPreviewCart(cart, appliedCoupon?.discount ?? 0),
    [cart, appliedCoupon?.discount],
  );

  const commitCart = useCallback((nextCart: Cart, options: { resetItemDiscountForms?: boolean } = {}) => {
    checkoutIdempotencyKeyRef.current = null;
    cartRef.current = nextCart;
    setCart(nextCart);
    setDiscountDraft(discountDraftFromCart(nextCart));
    setAppliedCoupon(null);
    setCustomerCouponMessage(null);
    if (options.resetItemDiscountForms || nextCart.items.length === 0) {
      setItemDiscountResetKey((current) => current + 1);
    }
    if (nextCart.items.length === 0) {
      setDiscountFormOpen(false);
    }
  }, []);

  function updateDiscountDraft(patch: Partial<DiscountDraft>) {
    setDiscountDraft((current) => ({ ...current, ...patch }));
  }

  function clearCurrentOrder(message = "ล้างออร์เดอร์แล้ว") {
    commitCart(emptyCart(storeId), { resetItemDiscountForms: true });
    setDiscountFormOpen(false);
    setActiveTicketId(null);
    setTicketDraft(EMPTY_TICKET_DRAFT);
    setCouponCode("");
    setCustomerResults([]);
    setTicketMessage(message);
  }

  function handleApplyDiscount(type: DiscountType, value: number, note?: string) {
    const nextCart =
      type === "amount"
        ? applyDiscount(cart, value, note)
        : applyOrderDiscount(cart, { type, value, note });
    commitCart(nextCart);
    setDiscountFormOpen(false);
  }

  function handleApplyItemDiscount(key: string, type: DiscountType, value: number, note?: string) {
    commitCart(applyItemDiscount(cart, key, { type, value, note }));
  }

  function handleClearItemDiscount(key: string) {
    commitCart(removeItemDiscount(cart, key));
  }

  const persistSavedTickets = useCallback((next: SavedOrderTicket[]) => {
    if (!writeSavedTickets(storeId, next)) {
      setTicketMessage("บันทึกตั๋วในเครื่องนี้ไม่สำเร็จ กรุณาตรวจ storage ของเบราว์เซอร์");
      return false;
    }
    setSavedTickets(next);
    return true;
  }, [storeId]);

  const refreshBillHistory = useCallback((range: BillHistoryRange) => {
    const normalizedRange = normalizeHistoryRange(range, storeTimezone);
    const requestId = historyRequestIdRef.current + 1;
    historyRequestIdRef.current = requestId;
    startTransition(async () => {
      setIsBillHistoryPending(true);
      try {
        const result = normalizedRange.mode === "today"
          ? await listTodayOrdersAction()
          : await listOrdersHistoryAction({
              fromDate: normalizedRange.fromDate,
              toDate: normalizedRange.toDate,
              limit: normalizedRange.mode === "30d" ? 500 : 300,
            });
        if (historyRequestIdRef.current !== requestId) return;
        if (result.error) {
          setTicketMessage(`โหลดบิลย้อนหลังไม่สำเร็จ: ${result.error}`);
        } else {
          setHistoryRange(normalizedRange);
          setBillHistory(result.orders);
        }
      } catch (error) {
        if (historyRequestIdRef.current !== requestId) return;
        setTicketMessage(error instanceof Error ? `โหลดบิลย้อนหลังไม่สำเร็จ: ${error.message}` : "โหลดบิลย้อนหลังไม่สำเร็จ");
      } finally {
        if (historyRequestIdRef.current === requestId) {
          setIsBillHistoryPending(false);
        }
      }
    });
  }, [storeTimezone]);

  useEffect(() => {
    let cancelled = false;
    startTicketTransition(async () => {
      const result = await listSavedTicketsAction();
      if (cancelled) return;
      if (result.error) {
        setSavedTickets(readSavedTickets(storeId));
        setTicketMessage(`ใช้ตั๋วในเครื่องนี้อยู่: ${result.error}`);
        return;
      }
      persistSavedTickets(mergeSavedTickets(result.tickets, readSavedTickets(storeId)));
    });
    return () => {
      cancelled = true;
    };
  }, [persistSavedTickets, storeId]);

  useEffect(() => {
    refreshBillHistory(createHistoryRange("today", storeTimezone));
    // Load once per store/terminal mount; manual refresh handles later updates.
  }, [refreshBillHistory, storeId, storeTimezone]);

  useEffect(() => {
    if (!customerDisplayEnabled) return;
    const status = phase === "receipt" ? "paid" : phase === "payment" ? "checkout" : displayCart.items.length > 0 ? "scanning" : "idle";
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
  }, [customerDisplayEnabled, displayCart, phase, selectedCustomer]);

  function handleShowPromptPayOnCustomerDisplay(payment: CustomerDisplayPayment, cart: Cart = displayCart) {
    if (!customerDisplayEnabled) return;
    publishCustomerDisplaySnapshot(cart, {
      status: "checkout",
      customerName: selectedCustomer?.name,
      customer: selectedCustomer
        ? {
            name: selectedCustomer.name,
            pointsBalance: selectedCustomer.pointsBalance,
          }
        : null,
      payment: {
        method: payment.method,
        amount: payment.amount,
        promptPayPayload: payment.promptPayPayload,
      },
    });
  }

  const handleProductClick = useCallback((product: Product) => {
    if (cartLocked) return;
    if (!product.isActive || !product.availableForPos) return;
    if (product.variants.length === 0 && product.modifierGroups.length === 0) {
      commitCart(addToCart(cartRef.current, { product, variant: null, modifiers: [] }));
      return;
    }
    setPicker({
      product,
      selectedVariant: null,
      selectedModifiers: buildDefaultModifierSelections(product.modifierGroups),
    });
  }, [cartLocked, commitCart]);

  const handleAddFromPicker = useCallback((input: AddToCartInput) => {
    commitCart(addToCart(cartRef.current, input));
  }, [commitCart]);

  // ── U15/U21 — สะพานให้ปุ่มเสียงของ shell ใช้ (ไม่มี provider = no-op ในเส้นทาง legacy) ──
  // เสียงอ่านสถานะล่าสุดผ่าน ref และ "เขียน" ผ่านฟังก์ชันเดิมของหน้าขายเท่านั้น
  // (commitCart / handleProductClick / handleAddFromPicker) — ไม่มี logic ตะกร้าซ้ำ
  const voiceCartSnapshotRef = useRef({ cart, products, locked: cartLocked });
  useEffect(() => {
    voiceCartSnapshotRef.current = { cart, products, locked: cartLocked };
  }, [cart, products, cartLocked]);
  const voicePickerRef = useRef<PickerState | null>(picker);
  useEffect(() => {
    voicePickerRef.current = picker;
  }, [picker]);

  const voiceCartApi = useMemo<VoiceCartApi>(
    () => ({
      getSnapshot: () => voiceCartSnapshotRef.current,
      commit: (nextCart: Cart) => commitCart(nextCart),
      // เปิดแผงตะกร้า/ออเดอร์ — ปุ่มเดียวกับที่พนักงานกดบนมือถือ (ไม่แตะเงิน)
      openOrderPanel: () => setOrderPanelOpen(true),
      // เปิด dialog ของสินค้า (สินค้าที่มีตัวเลือกบังคับจะเด้งหน้าต่างให้เลือก)
      openProduct: (productId: string) => {
        const product = voiceCartSnapshotRef.current.products.find((item) => item.id === productId);
        if (!product) return false;
        handleProductClick(product);
        // เปิด dialog เมื่อสินค้ามีตัวเลือก — sync ref ทันทีให้ผู้เรียกอ่านต่อได้ในจังหวะเดียวกัน
        if (product.variants.length > 0 || product.modifierGroups.length > 0) {
          voicePickerRef.current = {
            product,
            selectedVariant: null,
            selectedModifiers: buildDefaultModifierSelections(product.modifierGroups),
          };
        }
        return true;
      },
      getPicker: () => {
        const current = voicePickerRef.current;
        if (!current) return null;
        const needsVariant = current.product.variants.length > 0 && !current.selectedVariant;
        const missingGroups = current.product.modifierGroups.filter(
          (group) =>
            group.isRequired &&
            (current.selectedModifiers[group.id]?.length ?? 0) < Math.max(1, group.minSelections),
        );
        return {
          productName: current.product.name,
          needsVariant,
          missingRequiredGroups: missingGroups.map((group) => group.name),
          choices: [
            ...current.product.variants.map((variant) => variant.name),
            ...current.product.modifierGroups.flatMap((group) => group.options.map((option) => option.name)),
          ],
          // เฉพาะสิ่งที่ยังขาดจริง — กลุ่มที่ระบบเลือกค่าเริ่มต้นให้แล้วไม่ต้องถามซ้ำ
          pendingChoices: [
            ...(needsVariant ? current.product.variants.map((variant) => variant.name) : []),
            ...missingGroups.flatMap((group) => group.options.map((option) => option.name)),
          ],
        };
      },
      selectPickerChoice: (phrase: string) => {
        const current = voicePickerRef.current;
        if (!current) return null;
        const target = normalizeVoiceChoicePhrase(phrase);
        if (!target) return null;

        const variant = current.product.variants.find((item) => matchesVoiceChoicePhrase(item.name, target));
        if (variant) {
          const nextPicker = { ...current, selectedVariant: variant };
          // อัปเดต ref ทันที — ผู้เรียกอ่านสถานะต่อในจังหวะเดียวกัน (setPicker ยังไม่ทัน re-render)
          voicePickerRef.current = nextPicker;
          setPicker(nextPicker);
          return variant.name;
        }
        for (const group of current.product.modifierGroups) {
          const option = group.options.find((item) => matchesVoiceChoicePhrase(item.name, target));
          if (!option) continue;
          const next =
            group.selectionType === "single"
              ? [option]
              : [...(current.selectedModifiers[group.id] ?? []).filter((o) => o.id !== option.id), option];
          const nextPicker = {
            ...current,
            selectedModifiers: { ...current.selectedModifiers, [group.id]: next },
          };
          voicePickerRef.current = nextPicker;
          setPicker(nextPicker);
          return option.name;
        }
        return null;
      },
      confirmPicker: () => {
        const current = voicePickerRef.current;
        if (!current) return { ok: false, message: "ยังไม่มีหน้าต่างตัวเลือกเปิดอยู่" };
        if (current.product.variants.length > 0 && !current.selectedVariant) {
          return { ok: false, message: `ยังไม่ได้เลือกตัวเลือกของ ${current.product.name}` };
        }
        const missing = current.product.modifierGroups.filter(
          (group) =>
            group.isRequired &&
            (current.selectedModifiers[group.id]?.length ?? 0) < Math.max(1, group.minSelections),
        );
        if (missing.length > 0) {
          return { ok: false, message: `ยังต้องเลือก ${missing.map((group) => group.name).join(" และ ")}` };
        }
        handleAddFromPicker({
          product: current.product,
          variant: current.selectedVariant,
          modifiers: Object.entries(current.selectedModifiers).flatMap(([groupId, options]) => {
            const group = current.product.modifierGroups.find((item) => item.id === groupId);
            if (!group) return [];
            return options.map((option) => ({ groupId, groupName: group.name, option }));
          }),
        });
        voicePickerRef.current = null;
        setPicker(null);
        return { ok: true, message: `เพิ่ม ${current.product.name} ลงตะกร้าแล้ว` };
      },
    }),
    [commitCart, handleAddFromPicker, handleProductClick],
  );
  useRegisterVoiceCart(voiceCartApi);

  function handleCustomerQueryChange(value: string) {
    setCustomerQuery(value);
    if (!value.trim()) setCustomerResults([]);
  }

  function handleSearchCustomer() {
    if (!loyaltyEnabled) {
      setCustomerCouponMessage(loyaltyUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับสะสมแต้ม");
      return;
    }
    const query = customerQuery.trim();
    if (!query) return;
    startTransition(async () => {
      const result = await searchPosCustomersAction(query);
      if (result.error) {
        setCustomerCouponMessage(result.error);
        setCustomerResults([]);
        return;
      }
      setCustomerResults(result.customers);
      setCustomerCouponMessage(result.customers.length > 0 ? null : "ไม่พบลูกค้าจากคำค้นนี้");
    });
  }

  function handleSelectCustomer(customer: CustomerProfile) {
    checkoutIdempotencyKeyRef.current = null;
    setSelectedCustomer(customer);
    setCustomerQuery("");
    setCustomerResults([]);
    setAppliedCoupon(null);
    setCustomerCouponMessage(`เลือกลูกค้า ${customer.name} แล้ว`);
  }

  function handleClearCustomer() {
    checkoutIdempotencyKeyRef.current = null;
    setSelectedCustomer(null);
    setCustomerResults([]);
    setAppliedCoupon(null);
    setCustomerCouponMessage("ล้างลูกค้าแล้ว");
  }

  function handleApplyCoupon() {
    if (!couponEnabled) {
      setCustomerCouponMessage(couponUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับคูปอง");
      return;
    }
    if (cart.items.length === 0) {
      setCustomerCouponMessage("กรุณาเพิ่มสินค้าในออร์เดอร์ก่อนใช้คูปอง");
      return;
    }
    const code = couponCode.trim();
    if (!code) return;
    startTransition(async () => {
      const result = await evaluatePosCouponAction(code, cart, selectedCustomer?.id ?? null);
      if (result.rewardProduct) {
        const next = appendRewardLine(cartRef.current, result.rewardProduct);
        cartRef.current = next;
        setCart(next);
        checkoutIdempotencyKeyRef.current = null;
        setCouponCode("");
        setCustomerCouponMessage(
          next === cart
            ? `ของรางวัล ${result.rewardProduct.productName} ถูกเพิ่มไว้แล้ว`
            : `เพิ่มของรางวัล ${result.rewardProduct.productName} (โค้ด ${result.rewardProduct.voucherCode}) ลงบิลแล้ว`,
        );
        return;
      }
      if (result.error || !result.couponId || !result.normalizedCode) {
        setAppliedCoupon(null);
        setCustomerCouponMessage(result.error ?? "คูปองนี้ใช้ไม่ได้");
        return;
      }
      setAppliedCoupon({
        couponId: result.couponId,
        code: result.normalizedCode,
        discount: result.discount,
      });
      checkoutIdempotencyKeyRef.current = null;
      setCouponCode(result.normalizedCode);
      setCustomerCouponMessage(`ใช้คูปอง ${result.normalizedCode} แล้ว`);
    });
  }

  function handleClearCoupon() {
    checkoutIdempotencyKeyRef.current = null;
    setAppliedCoupon(null);
    setCustomerCouponMessage("ล้างคูปองแล้ว");
  }

  /** เข้าโหมดเพิ่มรายการเข้าโต๊ะ (ส่งครัว) — ใช้ทั้งจากบิลโต๊ะและจากหน้าเปิดโต๊ะ */
  function startDineInAdd(tableId: string, tableNumber: string) {
    setDineInTable({ id: tableId, number: tableNumber });
    setTicketDraft((current) => ({ ...current, tableId, tableNumber }));
    setShowTableBill(false);
    setBillTableId(null);
    setBillTableNumber(null);
    setShowTableOpen(false);
    setOrderPanelOpen(true);
    setTicketMessage(`กำลังเพิ่มรายการเข้าโต๊ะ ${tableNumber} — เลือกเมนูแล้วกด "ส่งเข้าครัว"`);
  }

  /** ส่งรายการในตะกร้าเข้าครัวสำหรับโต๊ะที่กำลังเพิ่มรายการ (ออเดอร์เปิดผูกโต๊ะ ยังไม่เก็บเงิน) */
  function handleSendToKitchen() {
    if (!dineInTable || cart.items.length === 0) return;
    const table = dineInTable;
    const qrItems = cart.items.map((item) => ({
      productId: item.productId,
      variantId: item.variant?.id,
      modifierOptionIds: item.modifiers.map((m) => m.option.id),
      quantity: item.quantity,
      note: item.note,
    }));
    startTransition(async () => {
      const res = await addItemsToTableAction(table.id, qrItems);
      if (res.error) {
        setTicketMessage(res.error);
        return;
      }
      commitCart(emptyCart(storeId), { resetItemDiscountForms: true });
      setDineInTable(null);
      setTicketMessage(`ส่งเข้าครัวแล้ว — โต๊ะ ${table.number}${res.orderNumber ? ` (ออเดอร์ ${res.orderNumber})` : ""}`);
      // เปิดบิลโต๊ะกลับมาให้เห็นรายการที่เพิ่ง add
      setBillTableId(table.id);
      setShowTableBill(true);
    });
  }

  function handleSaveTicket() {
    if (cart.items.length === 0) {
      setTicketMessage("ยังไม่มีรายการให้บันทึกตั๋ว");
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const existing = activeTicketId ? savedTickets.find((ticket) => ticket.id === activeTicketId) : null;
    const tableNumber = ticketDraft.tableNumber?.trim() || existing?.tableNumber;
    const customerName = ticketDraft.customerName?.trim() || existing?.customerName;
    const note = ticketDraft.note?.trim() || existing?.note;
    const label = [tableNumber ? `โต๊ะ ${tableNumber}` : null, customerName].filter(Boolean).join(" · ");
    const ticket: SavedOrderTicket = {
      id: existing?.id ?? createTicketId(),
      ticketNumber: existing?.ticketNumber ?? createTicketNumber(now),
      label: label || existing?.label || `ตั๋ว ${createTicketNumber(now)}`,
      cart,
      tableId: ticketDraft.tableId ?? existing?.tableId,
      tableNumber,
      customerName,
      note,
      buffetSessionId: ticketDraft.buffetSessionId ?? existing?.buffetSessionId,
      syncState: "local",
      lastSyncedAt: existing?.lastSyncedAt,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    startTicketTransition(async () => {
      const result = await saveSavedTicketAction(ticket);
      const savedTicket: SavedOrderTicket = {
        ...(result.ticket ?? ticket),
        syncState: result.error ? "sync_failed" : "synced",
        lastSyncedAt: result.error ? ticket.lastSyncedAt : new Date().toISOString(),
      };
      const next = existing
        ? savedTickets.map((item) => (item.id === savedTicket.id ? savedTicket : item))
        : [savedTicket, ...savedTickets].slice(0, 30);

      if (persistSavedTickets(next)) {
        setActiveTicketId(savedTicket.id);
        setTicketMessage(
          result.error
            ? `บันทึกในเครื่องแล้ว แต่ยัง sync server ไม่สำเร็จ: ${result.error}`
            : `${existing ? "บันทึกกลับไปใหม่" : "บันทึกตั๋ว"} ${savedTicket.ticketNumber} แล้ว`,
        );
      }
    });
  }

  function handleLoadTicket(ticket: SavedOrderTicket) {
    if (pendingOrder) {
      setTicketMessage("สร้างออร์เดอร์แล้ว กรุณาชำระเงินให้จบก่อนเรียกตั๋วอื่น");
      return false;
    }
    if (isTicketSyncPending) {
      setTicketMessage("กำลังซิงค์ตั๋ว กรุณารอสักครู่");
      return false;
    }
    commitCart(ticket.cart, { resetItemDiscountForms: true });
    setDiscountFormOpen(false);
    setActiveTicketId(ticket.id);
    setTicketDraft({
      tableId: ticket.tableId,
      tableNumber: ticket.tableNumber ?? "",
      customerName: ticket.customerName ?? "",
      note: ticket.note ?? "",
      buffetSessionId: ticket.buffetSessionId,
    });
    setPhase("ordering");
    setReceipt(null);
    setPayError(null);
    setSelectedCustomer(null);
    setCustomerResults([]);
    setAppliedCoupon(null);
    setCouponCode("");
    setCustomerCouponMessage(null);
    setOrderPanelOpen(true);
    setTicketMessage(`เรียกตั๋ว ${ticket.ticketNumber} กลับมาแล้ว`);
    return true;
  }

  async function handleDeleteTicket(ticketId: string) {
    const ticket = savedTickets.find((item) => item.id === ticketId);
    if (ticket?.syncState === "sync_failed" || ticket?.syncState === "local") {
      const next = savedTickets.filter((item) => item.id !== ticketId);
      if (persistSavedTickets(next)) {
        if (activeTicketId === ticketId) {
          setActiveTicketId(null);
          setTicketDraft(EMPTY_TICKET_DRAFT);
        }
        setTicketMessage(`ลบตั๋ว ${ticket.ticketNumber} เฉพาะเครื่องนี้แล้ว`);
      }
      return;
    }
    const closeRelatedTableSession =
      !!ticket?.tableId &&
      (await confirm({
        title: "ลบตั๋ว",
        message: `ลบตั๋วและเคลียร์โต๊ะ ${ticket.tableNumber ?? ""}?`,
        confirmLabel: "ลบและเคลียร์โต๊ะ",
        cancelLabel: "ลบตั๋วอย่างเดียว",
        danger: true,
      }));
    startTicketTransition(async () => {
      const result = await deleteSavedTicketAction(ticketId, { closeRelatedTableSession });
      if (result.error) {
        setTicketMessage(`ลบตั๋วไม่สำเร็จ: ${result.error}`);
        return;
      }
      const next = savedTickets.filter((item) => item.id !== ticketId);
      if (persistSavedTickets(next)) {
        if (activeTicketId === ticketId) {
          setActiveTicketId(null);
          setTicketDraft(EMPTY_TICKET_DRAFT);
        }
        setTicketMessage(ticket ? `ลบตั๋ว ${ticket.ticketNumber} แล้ว` : "ลบตั๋วแล้ว");
      }
    });
  }

  async function handlePrintTicket() {
    if (cart.items.length === 0) {
      setTicketMessage("ยังไม่มีรายการให้พิมพ์ใบสั่งออเดอร์");
      return;
    }

    const settings: ReceiptSettings = receiptSettings ?? {
      id: "",
      storeId: "",
      organizationId: "",
      storeName,
      showTaxId: false,
      showQrPayment: false,
      autoPrintReceipt: false,
      autoPrintStationTickets: false,
      paperWidth: "80mm" as const,
      printCopies: 1,
      showVatBreakdown: false,
      vatRate: 7,
      updatedAt: new Date().toISOString(),
    };
    const ticketNumber = activeTicket?.ticketNumber ?? createTicketNumber();
    const ticketData = {
      storeName: settings.storeName || storeName,
      address: settings.address,
      phone: settings.phone,
      taxId: settings.taxId,
      showTaxId: false,
      orderNumber: `ใบสั่ง ${ticketNumber}`,
      items: cart.items.map((item) => ({
        name: item.productName,
        variantName: item.variant?.name,
        modifierNames: item.modifiers.map(modifierDetail),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        discount: item.discount,
        discountType: item.discountType,
        discountValue: item.discountValue,
        discountNote: item.discountNote,
        note: item.note,
      })),
      subtotal: cart.subtotal,
      discount: cart.discount,
      discountNote: cart.discountNote,
      total: cart.total,
      payments: [],
      paymentStatus: "unpaid" as const,
      footerText: "ใบสั่งออเดอร์ ไม่ใช่ใบเสร็จ",
      showQrPayment: settings.showQrPayment,
      promptpayId: settings.promptpayId,
      headerText: "*** ใบสั่งออเดอร์ ***",
      paperWidth: settings.paperWidth,
      printCopies: settings.printCopies,
      printedAt: new Date().toISOString(),
    };

    setIsPrintingTicket(true);
    setTicketMessage(null);
    setPrintStatusMessage("กำลังส่งงานพิมพ์ใบสั่ง...");
    try {
      const result = await printReceiptWithFallback({
        printers,
        preferredPrinterId: preferredPrinterIdForPrint,
        escpos: ticketData,
        browser: ticketData,
      });
      const message = printSuccessMessage(`พิมพ์ใบสั่งออเดอร์ ${ticketNumber} แล้ว`, result, printerLoadError);
      setPrintStatusMessage(message);
      setTicketMessage(message);
    } catch (err) {
      setPrintStatusMessage("พิมพ์ใบสั่งออเดอร์ไม่สำเร็จ กดพิมพ์ซ้ำหรือใช้ browser print fallback");
      setTicketMessage(err instanceof Error ? err.message : "พิมพ์ใบสั่งออเดอร์ไม่สำเร็จ");
    } finally {
      setIsPrintingTicket(false);
    }
  }

  function handleConfirmPayment(method: "cash" | "qr_promptpay", received?: number, opts?: { qrPaymentVerified?: boolean }) {
    setPayError(null);
    if (couponCode.trim() && !appliedCoupon) {
      setPayError("กรุณากดใช้คูปองก่อนชำระเงิน");
      return;
    }
    startTransition(async () => {
      const paymentInput = {
        method,
        amount: displayCart.total,
        receivedAmount: received,
        changeAmount: received !== undefined ? Math.max(0, received - displayCart.total) : undefined,
        qrPaymentVerified: method === "qr_promptpay" ? opts?.qrPaymentVerified : undefined,
      };
      let order = pendingOrder;
      let paidOrder: Order | null = null;
      if (!order) {
        // Pay-now path: one server round trip creates the order and closes the bill.
        const checkoutTicketContext = {
          tableId: ticketDraft.tableId ?? activeTicket?.tableId,
          tableNumber: ticketDraft.tableNumber?.trim() || activeTicket?.tableNumber,
          note: ticketDraft.note?.trim() || activeTicket?.note,
        };
        const checkoutIdempotencyKey = checkoutIdempotencyKeyRef.current ?? createTicketId();
        checkoutIdempotencyKeyRef.current = checkoutIdempotencyKey;
        const result = await checkoutAndPayAction(cart, paymentInput, {
          tableId: checkoutTicketContext.tableId,
          tableNumber: checkoutTicketContext.tableNumber,
          note: checkoutTicketContext.note,
          customerId: selectedCustomer?.id ?? null,
          couponCode: appliedCoupon?.code ?? null,
          clientCouponDiscountAmount: appliedCoupon?.discount ?? 0,
          idempotencyKey: checkoutIdempotencyKey,
          paymentIdempotencyKey: createTicketId(),
        });
        if (result.error) {
          // Order persisted but payment failed — remember it so retry only pays.
          if (result.failedStage === "payment" && result.orderId && result.orderNumber) {
            order = { orderId: result.orderId, orderNumber: result.orderNumber };
            setPendingOrder(order);
          }
          setPayError(result.error);
          return;
        }
        if (!result.orderId || !result.orderNumber) {
          setPayError("ไม่สามารถสร้างออร์เดอร์ได้");
          return;
        }
        order = { orderId: result.orderId, orderNumber: result.orderNumber };
        paidOrder = result.order;
      } else {
        // Retry path: the order already exists from a failed payment attempt.
        const payResult = await collectPaymentAction(order.orderId, paymentInput, {
          idempotencyKey: createTicketId(),
        });
        if (payResult.error) {
          setPayError(payResult.error);
          return;
        }
        paidOrder = payResult.order;
      }
      paidDisplayCartRef.current = displayCart;
      paidCustomerNameRef.current = selectedCustomer?.name;
      const paidPointsEarned = paidOrder?.loyaltyPointsEarned;
      const hasPaidPointMovement = typeof paidPointsEarned === "number" && paidPointsEarned > 0;
      paidCustomerRef.current = selectedCustomer && paidOrder
        ? {
            name: selectedCustomer.name,
            pointsEarned: paidOrder.loyaltyPointsEarned,
            pointsBalance: hasPaidPointMovement ? paidOrder.loyaltyPointsBalance : undefined,
          }
        : null;
      if (customerDisplayEnabled) {
        publishCustomerDisplaySnapshot(displayCart, {
          status: "paid",
          customerName: selectedCustomer?.name,
          customer: paidCustomerRef.current,
        });
      }
      setReceipt({
        orderNumber: order.orderNumber,
        items: displayCart.items,
        subtotal: displayCart.subtotal,
        discount: displayCart.discount,
        discountNote: displayCart.discountNote,
        total: displayCart.total,
        method,
        receivedAmount: received,
        changeAmount: received !== undefined ? Math.max(0, received - displayCart.total) : undefined,
        loyaltyPointsEarned: paidOrder?.loyaltyPointsEarned,
        loyaltyPointsBalance: paidOrder?.loyaltyPointsBalance,
        // บิลที่ยังไม่ผูกลูกค้าจะมี QR รับแต้มตามมาทีหลัง — บอกใบเสร็จให้รอก่อนพิมพ์อัตโนมัติ
        loyaltyClaimPending: !selectedCustomer && Boolean(order.orderId),
      });
      // Receipt must appear immediately after payment — ticket cleanup runs in the
      // background and must never delay the phase switch.
      setPendingOrder(null);
      setPhase("receipt");

      // QR รับแต้ม: เฉพาะบิลที่ยังไม่ผูกลูกค้า (บิลที่ผูกแล้วได้แต้มไปตั้งแต่จ่ายเงิน)
      // ขอแบบไม่บล็อกการเปิดหน้าใบเสร็จ แต่การพิมพ์จะรอจนรู้ผล QR และหยุดพร้อมแจ้งเมื่อเกิด error
      if (!selectedCustomer) {
        const claimOrderId = order.orderId;
        void (async () => {
          const claimResult = await getReceiptLoyaltyClaimAction(claimOrderId).catch(() => ({
            error: "เชื่อมต่อระบบสะสมแต้มไม่สำเร็จ",
            claim: null,
          }));
          setReceipt((current) =>
            current && current.orderNumber === order.orderNumber
              ? {
                  ...current,
                  loyaltyClaim: claimResult.claim ?? undefined,
                  loyaltyClaimPending: false,
                  loyaltyClaimError: claimResult.error ?? undefined,
                }
              : current,
          );
        })();
      }
      if (activeTicketId) {
        void (async () => {
          const deleteResult = await deleteSavedTicketAction(activeTicketId);
          if (deleteResult.error) {
            setTicketMessage(`ปิดการขายแล้ว แต่ลบตั๋วบน server ไม่สำเร็จ: ${deleteResult.error}`);
          } else {
            persistSavedTickets(savedTickets.filter((ticket) => ticket.id !== activeTicketId));
            setActiveTicketId(null);
          }
        })();
      }
    });
  }

  function handleNewOrder() {
    commitCart(emptyCart(storeId), { resetItemDiscountForms: true });
    setPhase("ordering");
    setReceipt(null);
    setPayError(null);
    setPendingOrder(null);
    paidDisplayCartRef.current = null;
    paidCustomerNameRef.current = undefined;
    paidCustomerRef.current = null;
    setActiveTicketId(null);
    setTicketDraft(EMPTY_TICKET_DRAFT);
    setCustomerQuery("");
    setCustomerResults([]);
    setSelectedCustomer(null);
    setCouponCode("");
    setAppliedCoupon(null);
    setCustomerCouponMessage(null);
    setTicketMessage(null);
    setPrintStatusMessage(null);
    setOrderPanelOpen(false);
  }

  function handleTicketDraftChange(patch: Partial<TicketDraft>) {
    setTicketDraft((current) => ({ ...current, ...patch }));
  }

  function handleRefreshBillHistory(range = historyRange) {
    refreshBillHistory(range);
  }

  function handleHistoryRangeChange(range: BillHistoryRange) {
    const normalizedRange = normalizeHistoryRange(range, storeTimezone);
    setHistoryRange(normalizedRange);
    if (normalizedRange.mode !== "custom") {
      refreshBillHistory(normalizedRange);
    }
  }

  async function handlePrintHistoryOrder(order: Order) {
    setPrintStatusMessage(`กำลังเตรียม QR และพิมพ์ซ้ำ ${order.orderNumber}...`);
    const settings: ReceiptSettings = receiptSettings ?? {
      id: "",
      storeId: "",
      organizationId: "",
      storeName,
      showTaxId: false,
      showQrPayment: false,
      autoPrintReceipt: false,
      autoPrintStationTickets: false,
      paperWidth: "80mm" as const,
      printCopies: 1,
      showVatBreakdown: false,
      vatRate: 7,
      updatedAt: new Date().toISOString(),
    };
    const claimResult = !order.customerId
      ? await getReceiptLoyaltyClaimAction(order.id).catch(() => ({
          error: "เชื่อมต่อระบบสะสมแต้มไม่สำเร็จ",
          claim: null,
        }))
      : null;
    if (claimResult?.error) {
      setPrintStatusMessage(`QR รับแต้มไม่พร้อม: ${claimResult.error} กรุณาลองพิมพ์ซ้ำอีกครั้ง`);
      return;
    }
    const receiptData = {
      storeName: settings.storeName || storeName,
      address: settings.address,
      phone: settings.phone,
      taxId: settings.taxId,
      showTaxId: settings.showTaxId,
      headerText: settings.headerText,
      orderNumber: order.orderNumber,
      items: order.items.map((item) => ({
        name: item.productName,
        variantName: item.variantName,
        modifierNames: item.modifiers.map(modifierDetail),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        discount: item.discount,
        discountType: item.discountType,
        discountValue: item.discountValue,
        discountNote: item.discountNote,
        note: item.note,
      })),
      subtotal: order.subtotal,
      discount: order.discount,
      discountNote: order.discountNote,
      total: order.total,
      payments: order.payments.map((payment) => ({
        method: payment.method,
        amount: payment.amount,
        receivedAmount: payment.receivedAmount,
        changeAmount: payment.changeAmount,
        // บิลที่แก้ช่องทางชำระย้อนหลังต้องบอกบนใบว่าเดิมลงเป็นอะไร
        originalMethod: payment.originalMethod,
      })),
      paymentStatus: "paid" as const,
      loyaltyPointsEarned: order.customerId && (order.loyaltyPointsEarned ?? 0) > 0 ? order.loyaltyPointsEarned : undefined,
      loyaltyPointsBalance: order.customerId && (order.loyaltyPointsEarned ?? 0) > 0 ? order.loyaltyPointsBalance : undefined,
      loyaltyClaim: claimResult?.claim ?? undefined,
      vatRate: settings.showVatBreakdown && settings.vatRate > 0 ? settings.vatRate : undefined,
      footerText: settings.footerText,
      showQrPayment: false,
      promptpayId: settings.promptpayId,
      // ใบซ้ำต้องมีป้าย REPRINT ไม่งั้นแยกจากใบจริงไม่ออก (เอาไปเบิก/ลงบัญชีซ้ำได้)
      isReprint: true,
      // พิมพ์ซ้ำต้องได้ใบเหมือนใบแรก รวมถึงโลโก้หัวใบและรูป QR ท้ายใบที่ร้านอัปโหลดไว้
      logoUrl: settings.logoUrl,
      footerImageUrl: settings.footerImageUrl,
      footerImageLabel: settings.footerImageLabel,
      hideFooterImageWithSystemQr: settings.hideFooterImageWithSystemQr,
      paperWidth: settings.paperWidth,
      printCopies: settings.printCopies,
      printedAt: new Date().toISOString(),
    };
    setPrintStatusMessage(`กำลังพิมพ์ซ้ำ ${order.orderNumber}...`);
    try {
      const result = await printReceiptWithFallback({
        printers,
        preferredPrinterId: preferredPrinterIdForPrint,
        escpos: receiptData,
        browser: receiptData,
      });
      setPrintStatusMessage(printSuccessMessage(`พิมพ์ซ้ำ ${order.orderNumber} แล้ว`, result, printerLoadError));
    } catch (err) {
      setPrintStatusMessage(err instanceof Error ? err.message : "พิมพ์ซ้ำไม่สำเร็จ");
    }
  }

  async function handleVoidHistoryOrder(order: Order) {
    const ok = await confirm({
      title: "ยกเลิกบิล",
      message: `ยกเลิกบิล ${order.orderNumber}?`,
      confirmLabel: "ยกเลิกบิล",
      cancelLabel: "ไม่ยกเลิก",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await voidOrderAction(order.id, "ยกเลิกจาก POS bill history");
      if (result.error) {
        setTicketMessage(`ยกเลิกบิลไม่สำเร็จ: ${result.error}`);
        return;
      }
      setTicketMessage(`ยกเลิกบิล ${order.orderNumber} แล้ว`);
      handleRefreshBillHistory();
    });
  }

  function handleOpenChangePayment(order: Order) {
    setChangePaymentError(null);
    setChangePaymentOrder(order);
  }

  function handleCloseChangePayment() {
    setChangePaymentError(null);
    setChangePaymentOrder(null);
  }

  function handleChangePaymentMethod(order: Order, method: PaymentMethod, reason: string) {
    setChangePaymentError(null);
    startTransition(async () => {
      try {
        const result = await changeOrderPaymentMethodAction({
          orderId: order.id,
          method,
          reason: reason || undefined,
        });
        if (result.error) {
          setChangePaymentError(result.error);
          return;
        }
        setChangePaymentOrder(null);
        setTicketMessage(`แก้ช่องทางชำระบิล ${order.orderNumber} เป็น ${paymentMethodLabel(method)} แล้ว กำลังพิมพ์ใบใหม่...`);
        handleRefreshBillHistory();
        // ใบที่ลูกค้า/ร้านถืออยู่ยังบอกช่องทางเก่า จึงต้องมีใบใหม่ที่บอกว่าแก้เป็นอะไรออกมาคู่กันเสมอ
        if (result.order) {
          await handlePrintHistoryOrder(result.order);
        }
      } catch {
        setChangePaymentError("ไม่สามารถติดต่อระบบได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง");
      }
    });
  }

  const customerCouponTools = (
    <CustomerCouponPanel
      cart={cart}
      loyaltyEnabled={loyaltyEnabled}
      loyaltyUnavailableMessage={loyaltyUnavailableMessage}
      couponEnabled={couponEnabled}
      couponUnavailableMessage={couponUnavailableMessage}
      customerDisplayEnabled={customerDisplayEnabled}
      customerDisplayUnavailableMessage={customerDisplayUnavailableMessage}
      customerQuery={customerQuery}
      customerResults={customerResults}
      selectedCustomer={selectedCustomer}
      couponCode={couponCode}
      appliedCoupon={appliedCoupon}
      message={customerCouponMessage}
      isPending={isPending}
      onCustomerQueryChange={handleCustomerQueryChange}
      onSearchCustomer={handleSearchCustomer}
      onSelectCustomer={handleSelectCustomer}
      onClearCustomer={handleClearCustomer}
      onCouponCodeChange={(value) => {
        checkoutIdempotencyKeyRef.current = null;
        setCouponCode(value);
        setAppliedCoupon(null);
      }}
      onApplyCoupon={handleApplyCoupon}
      onClearCoupon={handleClearCoupon}
    />
  );

  function renderOrderPanelContent(onClose?: () => void) {
    return (
      <>
        {phase !== "ordering" && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 min-h-11 rounded-lg bg-white/90 px-3 text-xs font-semibold text-gray-600 shadow-sm lg:hidden"
          >
            ปิด
          </button>
        )}
        {phase === "ordering" && (
          <CartPanel
            cart={cart}
            displayCart={displayCart}
            appliedCoupon={appliedCoupon}
            selectedCustomerName={selectedCustomer?.name ?? null}
            onOpenCustomerTools={() => setCustomerToolsOpen(true)}
            onUpdateQty={(key, qty) => commitCart(updateQuantity(cart, key, qty))}
            onRemove={(key) => commitCart(removeFromCart(cart, key))}
            onCheckout={() => {
              setPhase("payment");
              setOrderPanelOpen(true);
            }}
            onClear={() => clearCurrentOrder()}
            onApplyItemDiscount={handleApplyItemDiscount}
            onClearItemDiscount={handleClearItemDiscount}
            itemDiscountResetKey={itemDiscountResetKey}
            canDiscount={canDiscount}
            onOpenDiscountTools={() => setDiscountFormOpen(true)}
            activeTicket={activeTicket}
            isTicketSyncPending={isTicketSyncPending}
            savedTicketCount={savedTickets.length}
            billHistoryCount={billHistory.length}
            ticketMessage={ticketMessage}
            printStatusMessage={printStatusMessage}
            onSaveTicket={handleSaveTicket}
            onOpenTickets={() => setTicketPanelOpen(true)}
            onOpenBillHistory={() => {
              setBillHistoryPanelOpen(true);
              handleRefreshBillHistory();
            }}
            onClose={onClose}
          />
        )}
        {phase === "payment" && (
          <PaymentPanel
            cart={displayCart}
            onConfirm={handleConfirmPayment}
            onShowPromptPayOnCustomerDisplay={handleShowPromptPayOnCustomerDisplay}
            onBack={() => {
              if (pendingOrder) {
                setPayError("สร้างออร์เดอร์แล้ว กรุณาชำระเงินให้จบก่อนแก้ไขตะกร้า");
                return;
              }
              setPhase("ordering");
              setPayError(null);
            }}
            isPending={isPending}
            error={payError}
            hasPendingOrder={pendingOrder !== null}
            promptpayId={receiptSettings?.promptpayId}
            customerDisplayEnabled={customerDisplayEnabled}
            customerDisplayUnavailableMessage={customerDisplayUnavailableMessage}
            cashSessionRequired={!cashSession}
          />
        )}
        {phase === "receipt" && receipt && (
          <ReceiptPanel
            order={receipt}
            receiptSettings={receiptSettings}
            storeName={storeName}
            printers={printers}
            preferredPrinterId={preferredPrinterIdForPrint}
            printerLoadError={printerLoadError}
            onNewOrder={handleNewOrder}
          />
        )}
      </>
    );
  }

  // เต็มความสูงของกล่องแม่ (h-full) ไม่ใช่ 100vh ตายตัว — เมื่อ POS ถูกวางใน shell รวม
  // ที่มีหัวข้อ/แท็บอยู่ด้านบน ความสูง 100vh จะดันให้ทั้งหน้าเลื่อน ผู้ใช้ต้องการให้เลื่อน
  // ได้เฉพาะรายการเมนูเท่านั้น
  // ปุ่มบนแถบหัวของหน้าขาย — วางผ่าน portal ไปอยู่แถวเดียวกับแท็บเมื่ออยู่ใน shell รวม
  const posActionButtons = (
    <>
      {/* โชว์ทุกขนาดจอ — สถานะออฟไลน์เป็นสิ่งที่แคชเชียร์บนมือถือยิ่งต้องเห็น */}
      <ConnectionBadge />
      {/* ใน POS รวม ปุ่มโต๊ะอยู่บนแถบหัวของ shell แล้ว (คุมทั้งผังโต๊ะ/ครัว/บิล)
          ที่นี่จึงแสดงเฉพาะตอนเปิด POS เดี่ยวที่ไม่มี shell */}
      {topbarHost ? null : (
        <button
          type="button"
          onClick={() => setTableMenuOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={tableMenuOpen}
          className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
        >
          🍽️ <span className="hidden sm:inline">โต๊ะ</span>
        </button>
      )}
      <CashSessionPanel
        session={cashSession}
        cashSalesPreview={cashSalesPreview}
        cashMovementPreview={cashMovementPreview}
        currency={currency}
        forceOpenPrompt={!cashSession && canRecordCashflow}
      />
      <button
        type="button"
        onClick={() => setPrinterConnectionOpen((open) => !open)}
        className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
        aria-expanded={printerConnectionOpen}
        aria-controls="pos-printer-connection"
      >
        <span className="sm:hidden">ปริ้น</span>
        <span className="hidden sm:inline">เชื่อมต่อเครื่องพิมพ์</span>
      </button>
      {exitHref ? (
        <a href={exitHref} className="btn-secondary min-h-11 shrink-0 px-3 text-xs" aria-label="กลับ">
          ←<span className="hidden sm:inline"> กลับ</span>
        </a>
      ) : (
        <form action={signOut} className="shrink-0">
          <SubmitButton variant="secondary" className="min-h-11 px-3 text-xs" aria-label="ออกจากระบบ">
            <span className="sm:hidden">⎋</span>
            <span className="hidden sm:inline">ออกจากระบบ</span>
          </SubmitButton>
        </form>
      )}
    </>
  );

  // อยู่ใน shell รวม = ยิงปุ่มขึ้นไปแถวแท็บ (แถวเดียว) / อยู่เดี่ยว = แถบหัวของตัวเอง
  const posActions = topbarHost
    ? createPortal(posActionButtons, topbarHost)
    : (
      <header className="topbar h-auto min-h-16 flex-nowrap justify-end overflow-x-auto">
        {posActionButtons}
      </header>
    );

  return (
    <div className="storeos-pos flex h-full min-h-0 flex-col overflow-hidden bg-[var(--canvas)] md:flex-row">
      {/* งานพิมพ์ที่ไม่ทราบผลต้องเห็นตรงจุดที่คนยืนอยู่หน้าเครื่องพิมพ์ (การ์ดลอย ไม่กินความสูง) */}
      <PrintQueueAlert />

      {/* Product catalog */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* ปุ่มบนแถบหัว: ไม่มีโลโก้/ชื่อร้านแล้ว (หน้า POS ไม่ต้องบอกว่าอยู่ร้านไหน
            ทุกวินาที และที่ตรงนั้นมีค่ากว่าถ้าให้ปุ่มสั่งงานด้วยเสียงอยู่แทน) */}
        {posActions}

        {printerLoadError && (
          <div role="status" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
            โหลดการตั้งค่าเครื่องพิมพ์ไม่สำเร็จ: {printerLoadError} · ระบบจะใช้ช่องทางสำรองเมื่อพิมพ์
          </div>
        )}

        {printerConnectionOpen && (
          <div id="pos-printer-connection">
            <PrinterConnectionPanel
              variant="compact"
              printers={printers}
              printerLoadError={printerLoadError}
              storeName={receiptSettings?.storeName ?? storeName}
              paperWidth={receiptSettings?.paperWidth ?? "80mm"}
              onNetworkPrinterSelect={setPreferredPrinterId}
            />
          </div>
        )}

        {/* Category tabs */}
        <div className="shrink-0 flex gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <button
            type="button"
            onClick={() => setSelectedCategoryId(null)}
            className={`shrink-0 min-h-11 px-4 py-2 text-xs rounded-full border font-bold transition-colors ${
              selectedCategoryId === null
                ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                : "border-[var(--border)] text-[var(--ink-2)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
            }`}
          >
            ทั้งหมด
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategoryId(cat.id)}
              className={`shrink-0 min-h-11 px-4 py-2 text-xs rounded-full border font-bold transition-colors ${
                selectedCategoryId === cat.id
                  ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                  : "border-[var(--border)] text-[var(--ink-2)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Product grid */}
        <div className="flex-1 overflow-y-auto p-3">
          {filteredProducts.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-gray-400">
              ไม่มีสินค้าในหมวดนี้
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {filteredProducts.map((product) => (
                <PosProductTile
                  key={product.id}
                  disabled={cartLocked}
                  onSelect={handleProductClick}
                  product={product}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOrderPanelOpen(true)}
        className={`fixed bottom-4 right-4 z-40 min-h-11 items-center gap-2 rounded-full bg-[var(--tenant-primary)] px-4 py-2 text-sm font-bold text-white shadow-lg md:hidden ${
          orderPanelOpen ? "hidden" : "flex"
        }`}
      >
        <span>เปิดออร์เดอร์</span>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">
          {cart.items.length} · {priceStr(displayCart.total)}
        </span>
      </button>

      {/* Mobile / tablet order drawer */}
      <div
        role="dialog"
        aria-label="ออร์เดอร์"
        aria-modal={orderPanelOpen && !utilitySheetOpen ? "true" : undefined}
        aria-hidden={!orderPanelOpen || utilitySheetOpen ? true : undefined}
        inert={!orderPanelOpen || utilitySheetOpen ? true : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOrderPanelOpen(false);
        }}
        className={`fixed inset-0 z-50 flex h-[100dvh] flex-col border-t border-gray-200 bg-white transition-transform duration-200 md:hidden ${
          orderPanelOpen ? "translate-y-0" : "pointer-events-none translate-y-full"
        }`}
      >
        {phase !== "ordering" && (
          <button
            type="button"
            onClick={() => setOrderPanelOpen(false)}
            className="absolute right-3 top-3 z-10 min-h-11 rounded-lg bg-white/90 px-3 text-xs font-semibold text-gray-600 shadow-sm lg:hidden"
          >
            ปิด
          </button>
        )}
        {phase === "ordering" && (
          <CartPanel
            cart={cart}
            displayCart={displayCart}
            appliedCoupon={appliedCoupon}
            selectedCustomerName={selectedCustomer?.name ?? null}
            onOpenCustomerTools={() => setCustomerToolsOpen(true)}
            onUpdateQty={(key, qty) => commitCart(updateQuantity(cart, key, qty))}
            onRemove={(key) => commitCart(removeFromCart(cart, key))}
            onCheckout={() => {
              setPhase("payment");
              setOrderPanelOpen(true);
            }}
            onClear={() => clearCurrentOrder()}
            onApplyItemDiscount={handleApplyItemDiscount}
            onClearItemDiscount={handleClearItemDiscount}
            itemDiscountResetKey={itemDiscountResetKey}
            canDiscount={canDiscount}
            onOpenDiscountTools={() => setDiscountFormOpen(true)}
            activeTicket={activeTicket}
            isTicketSyncPending={isTicketSyncPending}
            savedTicketCount={savedTickets.length}
            billHistoryCount={billHistory.length}
            ticketMessage={ticketMessage}
            printStatusMessage={printStatusMessage}
            onSaveTicket={handleSaveTicket}
            onOpenTickets={() => setTicketPanelOpen(true)}
            onOpenBillHistory={() => {
              setBillHistoryPanelOpen(true);
              handleRefreshBillHistory();
            }}
            onClose={() => setOrderPanelOpen(false)}
          />
        )}
        {phase === "payment" && (
          <PaymentPanel
            cart={displayCart}
            onConfirm={handleConfirmPayment}
            onShowPromptPayOnCustomerDisplay={handleShowPromptPayOnCustomerDisplay}
            onBack={() => {
              if (pendingOrder) {
                setPayError("สร้างออร์เดอร์แล้ว กรุณาชำระเงินให้จบก่อนแก้ไขตะกร้า");
                return;
              }
              setPhase("ordering");
              setPayError(null);
            }}
            isPending={isPending}
            error={payError}
            hasPendingOrder={pendingOrder !== null}
            promptpayId={receiptSettings?.promptpayId}
            customerDisplayEnabled={customerDisplayEnabled}
            customerDisplayUnavailableMessage={customerDisplayUnavailableMessage}
            cashSessionRequired={!cashSession}
          />
        )}
        {phase === "receipt" && receipt && (
          <ReceiptPanel
            order={receipt}
            receiptSettings={receiptSettings}
            storeName={storeName}
            printers={printers}
            preferredPrinterId={preferredPrinterIdForPrint}
            printerLoadError={printerLoadError}
            onNewOrder={handleNewOrder}
          />
        )}
      </div>

      <aside className="hidden min-h-0 overflow-hidden border-l border-gray-200 bg-white md:flex md:w-80 md:shrink-0 md:flex-col">
        {renderOrderPanelContent()}
      </aside>

      {/* เมนูโต๊ะ — ยุบสองปุ่มบนแถบหัว (เปิดโต๊ะ / เช็คบิลโต๊ะ) เหลือปุ่มเดียว
          งานโต๊ะไม่ได้ทำทุกบิล การให้กินที่แถบหัวสองช่องจึงไม่คุ้ม */}
      <PosUtilitySheet
        open={tableMenuOpen}
        title="โต๊ะ"
        onClose={() => setTableMenuOpen(false)}
      >
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              setTableMenuOpen(false);
              setShowTableOpen(true);
            }}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition-colors hover:bg-gray-50 motion-reduce:transition-none"
          >
            <span aria-hidden="true" className="text-xl">🍽️</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-gray-900">เปิดโต๊ะ</span>
              <span className="block text-xs text-gray-500">เริ่มรอบโต๊ะใหม่ พิมพ์ QR ให้ลูกค้าสั่งเอง</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTableMenuOpen(false);
              setShowTableBill(true);
            }}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition-colors hover:bg-gray-50 motion-reduce:transition-none"
          >
            <span aria-hidden="true" className="text-xl">🧾</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-gray-900">เช็คบิลโต๊ะ</span>
              <span className="block text-xs text-gray-500">รวมบิลทั้งโต๊ะแล้วรับเงิน</span>
            </span>
          </button>
        </div>
      </PosUtilitySheet>

      <PosUtilitySheet
        open={discountFormOpen && canDiscount}
        title="ส่วนลดท้ายบิล"
        onClose={() => setDiscountFormOpen(false)}
      >
        <BillDiscountPanel
          cart={cart}
          discountMode={discountDraft.mode}
          discountAmount={discountDraft.amount}
          discountPercentage={discountDraft.percentage}
          discountNote={discountDraft.note}
          onDiscountDraftChange={updateDiscountDraft}
          onApplyDiscount={handleApplyDiscount}
          onClose={() => setDiscountFormOpen(false)}
        />
      </PosUtilitySheet>

      <PosUtilitySheet
        open={customerToolsOpen}
        title="ลูกค้า / คูปอง / จอลูกค้า"
        onClose={() => setCustomerToolsOpen(false)}
      >
        {customerCouponTools}
      </PosUtilitySheet>

      <PosUtilitySheet
        open={ticketPanelOpen}
        title="ระบบตั๋ว"
        onClose={() => setTicketPanelOpen(false)}
      >
        <TicketPanel
          cart={cart}
          savedTickets={savedTickets}
          activeTicketId={activeTicketId}
          activeTicket={activeTicket}
          ticketDraft={ticketDraft}
          ticketMessage={ticketMessage}
          printStatusMessage={printStatusMessage}
          isTicketSyncPending={isTicketSyncPending}
          isPrintingTicket={isPrintingTicket}
          onSaveTicket={handleSaveTicket}
          onPrintTicket={handlePrintTicket}
          onLoadTicket={(ticket) => {
            const loaded = handleLoadTicket(ticket);
            if (!loaded) return;
            setTicketPanelOpen(false);
            setOrderPanelOpen(true);
          }}
          onDeleteTicket={handleDeleteTicket}
          onTicketDraftChange={handleTicketDraftChange}
        />
      </PosUtilitySheet>

      <PosUtilitySheet
        open={billHistoryPanelOpen && changePaymentOrder === null}
        title="ประวัติบิล"
        onClose={() => setBillHistoryPanelOpen(false)}
      >
        <BillHistoryPanel
          orders={billHistory}
          isPending={isBillHistoryPending}
          historyRange={historyRange}
          storeTimezone={storeTimezone}
          onHistoryRangeChange={handleHistoryRangeChange}
          onRefresh={handleRefreshBillHistory}
          onPrint={handlePrintHistoryOrder}
          onVoid={handleVoidHistoryOrder}
          onChangePayment={handleOpenChangePayment}
          historyMode="sheet"
        />
      </PosUtilitySheet>

      {/* Dine-in: ส่งรายการเข้าครัวสำหรับโต๊ะที่กำลังเพิ่มรายการ */}
      {dineInTable && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-2 border-t border-teal-200 bg-teal-50 px-4 py-2 shadow-lg">
          <span className="min-w-0 truncate text-sm font-semibold text-teal-800">
            เพิ่มรายการเข้าโต๊ะ {dineInTable.number} · {cart.items.reduce((s, i) => s + i.quantity, 0)} รายการ
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setDineInTable(null)}
              className="min-h-10 px-3 text-xs text-gray-500 hover:text-gray-800"
            >
              ยกเลิก
            </button>
            <Button
              onClick={handleSendToKitchen}
              loading={isPending}
              disabled={cart.items.length === 0}
              className="min-h-10 rounded-lg bg-teal-600 px-4 text-sm font-bold text-white disabled:opacity-40"
            >
              ส่งเข้าครัว
            </Button>
          </div>
        </div>
      )}

      {/* Picker modal */}
      {picker && (
        <ProductPickerModal
          /* U21 — remount เมื่อ "เสียง" เปลี่ยนตัวเลือก เพื่อให้หน้าต่างแสดงตามที่พูด
             (การกดเลือกด้วยมือไม่แตะ state ตัวนี้ จึงไม่ทำให้ remount ระหว่างพิมพ์/กด) */
          key={`${picker.product.id}|${picker.selectedVariant?.id ?? ""}|${Object.values(picker.selectedModifiers)
            .flat()
            .map((option) => option.id)
            .sort()
            .join(",")}`}
          picker={picker}
          onAdd={handleAddFromPicker}
          onClose={() => setPicker(null)}
        />
      )}

      {/* Open à la carte table session */}
      {showTableOpen && (
        <TableOpenModal
          onClose={() => setShowTableOpen(false)}
          onSelectTable={(table) => {
            setTicketDraft((current) => ({
              ...current,
              tableId: table.id,
              tableNumber: table.label ?? table.number,
              buffetSessionId: table.currentSessionId ?? undefined,
            }));
            setTicketMessage(`ผูกตั๋วกับโต๊ะ ${table.label ?? table.number} แล้ว`);
            setOrderPanelOpen(true);
          }}
          onOpenBill={(tableId, tableLabel) => {
            setBillTableId(tableId);
            setBillTableNumber(tableLabel);
            setShowTableOpen(false);
            setShowTableBill(true);
          }}
          onAddItems={(tableId, tableLabel) => startDineInAdd(tableId, tableLabel)}
        />
      )}

      {/* Settle QR table bills */}
      {showTableBill && (
        <TableBillModal
          currency={currency}
          promptpayId={receiptSettings?.promptpayId}
          storeName={storeName}
          receiptSettings={receiptSettings}
          printers={printers}
          preferredPrinterId={preferredPrinterIdForPrint}
          initialTableId={billTableId}
          initialTableNumber={billTableNumber}
          onClose={() => { setShowTableBill(false); setBillTableId(null); setBillTableNumber(null); }}
          onSettled={() => {}}
          onAddItems={(tableId, tableNumber) => startDineInAdd(tableId, tableNumber)}
        />
      )}

      {changePaymentOrder && (
        <ChangePaymentModal
          order={changePaymentOrder}
          isPending={isPending}
          error={changePaymentError}
          onClose={handleCloseChangePayment}
          onSubmit={(method, reason) => handleChangePaymentMethod(changePaymentOrder, method, reason)}
        />
      )}
      {confirmDialog}
    </div>
  );
}
