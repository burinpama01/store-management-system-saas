import { describe, expect, it } from 'vitest';
import { chooseBleChannel, sendBleChunks } from '../src/domain/ble';

describe('BLE printer channel and delivery', () => {
  it('prefers known printer UART over unrelated writable controls', () => {
    const control = { serviceUUID: '180a', uuid: '2a00', isWritableWithResponse: true, isWritableWithoutResponse: false };
    const uart = { ...control, serviceUUID: '0000ff00-0000-1000-8000-00805f9b34fb', uuid: '0000ff02-0000-1000-8000-00805f9b34fb' };
    expect(chooseBleChannel([control, uart])).toEqual(uart);
    expect(chooseBleChannel([control])).toBeUndefined();
  });
  it('writes in order using conservative chunks without retry', async () => {
    const calls: number[][] = [];
    await sendBleChunks(new Uint8Array(45).map((_, i) => i), async bytes => { calls.push([...bytes]); });
    expect(calls.map(c => c.length)).toEqual([20, 20, 5]);
    expect(calls.flat()).toEqual(Array.from({ length: 45 }, (_, i) => i));
  });
  it('stops immediately when a partial job fails', async () => {
    let calls = 0;
    await expect(sendBleChunks(new Uint8Array(60), async () => { if (++calls === 2) throw new Error('disconnected'); })).rejects.toThrow('disconnected');
    expect(calls).toBe(2);
  });
  it('rejects empty and oversized jobs before writing', async () => {
    let calls = 0;
    const write = async () => { calls++; };
    await expect(sendBleChunks(new Uint8Array(), write)).rejects.toThrow();
    await expect(sendBleChunks(new Uint8Array(1024 * 1024 + 1), write)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
