export type PrintRoute = 'tcp' | 'ble' | 'classic' | 'usb' | 'hub' | 'system' | 'vendor';
export interface PrinterProfile { transport: 'lan' | 'ble' | 'classic' | 'usb' | 'hub' | 'system' | 'vendor'; protocol: string; tested: boolean }
export function choosePrintRoute(profile: PrinterProfile, platform: string, adapters: readonly PrintRoute[]): PrintRoute | 'unsupported' | 'needs-test' {
  const route: PrintRoute = profile.transport === 'lan' ? 'tcp' : profile.transport;
  if (platform === 'ios' && (route === 'classic' || route === 'usb')) return 'unsupported';
  if (!adapters.includes(route)) return 'unsupported';
  return profile.tested ? route : 'needs-test';
}
export async function runPrintJob(driver: () => Promise<{ confirmed: boolean }>): Promise<{ state: 'confirmed' | 'submitted' | 'unknown'; error?: string }> {
  try { const result = await driver(); return { state: result.confirmed ? 'confirmed' : 'submitted' }; }
  catch (error) { return { state: 'unknown', error: error instanceof Error ? error.message : 'ไม่ทราบผลการพิมพ์ กรุณาตรวจเครื่องก่อนพิมพ์ซ้ำ' }; }
}
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
