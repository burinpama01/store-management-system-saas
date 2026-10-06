import { BleManager, type Device, type Characteristic, type State } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { fromByteArray } from 'base64-js';
import { chooseBleChannel, sendBleChunks } from '../domain/ble';

export class BlePrinter {
  private manager = new BleManager();
  private device?: Device;
  private channel?: Characteristic;
  private closed = false;
  private writing = false;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private finishScan?: (error?: string) => void;
  private cancelStateWait?: () => void;
  stopScan() { clearTimeout(this.scanTimer); this.scanTimer = undefined; if (!this.closed) void this.manager.stopDeviceScan().catch(() => undefined); }
  async scan(found: (device: { id: string; name: string }) => void, done: (error?: string) => void) {
    if (Platform.OS === 'android') {
      const names = Number(Platform.Version) >= 31
        ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      const result = await PermissionsAndroid.requestMultiple(names);
      if (names.some(name => result[name] !== PermissionsAndroid.RESULTS.GRANTED)) throw new Error('กรุณาอนุญาต Bluetooth เพื่อค้นหาเครื่องพิมพ์');
    }
    if (this.closed) return;
    let state = await this.manager.state();
    if (this.closed) return;
    if (state === 'Unknown' || state === 'Resetting') {
      state = await new Promise<State>(resolve => {
        let finished = false;
        let subscription: { remove(): void } | undefined;
        const finish = (next: State) => {
          if (finished) return;
          finished = true; clearTimeout(timeout); subscription?.remove(); this.cancelStateWait = undefined; resolve(next);
        };
        const update = (next: State) => { if (next !== 'Unknown' && next !== 'Resetting') finish(next); };
        const timeout = setTimeout(() => finish('Unknown' as State), 8000);
        this.cancelStateWait = () => finish('Unknown' as State);
        subscription = this.manager.onStateChange(update);
        if (finished) subscription.remove();
        void this.manager.state().then(update).catch(() => finish('Unknown' as State));
      });
    }
    if (this.closed) return;
    if (state !== 'PoweredOn') throw new Error(`Bluetooth: ${state} — เปิด Bluetooth และอนุญาต StoreOS ในการตั้งค่า`);
    this.stopScan();
    let finished = false;
    const finish = (error?: string) => { if (finished) return; finished = true; this.stopScan(); this.finishScan = undefined; done(error); };
    this.finishScan = finish;
    this.scanTimer = setTimeout(() => finish(), 12000);
    try { await this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (this.closed) return;
      if (error) { finish(error.message); return; }
      if (device && (device.name || device.localName)) found({ id: device.id, name: device.name || device.localName || device.id });
    }); } catch (error) { finish(error instanceof Error ? error.message : 'ค้นหา Bluetooth ไม่สำเร็จ'); }
  }
  async connect(id: string) {
    if (this.closed) throw new Error('ปิดหน้าเครื่องพิมพ์แล้ว');
    if (this.writing) throw new Error('กำลังส่งงานพิมพ์');
    this.stopScan(); this.channel = undefined;
    if (this.device) await this.device.cancelConnection().catch(() => undefined);
    if (this.closed) throw new Error('ปิดหน้าเครื่องพิมพ์แล้ว');
    const device = await this.manager.connectToDevice(id, { timeout: 10000 });
    const check = () => { if (this.closed) throw new Error('ปิดหน้าเครื่องพิมพ์แล้ว'); };
    try {
    check();
    await device.discoverAllServicesAndCharacteristics(); check();
    const channels: Characteristic[] = [];
    const services = await device.services(); check();
    for (const service of services) { channels.push(...await service.characteristics()); check(); }
    this.device = device;
    this.channel = chooseBleChannel(channels);
    return { name: device.name || id, ready: !!this.channel,
      diagnostics: channels.map(c => `${c.serviceUUID} / ${c.uuid} ${c.isWritableWithResponse ? 'write' : ''}${c.isWritableWithoutResponse ? ' write-no-response' : ''}`).join('\n') };
    } catch (error) { await device.cancelConnection().catch(() => undefined); throw error; }
  }
  async print(bytes: Uint8Array): Promise<{ confirmed: boolean }> {
    if (this.closed || !this.device || !this.channel) throw new Error('ยังไม่มีช่องส่งข้อมูลเครื่องพิมพ์ที่รองรับ');
    if (this.writing) throw new Error('กำลังส่งงานพิมพ์');
    this.writing = true;
    const device = this.device; const channel = this.channel; const transaction = `print-${Date.now()}`;
    const deadline = Date.now() + 90000;
    try {
      await sendBleChunks(bytes, async chunk => {
        if (this.closed || Date.now() > deadline) throw new Error('หยุดส่งงานพิมพ์ ตรวจเครื่องก่อนส่งซ้ำ');
        const encoded = fromByteArray(chunk);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            channel.isWritableWithResponse
              ? device.writeCharacteristicWithResponseForService(channel.serviceUUID, channel.uuid, encoded, transaction)
              : device.writeCharacteristicWithoutResponseForService(channel.serviceUUID, channel.uuid, encoded, transaction),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { void this.manager.cancelTransaction(transaction).catch(() => undefined); reject(new Error('Bluetooth ส่งข้อมูลหมดเวลา')); }, 5000); }),
          ]);
        } finally { clearTimeout(timer); }
        await new Promise(resolve => setTimeout(resolve, 12));
      });
      return { confirmed: false };
    } finally { this.writing = false; }
  }
  dispose() { this.closed = true; this.cancelStateWait?.(); this.finishScan?.('ปิดหน้าเครื่องพิมพ์แล้ว'); clearTimeout(this.scanTimer); this.channel = undefined; void this.manager.destroy().catch(() => undefined); }
}
