"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { Category, Product, ProductVariant, ModifierOption, ModifierGroup } from "@/modules/catalog/types";
import type { Cart, CartItem } from "@/modules/pos/types";
import { emptyCart, addToCart, updateQuantity, removeFromCart } from "@/modules/pos/cart";
import type { AddToCartInput } from "@/modules/pos/cart";
import { submitOrderAction, collectPaymentAction } from "./actions";
import { signOut } from "../(dashboard)/actions";
import type { ReceiptSettings } from "@/modules/stores/types";
import { printReceiptAuto } from "@/modules/printing/print-router";
import { CashSessionPanel } from "./CashSessionPanel";
import type { CashSession } from "@/modules/cashflow/types";
import { QrCode } from "@/shared/components/ui/QrCode";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { TableBillModal } from "./TableBillModal";
import { TableOpenModal } from "./TableOpenModal";

// ─── Types ────────────────────────────────────────────────────────

type Phase = "ordering" | "payment" | "receipt";

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
  currency: string;
}

interface SavedOrderTicket {
  id: string;
  ticketNumber: string;
  label: string;
  cart: Cart;
  createdAt: string;
  updatedAt: string;
}

const POS_TICKET_STORAGE_PREFIX = "storeos.pos.tickets";

// ─── Helpers ──────────────────────────────────────────────────────

