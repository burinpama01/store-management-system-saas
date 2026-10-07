import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Print from 'expo-print';
import type { NativeCustomer, NativeSalesInput, NativeSaleQuote, NativeBootstrap, NativeCheckoutInput, NativeCheckoutResult, NativeDeliveryOrder, NativeLine, NativeOrder, NativeProduct } from '../../src/modules/native-pos/contracts';
import { addLine, acceptAiProposal, emptyDraft, restoreDraft, setQuantity, totalSatang, type Draft } from './src/domain/cart';
import { availableDeliveryActions, deliveryLabel } from './src/domain/delivery';
import { resolveAiLines } from './src/domain/ai';
import { runPrintJob } from './src/domain/printing';
import { api, ApiError, login, savedSession, saveSession, type Session } from './src/client';
import { createWriteQueue, canReleaseRejectedCheckout } from './src/domain/storage';
import { demo, demoDelivery } from './src/demo';
import { Brand, EntryButton, EntryField, EntryLayout, SessionLoading, e } from './src/Entry';
import { initialEntryScreen, homeScreen, productionBase } from './src/domain/entry';
import { useSearchKeyboard } from './src/useSearchKeyboard';
import { MenuCard } from './src/MenuCard';
import { SalesTools } from './src/SalesTools';
import { BeamPayment } from './src/BeamPayment';
import { startBeam, advanceBeam, restoreBeamPending, isBeamPending, type PendingPayment } from './src/domain/beam';
import type { NativeBeamQr } from '../../src/modules/native-pos/contracts';
import { salesFingerprint, confirmedSale, type ConfirmedSale } from './src/domain/sales';
import { theme } from './src/theme';
import { PosWorkflow } from './src/PosWorkflow';
import { createDemoWorkflow } from './src/demo-workflow';
import { startParking, finishParking, startResuming, finishResuming, workflowBlocked } from './src/domain/workflow';
import type { NativeTicketResume } from '../../src/modules/native-pos/workflow-contracts';
import { quickSaleLine, saleLayout } from './src/domain/sale-layout';
const DeferredPrinterSettings = React.lazy(() => import('./src/printers/PrinterSettings').then(module => ({ default: module.PrinterSettings })));
const DeferredBluetoothSettings = React.lazy(() => import('./src/printers/BluetoothSettings').then(module => ({ default: module.BluetoothSettings })));
function PrinterSettings() { return <React.Suspense fallback={<Text>กำลังโหลดเครื่องพิมพ์…</Text>}><DeferredPrinterSettings /></React.Suspense>; }

