"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { OnlineMenuProduct } from "@/modules/online-orders/menu";
import { quoteOnlineOrderAction, startOnlineOrderAction, type QuoteResult } from "./actions";

interface CartItem {
  key: string;
  productId: string;
  name: string;
  detail: string;
  unitPrice: number;
  variantId: string | null;
  modifierOptionIds: string[];
  quantity: number;
  note: string;
}

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
const inputCls = "w-full rounded-lg border border-stone-300 px-3 py-2";
// iOS ซูมเมื่อฟอนต์ช่องกรอก < 16px
const inputStyle = { fontSize: 16 } as const;

function newRequestId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function OrderApp(props: {
  slug: string;
  storeName: string;
  storePhone: string | null;
  menu: OnlineMenuProduct[];
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  minOrder: number;
  prepMinutes: number;
  deliveryRadiusKm: number;
}) {
  const router = useRouter();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [picking, setPicking] = useState<OnlineMenuProduct | null>(null);
  const [step, setStep] = useState<"menu" | "checkout">("menu");
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">(props.pickupEnabled ? "pickup" : "delivery");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [addressNote, setAddressNote] = useState("");
  const [note, setNote] = useState("");
  const [pickupIn, setPickupIn] = useState<number | null>(null);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const [pending, startTransition] = useTransition();

  const categories = useMemo(() => {
    const map = new Map<string, OnlineMenuProduct[]>();
    for (const p of props.menu) {
      const key = p.categoryName || "เมนู";
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()];
  }, [props.menu]);

  const itemsTotal = cart.reduce((s, c) => s + c.unitPrice * c.quantity, 0);
  const count = cart.reduce((s, c) => s + c.quantity, 0);

  const payload = () => ({
    clientRequestId: requestId,
    fulfillment,
    items: cart.map((c) => ({
      productId: c.productId,
      variantId: c.variantId,
      modifierOptionIds: c.modifierOptionIds,
      quantity: c.quantity,
      ...(c.note ? { note: c.note } : {}),
    })),
    customerName: name.trim() || "-",
    customerPhone: phone.trim() || "0000000000",
    ...(fulfillment === "delivery" ? { address: address.trim() || "-", addressNote: addressNote.trim(), lat: point?.lat ?? null, lng: point?.lng ?? null } : {}),
    pickupInMinutes: fulfillment === "pickup" ? pickupIn : null,
    note: note.trim(),
  });

  const refreshQuote = (nextFulfillment = fulfillment, nextPoint = point) => {
    if (cart.length === 0) return;
    startTransition(async () => {
      const res = await quoteOnlineOrderAction(props.slug, {
        ...payload(),
        fulfillment: nextFulfillment,
        ...(nextFulfillment === "delivery" ? { address: "-", lat: nextPoint?.lat ?? null, lng: nextPoint?.lng ?? null } : { address: undefined, lat: undefined, lng: undefined, addressNote: undefined }),
      });
      setQuote(res);
    });
  };

  const locate = () => {
    if (!navigator.geolocation) {
      setError("อุปกรณ์นี้ไม่รองรับการหาตำแหน่ง");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setPoint(next);
        setLocating(false);
        refreshQuote("delivery", next);
      },
      () => {
        setLocating(false);
        setError("หาตำแหน่งไม่ได้ — อนุญาตการเข้าถึงตำแหน่งแล้วลองอีกครั้ง");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const submit = () => {
    setError(null);
    if (!name.trim()) return setError("กรอกชื่อผู้รับ");
    if (!/^0[0-9]{8,9}$/.test(phone.replace(/[\s-]/g, ""))) return setError("กรอกเบอร์โทรให้ถูกต้อง");
    if (fulfillment === "delivery" && !address.trim()) return setError("กรอกที่อยู่จัดส่ง");
    if (fulfillment === "delivery" && !point) return setError("กดใช้ตำแหน่งปัจจุบันเพื่อคำนวณค่าส่ง");
    startTransition(async () => {
      const res = await startOnlineOrderAction(props.slug, { ...payload(), customerName: name.trim(), customerPhone: phone.trim() });
      if (!res.ok || !res.token) {
        setError(res.error ?? "สั่งไม่สำเร็จ");
        return;
      }
      router.push(`/s/${props.slug}/order/t/${res.token}`);
    });
  };

  return (
    <main className="mx-auto min-h-screen max-w-md bg-stone-50 pb-32 text-stone-900">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-4 py-3">
        <div>
          <p className="text-xs text-stone-500">สั่งออนไลน์</p>
          <h1 className="text-lg font-bold">{props.storeName}</h1>
        </div>
        <Link href={`/s/${props.slug}`} className="text-sm text-orange-700">หน้าร้าน</Link>
      </header>

      {step === "menu" ? (
        <div className="space-y-6 p-4">
          {props.menu.length === 0 && <p className="text-center text-stone-500">ยังไม่มีเมนูให้สั่ง</p>}
          {categories.map(([category, products]) => (
            <section key={category}>
              <h2 className="mb-2 font-semibold">{category}</h2>
              <div className="grid gap-2">
                {products.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPicking(p)}
                    className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-2 text-left"
                  >
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- รูปเมนูของร้าน (หลายโดเมน)
                      <img src={p.imageUrl} alt="" className="h-16 w-16 rounded-lg object-cover" loading="lazy" />
                    ) : (
                      <div className="h-16 w-16 rounded-lg bg-stone-200" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{p.name}</p>
                      {p.description && <p className="line-clamp-2 text-xs text-stone-500">{p.description}</p>}
                      <p className="text-sm font-semibold text-orange-700">{baht(p.price)}</p>
                    </div>
                    <span className="rounded-full bg-orange-600 px-3 py-1 text-sm text-white">+</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <section className="rounded-xl border bg-white p-3">
            <h2 className="mb-2 font-semibold">รายการ</h2>
            {cart.map((c) => (
              <div key={c.key} className="flex items-start justify-between gap-2 border-b border-dashed py-2 last:border-0">
                <div className="min-w-0">
                  <p className="font-medium">{c.name}</p>
                  {c.detail && <p className="text-xs text-stone-500">{c.detail}</p>}
                  <div className="mt-1 flex items-center gap-2 text-sm">
                    <button type="button" className="h-7 w-7 rounded-full border" onClick={() => setCart((xs) => xs.flatMap((x) => (x.key === c.key ? (x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : []) : [x])))} aria-label="ลด">−</button>
                    <span>{c.quantity}</span>
                    <button type="button" className="h-7 w-7 rounded-full border" onClick={() => setCart((xs) => xs.map((x) => (x.key === c.key ? { ...x, quantity: Math.min(50, x.quantity + 1) } : x)))} aria-label="เพิ่ม">+</button>
                  </div>
                </div>
                <span className="text-sm font-semibold">{baht(c.unitPrice * c.quantity)}</span>
              </div>
            ))}
          </section>

          <section className="rounded-xl border bg-white p-3">
            <h2 className="mb-2 font-semibold">รับสินค้า</h2>
            <div className="grid grid-cols-2 gap-2">
              {props.pickupEnabled && (
                <button type="button" onClick={() => { setFulfillment("pickup"); refreshQuote("pickup"); }} className={`rounded-lg border px-3 py-2 ${fulfillment === "pickup" ? "border-orange-600 bg-orange-50 font-semibold" : ""}`}>รับที่ร้าน</button>
              )}
              {props.deliveryEnabled && (
                <button type="button" onClick={() => { setFulfillment("delivery"); refreshQuote("delivery"); }} className={`rounded-lg border px-3 py-2 ${fulfillment === "delivery" ? "border-orange-600 bg-orange-50 font-semibold" : ""}`}>ส่งถึงบ้าน</button>
              )}
            </div>
            {fulfillment === "pickup" ? (
              <label className="mt-3 block text-sm">
                เวลารับ
                <select className={inputCls} style={inputStyle} value={pickupIn ?? ""} onChange={(e) => setPickupIn(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">เร็วที่สุด (ประมาณ {props.prepMinutes} นาที)</option>
                  {[30, 45, 60, 90, 120, 180].filter((m) => m > props.prepMinutes).map((m) => (
                    <option key={m} value={m}>อีก {m} นาที</option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="mt-3 space-y-2 text-sm">
                <button type="button" onClick={locate} disabled={locating} className="w-full rounded-lg border border-orange-600 px-3 py-2 text-orange-700">
                  {locating ? "กำลังหาตำแหน่ง..." : point ? "📍 อัปเดตตำแหน่งปัจจุบัน" : "📍 ใช้ตำแหน่งปัจจุบัน"}
                </button>
                <p className="text-xs text-stone-500">ร้านส่งในระยะ {props.deliveryRadiusKm} กม. — ใช้ตำแหน่งนี้คำนวณค่าส่งและให้ร้านนำทาง</p>
                <textarea className={inputCls} style={inputStyle} rows={2} maxLength={300} placeholder="ที่อยู่ (บ้านเลขที่ ซอย อาคาร)" value={address} onChange={(e) => setAddress(e.target.value)} />
                <input className={inputCls} style={inputStyle} maxLength={200} placeholder="จุดสังเกต (ถ้ามี)" value={addressNote} onChange={(e) => setAddressNote(e.target.value)} />
              </div>
            )}
          </section>

          <section className="space-y-2 rounded-xl border bg-white p-3 text-sm">
            <h2 className="font-semibold">ผู้สั่ง</h2>
            <input className={inputCls} style={inputStyle} maxLength={80} placeholder="ชื่อ" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            <input className={inputCls} style={inputStyle} inputMode="tel" maxLength={12} placeholder="เบอร์โทร" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
            <textarea className={inputCls} style={inputStyle} rows={2} maxLength={300} placeholder="หมายเหตุถึงร้าน" value={note} onChange={(e) => setNote(e.target.value)} />
          </section>

          <section className="rounded-xl border bg-white p-3 text-sm">
            <div className="flex justify-between"><span>ค่าอาหาร</span><span>{baht(quote?.subtotal || itemsTotal)}</span></div>
            {fulfillment === "delivery" && (
              <div className="flex justify-between">
                <span>ค่าส่ง{quote?.distanceKm != null ? ` (${quote.distanceKm.toFixed(1)} กม.)` : ""}</span>
                <span>{quote?.ok ? baht(quote.deliveryFee) : "—"}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between text-base font-bold">
              <span>รวม</span>
              <span>{quote?.ok ? baht(quote.total) : baht(itemsTotal)}</span>
            </div>
            {quote && !quote.ok && quote.error && <p className="mt-1 text-xs text-red-600">{quote.error}</p>}
            {props.minOrder > 0 && itemsTotal < props.minOrder && <p className="mt-1 text-xs text-red-600">ยอดขั้นต่ำ {baht(props.minOrder)}</p>}
            <p className="mt-2 text-xs text-stone-500">จ่ายด้วย QR พร้อมเพย์ — ร้านเริ่มทำหลังได้รับเงิน{props.storePhone ? ` · ติดต่อร้าน ${props.storePhone}` : ""}</p>
          </section>
          {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        </div>
      )}

      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t bg-white p-3">
          {step === "menu" ? (
            <button type="button" onClick={() => { setStep("checkout"); refreshQuote(); }} className="w-full rounded-xl bg-orange-600 py-3 font-semibold text-white">
              ดูตะกร้า {count} รายการ · {baht(itemsTotal)}
            </button>
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("menu")} className="rounded-xl border px-4">เพิ่มเมนู</button>
              <button type="button" onClick={submit} disabled={pending} className="flex-1 rounded-xl bg-orange-600 py-3 font-semibold text-white disabled:opacity-60">
                {pending ? "กำลังดำเนินการ..." : "ไปชำระเงิน"}
              </button>
            </div>
          )}
        </div>
      )}

      {picking && (
        <ProductSheet
          product={picking}
          onClose={() => setPicking(null)}
          onAdd={(item) => {
            setCart((xs) => {
              const same = xs.find((x) => x.key === item.key);
              return same ? xs.map((x) => (x.key === item.key ? { ...x, quantity: Math.min(50, x.quantity + item.quantity) } : x)) : [...xs, item];
            });
            setQuote(null);
            setPicking(null);
          }}
        />
      )}
    </main>
  );
}

function ProductSheet({ product, onClose, onAdd }: { product: OnlineMenuProduct; onClose: () => void; onAdd: (item: CartItem) => void }) {
  const [variantId, setVariantId] = useState<string | null>(product.variants[0]?.id ?? null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");

  const variant = product.variants.find((v) => v.id === variantId) ?? null;
  const optionIds = Object.values(selected).flat();
  const optionPrice = product.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).reduce((s, o) => s + o.priceAdjustment, 0);
  const unitPrice = product.price + (variant?.priceAdjustment ?? 0) + optionPrice;
  const missing = product.groups.find((g) => (selected[g.id]?.length ?? 0) < g.minSelections);

  const toggle = (groupId: string, optionId: string, single: boolean, max: number) => {
    setSelected((prev) => {
      const current = prev[groupId] ?? [];
      if (single) return { ...prev, [groupId]: current[0] === optionId ? [] : [optionId] };
      if (current.includes(optionId)) return { ...prev, [groupId]: current.filter((id) => id !== optionId) };
      if (current.length >= max) return prev;
      return { ...prev, [groupId]: [...current, optionId] };
    });
  };

  const add = () => {
    const names = product.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).map((o) => o.name);
    const sortedIds = [...optionIds].sort();
    onAdd({
      key: [product.id, variantId ?? "", ...sortedIds, note.trim()].join("|"),
      productId: product.id,
      name: product.name,
      detail: [variant?.name, ...names, note.trim()].filter(Boolean).join(" · "),
      unitPrice,
      variantId,
      modifierOptionIds: sortedIds,
      quantity,
      note: note.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={onClose}>
      <div className="mx-auto max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={product.name}>
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-lg font-bold">{product.name}</h3>
          <button type="button" onClick={onClose} aria-label="ปิด" className="text-xl">×</button>
        </div>
        {product.variants.length > 0 && (
          <fieldset className="mb-3">
            <legend className="mb-1 text-sm font-semibold">ขนาด</legend>
            <div className="grid gap-1">
              {product.variants.map((v) => (
                <label key={v.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <span><input type="radio" name="variant" checked={variantId === v.id} onChange={() => setVariantId(v.id)} className="mr-2" />{v.name}</span>
                  {v.priceAdjustment !== 0 && <span>+{v.priceAdjustment}</span>}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {product.groups.map((g) => (
          <fieldset key={g.id} className="mb-3">
            <legend className="mb-1 text-sm font-semibold">
              {g.name} <span className="font-normal text-stone-500">{g.minSelections > 0 ? "(ต้องเลือก)" : "(ไม่บังคับ)"}{g.selectionType === "multiple" ? ` เลือกได้ ${g.maxSelections}` : ""}</span>
            </legend>
            <div className="grid gap-1">
              {g.options.map((o) => (
                <label key={o.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <span>
                    <input
                      type={g.selectionType === "single" ? "radio" : "checkbox"}
                      name={g.id}
                      checked={selected[g.id]?.includes(o.id) ?? false}
                      onChange={() => toggle(g.id, o.id, g.selectionType === "single", g.maxSelections)}
                      className="mr-2"
                    />
                    {o.name}
                  </span>
                  {o.priceAdjustment !== 0 && <span>+{o.priceAdjustment}</span>}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <input className={`${inputCls} mb-3 text-sm`} style={inputStyle} maxLength={120} placeholder="หมายเหตุ เช่น ไม่ใส่ผัก" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <button type="button" className="h-9 w-9 rounded-full border" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="ลด">−</button>
            <span className="w-6 text-center">{quantity}</span>
            <button type="button" className="h-9 w-9 rounded-full border" onClick={() => setQuantity((q) => Math.min(50, q + 1))} aria-label="เพิ่ม">+</button>
          </div>
          <button type="button" disabled={Boolean(missing)} onClick={add} className="flex-1 rounded-xl bg-orange-600 py-3 font-semibold text-white disabled:opacity-50">
            {missing ? `เลือก ${missing.name}` : `ใส่ตะกร้า · ${baht(unitPrice * quantity)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
