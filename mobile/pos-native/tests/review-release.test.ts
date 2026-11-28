import { expect, it } from 'vitest';
import fs from 'node:fs';
import { FEATURES, LEGAL_LINKS } from '../src/features';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const config = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;

it('ships the App Review 1.0.0 feature set as build-time constants', () => {
  expect(FEATURES).toEqual({ ai: false, delivery: false, bluetoothPrinter: false, lanPrinter: true, demoMode: false, serverOverride: false });
  expect(config.version).toBe('1.0.0');
  expect(config.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
});

it('gates every entry point of disabled features behind FEATURES', () => {
  expect(app).toContain("(id === 'delivery' && FEATURES.delivery)");
  expect(app).toContain("{FEATURES.delivery && tab === 'delivery' &&");
  expect(app).toContain("{FEATURES.delivery && <EntryButton secondary label=\"ออเดอร์เดลิเวอรี\"");
  expect(app).toContain("{FEATURES.ai && sheet === 'ai' &&");
  expect(app.match(/\{FEATURES\.ai && <Button/g)).toHaveLength(2);
  expect(app).toContain('{FEATURES.demoMode && <><EntryButton secondary label="ลองหน้าขายแบบสาธิต"');
  expect(app).toContain('{FEATURES.serverOverride && <><Pressable');
  expect(app).toContain('{FEATURES.bluetoothPrinter && <React.Suspense');
  expect(app.match(/openWork\('delivery'\)/g)).toHaveLength(1);
  expect(app).not.toMatch(/BleManager/);
  expect(app).not.toContain('ยังไม่เปิดใช้งานในรุ่นนี้');
  expect(app).not.toContain('React Native · iPhone / iPad');
});

it('links to privacy, terms and account deletion from settings', () => {
  expect(LEGAL_LINKS.map(([, url]) => url)).toEqual([
    'https://www.store-os.online/privacy-policy',
    'https://www.store-os.online/terms-of-service',
    'https://www.store-os.online/account-deletion',
  ]);
  expect(app).toContain('LEGAL_LINKS.map(([label, url]) => <Button key={url} secondary label={label} onPress={() => void Linking.openURL(url)} />)');
});
