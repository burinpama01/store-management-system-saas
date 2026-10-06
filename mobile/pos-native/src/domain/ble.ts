export interface BleChannel {
  serviceUUID: string; uuid: string;
  isWritableWithResponse: boolean; isWritableWithoutResponse: boolean;
}
const short = (uuid: string) => uuid.toLowerCase().replace(/^0000([a-f0-9]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
export function chooseBleChannel<T extends BleChannel>(channels: readonly T[]): T | undefined {
  return channels.find(c => (c.isWritableWithResponse || c.isWritableWithoutResponse) && (
    (short(c.serviceUUID) === 'ff00' && short(c.uuid) === 'ff02') ||
    (short(c.serviceUUID) === 'ffe0' && short(c.uuid) === 'ffe1') ||
    (short(c.serviceUUID) === 'ae00' && short(c.uuid) === 'ae01') ||
    (c.serviceUUID.toLowerCase() === '6e400001-b5a3-f393-e0a9-e50e24dcca9e' && c.uuid.toLowerCase() === '6e400002-b5a3-f393-e0a9-e50e24dcca9e')
  ));
}
export async function sendBleChunks(bytes: Uint8Array, write: (chunk: Uint8Array) => Promise<void>) {
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('ขนาดงานพิมพ์ Bluetooth ไม่ถูกต้อง');
  for (let offset = 0; offset < bytes.length; offset += 20) await write(bytes.slice(offset, offset + 20));
}
