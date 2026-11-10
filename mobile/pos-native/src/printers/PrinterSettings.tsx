import { theme } from '../theme';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearLanPrinter, lanPrinterLabel, lanPrintMessage, loadLanPrinter, makeLanPrinter, saveLanPrinter, type SavedLanPrinter } from '../domain/lan-printer';

export function PrinterSettings() {
  const [host, setHost] = useState(''); const [port, setPort] = useState('9100');
  const [dots, setDots] = useState(384); const [cut, setCut] = useState(false);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [message, setMessage] = useState('');
  const [saved, setSaved] = useState<SavedLanPrinter | null>(null);
  const preview = useRef<View>(null); const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void loadLanPrinter(AsyncStorage).then(printer => {
      if (!mounted.current || !printer) return;
      setSaved(printer); setHost(printer.host); setPort(String(printer.port)); setDots(printer.dots); setCut(printer.cut);
    });
    return () => { mounted.current = false; };
  }, []);
  const button = (label: string, action: () => void, active = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={action} style={{ minHeight: 48, padding: 14, borderRadius: 10, backgroundColor: active ? theme.primary : theme.soft }}><Text style={{ color: active ? '#fff' : theme.primary }}>{label}</Text></Pressable>;
  async function guarded(work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage('');
    try { await work(); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'ทำรายการไม่สำเร็จ'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const current = () => makeLanPrinter(host, Number(port), dots, cut);
  const test = () => guarded(async () => {
    if (Platform.OS === 'web') throw new Error('LAN printing ต้องเปิดจาก native development build บนอุปกรณ์จริง');
    const printer = current();
    // Load optional native bridges only for an explicit print request, inside the error handler.
    const { printViewToLan } = await import('./lan-print');
    const result = await printViewToLan(preview, printer);
    if (mounted.current) setMessage(result.state === 'submitted' ? 'ส่งข้อมูลแล้ว กรุณาตรวจว่ากระดาษออกและภาษาไทยครบ ถ้าถูกต้องให้กด "ใช้เครื่องนี้พิมพ์ใบเสร็จ"' : lanPrintMessage(result.state, result.error));
  });
  const save = () => guarded(async () => {
    const printer = await saveLanPrinter(AsyncStorage, current());
    if (mounted.current) { setSaved(printer); setMessage(`บันทึกแล้ว หน้าใบเสร็จจะมีปุ่มพิมพ์ผ่าน WiFi ไปที่ ${lanPrinterLabel(printer)}`); }
  });
  const forget = () => guarded(async () => {
    await clearLanPrinter(AsyncStorage);
    if (mounted.current) { setSaved(null); setMessage('เลิกใช้เครื่องพิมพ์ WiFi สำหรับใบเสร็จแล้ว'); }
  });
  return <View style={{ backgroundColor: '#fff', padding: 22, borderRadius: 16, gap: 14, borderWidth: 1, borderColor: theme.border }}>
    <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>LAN / Wi-Fi · ESC/POS</Text>
    <Text style={{ color: theme.muted, lineHeight: 23 }}>ระบุ IP เครื่องพิมพ์ในเครือข่ายร้าน (มือถือ/iPad ต้องต่อ WiFi วงเดียวกัน) ภาษาไทยส่งเป็นภาพเพื่อไม่พึ่งชุดตัวอักษรในเครื่อง พิมพ์ทดสอบก่อนบันทึก</Text>
    <Text style={{ color: theme.text }}>{saved ? `เครื่องพิมพ์ใบเสร็จ: ${lanPrinterLabel(saved)}` : 'ยังไม่ได้เลือกเครื่องพิมพ์ใบเสร็จ'}</Text>
    <TextInput accessibilityLabel="IP เครื่องพิมพ์ LAN" placeholder="เช่น 192.168.1.20" keyboardType="decimal-pad" value={host} onChangeText={setHost} style={{ padding: 14, minHeight: 48, borderWidth: 1, borderColor: theme.border, borderRadius: 10, fontSize: 16 }} />
    <TextInput accessibilityLabel="Port เครื่องพิมพ์" value={port} onChangeText={setPort} keyboardType="number-pad" style={{ padding: 14, minHeight: 48, borderWidth: 1, borderColor: theme.border, borderRadius: 10, fontSize: 16 }} />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{button('58 mm · 384 dots', () => setDots(384), dots === 384)}{button('80 mm · 576 dots', () => setDots(576), dots === 576)}{button(cut ? 'ตัดกระดาษ: เปิด' : 'ตัดกระดาษ: ปิด', () => setCut(!cut), cut)}</View>
    <ScrollView horizontal><View ref={preview} collapsable={false} style={{ width: dots, padding: 20, backgroundColor: 'white' }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: 'black', textAlign: 'center' }}>StoreOS POS</Text>
      <Text style={{ fontSize: 22, lineHeight: 32, color: 'black', textAlign: 'center' }}>ทดสอบภาษาไทย{ '\n' }กิ กี กึ กื กุ กู ก่ ก้ ก๊ ก๋{ '\n' }ลาเต้ · หวานน้อย · แยกน้ำแข็ง{ '\n' }0123456789 · ฿123.45</Text>
      <Text style={{ fontSize: 18, lineHeight: 28, color: 'black', textAlign: 'center', marginTop: 18 }}>เอกสารทดสอบ ไม่ใช่ใบเสร็จรับเงิน</Text>
    </View></ScrollView>
    {button(busy ? 'กำลังส่งงานพิมพ์…' : 'พิมพ์ทดสอบผ่าน LAN', () => void test(), true)}
    {button('ใช้เครื่องนี้พิมพ์ใบเสร็จ', () => void save())}
    {saved ? button('เลิกใช้เครื่องพิมพ์ WiFi', () => void forget()) : null}
    {message ? <Text accessibilityRole="alert" style={{ color: theme.text, lineHeight: 23 }}>{message}</Text> : null}
  </View>;
}
