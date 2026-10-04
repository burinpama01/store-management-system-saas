export function createWriteQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    write(action: () => Promise<void>) { const result = tail.then(action); tail = result.catch(() => {}); return result; },
    idle() { return tail; },
  };
}
// A retry can overlap an older timed-out request. Its rejection does not prove
// that the older request did not create an order; never release that lock.
export const canReleaseRejectedCheckout = (wasPending: boolean, notCreated: boolean) => !wasPending && notCreated;
