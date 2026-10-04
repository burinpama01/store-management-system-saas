import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
export type Session = { base: string; token: string; refreshToken: string; userId: string; expiresAt: number; supabaseUrl: string; publishableKey: string };
const SESSION_KEY = 'storeos.native.session.v1';
export class ApiError extends Error { constructor(message: string, public notCreated: boolean) { super(message); } }
export async function savedSession(): Promise<Session | null> {
  if (Platform.OS === 'web') return null;
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  try { const value = raw ? JSON.parse(raw) as Session : null; return value?.token && value?.base && value?.userId && value?.refreshToken ? value : null; } catch { return null; }
}
export async function saveSession(session: Session | null) {
  if (Platform.OS === 'web') return;
  if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error_description ?? body.error ?? body.msg ?? 'เชื่อมต่อไม่สำเร็จ', body.notCreated === true);
  return body as T;
}
export async function login(baseInput: string, email: string, password: string): Promise<Session> {
  if (Platform.OS === 'web') throw new Error('เปิดโหมดสาธิตบนเว็บ หรือใช้แอป iOS/Android เพื่อเข้าสู่ระบบ');
  const url = new URL(baseInput.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('ใช้ HTTPS origin ของ StoreOS เช่น https://your-store.example');
  const base = url.origin;
  const config = await responseJson<{ supabaseUrl: string; publishableKey: string }>(await fetch(`${base}/api/mobile/pos/config`, { signal: AbortSignal.timeout(15000) }));
  if (new URL(config.supabaseUrl).protocol !== 'https:') throw new Error('ปลายทางเข้าสู่ระบบไม่ปลอดภัย');
  const auth = await responseJson<{ access_token: string; refresh_token: string; expires_in: number; user: { id: string } }>(await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim(), password }), signal: AbortSignal.timeout(15000) }));
  const session = { base, token: auth.access_token, refreshToken: auth.refresh_token, userId: auth.user.id, expiresAt: Date.now() + auth.expires_in * 1000, ...config };
  await saveSession(session); return session;
}
export async function api<T>(session: Session, storeId: string | null, operation: string, body?: unknown): Promise<T> {
  if (session.expiresAt < Date.now() + 30000) throw new Error('เซสชันหมดอายุ กรุณาออกแล้วเข้าสู่ระบบใหม่ บิลยังเก็บไว้');
  return responseJson<T>(await fetch(`${session.base}/api/mobile/pos/${operation}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${session.token}`, ...(storeId ? { 'X-Store-Id': storeId } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) }));
}