function priceStr(n: number) {
  return `฿${n.toLocaleString("th-TH")}`;
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

function changeStr(received: number, total: number) {
  const change = received - total;
  if (change < 0) return null;
  return `เงินทอน ${priceStr(change)}`;
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
  onUpdateQty,
  onRemove,
  onCheckout,
  onClear,
  savedTickets,
  activeTicketId,
  ticketMessage,
  isPrintingTicket,
  onSaveTicket,
  onPrintTicket,
  onLoadTicket,
  onDeleteTicket,
  onClose,
}: {
  cart: Cart;
  onUpdateQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onCheckout: () => void;
  onClear: () => void;
  savedTickets: SavedOrderTicket[];
  activeTicketId: string | null;
  ticketMessage: string | null;
  isPrintingTicket: boolean;
  onSaveTicket: () => void;
  onPrintTicket: () => void;
  onLoadTicket: (ticket: SavedOrderTicket) => void;
  onDeleteTicket: (ticketId: string) => void;
  onClose?: () => void;
}) {
  const activeTicket = activeTicketId ? savedTickets.find((ticket) => ticket.id === activeTicketId) : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div>
          <span className="text-sm font-semibold text-gray-800">ออร์เดอร์</span>
          {activeTicket && (
            <p className="text-[11px] text-amber-600">
              กำลังแก้ {activeTicket.ticketNumber}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {cart.items.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="min-h-11 px-3 text-xs text-red-400 hover:text-red-600"
            >
              ล้าง
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 px-3 text-xs text-gray-500 hover:text-gray-800 lg:hidden"
            >
              ปิด
            </button>
          )}
        </div>
      </div>

      <div className="border-b border-gray-100 px-4 py-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={cart.items.length === 0}
            onClick={onSaveTicket}
            className="min-h-11 rounded-lg border border-amber-200 px-3 text-xs font-semibold text-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {activeTicket ? "บันทึกทับตั๋ว" : "บันทึกตั๋ว"}
          </button>
          <button
            type="button"
            disabled={cart.items.length === 0 || isPrintingTicket}
            onClick={onPrintTicket}
            className="min-h-11 rounded-lg border border-gray-300 px-3 text-xs font-semibold text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPrintingTicket ? "กำลังพิมพ์..." : "พิมพ์ใบสั่ง"}
          </button>
        </div>
        <p className="text-[11px] text-gray-500">ใบสั่งออเดอร์ ไม่ใช่ใบเสร็จ</p>
        {ticketMessage && (
          <p aria-live="polite" className="text-xs text-amber-700">
            {ticketMessage}
          </p>
        )}
        {savedTickets.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-gray-500">ตั๋วที่บันทึก</p>
            <ul className="max-h-28 space-y-1 overflow-y-auto pr-1">
              {savedTickets.map((ticket) => (
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
                    <span className="block font-semibold">{ticket.ticketNumber}</span>
                    <span className="block text-[11px] text-gray-500">
                      {ticket.cart.items.length} รายการ · {priceStr(ticket.cart.total)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteTicket(ticket.id)}
                    className="min-h-11 rounded-lg px-2 text-[11px] text-red-400 hover:text-red-600"
                    aria-label={`ลบตั๋ว ${ticket.ticketNumber}`}
                  >
                    ลบ
                  </button>
                </li>
              ))}
            </ul>
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
                key={item.key}
                item={item}
                onUpdateQty={onUpdateQty}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-gray-100 px-4 py-3 space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>ยอดรวม</span>
          <span className="tabular-nums">{priceStr(cart.subtotal)}</span>
        </div>
        {cart.discount > 0 && (
          <div className="flex justify-between text-xs text-green-600">
            <span>ส่วนลด</span>
            <span className="tabular-nums">-{priceStr(cart.discount)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-semibold text-gray-900 pt-1 border-t border-gray-100">
          <span>รวมทั้งหมด</span>
          <span className="tabular-nums">{priceStr(cart.total)}</span>
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

function CartItemRow({
  item,
  onUpdateQty,
  onRemove,
}: {
  item: CartItem;
  onUpdateQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
}) {
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
        </div>
        <span className="text-sm tabular-nums text-gray-700 shrink-0">
          {priceStr(item.totalPrice)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-400">
          {priceStr(item.unitPrice)} × {item.quantity}
        </span>
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
    </li>
  );
}

// ─── Payment Panel ────────────────────────────────────────────────

function PaymentPanel({
  cart,
  onConfirm,
  onBack,
  isPending,
  error,
  hasPendingOrder,
  promptpayId,
}: {
  cart: Cart;
  onConfirm: (method: "cash" | "qr_promptpay", received?: number) => void;
  onBack: () => void;
  isPending: boolean;
  error: string | null;
  hasPendingOrder: boolean;
  promptpayId?: string;
}) {
  const [method, setMethod] = useState<"cash" | "qr_promptpay">("cash");
  const [received, setReceived] = useState<string>("");

  const receivedNum = parseFloat(received) || 0;
  const change = method === "cash" ? receivedNum - cart.total : null;
  const cashReady = method !== "cash" || receivedNum >= cart.total;

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
                onClick={() => setMethod(m)}
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
                <p className="text-xs text-gray-400">PromptPay: {promptpayId}</p>
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
        <button
          type="button"
          disabled={!cashReady || isPending || (method === "qr_promptpay" && !promptPayPayload)}
          onClick={() =>
            onConfirm(
              method,
              method === "cash" ? receivedNum : undefined,
            )
          }
          className="btn-primary w-full disabled:opacity-40"
        >
          {isPending ? "กำลังบันทึก..." : "ยืนยันการชำระ"}
        </button>
      </div>
    </div>
  );
}

// ─── Receipt Panel ────────────────────────────────────────────────

function ReceiptPanel({
  order,
  receiptSettings,
  storeName,
  onNewOrder,
}: {
  order: { orderNumber: string; items: CartItem[]; subtotal: number; discount: number; discountNote?: string; total: number; method: string; change?: number };
  receiptSettings: ReceiptSettings | null;
  storeName: string;
  onNewOrder: () => void;
}) {
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  async function handlePrint() {
    setPrintError(null);
    setIsPrinting(true);
    try {
      const settings: ReceiptSettings = receiptSettings ?? {
        id: "",
        storeId: "",
        organizationId: "",
        storeName,
        showTaxId: false,
        showQrPayment: false,
        paperWidth: "80mm",
        printCopies: 1,
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
          note: item.note,
        })),
        subtotal: order.subtotal,
        discount: order.discount,
        discountNote: order.discountNote,
        total: order.total,
        payments: [{
          method: order.method,
          amount: order.total,
          changeAmount: order.change && order.change > 0 ? order.change : undefined,
        }],
        footerText: settings.footerText,
        headerText: settings.headerText,
        showQrPayment: settings.showQrPayment,
        promptpayId: settings.promptpayId,
        paperWidth: settings.paperWidth,
        printedAt: new Date().toISOString(),
      };
      // Route to a connected thermal printer (Bluetooth → USB) using image-raster
      // ESC/POS, falling back to the browser/PDF dialog when none is connected.
      await printReceiptAuto(
        {
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
          })),
          subtotal: receiptData.subtotal,
          discount: receiptData.discount,
          discountNote: receiptData.discountNote,
          total: receiptData.total,
          payments: receiptData.payments,
          footerText: receiptData.footerText,
          paperWidth: receiptData.paperWidth,
          printedAt: receiptData.printedAt,
        },
        receiptData,
      );
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "พิมพ์ไม่สำเร็จ");
    } finally {
      setIsPrinting(false);
    }
  }

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
            </li>
          ))}
        </ul>
        <div className="pt-2 border-t border-gray-100 flex justify-between font-semibold">
          <span>รวม</span>
          <span className="tabular-nums">{priceStr(order.total)}</span>
        </div>
        {order.change !== undefined && order.change >= 0 && (
          <p className="text-sm text-green-600 font-medium text-center">
            เงินทอน {priceStr(order.change)}
          </p>
        )}
        {printError && (
          <p className="text-xs text-red-500 text-center">{printError}</p>
        )}
      </div>
      <div className="p-4 border-t border-gray-100 space-y-2">
        <button
          type="button"
          onClick={handlePrint}
          disabled={isPrinting}
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

