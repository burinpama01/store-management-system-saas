import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { NativeOrder } from '../../../src/modules/native-pos/contracts';
import type { NativeCashSession, NativeSavedTicket, NativeOrderDetail } from '../../../src/modules/native-pos/workflow-contracts';
import type { Draft } from './domain/cart';
import { cashAmount, workflowBlocked } from './domain/workflow';
import { theme } from './theme';

type Request = <T>(operation: string, body?: unknown) => Promise<T>;
type Props = {
  mode: 'cash' | 'tickets' | 'orders'; request: Request; cart: Draft;
  pending: boolean; busy: boolean; demo: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  park: (label: string) => Promise<void>;
  resume: (ticket?: { id: string; updatedAt: string }) => Promise<void>;
  abandon: () => Promise<void>;
};
const money = (value: number) => `฿${(value / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export function PosWorkflow({ mode, request, cart, pending, busy, demo, perform, park, resume, abandon }: Props) {
  const alive = useRef(true); const lock = useRef(false); const loadVersion = useRef(0);
  const [loading, setLoading] = useState(false); const [message, setMessage] = useState('');
  const [cash, setCash] = useState<NativeCashSession | null>(null); const [canRecord,setCanRecord] = useState(false);
  const [amount,setAmount] = useState(''); const [note,setNote] = useState(''); const [confirmClose,setConfirmClose] = useState(false);
  const [cashKnown,setCashKnown] = useState(false); const [cashUncertain,setCashUncertain] = useState(false);
  const [label,setLabel] = useState(''); const [tickets,setTickets] = useState<NativeSavedTicket[]>([]);
  const [confirmAbandon,setConfirmAbandon] = useState(false);
  const [orders,setOrders] = useState<NativeOrder[]>([]); const [detail,setDetail] = useState<NativeOrderDetail | null>(null);
  const [date,setDate] = useState(localDate()); const [from,setFrom] = useState(localDate()); const [search,setSearch] = useState('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadVersion.current++; }; }, []);
  async function refresh() {
    const generation = ++loadVersion.current;
    if (mode === 'cash') {
      setCashKnown(false);
      const result = await request<{ session: NativeCashSession | null; canRecord: boolean }>('cash-session');
      if (!alive.current || generation !== loadVersion.current) return;
      setCash(result.session); setCanRecord(result.canRecord); setCashKnown(true); setCashUncertain(false); setConfirmClose(false);
    } else if (mode === 'tickets') {
      const result = await request<{ tickets: NativeSavedTicket[] }>('tickets');
      if (alive.current && generation === loadVersion.current) setTickets(result.tickets);
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('ใช้วันที่ YYYY-MM-DD เช่น 2026-10-06');
      const result = await request<{ orders: NativeOrder[] }>(`history?fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(date)}`);
      if (alive.current && generation === loadVersion.current) { setOrders(result.orders); setDetail(null); }
    }
  }
  async function action(work: () => Promise<void>) {
    if (lock.current || busy) return;
    lock.current = true; setLoading(true); setMessage('');
    try { await perform(async () => { try { await work(); } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : 'ทำรายการไม่สำเร็จ'); } }); }
    finally { lock.current = false; if (alive.current) setLoading(false); }
  }
  useEffect(() => { setMessage(''); setDetail(null); setCashKnown(false); void action(refresh); }, [mode]);
  const blocked = busy || loading;
  const button = (text: string, work: () => Promise<void>, disabled = false, secondary = false) => <Pressable accessibilityRole="button" accessibilityLabel={text} disabled={blocked || disabled} onPress={() => void action(work)} style={{ minHeight:48,padding:15,borderRadius:12,backgroundColor:secondary ? theme.soft : theme.primary, opacity:blocked || disabled ? .45 : 1 }}><Text style={{color:secondary ? theme.primary : '#fff',fontWeight:'600'}}>{text}</Text></Pressable>;
  const input = (title: string, value: string, update: (value:string)=>void, numeric=false) => <View style={{gap:6}}><Text style={{color:theme.text}}>{title}</Text><TextInput accessibilityLabel={title} value={value} editable={!blocked} onChangeText={update} keyboardType={numeric ? 'decimal-pad' : 'default'} maxLength={numeric ? 14 : 80} style={{minHeight:48,padding:14,borderWidth:1,borderColor:theme.border,borderRadius:12,backgroundColor:'#fff',color:theme.text}} /></View>;
  return <View style={{gap:16}}>
    <Text style={{fontSize:24,fontWeight:'700',color:theme.text}}>{mode === 'cash' ? 'กะเงินสด' : mode === 'tickets' ? 'บิลพัก' : 'ประวัติการขาย'}</Text>
    {demo ? <Text style={{color:theme.muted}}>โหมดสาธิต ไม่บันทึกข้อมูลจริง</Text> : null}
    {button(loading ? 'กำลังโหลด…' : 'โหลดข้อมูลล่าสุด', refresh, false, true)}
    {mode === 'cash' && <>
      {cash ? <View style={{backgroundColor:'#fff',padding:20,borderRadius:16,gap:10}}>
        <Text style={{color:theme.text,fontSize:18,fontWeight:'600'}}>กะ {cash.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}</Text>
        <Text style={{color:theme.muted}}>เปิดเมื่อ {new Date(cash.openedAt).toLocaleString('th-TH')}</Text>
        <Text style={{color:theme.text}}>เงินเริ่มต้น {money(cash.openingSatang)}</Text>
        <Text style={{color:theme.text}}>เงินที่ควรมี {cash.expectedSatang === null ? 'ยังโหลดไม่ได้' : money(cash.expectedSatang)}</Text>
        {cash.varianceSatang !== undefined ? <Text style={{color:theme.text}}>ส่วนต่าง {money(cash.varianceSatang)}</Text> : null}
      </View> : cashKnown ? <Text style={{color:theme.muted}}>ยังไม่มีกะเงินสดที่เปิดอยู่</Text> : null}
      {cash?.status !== 'closed' && <>
        {input(cash ? 'เงินสดที่นับได้ (บาท)' : 'เงินทอนเริ่มต้น (บาท)',amount,v=>{setAmount(v);setConfirmClose(false);},true)}
        {input('หมายเหตุกะ',note,setNote)}
        {!canRecord && cashKnown ? <Text style={{color:theme.muted}}>บัญชีนี้ดูข้อมูลได้ แต่ไม่มีสิทธิ์เปิด/ปิดกะ</Text> : null}
        {cashUncertain ? <Text accessibilityRole="alert" style={{color:theme.danger}}>ยังไม่ทราบผลคำขอ กรุณาโหลดข้อมูลล่าสุดก่อนทำรายการอีกครั้ง</Text> : null}
        {confirmClose && cash ? <Text style={{color:theme.text}}>ยืนยันปิดกะด้วยเงินนับจริง {money(cashAmount(amount))} ส่วนต่างโดยประมาณ {money(cashAmount(amount)-(cash.expectedSatang ?? 0))} ยอดสุดท้ายให้ระบบหลังบ้านตรวจ</Text> : null}
        {button(cash ? confirmClose ? 'ยืนยันปิดกะ' : 'ตรวจยอดก่อนปิดกะ' : 'เปิดกะเงินสด',async()=>{
          const satang=cashAmount(amount);
          if(cash && !confirmClose){setConfirmClose(true);return;}
          try {
            const result = await request<{session:NativeCashSession|null}>(cash ? 'cash-close' : 'cash-open',cash ? {sessionId:cash.id,closingSatang:satang,note} : {openingSatang:satang,note});
            if(!alive.current)return;
            setCash(result.session);setAmount('');setNote('');setConfirmClose(false);setMessage(cash ? 'ปิดกะแล้ว ตรวจยอดและส่วนต่างด้านบน' : 'เปิดกะแล้ว');
          } catch(error){if(alive.current){setCashUncertain(true);setCashKnown(false);}throw error;}
        },!cashKnown || !canRecord || cashUncertain || pending || workflowBlocked(cart) || !!cash && cash.expectedSatang === null)}
      </>}
    </>}
    {mode === 'tickets' && <>
      {input('ชื่อบิลพัก',label,setLabel)}
      {cart.parking ? <Text style={{color:theme.muted}}>กำลังตรวจผลพักบิล {cart.parking.label} รายการเดิมยังเก็บไว้บนเครื่อง</Text> : null}
      {button(cart.parking ? 'ตรวจผลพักบิลอีกครั้ง' : 'พักบิลปัจจุบัน', async()=>{await park(label);await refresh();},pending || !!cart.resuming || !!cart.checkoutOperationId || !cart.lines.length)}
      {cart.checkoutOperationId ? <><Text style={{color:theme.muted}}>บิลนี้เรียกกลับมาแล้ว กรุณาขายให้เสร็จก่อนพักบิลใหม่</Text>{confirmAbandon ? <Text style={{color:theme.danger}}>ยุติบิลที่เรียกกลับเฉพาะเมื่อระบบยืนยันว่าไม่ได้สร้างออเดอร์แล้ว รายการนี้จะถูกนำออกจากตะกร้า</Text> : null}{button(confirmAbandon ? 'ยืนยันยุติบิลที่ยังไม่สร้างออเดอร์' : 'ยุติบิลที่เรียกกลับ',async()=>{if(!confirmAbandon){setConfirmAbandon(true);return;}await abandon();setConfirmAbandon(false);await refresh();},false,true)}</> : null}
      {cart.resuming ? <>{<Text style={{color:theme.muted}}>ยังไม่ทราบผลเรียกบิล กรุณาตรวจคำขอเดิมก่อนเริ่มขาย</Text>}{button('ตรวจผลเรียกบิลอีกครั้ง', async()=>{await resume();await refresh();})}</> : null}
      {!tickets.length && !loading ? <Text style={{color:theme.muted}}>ไม่มีบิลพัก</Text> : null}
      {tickets.map(ticket=><View key={ticket.id} style={{backgroundColor:'#fff',padding:20,borderRadius:16,gap:10}}><Text style={{fontSize:18,fontWeight:'600',color:theme.text}}>{ticket.label}</Text><Text style={{color:theme.muted}}>{ticket.lineCount} รายการ · {money(ticket.totalSatang)}</Text>{ticket.blockedReason ? <Text style={{color:theme.muted}}>{ticket.blockedReason}</Text> : null}{button('เรียกบิล '+ticket.label,async()=>{await resume(ticket);await refresh();},!ticket.resumable || pending || workflowBlocked(cart) || cart.lines.length>0)}</View>)}
    </>}
    {mode === 'orders' && <>
      <Text style={{color:theme.muted}}>ค้นหาช่วงวันได้สูงสุด 31 วัน โหลดไม่เกิน 100 บิลต่อครั้ง</Text>
      {input('วันที่เริ่ม YYYY-MM-DD',from,setFrom)}{input('วันที่สิ้นสุด YYYY-MM-DD',date,setDate)}
      {button('ค้นหาประวัติ',refresh)}{input('ค้นหาหมายเลขบิล',search,setSearch)}
      {detail ? <View style={{backgroundColor:'#fff',padding:20,borderRadius:16,gap:10}}>
        <Text style={{fontSize:20,fontWeight:'700',color:theme.text}}>{detail.number}</Text><Text style={{color:theme.muted}}>{detail.status} · {new Date(detail.createdAt).toLocaleString('th-TH')}</Text>
        {detail.lines.map((line,i)=><Text key={`${line.key}-${i}`} style={{color:theme.text}}>{line.quantity} × {line.name} · {money(line.unitSatang*line.quantity)}{line.choiceLabel ? `\n${line.choiceLabel}` : ''}{line.note ? `\n${line.note}` : ''}</Text>)}
        <Text style={{color:theme.text}}>ยอดสินค้า {money(detail.subtotalSatang)} · ส่วนลด {money(detail.discountSatang)}</Text><Text style={{fontSize:22,fontWeight:'700',color:theme.text}}>รวม {money(detail.totalSatang)}</Text>
        {detail.payments.map((payment,i)=><Text key={i} style={{color:theme.text}}>{payment.method} · {payment.status} · {money(payment.amountSatang)}{payment.receivedSatang !== undefined ? `\nรับ ${money(payment.receivedSatang)} ทอน ${money(payment.changeSatang ?? 0)}` : ''}</Text>)}
        {detail.note ? <Text style={{color:theme.text}}>{detail.note}</Text> : null}{button('ปิดรายละเอียด',async()=>setDetail(null),false,true)}
      </View> : null}
      {orders.filter(order=>order.number.toLowerCase().includes(search.toLowerCase())).map(order=><View key={order.id} style={{backgroundColor:'#fff',padding:20,borderRadius:16,gap:10}}><Text style={{fontSize:18,fontWeight:'600',color:theme.text}}>{order.number}</Text><Text style={{color:theme.muted}}>{order.status} · {money(order.totalSatang)}</Text>{button('ดูบิล '+order.number,async()=>{const result=await request<{order:NativeOrderDetail}>(`order-detail?id=${encodeURIComponent(order.id)}`);if(alive.current)setDetail(result.order);})}</View>)}
      {!orders.length && !loading ? <Text style={{color:theme.muted}}>ไม่มีบิลในช่วงวันที่นี้</Text> : null}
    </>}
    {message ? <Text accessibilityRole="alert" style={{color:theme.danger,lineHeight:24}}>{message}</Text> : null}
  </View>;
}
