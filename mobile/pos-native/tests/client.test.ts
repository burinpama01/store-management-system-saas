import { beforeEach, expect, it, vi } from 'vitest';
const secure = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => secure);
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
import { api, login, saveSession, type Session } from '../src/client';
const session = (): Session => ({ base: 'https://store.example', token: 'old', refreshToken: 'refresh', userId: 'user', expiresAt: 0, supabaseUrl: 'https://project.supabase.co', publishableKey: 'public' });
const auth = (userId = 'user') => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600, user: { id: userId } }));
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', vi.fn()); });
it('refreshes and persists rotated tokens before calling the store API', async () => {
  const s = session(); vi.mocked(fetch).mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response('{"ok":true}'));
  await expect(api(s, 'store', 'orders')).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenNthCalledWith(1, 'https://project.supabase.co/auth/v1/token?grant_type=refresh_token', expect.objectContaining({ method: 'POST', body: JSON.stringify({ refresh_token: 'refresh' }) }));
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://store.example/api/mobile/pos/orders', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer new', 'X-Store-Id': 'store' }) }));
  expect(JSON.parse(secure.setItemAsync.mock.calls[0][1]).refreshToken).toBe('rotated');
  expect(s.token).toBe('new');
});
it('shares one refresh between concurrent reads', async () => {
  const s = session(); vi.mocked(fetch).mockImplementation(async (url) => String(url).includes('refresh_token') ? auth() : new Response('{}'));
  await Promise.all([api(s, null, 'bootstrap'), api(s, 'store', 'orders')]);
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('refresh_token'))).toHaveLength(1);
});
it('does not send a request when refreshed identity changes', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(auth('other-user'));
  await expect(api(session(), 'store', 'checkout', {})).rejects.toThrow('เข้าสู่ระบบใหม่');
  expect(fetch).toHaveBeenCalledTimes(1); expect(secure.setItemAsync).not.toHaveBeenCalled();
});
it('preserves the old session and does not checkout when secure persistence fails', async () => {
  const s = session(); secure.setItemAsync.mockRejectedValueOnce(new Error('disk full')); vi.mocked(fetch).mockResolvedValueOnce(auth());
  await expect(api(s, 'store', 'checkout', {})).rejects.toThrow();
  expect(s.token).toBe('old'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not retry a checkout that returns unauthorized', async () => {
  const s = { ...session(), expiresAt: Date.now() + 3600000 }; vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }));
  await expect(api(s, 'store', 'checkout', {})).rejects.toMatchObject({ notCreated: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reports HTML instead of JSON without exposing its content or releasing an uncertain bill', async () => {
  const s = { ...session(), expiresAt: Date.now() + 3600000 }; vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>secret</html>'));
  await expect(api(s, 'store', 'checkout', {})).rejects.toMatchObject({ notCreated: false, message: expect.stringContaining('API') });
});
it('does not persist or call the API after logout during a refresh', async () => {
  let finish!: (value: Response) => void; vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = api(session(), null, 'bootstrap'); const rejected = expect(pending).rejects.toThrow('เข้าสู่ระบบใหม่');
  await saveSession(null); finish(auth()); await rejected;
  expect(secure.setItemAsync).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});
it('reports missing backend API during login without sending a password', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>not found</html>', { status: 404 }));
  await expect(login('https://store.example', 'user@example.invalid', 'password')).rejects.toThrow('API');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('finishes logout after an already running secure write without sending checkout', async () => {
  let finishWrite!: () => void;
  secure.setItemAsync.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  vi.mocked(fetch).mockResolvedValueOnce(auth());
  const s = session(); const pending = api(s, 'store', 'checkout', {});
  const rejected = expect(pending).rejects.toThrow('เข้าสู่ระบบใหม่');
  await vi.waitFor(() => expect(secure.setItemAsync).toHaveBeenCalledTimes(1));
  const logout = saveSession(null); finishWrite(); await Promise.all([rejected, logout]);
  expect(secure.deleteItemAsync).toHaveBeenCalledTimes(1);
  expect(s.token).toBe('old'); expect(fetch).toHaveBeenCalledTimes(1);
});
