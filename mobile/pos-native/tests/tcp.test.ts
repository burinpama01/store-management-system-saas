import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ connect: null as null | (() => void), handlers: {} as Record<string, (...args: any[]) => void>, written: null as null | ((error?: Error) => void), write: vi.fn(), end: vi.fn(), destroy: vi.fn() }));
vi.mock('react-native-tcp-socket', () => ({ default: { createConnection: (_options: unknown, connected: () => void) => { state.connect = connected; return { write: (data: Uint8Array, _encoding: unknown, done: (error?: Error) => void) => { state.write(data); state.written = done; return true; }, on: (event: string, callback: (...args: any[]) => void) => { state.handlers[event] = callback; }, end: state.end, destroy: state.destroy }; } } }));
import { sendTcp } from '../src/printers/tcp.native';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.handlers = {}; state.written = null; });
afterEach(() => vi.useRealTimers());
it('sends one job, reports only submitted after write, and closes its connection', async () => {
  const result = sendTcp('192.168.1.20', 9100, Uint8Array.of(27, 64)); state.connect!(); state.written!();
  await expect(result).resolves.toEqual({ confirmed: false }); expect(state.write).toHaveBeenCalledTimes(1); expect(state.end).toHaveBeenCalledTimes(1);
});
it('does not resend after an uncertain timeout or error following the write', async () => {
  const result = sendTcp('192.168.1.20', 9100, Uint8Array.of(27, 64)); const rejection = expect(result).rejects.toThrow(); state.connect!();
  await vi.advanceTimersByTimeAsync(15000); await rejection;
  state.handlers.error(new Error('late disconnect')); expect(state.write).toHaveBeenCalledTimes(1); expect(state.destroy).toHaveBeenCalledTimes(1);
});
