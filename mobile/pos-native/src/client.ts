import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
export type Session = { base: string; token: string; refreshToken: string; userId: string; expiresAt: number; supabaseUrl: string; publishableKey: string };
const SESSION_KEY = 'storeos.native.session.v1';
let sessionGeneration = 0;
let sessionWrites: Promise<void> = Promise.resolve();
const refreshes = new WeakMap<Session, Promise<void>>();
const expiredMessage = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่ บิลยังเก็บไว้';
export class ApiError extends Error { constructor(message: string, public notCreated: boolean) { super(message); } }
export async function savedSession(): Promise<Session | null> {
  if (Platform.OS === 'web') return null;
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  try { const value = raw ? JSON.parse(raw) as Session : null; return value?.token && value?.base && value?.userId && value?.refreshToken ? value : null; } catch { return null; }
}
async function persistSession(session: Session | null, generation: number) {
  if (Platform.OS === 'web') return;
  const write = sessionWrites.catch(() => {}).then(async () => {
    if (generation !== sessionGeneration) throw new Error(expiredMessage);
    if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  });
  sessionWrites = write; await write;
}
export async function saveSession(session: Session | null) {
  await persistSession(session, ++sessionGeneration);
}
async function responseJson<T>(response: Response): Promise<T> {
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await response.text());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    throw new ApiError(response.status === 404 ? 'ระบบหลังบ้านยังไม่มี API สำหรับแอปรุ่นนี้' : 'ปลายทางส่งหน้าเว็บแทนข้อมูล API กรุณาตรวจ URL และการตั้งค่าระบบหลังบ้าน', false);
  }
  if (!response.ok) {
    const message = body.error_description ?? body.error ?? body.msg;
    throw new ApiError(typeof message === 'string' ? message : 'เชื่อมต่อไม่สำเร็จ', body.notCreated === true);
  }
  return body as T;
}
async function refreshSession(session: Session) {
  if (session.expiresAt >= Date.now() + 30000) return;
  const existing = refreshes.get(session);
  if (existing) return existing;
  const generation = sessionGeneration;
  const pending = (async () => {
    const response = await fetch(`${session.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: session.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refreshToken }), signal: AbortSignal.timeout(15000) });
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new Error(expiredMessage);
    const auth = await responseJson<{ access_token: string; refresh_token: string; expires_in: number; user: { id: string } }>(response);
    if (auth.user?.id !== session.userId || typeof auth.access_token !== 'string' || !auth.access_token || typeof auth.refresh_token !== 'string' || !auth.refresh_token || !Number.isFinite(auth.expires_in) || auth.expires_in <= 30 || generation !== sessionGeneration) throw new Error(expiredMessage);
    const updated = { ...session, token: auth.access_token, refreshToken: auth.refresh_token, expiresAt: Date.now() + auth.expires_in * 1000 };
    await persistSession(updated, generation);
    if (generation !== sessionGeneration) throw new Error(expiredMessage);
    Object.assign(session, updated);
  })();
  refreshes.set(session, pending);
  try { await pending; } finally { refreshes.delete(session); }
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
  await refreshSession(session);
  return responseJson<T>(await fetch(`${session.base}/api/mobile/pos/${operation}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${session.token}`, ...(storeId ? { 'X-Store-Id': storeId } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) }));
}
