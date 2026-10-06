import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { theme } from '../theme';
import { rasterEscPos } from '../domain/raster';
import { runPrintJob } from '../domain/printing';
import type { BlePrinter } from './ble';

export function BluetoothSettings() {
  const driver = useRef<BlePrinter | undefined>(undefined);
  const mounted = useRef(true); const lock = useRef(false);
  const preview = useRef<View>(null);
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const [message, setMessage] = useState(''); const [diagnostics, setDiagnostics] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; driver.current?.dispose(); }; }, []);
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" disabled={busy} onPress={action} style={{ minHeight: 48, padding: 14, borderRadius: 10, backgroundColor: busy ? theme.soft : theme.primary }}><Text style={{ color: busy ? theme.muted : '#fff' }}>{label}</Text></Pressable>;
  async function getDriver() {
    if (Platform.OS === 'web') throw new Error('Bluetooth ต้องใช้ StoreOS บน iPhone/iPad หรือ Android จาก build ใหม่');
    if (!driver.current) {
      const { BlePrinter } = await import('./ble');
      if (!mounted.current) throw new Error('ปิดหน้าเครื่องพิมพ์แล้ว');
      driver.current = new BlePrinter();
    }
    return driver.current;
  }
  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await work(); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'เชื่อมต่อ Bluetooth ไม่สำเร็จ'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function scan() {
    setDevices([]); setMessage('กำลังค้นหา 12 วินาที เปิดเครื่องพิมพ์ไว้ใกล้โทรศัพท์');
    const printer = await getDriver();
    await new Promise<void>((resolve, reject) => {
      printer.scan(device => {
        if (mounted.current) setDevices(previous => previous.some(d => d.id === device.id) ? previous : [...previous, device]);
      }, error => {
        if (mounted.current) setMessage(error || 'ค้นหาเสร็จแล้ว เลือกเครื่องพิมพ์ด้านล่าง หากไม่พบ 583-02/PT280 ให้ตรวจรุ่นและชนิด Bluetooth ของเครื่อง');
        resolve();
      }).catch(reject);
    });
  }
  async function connect(id: string) {
    setReady(false); setDiagnostics('');
    const result = await (await getDriver()).connect(id);
    if (!mounted.current) return;
    setReady(result.ready); setDiagnostics(result.diagnostics);
    setMessage(result.ready ? `เชื่อมต่อ ${result.name} แล้ว กรุณาพิมพ์ทดสอบ` : `เชื่อมต่อ ${result.name} ได้ แต่ยังไม่พบช่องพิมพ์ที่รู้จัก ส่งรายละเอียดด้านล่างให้ตรวจต่อ`);
  }
  async function printTest() {
    const printer = await getDriver();
    const { captureRef } = await import('react-native-view-shot');
    const { decode } = await import('fast-png');
    const { toByteArray } = await import('base64-js');
    const png = decode(toByteArray(await captureRef(preview, { result: 'base64', format: 'png', width: 384 })));
    if (png.width !== 384 || png.palette) throw new Error('ภาพพิมพ์ไม่ตรงกับหน้าพิมพ์ 384 จุด');
    const result = await runPrintJob(() => printer.print(rasterEscPos(png, false)));
    if (mounted.current) setMessage(result.state === 'submitted'
      ? 'ส่งข้อมูลทดสอบแล้ว ตรวจว่ากระดาษออกและภาษาไทยครบ การส่งข้อมูลยังไม่ใช่การยืนยันว่าพิมพ์สำเร็จ'
      : `ไม่ทราบผลการพิมพ์ ตรวจเครื่องก่อนส่งซ้ำ เพราะอาจพิมพ์ไปบางส่วนแล้ว ${result.error || ''}`);
  }
  return <View style={{ backgroundColor: '#fff', padding: 22, borderRadius: 16, gap: 14, borderWidth: 1, borderColor: theme.border }}>
    <Text style={{ fontSize: 18, fontWeight: '600', color: theme.text }}>Bluetooth · เครื่องพิมพ์ 58 mm</Text>
    <Text style={{ color: theme.muted, lineHeight: 23 }}>ค้นหาภายในแอป รองรับช่องพิมพ์ BLE ที่รู้จัก เป้าหมายทดสอบ 583-02 และ PT280 ยังต้องยืนยันกับเครื่องจริง ไม่ส่งงานซ้ำอัตโนมัติ</Text>
    {button(busy ? 'กำลังทำงาน…' : 'ค้นหาเครื่องพิมพ์ Bluetooth', () => void action(scan))}
    {devices.map(device => <View key={device.id} style={{ gap: 6 }}><Text style={{ color: theme.text }}>{device.name}</Text><Text style={{ fontSize: 12, color: theme.muted }}>{device.id}</Text>{button('เชื่อมต่อ ' + device.name, () => void action(() => connect(device.id)))}</View>)}
    <ScrollView horizontal><View ref={preview} collapsable={false} style={{ width: 384, backgroundColor: '#fff', padding: 20 }}>
      <Text style={{ color: '#000', fontSize: 28, fontWeight: '700', textAlign: 'center' }}>StoreOS POS</Text>
      <Text style={{ color: '#000', fontSize: 22, lineHeight: 32, textAlign: 'center' }}>ทดสอบ Bluetooth ภาษาไทย{'\n'}กิ กี กึ กื กุ กู ก่ ก้ ก๊ ก๋{'\n'}ลาเต้ · หวานน้อย · แยกน้ำแข็ง{'\n'}0123456789 · ฿123.45{'\n'}เอกสารทดสอบ ไม่ใช่ใบเสร็จ</Text>
    </View></ScrollView>
    {ready ? button('พิมพ์ทดสอบภาษาไทยผ่าน Bluetooth', () => void action(printTest)) : null}
    {message ? <Text accessibilityRole="alert" style={{ color: theme.text, lineHeight: 23 }}>{message}</Text> : null}
    {diagnostics ? <Text selectable style={{ fontSize: 11, color: theme.muted }}>รายละเอียดช่องเชื่อมต่อ BLE{'\n'}{diagnostics}</Text> : null}
  </View>;
}