const money = (satang: number) => `฿${(satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tabs = [['sale', 'ขายสินค้า', '▦'], ['delivery', 'เดลิเวอรี', '↗'], ['orders', 'บิลวันนี้', '≡'], ['printers', 'เครื่องพิมพ์', '▤'], ['settings', 'ตั้งค่า', '⚙'], ['cash', 'กะเงินสด', '฿'], ['tickets', 'บิลพัก', '▣'], ['more', 'เพิ่มเติม', '•••']] as const;
const navTabs = tabs.filter(([id]) => ['sale', 'orders', 'delivery', 'more'].includes(id));
type Tab = typeof tabs[number][0];
type Pending = PendingPayment;
type Sheet = 'product' | 'payment' | 'ai' | 'cart' | 'sales' | null;
function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, secondary && s.secondary, disabled && s.disabled, pressed && { opacity: .7 }]}><Text style={[s.buttonText, secondary && { color: theme.primary }]}>{label}</Text></Pressable>;
}
function PosApp() {
  const { width, height, fontScale } = useWindowDimensions();
  const searchKeyboard = useSearchKeyboard();
  const searchInput = useRef<TextInput>(null);
  function finishSearch() { searchInput.current?.blur(); Keyboard.dismiss(); searchKeyboard.blur(); }
  const [catalogWidth, setCatalogWidth] = useState<number | undefined>();
  const { wide, compact, sidebarWidth, cartWidth, cardWidth } = saleLayout(width, fontScale, catalogWidth, height);
  const [session, setSession] = useState<Session | null>(null);
  const [boot, setBoot] = useState<NativeBootstrap | null>(null);
  const [cart, setCart] = useState<Draft | null>(null); const cartRef = useRef<Draft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [isDemo, setDemo] = useState(false); const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [message, setMessage] = useState(''); const [tab, setTab] = useState<Tab>('sale'); const [sheet, setSheet] = useState<Sheet>(null);
  const searching = tab === 'sale' && sheet === null && searchKeyboard.active;
  const [base, setBase] = useState(productionBase); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [starting, setStarting] = useState(true); const [advanced, setAdvanced] = useState(false);
  const [screen, setScreen] = useState('store-picker');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [search, setSearch] = useState(''); const [category, setCategory] = useState('all');
  const [product, setProduct] = useState<NativeProduct | null>(null); const [variantId, setVariant] = useState<string | null>(null); const [optionIds, setOptions] = useState<string[]>([]); const [note, setNote] = useState('');
  const [sales,setSales] = useState<NativeSalesInput>({}); const salesRef=useRef<NativeSalesInput>({});
  const [customer,setCustomer] = useState<NativeCustomer|null>(null); const [quoted,setQuoted]=useState<ConfirmedSale|null>(null);
  function changeSales(value:NativeSalesInput, selected?:NativeCustomer|null){salesRef.current=value;setSales(value);setQuoted(null);if(selected!==undefined)setCustomer(selected)}
  useEffect(()=>{changeSales({},null)},[cart?.storeId,cart?.userId]);
  useEffect(()=>{if(cart && !cart.lines.length && !pending)changeSales({},null)},[cart?.lines.length,pending]);
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'beam'>('cash'); const [received, setReceived] = useState('');
  const [beamEnabled,setBeamEnabled]=useState(false);
  const [orders, setOrders] = useState<NativeOrder[]>([]); const [delivery, setDelivery] = useState<NativeDeliveryOrder[]>([]); const [nextPage, setNextPage] = useState<number | null>(null);
  const [utterance, setUtterance] = useState(''); const [proposal, setProposal] = useState<{ storeId: string; revision: number; lines: NativeLine[] } | null>(null);
  const writes = useRef(createWriteQueue());
  const demoWorkflow = useRef(createDemoWorkflow());
  const workflowLocked = workflowBlocked(cart);
  const total = pending?.input.expectedTotalSatang ?? (cart && quoted?.fingerprint===salesFingerprint(cart,sales) ? quoted.quote.totalSatang : cart ? totalSatang(cart) : 0);
  async function openPayment(){
    const draft=cartRef.current; if(!draft?.lines.length||pending||workflowBlocked(draft))throw new Error('ตรวจบิลเดิมก่อนรับชำระ');
    const selection={...salesRef.current}; const fingerprint=salesFingerprint(draft,selection);
    const lines=draft.lines.map(({productId,variantId,optionIds,quantity,note})=>({productId,variantId,optionIds,quantity,note}));
    let quote:NativeSaleQuote;
    if(isDemo){const subtotal=totalSatang(draft),manual=selection.manualDiscountSatang??0;if(manual>subtotal)throw new Error('ส่วนลดเกินยอดบิล');if(selection.couponCode&&selection.couponCode.toUpperCase()!=='DEMO10')throw new Error('โหมดสาธิตใช้คูปอง DEMO10');const coupon=selection.couponCode?Math.round((subtotal-manual)*.1):0;quote={subtotalSatang:subtotal,manualDiscountSatang:manual,couponDiscountSatang:coupon,totalSatang:subtotal-manual-coupon,couponCode:selection.couponCode?'DEMO10':null}}
    else {const result=await workflowRequest<{quote:NativeSaleQuote}>('quote',{lines,...selection});quote=result.quote;}
    const snapshot={fingerprint,quote};confirmedSale(cartRef.current!,salesRef.current,snapshot);setQuoted(snapshot);setReceived((quote.totalSatang/100).toFixed(2));setSheet('payment');
    setMethod('cash');setBeamEnabled(false);
    if(isDemo)setBeamEnabled(true);
    else {try{const config=await workflowRequest<{enabled:boolean}>('beam-config');setBeamEnabled(config.enabled);}catch{setMessage('Beam QR ยังไม่พร้อมในระบบหลังบ้านรุ่นนี้ · วิธีรับชำระเดิมยังใช้งานได้');}}
  }
  const keyFor = (draft: Draft) => `storeos.native.bill.v1.${draft.userId}.${draft.storeId}`;
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'ทำรายการไม่สำเร็จ'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function persist(draft: Draft, operation: Pending | null) {
    await writes.current.write(() => AsyncStorage.setItem(keyFor(draft), JSON.stringify({ draft, pending: operation })));
  }
  async function change(draft: Draft, operation: Pending | null = pending) {
    await persist(draft, operation); cartRef.current = draft; setCart(draft); setPending(operation);
  }

  async function workflowRequest<T>(operation: string, body?: unknown): Promise<T> {
    if (isDemo) return demoWorkflow.current<T>(operation, body);
    if (!session || !boot?.store) throw new Error('กรุณาเข้าสู่ระบบและเลือกร้าน');
    return api<T>(session, boot.store.id, operation, body);
  }
  async function parkBill(label: string) {
    const draft = cartRef.current;
    if (!draft || pending) throw new Error('ตรวจบิลที่รอชำระก่อนพักบิล');
    if(salesRef.current.customerId||salesRef.current.couponCode||salesRef.current.manualDiscountSatang)throw new Error('ลูกค้าและส่วนลดยังไม่รองรับบิลพัก กรุณาล้างในเครื่องมือบิลก่อนพัก');
    const intent = draft.parking ? draft : startParking(draft, label, Crypto.randomUUID(), !!pending);
    if (!draft.parking) await change(intent, null);
    const result = await workflowRequest<{ ticket: { id: string } }>('ticket-save', { id: intent.parking!.id, label: intent.parking!.label, lines: intent.lines, expectedTotalSatang: totalSatang(intent) });
    await change(finishParking(intent, result.ticket.id), null);
    setMessage('พักบิลแล้ว รายการเก็บบนระบบหลังบ้าน · พร้อมเริ่มบิลใหม่');
  }
  async function resumeBill(ticket?: { id: string; updatedAt: string }) {
    const draft = cartRef.current;
    if (!draft || pending) throw new Error('ตรวจบิลที่รอชำระก่อนเรียกบิลกลับ');
    if (!draft.resuming && !ticket) throw new Error('กรุณาเลือกบิลพัก');
    const intent = draft.resuming ? draft : startResuming(draft, ticket!, Crypto.randomUUID(), !!pending);
    if (!draft.resuming) await change(intent, null);
    const result = await workflowRequest<NativeTicketResume>('ticket-resume', intent.resuming);
    await change(finishResuming(intent, result), null);
    setMessage('เรียกบิลกลับแล้ว เปิดหน้าขายเพื่อตรวจรายการและรับชำระ');
  }

  async function abandonClaimedBill() {
    if(isBeamPending(pending))throw new Error('มีรายการ Beam ค้าง กรุณาตรวจรายการเดิมก่อนยุติบิล');
    const draft = cartRef.current;
    if (!draft?.checkoutOperationId) throw new Error('ไม่พบบิลที่เรียกกลับ');
    if (!isDemo) {
      const result = await workflowRequest<{ outcome: string; orderId?: string }>('cancel-operation', { operationId: draft.checkoutOperationId });
      if (result.outcome !== 'not_created') throw new Error(`มีบิล ${result.orderId ?? ''} แล้ว กรุณาจัดการบิลเดิมใน StoreOS`);
    }
    await change(emptyDraft(draft.storeId, draft.userId), null);
    setMessage('ยุติคำขอที่ยังไม่สร้างออเดอร์แล้ว ไม่มีการยกเลิกบิลที่รับชำระ');
  }
  async function enter(data: NativeBootstrap, demoMode: boolean) {
    if (!data.store) { setBoot(data); setScreen(initialEntryScreen(false)); return; }
    const initial = emptyDraft(data.store.id, data.userId);
    const savedFavorites = await AsyncStorage.getItem(`storeos.favorites.${data.userId}.${data.store.id}`);
    try { const parsed: unknown = JSON.parse(savedFavorites ?? '[]'); setFavorites(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []); } catch { setFavorites([]); }
    const raw = await AsyncStorage.getItem(keyFor(initial));
    let restored = initial; let operation: Pending | null = null;
    if (raw) {
      try { const saved = JSON.parse(raw); const recovered = restoreDraft(JSON.stringify(saved.draft), data.store.id, data.userId); if (!recovered) throw new Error(); restored = recovered; operation = saved.pending ?? null; if (operation?.input?.method==='beam')operation=restoreBeamPending(operation);else if (operation && (!operation.operationId || !operation.input || !['sending', 'unknown', 'partial'].includes(operation.state))) throw new Error(); }
      catch { throw new Error('ข้อมูลบิลที่เก็บไว้ไม่สมบูรณ์ กรุณาตรวจสอบก่อนเริ่มบิลใหม่'); }
    }
    cartRef.current = restored; setCart(restored); setPending(operation); setBoot(data); setDemo(demoMode); setOrders([]); setDelivery(demoMode ? demoDelivery : []); setNextPage(null); setTab('sale'); setScreen(initialEntryScreen(true));
  }
  async function restoreSession() { await run(async () => { const saved = await savedSession(); if (!saved) return; setSession(saved); setBase(saved.base); await enter(await api<NativeBootstrap>(saved, null, 'bootstrap'), false); }); setStarting(false); }
  useEffect(() => { void restoreSession(); }, []);
  async function chooseStore() { await writes.current.idle(); if (isDemo) { setScreen('home'); return; } if (!session) return; const data = await api<NativeBootstrap>(session, null, 'bootstrap'); setBoot(data); setScreen('store-picker'); setSheet(null); }
  function openWork(id: Tab) { finishSearch(); setTab(id); setScreen(id); setSheet(null); }
  async function refresh(page = 0) {
    if (isDemo) { setMessage('กำลังแสดงข้อมูลสาธิต ไม่เชื่อม JDC จริง'); return; }
    if (!session || !boot?.store) return;
    if (tab === 'delivery') { const result = await api<{ orders: NativeDeliveryOrder[]; nextPage: number | null }>(session, boot.store.id, `delivery?page=${page}`); setDelivery(previous => page === 0 ? result.orders : [...previous.filter(p => !result.orders.some(n => n.id === p.id)), ...result.orders]); setNextPage(result.nextPage); }
    if (tab === 'orders') { const result = await api<{ orders: NativeOrder[] }>(session, boot.store.id, 'orders'); setOrders(result.orders); }
  }
  function openProduct(value: NativeProduct) {
    if (busyRef.current || pending || !cart || !boot?.permissions.sell || !value.available) return;
    const line = quickSaleLine(value);
    if (line) { void run(() => change(addLine(cartRef.current ?? cart, line))); return; }
    finishSearch(); setProduct(value); setVariant(null); setOptions([]); setNote(''); setSheet('product');
  }
  function toggleFavorite(id: string) {
    if (!cart || busyRef.current) return;
    void run(async () => {
      const next = favorites.includes(id) ? favorites.filter(value => value !== id) : [...favorites, id];
      await writes.current.write(() => AsyncStorage.setItem(`storeos.favorites.${cart.userId}.${cart.storeId}`, JSON.stringify(next)));
      setFavorites(next);
    });
  }
  const visibleProducts = boot?.products.filter(p => (category === 'all' || (category === 'favorites' ? favorites.includes(p.id) : p.categoryId === category)) && p.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  async function addProduct() {
    if (!product || !cart || pending || !boot?.permissions.sell) return;
    if (product.variants.length && !variantId) throw new Error('กรุณาเลือกขนาดหรือรูปแบบ');
    for (const group of product.groups) { const count = group.options.filter(o => optionIds.includes(o.id)).length; if (count < group.min || count > group.max) throw new Error(`กรุณาเลือก ${group.name} จำนวน ${group.min}–${group.max}`); }
    const variant = product.variants.find(v => v.id === variantId); const options = product.groups.flatMap(g => g.options).filter(o => optionIds.includes(o.id));
    const line: NativeLine = { key: JSON.stringify([product.id, variantId, [...optionIds].sort(), note.trim()]), productId: product.id, name: product.name, quantity: 1, unitSatang: product.priceSatang + (variant?.priceSatang ?? 0) + options.reduce((sum, o) => sum + o.priceSatang, 0), variantId, optionIds, note: note.trim(), choiceLabel: [variant?.name, ...options.map(o => o.name)].filter(Boolean).join(' · ') };
    await change(addLine(cart, line)); setSheet(null);
  }
  async function beamPrepare(input:NativeCheckoutInput):Promise<NativeBeamQr>{
    if(isDemo)return {gatewayPaymentId:input.operationId,totalSatang:input.expectedTotalSatang,status:'PENDING',imageUri:null,expiresAt:null};
    const {method:_,receivedSatang:__,gatewayPaymentId:___,...payload}=input;
    return (await workflowRequest<{qr:NativeBeamQr}>('beam-prepare',payload)).qr;
  }
  async function beginBeam(){
    if(!cart||pending||workflowBlocked(cart)||!beamEnabled)throw new Error('ตรวจบิลเดิมก่อนสร้าง QR');
    confirmedSale(cart,sales,quoted);
    const input:NativeCheckoutInput={operationId:cart.checkoutOperationId??Crypto.randomUUID(),expectedTotalSatang:total,method:'beam',receivedSatang:total,...sales,lines:cart.lines.map(({productId,variantId,optionIds,quantity,note})=>({productId,variantId,optionIds,quantity,note}))};
    const next=await startBeam(input,p=>change(cart,p),beamPrepare);await change(cart,next);
    if(next.beam?.status==='PAID')await checkout(next);
  }
  async function checkBeam(){
    if(!cart||!pending||!isBeamPending(pending))return;
    // Once checkout may have created an order, reconcile that same order rather than creating another charge.
    if(pending.orderId||['sending','unknown','partial'].includes(pending.state)&&pending.input.gatewayPaymentId){await checkout(pending);return;}
    const qr=isDemo?{...pending.beam!,gatewayPaymentId:pending.input.operationId,totalSatang:pending.input.expectedTotalSatang,status:'PAID' as const,imageUri:null,expiresAt:null}:pending.input.gatewayPaymentId?(await workflowRequest<{qr:NativeBeamQr}>('beam-status',{operationId:pending.operationId,gatewayPaymentId:pending.input.gatewayPaymentId,expectedTotalSatang:pending.input.expectedTotalSatang})).qr:await beamPrepare(pending.input);
    const next=advanceBeam(pending,qr);await change(cart,next);
    if(qr.status==='PAID')await checkout(next);else setMessage('ยังไม่ยืนยันรับเงิน · ตรวจรายการ Beam เดิมต่อ');
  }
  async function checkout(paidBeam?:Pending) {
    if(isBeamPending(pending)&&!paidBeam){await checkBeam();return;}
    const existing=paidBeam??pending;
    if (workflowBlocked(cart)) throw new Error('ตรวจผลบิลพักหรือเรียกบิลกลับก่อนรับชำระ');
    if (!cart || !cart.lines.length) return;
    if(!existing)confirmedSale(cart,sales,quoted);
    if (!existing && !/^\d+(\.\d{1,2})?$/.test(received)) throw new Error('กรุณาระบุเงินรับเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง');
    const receivedSatang = Math.round(Number(received) * 100);
    if (!existing && method === 'cash' && receivedSatang < total) throw new Error('เงินรับยังไม่ครบ');
    if (isDemo) { const order: NativeOrder = { id: Crypto.randomUUID(), number: `DEMO-${orders.length + 1}`, status: 'paid', totalSatang: total, createdAt: new Date().toISOString(), lines: cart.lines }; await change(emptyDraft(cart.storeId, cart.userId), null); setOrders([order, ...orders]); setSheet(null); setMessage('จบบิลสาธิตแล้ว ไม่มีการรับเงินหรือบันทึกยอดจริง'); return; }
    if (!session || !boot?.store) throw new Error('กรุณาเข้าสู่ระบบ');
    const input: NativeCheckoutInput = existing?.input ?? { operationId: cart.checkoutOperationId ?? Crypto.randomUUID(), expectedTotalSatang: total, method, receivedSatang, ...sales, lines: cart.lines.map(({ productId, variantId, optionIds, quantity, note }) => ({ productId, variantId, optionIds, quantity, note })) };
    const operation: Pending = { ...existing, operationId: input.operationId, input, state: 'sending' };
    await change(cart, operation);
    try {
      const result = await api<NativeCheckoutResult>(session, cart.storeId, 'checkout', input);
      if (result.error) { await change(cart, { ...operation, state: result.orderId ? 'partial' : 'unknown', orderId: result.orderId }); throw new Error(`${result.error} · ตรวจบิลบน StoreOS ก่อนดำเนินการต่อ`); }
      if (!result.orderId && !result.order?.id) throw new Error('ไม่พบเลขออเดอร์ที่ยืนยันแล้ว');
      if (result.outcome === 'closed') {
        await change(emptyDraft(cart.storeId, cart.userId), null); setSheet(null);
        setMessage(`บิลเดิมปิดแล้ว: ${result.closedStatus === 'refunded' ? 'คืนเงิน' : result.closedStatus === 'voided' ? 'ยกเลิกบิล' : 'ยกเลิกออเดอร์'} · พร้อมเริ่มบิลใหม่ ไม่มีการรับชำระเพิ่ม`);
        return;
      }
      if (result.order) setOrders([result.order, ...orders]);
      await change(emptyDraft(cart.storeId, cart.userId), null); setSheet(null); setMessage(`บันทึกบิล ${result.order?.number ?? result.orderId} แล้ว · พิมพ์ใบเสร็จจริงผ่าน StoreOS เดิมระหว่างรอเชื่อม QR รับแต้มบน native`);
    } catch (error) { if (input.method!=='beam' && error instanceof ApiError && canReleaseRejectedCheckout(!!existing, error.notCreated)) await change(cart, null); setSheet(null); throw error; }
  }
  async function askAi() {
    if (!cart || !boot || pending) return;
    if (isDemo) throw new Error('AI ต้องใช้ร้านจริงและแพ็กเกจที่เปิด AI โหมดสาธิตไม่มีการเรียกโมเดล');
    if (!session) return;
    setProposal(null);
    const snapshot = { storeId: cart.storeId, revision: cart.revision };
    const result = await api<{ ok: boolean; intent: unknown; error?: string }>(session, cart.storeId, 'voice', { requestId: Crypto.randomUUID(), utterance, locale: 'th-TH', origin: 'push_to_talk' });
    if (!result.ok) throw new Error(result.error ?? 'AI ยังไม่พร้อม');
    setProposal({ ...snapshot, lines: resolveAiLines(result.intent, boot.products) });
  }
  async function printTest() {
    if (Platform.OS === 'web') throw new Error('ทดสอบเครื่องพิมพ์ผ่านแอป iOS/Android บนอุปกรณ์จริง');
    const result = await runPrintJob(async () => { await Print.printAsync({ html: '<!doctype html><html><head><meta charset="UTF-8"><style>body{font:20px sans-serif;padding:12px;text-align:center}</style></head><body><h1>StoreOS POS</h1><h2>ทดสอบเครื่องพิมพ์</h2><p>ภาษาไทย สระ วรรณยุกต์<br>กิ กี กึ กื กุ กู ก่ ก้ ก๊ ก๋</p><p>0123456789 · ฿123.45</p><hr><p>เอกสารทดสอบ ไม่ใช่ใบเสร็จรับเงิน</p></body></html>' }); return { confirmed: false }; });
    setMessage(result.state === 'submitted' ? 'ส่งให้ระบบพิมพ์แล้ว กรุณาตรวจว่ากระดาษออกและภาษาไทยถูกต้อง' : 'ยังไม่ทราบผลการพิมพ์ กรุณาตรวจเครื่องก่อนลองใหม่');
  }
  const header = <View style={[s.header, (compact || searching) && { paddingVertical: 8 }]}><View style={{ flex: 1, minWidth: 0 }}><Text style={[s.title, { fontSize: compact || searching ? 18 : 24 }]}>{tabs.find(t => t[0] === tab)?.[1] ?? 'ขายสินค้า'}{(compact || searching) && (isDemo ? ' · สาธิต' : ` · ${boot?.store?.name ?? ''}`)}</Text>{!compact && !searching && <Text style={s.muted}>{boot?.store?.name}</Text>}</View>{!compact && !searching && <View style={s.badge}><View style={[s.dot, { backgroundColor: isDemo ? theme.warning : theme.success }]} /><Text style={s.badgeText}>{isDemo ? 'โหมดสาธิต' : 'ข้อมูลร้านโหลดแล้ว'}</Text></View>}</View>;
    if (starting) return <SessionLoading />;
  if (!boot?.store || !cart || screen === 'store-picker') return <EntryLayout><Brand /><Text style={e.heading}>{session && boot ? 'เลือกร้านของคุณ' : 'ยินดีต้อนรับกลับมา'}</Text><Text style={e.muted}>เข้าสู่ร้านของคุณ เพื่อดูสินค้า บิล และออเดอร์ในที่เดียว</Text>{busy && <ActivityIndicator color={theme.primary} />}{message ? <Text accessibilityRole="alert" style={e.error}>{message}</Text> : null}{session && boot ? <>{boot.stores.map(store => <EntryButton key={store.id} label={store.name} disabled={busy} onPress={() => void run(async () => enter(await api<NativeBootstrap>(session, store.id, 'bootstrap'), false))} />)}{!boot.stores.length && <Text style={e.muted}>บัญชีนี้ยังไม่มีร้านที่เข้าถึงได้</Text>}{cart && <EntryButton secondary label="กลับร้านเดิม / บิลเดิม" disabled={busy} onPress={() => void run(async () => { const data = await api<NativeBootstrap>(session, cart.storeId, 'bootstrap'); await enter(data, false); })} />}</> : <><EntryField label="อีเมล" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" placeholder="อีเมลที่ใช้กับ StoreOS" value={email} onChangeText={setEmail} editable={!busy} /><EntryField label="รหัสผ่าน" secureTextEntry autoComplete="current-password" placeholder="รหัสผ่านของคุณ" value={password} onChangeText={setPassword} editable={!busy} /><EntryButton label="เข้าสู่ระบบ" disabled={busy || !base || !email.trim() || !password} onPress={() => void run(async () => { const next = await login(base.trim(), email.trim(), password); setPassword(''); setSession(next); await enter(await api<NativeBootstrap>(next, null, 'bootstrap'), false); })} /></>}{session && !boot && <EntryButton secondary label="ลองโหลดข้อมูลร้านอีกครั้ง" disabled={busy} onPress={() => void run(async () => enter(await api<NativeBootstrap>(session, null, 'bootstrap'), false))} />}<EntryButton secondary label="ลองหน้าขายแบบสาธิต" disabled={busy} onPress={() => void run(() => enter(demo, true))} /><Text style={e.hint}>โหมดสาธิตไม่เชื่อมระบบจริง และไม่บันทึกยอดขายจริง</Text><Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} style={e.link} onPress={() => setAdvanced(value => !value)}><Text style={e.linkText}>ตั้งค่าการเชื่อมต่อร้าน {advanced ? '⌄' : '›'}</Text></Pressable>{advanced && <EntryField label="ที่อยู่ระบบ StoreOS" autoCapitalize="none" autoCorrect={false} keyboardType="url" value={base} onChangeText={setBase} editable={!busy} />}{session && <EntryButton secondary label="ออกจากระบบ" disabled={busy} onPress={() => void run(async () => { await writes.current.idle(); await saveSession(null); setSession(null); setBoot(null); setCart(null); cartRef.current = null; setPending(null); setDemo(false); setPassword(''); })} />}</EntryLayout>;
  if (screen === 'home') return <EntryLayout><Brand /><Text style={e.heading}>วันนี้เริ่มงานอะไรดี?</Text><View style={e.card}><Text style={e.muted}>{isDemo ? 'ร้านสาธิต' : 'ร้านที่เลือก'}</Text><Text style={e.heading}>{boot.store.name}</Text><Text style={e.muted}>{isDemo ? 'ข้อมูลสาธิต · ไม่มีการรับเงินจริง' : 'โหลดข้อมูลร้านแล้ว · ไม่ใช่สถานะเครือข่ายแบบสด'}</Text>{!isDemo && <EntryButton secondary label="เลือกร้าน / สาขา" disabled={busy} onPress={() => void run(chooseStore)} />}</View>{pending && <Text accessibilityRole="alert" style={e.error}>มีบิลรอตรวจสอบ เปิดหน้าขายเพื่อทำต่อด้วยบิลเดิม</Text>}{message ? <Text accessibilityRole="alert" style={e.error}>{message}</Text> : null}<EntryButton label="เปิดหน้าขาย" disabled={busy || !boot.permissions.sell} onPress={() => openWork('sale')} />{!boot.permissions.sell && <Text style={e.muted}>บัญชีนี้ไม่มีสิทธิ์ขายสินค้า</Text>}<EntryButton secondary label="บิลล่าสุด" disabled={busy} onPress={() => openWork('orders')} /><EntryButton secondary label="ออเดอร์เดลิเวอรี" disabled={busy} onPress={() => openWork('delivery')} /><Text style={e.hint}>{isDemo ? 'ข้อมูลทั้งหมดเป็นการสาธิต' : 'บิลปัจจุบันเก็บอยู่ในอุปกรณ์ · เปิดหน้าขายเพื่อทำต่อ'}</Text></EntryLayout>;
const cartPanel = <View style={[s.cart, wide ? { width: cartWidth, flexBasis: cartWidth, flexShrink: 0, flexGrow: 0 } : { maxWidth: '100%', minHeight: 0 }]}><View style={s.rowBetween}><Text style={s.sectionTitle}>บิลปัจจุบัน</Text><Text style={s.muted}>{cart.lines.reduce((sum, l) => sum + l.quantity, 0)} ชิ้น</Text></View><Text style={s.small}>หน้าร้าน · บิลเก็บไว้บนอุปกรณ์นี้</Text><ScrollView keyboardShouldPersistTaps="handled" style={s.cartItems}>{cart.lines.length === 0 ? <View style={s.empty}><Text style={s.emptyIcon}>＋</Text><Text style={s.sectionTitle}>พร้อมรับออเดอร์ใหม่</Text><Text style={s.muted}>แตะสินค้าเพื่อเริ่มบิล</Text></View> : cart.lines.map(line => <View key={line.key} style={s.cartLine}><View style={s.rowBetween}><Text style={s.lineName}>{line.name}</Text><Text style={s.linePrice}>{money(line.quantity * line.unitSatang)}</Text></View>{line.choiceLabel ? <Text style={s.small}>{line.choiceLabel}</Text> : null}{line.note ? <Text style={s.small}>หมายเหตุ: {line.note}</Text> : null}<View style={s.quantityRow}><Pressable accessibilityRole="button" accessibilityLabel={`ลด ${line.name}`} disabled={busy || workflowLocked || !!pending} style={s.step} onPress={() => void run(() => change(setQuantity(cart, line.key, line.quantity - 1)))}><Text>−</Text></Pressable><Text style={s.quantity}>{line.quantity}</Text><Pressable accessibilityRole="button" accessibilityLabel={`เพิ่ม ${line.name}`} disabled={busy || workflowLocked || !!pending} style={s.step} onPress={() => void run(() => change(setQuantity(cart, line.key, line.quantity + 1)))}><Text>＋</Text></Pressable></View></View>)}</ScrollView><View style={s.cartFooter}><View style={s.rowBetween}><Text style={s.muted}>ยอดรวม</Text><Text style={s.total}>{money(total)}</Text></View><Button secondary label="ลูกค้า / ส่วนลด / คูปอง" disabled={busy || workflowLocked || !!pending || !cart.lines.length} onPress={()=>setSheet('sales')} /><Button label={pending ? 'รอตรวจสอบบิลเดิม' : isDemo ? 'ชำระบิลสาธิต' : 'รับชำระเงิน'} disabled={busy || workflowLocked || !!pending || !cart.lines.length || !boot.permissions.sell} onPress={() => void run(openPayment)} /><Button secondary label="พักบิล / เรียกบิลกลับ" disabled={busy || !!pending} onPress={() => { setSheet(null); openWork('tickets'); }} /><Button label="AI ช่วยเพิ่มสินค้า" secondary disabled={busy || workflowLocked || !!pending} onPress={() => { setProposal(null); setSheet('ai'); }} /></View></View>;
  return <SafeAreaView style={s.safe}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><View style={[s.shell, !wide && { flexDirection: 'column-reverse' }]}>{!(searching && !wide) && <View style={[s.sidebar, { width: sidebarWidth }, compact && { padding: 6 }, !wide && s.bottomNav]}>{wide && !compact && <Text style={s.logo}>S/</Text>}{navTabs.map(([id, label, icon]) => <Pressable accessibilityRole="button" accessibilityState={{ selected: tab === id || (id === 'more' && ['printers', 'settings', 'cash', 'tickets'].includes(tab)) }} key={id} disabled={busy} onPress={() => { openWork(id); }} style={[s.nav, compact && { paddingVertical: 8, gap: 2, minHeight: 48 }, (tab === id || (id === 'more' && ['printers', 'settings', 'cash', 'tickets'].includes(tab))) && s.navActive, !wide && { flex: 1 }]}><Text style={[s.navIcon, (tab === id || (id === 'more' && ['printers', 'settings', 'cash', 'tickets'].includes(tab))) && { color: '#fff' }]}>{icon}</Text><Text style={[s.navLabel, (tab === id || (id === 'more' && ['printers', 'settings', 'cash', 'tickets'].includes(tab))) && { color: '#fff' }]}>{label}</Text></Pressable>)}</View>}<View style={s.main}>{header}{busy && <ActivityIndicator color={theme.primary} />}{message ? <Pressable onPress={() => setMessage('')}><Text accessibilityRole="alert" style={s.notice}>{message}</Text></Pressable> : null}{isBeamPending(pending) && pending && <View style={{paddingHorizontal:18,marginBottom:12}}><BeamPayment pending={pending} busy={busy} demo={isDemo} onCheck={()=>void run(checkBeam)} /></View>}{pending && !isBeamPending(pending) && <View style={{ paddingHorizontal: 22, gap: 8, marginBottom: 12 }}><Text style={s.error}>บิล {pending.orderId ?? pending.operationId} รอตรวจสอบ · หากสร้างบิลแล้ว ให้จัดการบิลเดิมผ่าน StoreOS</Text><Button secondary label="ตรวจสอบ / ทำต่อด้วยบิลเดิม" disabled={busy} onPress={() => void run(checkout)} /><Button secondary label="ยุติคำขอที่ยังไม่สร้างบิล" disabled={busy || !session} onPress={() => void run(async () => { if (!session || !pending) return; const result = await api<{ outcome: string; orderId?: string }>(session, cart.storeId, 'cancel-operation', { operationId: pending.operationId }); if (result.outcome === 'not_created') { await change(cart.checkoutOperationId ? emptyDraft(cart.storeId, cart.userId) : cart, null); setMessage('เซิร์ฟเวอร์ยืนยันว่าไม่สร้างบิลและป้องกันคำขอเดิมแล้ว'); } else { setMessage(`มีบิล ${result.orderId} แล้ว กรุณาจัดการบิลเดิมใน StoreOS`); } })} /></View>}
    {workflowLocked && <View style={{ paddingHorizontal:22,gap:8,marginBottom:12 }}><Text style={s.error}>มีคำขอบิลพักรอตรวจสอบ รายการยังเก็บไว้ ห้ามเริ่มขายซ้ำ</Text><Button label="ตรวจคำขอบิลพัก" disabled={busy} onPress={() => openWork('tickets')} /></View>}
    {tab === 'sale' ? <View style={[s.workspace, !wide && { flexDirection: 'column' }]}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={s.catalog} contentContainerStyle={{ paddingBottom: 16 }} onLayout={event => setCatalogWidth(Math.max(128, event.nativeEvent.layout.width - 32))}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><TextInput ref={searchInput} accessibilityLabel="ค้นหาสินค้า" placeholder="ค้นหาชื่อสินค้า…" value={search} onChangeText={setSearch} onFocus={searchKeyboard.focus} onBlur={searchKeyboard.blur} onSubmitEditing={finishSearch} returnKeyType="done" style={[s.search, { flex: 1 }]} />{searching && <Button secondary label="เสร็จ" onPress={finishSearch} />}</View><ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.categories, { height: Math.max(58, 32 * fontScale + 24) }]} contentContainerStyle={{ gap: 8 }}><Pressable accessibilityRole="button" accessibilityState={{ selected: category === 'all' }} onPress={() => setCategory('all')} style={[s.chip, category === 'all' && s.chipActive]}><Text style={category === 'all' ? s.chipTextActive : s.chipText}>ทั้งหมด</Text></Pressable><Pressable accessibilityRole="button" accessibilityState={{ selected: category === 'favorites' }} onPress={() => setCategory('favorites')} style={[s.chip, category === 'favorites' && s.chipActive]}><Text style={category === 'favorites' ? s.chipTextActive : s.chipText}>★ รายการโปรด</Text></Pressable>{boot.categories.map(c => <Pressable accessibilityRole="button" accessibilityState={{ selected: category === c.id }} key={c.id} onPress={() => setCategory(c.id)} style={[s.chip, category === c.id && s.chipActive]}><Text style={category === c.id ? s.chipTextActive : s.chipText}>{c.name}</Text></Pressable>)}</ScrollView><View style={s.productGrid}>{visibleProducts.map(p => <MenuCard key={p.id} name={p.name} imageUrl={p.imageUrl} category={boot.categories.find(c => c.id === p.categoryId)?.name} price={money(p.priceSatang)} width={cardWidth} favorite={favorites.includes(p.id)} available={p.available} disabled={busy || workflowLocked || !!pending || !boot.permissions.sell} onAdd={() => openProduct(p)} onFavorite={() => toggleFavorite(p.id)} />)}{!visibleProducts.length && <Text style={s.emptyText}>{category === 'favorites' ? 'แตะดาวบนสินค้าเพื่อเก็บเมนูที่ขายบ่อย' : 'ไม่พบสินค้า ลองเปลี่ยนหมวดหรือคำค้นหา'}</Text>}</View></ScrollView>{searching && !wide ? <View style={[s.saleFooter, { paddingVertical: 8 }]}><Text style={s.muted}>{cart.lines.reduce((sum, line) => sum + line.quantity, 0)} ชิ้น · {money(total)} · ปิดคีย์บอร์ดเพื่อรับชำระ</Text></View> : wide ? cartPanel : <View style={s.saleFooter}><View style={s.rowBetween}><Text style={s.sectionTitle}>{cart.lines.reduce((sum, line) => sum + line.quantity, 0)} ชิ้น</Text><Text style={s.total}>{money(total)}</Text></View><View style={s.footerActions}><View style={{ flex: 1 }}><Button secondary label="ดูตะกร้า" onPress={() => setSheet('cart')} /></View><View style={{ flex: 1 }}><Button label="รับชำระเงิน" disabled={busy || workflowLocked || !!pending || !cart.lines.length || !boot.permissions.sell} onPress={() => void run(openPayment)} /></View></View></View>}</View> : <ScrollView contentContainerStyle={s.page}>
    {tab === 'more' && <><Text style={s.sectionTitle}>เพิ่มเติม</Text><Button secondary label="หน้าแรก / เลือกสาขา" onPress={() => setScreen('home')} /><Button secondary label="กะเงินสด" disabled={busy} onPress={() => openWork('cash')} /><Button secondary label="บิลพัก" disabled={busy} onPress={() => openWork('tickets')} /><Button secondary label="เครื่องพิมพ์" onPress={() => openWork('printers')} /><Button secondary label="ตั้งค่าและบัญชี" onPress={() => openWork('settings')} /><Button secondary label="AI ช่วยเพิ่มสินค้า" disabled={busy || workflowLocked || !!pending || !boot.permissions.sell} onPress={() => { setProposal(null); setSheet('ai'); }} /></>}
    {tab === 'delivery' && <><View style={s.rowBetween}><View><Text style={s.sectionTitle}>ออเดอร์จาก JDC</Text><Text style={s.muted}>สถานะจากระบบที่ร้านเชื่อมอยู่ · อัปเดตเมื่อกดโหลด</Text></View><Button label="โหลดออเดอร์" secondary disabled={busy} onPress={() => void run(() => refresh())} /></View>{delivery.map(order => <View style={s.orderCard} key={order.id}><View style={s.rowBetween}><Text style={s.sectionTitle}>{order.number}</Text><Text style={s.productPrice}>{money(order.totalSatang)}</Text></View><Text style={s.status}>{deliveryLabel(order.status)}</Text>{order.lines.map(l => <Text style={s.muted} key={l.key}>{l.quantity} × {l.name} {l.choiceLabel} {l.note}</Text>)}<View style={s.actionRow}>{(order.lines.length ? availableDeliveryActions(order.status) : []).map(next => <Button key={next} label={next === 'cancelled' ? 'ยกเลิกออเดอร์' : deliveryLabel(next)} secondary={next === 'cancelled'} disabled={busy} onPress={() => void run(async () => { if (isDemo) { setDelivery(delivery.map(o => o.id === order.id ? { ...o, status: next } : o)); return; } if (!session) return; await api(session, cart.storeId, 'delivery-status', { id: order.id, next }); await refresh(); })} />)}</View></View>)}{!delivery.length && <Text style={s.emptyText}>กดโหลดออเดอร์เพื่อดูคิวของร้าน</Text>}{nextPage !== null && <Button secondary label="โหลดรายการถัดไป" disabled={busy} onPress={() => void run(() => refresh(nextPage))} />}<Text style={s.small}>สถานะปิดงานของ JDC อาจหมายถึงส่งต่อไรเดอร์แล้ว · ไม่มีการพิมพ์อัตโนมัติข้ามอุปกรณ์</Text></>}
    {['cash', 'tickets', 'orders'].includes(tab) && <PosWorkflow key={`${cart.userId}.${cart.storeId}`} mode={tab as 'cash' | 'tickets' | 'orders'} request={workflowRequest} cart={cart} pending={!!pending} busy={busy} demo={isDemo} perform={run} park={parkBill} resume={resumeBill} abandon={abandonClaimedBill} />}
    {tab === 'printers' && <><Text style={s.sectionTitle}>เชื่อมต่อเครื่องพิมพ์</Text><Text style={s.muted}>เลือกเส้นทางตามเครื่องจริง แต่ละรุ่นต้องทดสอบกระดาษและภาษาไทยก่อนใช้งาน</Text><View style={s.orderCard}><Text style={s.sectionTitle}>{Platform.OS === 'ios' ? 'AirPrint' : 'ระบบพิมพ์ของอุปกรณ์'}</Text><Text style={s.muted}>เปิดหน้าต่างเลือกรุ่นที่ระบบมองเห็น แล้วทดสอบเอกสารภาษาไทย</Text><Button label="เลือกเครื่องและพิมพ์ทดสอบ" disabled={busy} onPress={() => void run(printTest)} /></View><React.Suspense fallback={<Text>กำลังโหลด Bluetooth…</Text>}><DeferredBluetoothSettings /></React.Suspense><PrinterSettings />{[['Bluetooth Classic / USB / COM', 'ต้องใช้ adapter ตาม protocol และข้อจำกัดของระบบปฏิบัติการ'], ['Print Hub · เครื่องพิมพ์ผ่าน Windows', 'ต้องเชื่อมระบบคิวและการยืนยันผลก่อนเปิดใช้บน native'], ['Star / Epson / vendor SDK', 'ต้องตรวจ SDK และทดสอบรุ่นจริงก่อนประกาศรองรับ']].map(([title, text]) => <View style={s.orderCard} key={title}><Text style={s.sectionTitle}>{title}</Text><Text style={s.muted}>{text}</Text><Text style={s.small}>ยังไม่เปิดใช้งานในรุ่นนี้</Text></View>)}</>}
    {tab === 'settings' && <><Text style={s.sectionTitle}>{boot.store.name}</Text><Text style={s.muted}>React Native · iPhone / iPad · {isDemo ? 'ข้อมูลสาธิต' : session?.base}</Text><View style={s.orderCard}><Text style={s.sectionTitle}>บิลอยู่กับร้านและผู้ใช้</Text><Text style={s.muted}>การสลับหน้าและออกจากแอปจะเก็บบิลไว้ในอุปกรณ์ บิลนี้ยังไม่ใช่ออเดอร์ที่บันทึกในเซิร์ฟเวอร์จนกว่าจะรับชำระสำเร็จ</Text></View><Button label="เปลี่ยนร้าน / กลับหน้าเริ่มต้น" secondary disabled={busy} onPress={() => void run(async () => { await writes.current.idle(); setBoot(null); setCart(null); cartRef.current = null; setSheet(null); setDemo(false); if (session) setBoot(await api<NativeBootstrap>(session, null, 'bootstrap')); })} /><Button label="ออกจากระบบ" secondary disabled={busy} onPress={() => void run(async () => { await writes.current.idle(); await saveSession(null); setSession(null); setBoot(null); setCart(null); cartRef.current = null; setDemo(false); setPassword(''); })} /></>}
    </ScrollView>}</View></View></KeyboardAvoidingView>
    <Modal visible={sheet !== null && sheet !== 'cart'} transparent animationType="fade" onRequestClose={() => !busy && setSheet(null)}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.scrim}><View style={s.modal}><View style={s.rowBetween}><Text style={s.sectionTitle}>{sheet === 'product' ? product?.name : sheet === 'payment' ? 'ตรวจสอบและรับชำระ' : sheet === 'sales' ? 'ลูกค้า / ส่วนลด / คูปอง' : 'AI ช่วยเพิ่มสินค้า'}</Text><Button secondary label="ปิด" disabled={busy} onPress={() => setSheet(null)} /></View><ScrollView keyboardShouldPersistTaps="handled">{message ? <Text style={s.error}>{message}</Text> : null}
    {sheet === 'sales' && <SalesTools value={sales} customer={customer} disabled={busy || workflowLocked || !!pending} demo={isDemo} change={changeSales} request={workflowRequest} perform={run} />}
    {sheet === 'product' && product && <><Text style={s.total}>{money(product.priceSatang)}</Text>{product.variants.length > 0 && <><Text style={s.fieldLabel}>เลือกขนาด / รูปแบบ</Text><View style={s.actionRow}>{product.variants.map(v => <Button key={v.id} secondary={variantId !== v.id} label={`${v.name} ${v.priceSatang ? `+${money(v.priceSatang)}` : ''}`} onPress={() => setVariant(v.id)} />)}</View></>}{product.groups.map(group => <View key={group.id}><Text style={s.fieldLabel}>{group.name} · เลือก {group.min}–{group.max}</Text><View style={s.actionRow}>{group.options.map(option => <Button key={option.id} label={`${option.name}${option.priceSatang ? ` +${money(option.priceSatang)}` : ''}`} secondary={!optionIds.includes(option.id)} onPress={() => setOptions(ids => ids.includes(option.id) ? ids.filter(id => id !== option.id) : group.max === 1 ? [...ids.filter(id => !group.options.some(o => o.id === id)), option.id] : [...ids, option.id])} />)}</View></View>)}<Text style={s.fieldLabel}>หมายเหตุ</Text><TextInput style={s.input} accessibilityLabel="หมายเหตุสินค้า" placeholder="เช่น แยกน้ำแข็ง" maxLength={500} value={note} onChangeText={setNote} /><Button label="เพิ่มลงบิล" disabled={busy || workflowLocked} onPress={() => void run(addProduct)} /></>}
    {sheet === 'payment' && <>
      <Text style={s.small}>ส่วนลดท้ายบิล {money(quoted?.quote.manualDiscountSatang??0)} · คูปอง {money(quoted?.quote.couponDiscountSatang??0)}</Text>
      <Button secondary label="แก้ลูกค้า / ส่วนลด / คูปอง" disabled={busy||!!pending} onPress={()=>setSheet('sales')} />
      <View style={s.paymentSummary}><Text style={s.muted}>ยอดที่ต้องชำระ</Text><Text style={s.paymentTotal}>{money(total)}</Text></View>
      {isBeamPending(pending)&&pending ? <BeamPayment pending={pending} busy={busy} demo={isDemo} onCheck={()=>void run(checkBeam)} /> : <>
        <View style={s.actionRow}><Button label="เงินสด" disabled={busy||!!pending} secondary={method!=='cash'} onPress={()=>setMethod('cash')} /><Button label="โอนธนาคาร" disabled={busy||!!pending} secondary={method!=='bank_transfer'} onPress={()=>setMethod('bank_transfer')} />{beamEnabled&&<Button label="Beam QR" disabled={busy||!!pending} secondary={method!=='beam'} onPress={()=>setMethod('beam')} />}</View>
        {method==='beam'?<><Text style={s.small}>สร้าง QR ตามยอดที่ระบบตรวจแล้ว · ต้องรอ Beam ยืนยันรับเงินก่อนปิดบิล</Text><Button label={isDemo?'ลอง Beam QR สาธิต':'สร้าง Beam QR'} disabled={busy||workflowLocked||!!pending} onPress={()=>void run(beginBeam)} /></>:<>
          <Text style={s.fieldLabel}>{method==='cash'?'เงินที่รับมา':'ตรวจสอบยอดเข้าบัญชีร้านก่อนกดยืนยัน'}</Text><TextInput accessibilityLabel="เงินรับ" style={s.input} keyboardType="decimal-pad" value={received} onChangeText={setReceived} />
          <Text style={s.sectionTitle}>เงินทอน {money(method==='cash'?Math.max(0,Math.round(Number(received||0)*100)-total):0)}</Text><Text style={s.small}>{isDemo?'บิลนี้เป็นการสาธิต ไม่มีการรับเงินจริง':'เงินสดต้องเปิดรอบเงินสดใน StoreOS ก่อน · การโอนไม่มีระบบตรวจสลิปอัตโนมัติ'}</Text>
          <Button label={isDemo?'ยืนยันบิลสาธิต':'ยืนยันว่าได้รับเงินแล้ว'} disabled={busy||workflowLocked||!!pending} onPress={()=>void run(()=>checkout())} />
        </>}
      </>}
    </>}
    {sheet === 'ai' && <><Text style={s.muted}>พิมพ์คำสั่งเพิ่มสินค้า โดยระบุชื่อ จำนวน และตัวเลือกให้ครบ AI เสนอ แล้วคุณตรวจและยืนยัน</Text><TextInput accessibilityLabel="คำสั่ง AI" style={[s.input, { minHeight: 90 }]} multiline maxLength={500} value={utterance} onChangeText={text => { setUtterance(text); setProposal(null); }} placeholder="เพิ่มบราวนี 2 ชิ้น" /><Button label="ให้ AI เสนอรายการ" disabled={busy || !utterance.trim()} onPress={() => void run(askAi)} />{proposal && <View style={s.orderCard}>{proposal.lines.map((line, i) => <Text style={s.sectionTitle} key={i}>{line.quantity} × {line.name} · {line.choiceLabel}</Text>)}<Button label="ตรวจแล้ว เพิ่มลงบิล" disabled={busy} onPress={() => void run(async () => { if (!cartRef.current) return; await change(acceptAiProposal(cartRef.current, proposal)); setProposal(null); setSheet(null); })} /></View>}<Text style={s.small}>รุ่นนี้รับข้อความก่อน ยังไม่เปิดไมโครโฟน · ไม่อนุญาตให้ AI รับชำระ ลดราคา หรือยกเลิกบิล</Text></>}
    </ScrollView></View></KeyboardAvoidingView></Modal>
    <Modal visible={sheet === 'cart'} transparent animationType="slide" onRequestClose={() => !busy && setSheet(null)}><SafeAreaView style={s.scrim}><View style={[s.modal, { flex: 1 }]}><View style={s.rowBetween}><Text style={s.sectionTitle}>ตรวจรายการ</Text><Button secondary label="กลับไปเลือกสินค้า" disabled={busy} onPress={() => setSheet(null)} /></View>{cartPanel}</View></SafeAreaView></Modal></SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><PosApp /></SafeAreaProvider>; }

const s = StyleSheet.create({
  saleFooter: { padding: 16, gap: 12, backgroundColor: theme.surface, borderTopWidth: 1, borderColor: theme.border }, footerActions: { flexDirection: 'row', gap: 12 }, favorite: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  safe: { flex: 1, backgroundColor: theme.background }, shell: { flex: 1, flexDirection: 'row' }, main: { flex: 1, minWidth: 0 }, sidebar: { width: 88, backgroundColor: '#fff', padding: 12, gap: 10, borderRightWidth: 1, borderColor: theme.border }, bottomNav: { flexDirection: 'row', width: '100%', padding: 6, gap: 3, borderTopWidth: 1 }, logo: { fontSize: 34, fontWeight: '800', color: theme.primary, padding: 14, marginBottom: 30 }, nav: { paddingVertical: 15, borderRadius: 16, alignItems: 'center', gap: 7, minHeight: 60 }, navActive: { backgroundColor: theme.strong }, navIcon: { fontSize: 25, color: theme.muted }, navLabel: { color: theme.muted, fontSize: 12, fontWeight: '600' }, header: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }, eyebrow: { color: theme.muted, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginBottom: 7 }, title: { fontSize: 28, fontWeight: '700', color: theme.text, marginBottom: 4 }, muted: { color: theme.muted, fontSize: 14, lineHeight: 23 }, small: { color: theme.muted, fontSize: 12, lineHeight: 20 }, badge: { backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 30, flexDirection: 'row', alignItems: 'center', gap: 8 }, badgeText: { fontSize: 12, color: theme.muted }, dot: { width: 7, height: 7, borderRadius: 5 }, workspace: { flex: 1, flexDirection: 'row', minHeight: 0 }, catalog: { flex: 1, minWidth: 0, paddingHorizontal: 16, minHeight: 0 }, search: { flexShrink: 0, backgroundColor: '#fff', borderWidth: 1, borderColor: theme.border, borderRadius: 13, paddingHorizontal: 18, height: 50, fontSize: 15, color: theme.text }, categories: { flexGrow: 0, flexShrink: 0, height: 58, marginVertical: 12 }, chip: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: 24, paddingHorizontal: 20, paddingVertical: 11, backgroundColor: '#fff' }, chipActive: { backgroundColor: theme.strong, borderColor: theme.strong }, chipText: { color: theme.muted, fontSize: 16 }, chipTextActive: { color: '#fff', fontSize: 16 }, productGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingBottom: 25 }, product: { backgroundColor: '#fff', borderRadius: 16, padding: 12, minHeight: 140, borderWidth: 1, borderColor: theme.border, minWidth: 110 }, productArt: { height: 106, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginBottom: 10, gap: 4 }, productMonogram: { color: theme.muted, fontSize: 37, fontWeight: '300' }, productKind: { fontSize: 10, color: theme.muted }, productName: { fontSize: 18, color: theme.text, fontWeight: '600', minHeight: 44, paddingHorizontal: 3 }, productPrice: { fontWeight: '700', color: theme.primary, fontSize: 16 }, plus: { fontSize: 21, color: theme.primary, backgroundColor: theme.soft, borderRadius: 9, paddingHorizontal: 7 }, rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }, cart: { backgroundColor: '#fff', borderLeftWidth: 1, borderColor: theme.border, padding: 16, flex: 1, maxWidth: 400, minHeight: 0 }, cartItems: { flex: 1, marginTop: 18 }, cartLine: { paddingVertical: 15, borderBottomWidth: 1, borderColor: theme.border }, lineName: { fontSize: 15, fontWeight: '600', color: theme.text, flexShrink: 1 }, linePrice: { color: theme.text, fontSize: 14, fontWeight: '600' }, quantityRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 10 }, step: { minWidth: 44, height: 44, borderRadius: 10, backgroundColor: theme.soft, alignItems: 'center', justifyContent: 'center' }, quantity: { fontSize: 15, fontWeight: '600' }, cartFooter: { gap: 10, paddingTop: 18, borderTopWidth: 1, borderColor: theme.border }, total: { color: theme.text, fontSize: 25, fontWeight: '700' }, sectionTitle: { color: theme.text, fontSize: 18, fontWeight: '600', lineHeight: 28 }, button: { backgroundColor: theme.strong, paddingHorizontal: 18, paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 48 }, buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 }, secondary: { backgroundColor: theme.soft }, disabled: { opacity: .4 }, empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 70, gap: 7 }, emptyIcon: { fontSize: 40, color: theme.borderStrong, marginBottom: 10 }, notice: { color: theme.primary, backgroundColor: theme.soft, marginHorizontal: 22, marginBottom: 12, padding: 15, borderRadius: 12, lineHeight: 23 }, error: { color: theme.danger, backgroundColor: theme.soft, padding: 14, borderRadius: 10, lineHeight: 23, marginBottom: 12 }, page: { padding: 25, gap: 18, maxWidth: 1050 }, orderCard: { backgroundColor: '#fff', padding: 22, borderWidth: 1, borderColor: theme.border, borderRadius: 16, gap: 12 }, status: { color: theme.warning, fontWeight: '600', marginVertical: 8 }, actionRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginVertical: 12 }, emptyText: { textAlign: 'center', color: theme.muted, padding: 70 }, scrim: { flex: 1, backgroundColor: 'rgba(52,43,36,0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 }, modal: { backgroundColor: '#fff', borderRadius: 22, padding: 16, width: '100%', maxWidth: 570, maxHeight: '95%', gap: 20 }, fieldLabel: { fontSize: 14, color: theme.text, fontWeight: '600', marginTop: 20, marginBottom: 12 }, input: { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.background, borderRadius: 11, padding: 15, fontSize: 16, color: theme.text, minHeight: 50, marginBottom: 14 }, paymentSummary: { backgroundColor: theme.soft, borderRadius: 15, padding: 25, alignItems: 'center', marginTop: 15 }, paymentTotal: { fontSize: 40, color: theme.primary, fontWeight: '700', marginTop: 10 }, welcome: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 30, backgroundColor: theme.soft }, brand: { color: theme.primary, fontSize: 23, fontWeight: '800', letterSpacing: 1 }, welcomeTitle: { color: theme.text, fontSize: 36, fontWeight: '700', marginTop: 35, marginBottom: 13, textAlign: 'center' }, subtitle: { color: theme.muted, fontSize: 16, lineHeight: 27, textAlign: 'center', marginBottom: 30 }, loginCard: { maxWidth: 430, width: '100%', backgroundColor: '#fff', borderRadius: 22, padding: 25, gap: 12 },
});