export function PosTerminal({ storeId, storeName, categories, products, receiptSettings, exitHref, cashSession, cashSalesPreview, currency }: Props) {
  const [cart, setCart] = useState<Cart>(() => emptyCart(storeId));
  const [phase, setPhase] = useState<Phase>("ordering");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    categories[0]?.id ?? null,
  );
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [showTableBill, setShowTableBill] = useState(false);
  const [showTableOpen, setShowTableOpen] = useState(false);
  const [orderPanelOpen, setOrderPanelOpen] = useState(false);
  const [savedTickets, setSavedTickets] = useState<SavedOrderTicket[]>(() => readSavedTickets(storeId));
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [ticketMessage, setTicketMessage] = useState<string | null>(null);
  const [isPrintingTicket, setIsPrintingTicket] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<{ orderId: string; orderNumber: string } | null>(null);
  const [receipt, setReceipt] = useState<{
    orderNumber: string;
    items: CartItem[];
    subtotal: number;
    discount: number;
    discountNote?: string;
    total: number;
    method: string;
    change?: number;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const filteredProducts = selectedCategoryId
    ? products.filter((p) => p.categoryId === selectedCategoryId && p.isActive && p.availableForPos)
    : products.filter((p) => p.isActive && p.availableForPos);
  const cartLocked = phase !== "ordering" || pendingOrder !== null;
  const activeTicket = activeTicketId ? savedTickets.find((ticket) => ticket.id === activeTicketId) : null;

  function persistSavedTickets(next: SavedOrderTicket[]) {
    if (!writeSavedTickets(storeId, next)) {
      setTicketMessage("บันทึกตั๋วในเครื่องนี้ไม่สำเร็จ กรุณาตรวจ storage ของเบราว์เซอร์");
      return false;
    }
    setSavedTickets(next);
    return true;
  }

  function handleProductClick(product: Product) {
    if (cartLocked) return;
    if (!product.isActive || !product.availableForPos) return;
    if (product.variants.length === 0 && product.modifierGroups.length === 0) {
      setCart((c) => addToCart(c, { product, variant: null, modifiers: [] }));
      return;
    }
    setPicker({ product, selectedVariant: null, selectedModifiers: {} });
  }

  function handleAddFromPicker(input: AddToCartInput) {
    setCart((c) => addToCart(c, input));
  }

  function handleSaveTicket() {
    if (cart.items.length === 0) {
      setTicketMessage("ยังไม่มีรายการให้บันทึกตั๋ว");
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const existing = activeTicketId ? savedTickets.find((ticket) => ticket.id === activeTicketId) : null;
    const ticket: SavedOrderTicket = {
      id: existing?.id ?? createTicketId(),
      ticketNumber: existing?.ticketNumber ?? createTicketNumber(now),
      label: existing?.label ?? `ตั๋ว ${createTicketNumber(now)}`,
      cart,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    const next = existing
      ? savedTickets.map((item) => (item.id === ticket.id ? ticket : item))
      : [ticket, ...savedTickets].slice(0, 30);

    if (persistSavedTickets(next)) {
      setActiveTicketId(ticket.id);
      setTicketMessage(`${existing ? "บันทึกกลับไปใหม่" : "บันทึกตั๋ว"} ${ticket.ticketNumber} แล้ว`);
    }
  }

  function handleLoadTicket(ticket: SavedOrderTicket) {
    if (pendingOrder) {
      setTicketMessage("สร้างออร์เดอร์แล้ว กรุณาชำระเงินให้จบก่อนเรียกตั๋วอื่น");
      return;
    }
    setCart(ticket.cart);
    setActiveTicketId(ticket.id);
    setPhase("ordering");
    setReceipt(null);
    setPayError(null);
    setOrderPanelOpen(true);
    setTicketMessage(`เรียกตั๋ว ${ticket.ticketNumber} กลับมาแล้ว`);
  }

  function handleDeleteTicket(ticketId: string) {
    const ticket = savedTickets.find((item) => item.id === ticketId);
    const next = savedTickets.filter((item) => item.id !== ticketId);
    if (persistSavedTickets(next)) {
      if (activeTicketId === ticketId) setActiveTicketId(null);
      setTicketMessage(ticket ? `ลบตั๋ว ${ticket.ticketNumber} แล้ว` : "ลบตั๋วแล้ว");
    }
  }

  async function handlePrintTicket() {
    if (cart.items.length === 0) {
      setTicketMessage("ยังไม่มีรายการให้พิมพ์ใบสั่งออเดอร์");
      return;
    }

    const settings = receiptSettings ?? {
      id: "",
      storeId: "",
      organizationId: "",
      storeName,
      showTaxId: false,
      showQrPayment: false,
      paperWidth: "80mm" as const,
      printCopies: 1,
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
        note: item.note,
      })),
      subtotal: cart.subtotal,
      discount: cart.discount,
      discountNote: cart.discountNote,
      total: cart.total,
      payments: [],
      footerText: "ใบสั่งออเดอร์ ไม่ใช่ใบเสร็จ",
      showQrPayment: false,
      promptpayId: undefined,
      headerText: "*** ใบสั่งออเดอร์ ***",
      paperWidth: settings.paperWidth,
      printedAt: new Date().toISOString(),
    };

    setIsPrintingTicket(true);
    setTicketMessage(null);
    try {
      await printReceiptAuto(ticketData, ticketData);
      setTicketMessage(`พิมพ์ใบสั่งออเดอร์ ${ticketNumber} แล้ว`);
    } catch (err) {
      setTicketMessage(err instanceof Error ? err.message : "พิมพ์ใบสั่งออเดอร์ไม่สำเร็จ");
    } finally {
      setIsPrintingTicket(false);
    }
  }

  function handleConfirmPayment(method: "cash" | "qr_promptpay", received?: number) {
    setPayError(null);
    startTransition(async () => {
      let order = pendingOrder;
      if (!order) {
        const orderResult = await submitOrderAction(cart);
        if (orderResult.error) {
          setPayError(orderResult.error);
          return;
        }
        if (!orderResult.orderId || !orderResult.orderNumber) {
          setPayError("ไม่สามารถสร้างออร์เดอร์ได้");
          return;
        }
        order = { orderId: orderResult.orderId, orderNumber: orderResult.orderNumber };
        setPendingOrder(order);
      }
      const payResult = await collectPaymentAction(order.orderId, {
        method,
        amount: cart.total,
        receivedAmount: received,
        changeAmount: received !== undefined ? Math.max(0, received - cart.total) : undefined,
      });
      if (payResult.error) {
        setPayError(payResult.error);
        return;
      }
      setReceipt({
        orderNumber: order.orderNumber,
        items: cart.items,
        subtotal: cart.subtotal,
        discount: cart.discount,
        discountNote: cart.discountNote,
        total: cart.total,
        method,
        change: received !== undefined ? Math.max(0, received - cart.total) : undefined,
      });
      if (activeTicketId) {
        persistSavedTickets(savedTickets.filter((ticket) => ticket.id !== activeTicketId));
        setActiveTicketId(null);
      }
      setPendingOrder(null);
      setPhase("receipt");
    });
  }

  function handleNewOrder() {
    setCart(emptyCart(storeId));
    setPhase("ordering");
    setReceipt(null);
    setPayError(null);
    setPendingOrder(null);
    setActiveTicketId(null);
    setTicketMessage(null);
    setOrderPanelOpen(false);
  }

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
            onUpdateQty={(key, qty) => setCart((c) => updateQuantity(c, key, qty))}
            onRemove={(key) => setCart((c) => removeFromCart(c, key))}
            onCheckout={() => {
              setPhase("payment");
              setOrderPanelOpen(true);
            }}
            onClear={() => {
              setCart(emptyCart(storeId));
              setActiveTicketId(null);
              setTicketMessage("ล้างออร์เดอร์แล้ว");
            }}
            savedTickets={savedTickets}
            activeTicketId={activeTicketId}
            ticketMessage={ticketMessage}
            isPrintingTicket={isPrintingTicket}
            onSaveTicket={handleSaveTicket}
            onPrintTicket={handlePrintTicket}
            onLoadTicket={handleLoadTicket}
            onDeleteTicket={handleDeleteTicket}
            onClose={onClose}
          />
        )}
        {phase === "payment" && (
          <PaymentPanel
            cart={cart}
            onConfirm={handleConfirmPayment}
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
          />
        )}
        {phase === "receipt" && receipt && (
          <ReceiptPanel
            order={receipt}
            receiptSettings={receiptSettings}
            storeName={storeName}
            onNewOrder={handleNewOrder}
          />
        )}
      </>
    );
  }

  return (
    <div className="storeos-pos flex h-screen flex-col overflow-hidden bg-[var(--canvas)] lg:flex-row">
      {/* Product catalog */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Store header */}
        <header className="topbar h-16 overflow-x-auto">
          <span className="store-dot shrink-0">S</span>
          <div className="min-w-0 shrink">
            <span className="block truncate text-sm font-extrabold text-[var(--ink)]">{storeName}</span>
            <span className="text-xs text-[var(--muted)]">ขายหน้าร้าน · POS</span>
          </div>
          {/* Action group: stays together, pushed right, never shrinks (scrolls on small screens).
              On mobile the buttons collapse to icon-only to fit narrow widths. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden sm:block">
              <span className="badge badge-success">เชื่อมต่อปกติ</span>
            </span>
            <button
              type="button"
              onClick={() => setShowTableOpen(true)}
              className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
              aria-label="เปิดโต๊ะ"
            >
              🍽️ <span className="hidden sm:inline">เปิดโต๊ะ</span>
            </button>
            <button
              type="button"
              onClick={() => setShowTableBill(true)}
              className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
              aria-label="เช็คบิลโต๊ะ"
            >
              🧾 <span className="hidden sm:inline">เช็คบิลโต๊ะ</span>
            </button>
            <CashSessionPanel
              session={cashSession}
              cashSalesPreview={cashSalesPreview}
              currency={currency}
            />
            {exitHref ? (
              <Link href={exitHref} className="btn-secondary min-h-11 shrink-0 px-3 text-xs" aria-label="กลับ">
                ←<span className="hidden sm:inline"> กลับ</span>
              </Link>
            ) : (
              <form action={signOut} className="shrink-0">
                <button type="submit" className="btn-secondary min-h-11 px-3 text-xs" aria-label="ออกจากระบบ">
                  <span className="sm:hidden">⎋</span>
                  <span className="hidden sm:inline">ออกจากระบบ</span>
                </button>
              </form>
            )}
          </div>
        </header>

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
                <button
                  key={product.id}
                  type="button"
                  disabled={cartLocked}
                  onClick={() => handleProductClick(product)}
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
              ))}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOrderPanelOpen(true)}
        className={`fixed bottom-4 right-4 z-40 min-h-11 items-center gap-2 rounded-full bg-[var(--tenant-primary)] px-4 py-2 text-sm font-bold text-white shadow-lg lg:hidden ${
          orderPanelOpen ? "hidden" : "flex"
        }`}
      >
        <span>เปิดออร์เดอร์</span>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">
          {cart.items.length} · {priceStr(cart.total)}
        </span>
      </button>

      {/* Mobile / tablet order drawer */}
      <div
        role="dialog"
        aria-label="ออร์เดอร์"
        aria-modal={orderPanelOpen ? "true" : undefined}
        aria-hidden={!orderPanelOpen ? true : undefined}
        inert={!orderPanelOpen ? true : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOrderPanelOpen(false);
        }}
        className={`fixed inset-0 z-50 flex h-[100dvh] flex-col border-t border-gray-200 bg-white transition-transform duration-200 lg:hidden ${
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
            onUpdateQty={(key, qty) => setCart((c) => updateQuantity(c, key, qty))}
            onRemove={(key) => setCart((c) => removeFromCart(c, key))}
            onCheckout={() => {
              setPhase("payment");
              setOrderPanelOpen(true);
            }}
            onClear={() => {
              setCart(emptyCart(storeId));
              setActiveTicketId(null);
              setTicketMessage("ล้างออร์เดอร์แล้ว");
            }}
            savedTickets={savedTickets}
            activeTicketId={activeTicketId}
            ticketMessage={ticketMessage}
            isPrintingTicket={isPrintingTicket}
            onSaveTicket={handleSaveTicket}
            onPrintTicket={handlePrintTicket}
            onLoadTicket={handleLoadTicket}
            onDeleteTicket={handleDeleteTicket}
            onClose={() => setOrderPanelOpen(false)}
          />
        )}
        {phase === "payment" && (
          <PaymentPanel
            cart={cart}
            onConfirm={handleConfirmPayment}
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
          />
        )}
        {phase === "receipt" && receipt && (
          <ReceiptPanel
            order={receipt}
            receiptSettings={receiptSettings}
            storeName={storeName}
            onNewOrder={handleNewOrder}
          />
        )}
      </div>

      <aside className="hidden border-l border-gray-200 bg-white lg:flex lg:h-auto lg:w-80 lg:shrink-0 lg:flex-col">
        {renderOrderPanelContent()}
      </aside>

      {/* Picker modal */}
      {picker && (
        <ProductPickerModal
          picker={picker}
          onAdd={handleAddFromPicker}
          onClose={() => setPicker(null)}
        />
      )}

      {/* Open à la carte table session */}
      {showTableOpen && <TableOpenModal onClose={() => setShowTableOpen(false)} />}

      {/* Settle QR table bills */}
      {showTableBill && (
        <TableBillModal
          currency={currency}
          promptpayId={receiptSettings?.promptpayId}
          onClose={() => setShowTableBill(false)}
          onSettled={() => {}}
        />
      )}
    </div>
  );
}
