import { expect, it } from 'vitest';
import { createWriteQueue, canReleaseRejectedCheckout } from '../src/domain/storage';
it('reports a failed save but allows a subsequent save and logout drain', async () => {
  const queue = createWriteQueue(); const events: string[] = [];
  await expect(queue.write(async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
  await queue.write(async () => { events.push('saved'); });
  await queue.idle(); expect(events).toEqual(['saved']);
});
it('releases first-request validation rejection but preserves uncertain or overlapping attempts', () => {
  expect(canReleaseRejectedCheckout(false, true)).toBe(true);
  expect(canReleaseRejectedCheckout(true, true)).toBe(false);
  expect(canReleaseRejectedCheckout(false, false)).toBe(false);
});
