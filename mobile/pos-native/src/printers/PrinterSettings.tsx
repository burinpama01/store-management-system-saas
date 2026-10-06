import { theme } from '../theme';
import React, { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { rasterEscPos, validateLanTarget } from '../domain/raster';
import { runPrintJob } from '../domain/printing';

export function PrinterSettings() {
  const [host, setHost] = useState(''); const [port, setPort] = useState('9100');
  const [dots, setDots] = useState(384); const [cut, setCut] = useState(false);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [message, setMessage] = useState('');
  const preview = useRef<View>(null);
  const button = (label: string, action: () => void, active = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={action} style={{ minHeight: 48, padding: 14, borderRadius: 10, backgroundColor: active ? theme.primary : theme.soft }}><Text style={{ color: active ? '#fff' : theme.primary }}>{label}</Text></Pressable>;
  async function test() {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage('');
    try {
      if (Platform.OS === 'web') throw new Error('LAN printing ต้องเปิดจาก native development build บนอุปกรณ์จริง');
      validateLanTarget(host.trim(), Number(port));
      // Load optional native bridges only for an explicit print request, inside the error handler.
      const { captureRef } = await import('react-native-view-shot');
      const { decode } = await import('fast-png');
      const { toByteArray } = await import('base64-js');
      const { sendTcp } = await import('./tcp');
      const base64 = await captureRef(preview, { result: 'base64', format: 'png', width: dots });
      const png = decode(toByteArray(base64));
      if (png.width !== dots || png.palette) throw new Error('ภาพทดสอบมีขนาดหรือรูปแบบไม่ตรงกับเครื่องพิมพ์');
      const bytes = rasterEscPos(png, cut);
      const result = await runPrintJob(() => sendTcp(host.trim(), Number(port), bytes));
      setMessage(result.state === 'submitted' ? 'ส่งข้อมูลแล้ว กรุณาตรวจว่ากระดาษออกและภาษาไทยครบก่อนใช้งาน รุ่นนี้ยังไม่มีการยืนยันผลจากตัวเครื่อง' : 'ไม่ทราบผลการพิมพ์ ตรวจเครื่องก่อนกดส่งซ้ำ เพราะบางส่วนอาจพิมพ์ไปแล้ว');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'พิมพ์ทดสอบไม่สำเร็จ'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <View style={{ backgroundColor: '#fff', padding: 22, borderRadius: 16, gap: 14, borderWidth: 1, borderColor: theme.border }}>
    <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>LAN / Wi-Fi · ESC/POS</Text>
    <Text style={{ color: theme.muted, lineHeight: 23 }}>ระบุ IP เครื่องพิมพ์ในเครือข่ายร้าน ภาษาไทยส่งเป็นภาพเพื่อไม่พึ่งชุดตัวอักษรในเครื่อง ยังต้องทดสอบรุ่นจริง</Text>
    <TextInput accessibilityLabel="IP เครื่องพิมพ์ LAN" placeholder="เช่น 192.168.1.20" keyboardType="decimal-pad" value={host} onChangeText={setHost} style={{ padding: 14, minHeight: 48, borderWidth: 1, borderColor: theme.border, borderRadius: 10 }} />
    <TextInput accessibilityLabel="Port เครื่องพิมพ์" value={port} onChangeText={setPort} keyboardType="number-pad" style={{ padding: 14, minHeight: 48, borderWidth: 1, borderColor: theme.border, borderRadius: 10 }} />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{button('58 mm · 384 dots', () => setDots(384), dots === 384)}{button('80 mm · 576 dots', () => setDots(576), dots === 576)}{button(cut ? 'ตัดกระดาษ: เปิด' : 'ตัดกระดาษ: ปิด', () => setCut(!cut), cut)}</View>
    <ScrollView horizontal><View ref={preview} collapsable={false} style={{ width: dots, padding: 20, backgroundColor: 'white' }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: 'black', textAlign: 'center' }}>StoreOS POS</Text>
      <Text style={{ fontSize: 22, lineHeight: 32, color: 'black', textAlign: 'center' }}>ทดสอบภาษาไทย{ '\n' }กิ กี กึ กื กุ กู ก่ ก้ ก๊ ก๋{ '\n' }ลาเต้ · หวานน้อย · แยกน้ำแข็ง{ '\n' }0123456789 · ฿123.45</Text>
      <Text style={{ fontSize: 18, lineHeight: 28, color: 'black', textAlign: 'center', marginTop: 18 }}>เอกสารทดสอบ ไม่ใช่ใบเสร็จรับเงิน</Text>
    </View></ScrollView>
    {button(busy ? 'กำลังส่งงานพิมพ์…' : 'พิมพ์ทดสอบผ่าน LAN', () => void test(), true)}
    {message ? <Text accessibilityRole="alert" style={{ color: theme.text, lineHeight: 23 }}>{message}</Text> : null}
  </View>;
}
