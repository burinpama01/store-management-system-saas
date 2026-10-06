import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

it('cancels a late connection after the printer screen is disposed', async () => {
  let resolve: (device: any) => void = () => {};
  const device = { cancelConnection: vi.fn(async () => {}), discoverAllServicesAndCharacteristics: vi.fn(async () => {}) };
  const manager = { connectToDevice: () => new Promise(r => { resolve = r; }), stopDeviceScan: async () => {}, destroy: async () => {} };
  const exports: any = {};
  const source = fs.readFileSync(new URL('../src/printers/ble.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, setTimeout, clearTimeout, Uint8Array, require: (name: string) => {
      if (name === 'react-native-ble-plx') return { BleManager: function () { return manager; } };
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      if (name === 'base64-js') return {};
      if (name === '../domain/ble') return {};
      throw new Error(name);
    },
  });
  const printer = new exports.BlePrinter();
  const connection = printer.connect('printer');
  printer.dispose(); resolve(device);
  await expect(connection).rejects.toThrow();
  expect(device.cancelConnection).toHaveBeenCalledOnce();
  expect(device.discoverAllServicesAndCharacteristics).not.toHaveBeenCalled();
});

it('removes state wait subscription when disposed and never starts scanning', async () => {
  let subscribed: () => void = () => {};
  const ready = new Promise<void>(resolve => { subscribed = resolve; });
  const remove = vi.fn(); const start = vi.fn();
  const manager = { state: async () => 'Unknown', onStateChange: () => { subscribed(); return { remove }; }, startDeviceScan: start, stopDeviceScan: async () => {}, destroy: async () => {} };
  const exports: any = {};
  const source = fs.readFileSync(new URL('../src/printers/ble.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, setTimeout, clearTimeout, Uint8Array, require: (name: string) => {
      if (name === 'react-native-ble-plx') return { BleManager: function () { return manager; } };
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      if (name === 'base64-js' || name === '../domain/ble') return {};
      throw new Error(name);
    },
  });
  const printer = new exports.BlePrinter();
  const scan = printer.scan(vi.fn(), vi.fn());
  await ready; printer.dispose(); await scan;
  expect(remove).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
});
