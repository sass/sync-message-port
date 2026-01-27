/**
 * A BigInt64 that can be atomically incremented and decremented, and which
 * callers can synchronously listen for it becoming non-zero.
 *
 * This can be "open" or "closed"; once it's closed, {@link wait} will no longer
 * emit useful events.
 */
export class BigInt64Counter {
  /**
   * The underlying BigInt64Array.
   *
   * The first BigInt64 is used to track the current number.
   * The second BigInt64 is used to track the closed state.
   */
  private readonly buffer: BigInt64Array;

  constructor(buffer: SharedArrayBuffer) {
    if (buffer.byteLength !== 16) {
      throw new Error('SharedArrayBuffer must have a byteLength of 16.');
    }
    this.buffer = new BigInt64Array(buffer);
  }

  /** Atomically decrement the current value by one. */
  decrement(): void {
    Atomics.sub(this.buffer, 0, 1n);
  }

  /** Atomically increment the current value by one. */
  increment(): void {
    if (Atomics.add(this.buffer, 0, 1n) === 0n) {
      Atomics.notify(this.buffer, 0, 1);
    }
  }

  /**
   * Closes the counter.
   */
  close(): void {
    // The current value is no longer relevant once closed, therefore set it to
    // non-zero to prevent a potential deadlock when `Atomics.notify` is called
    // immediately before `Atomics.wait`.
    if (
      Atomics.compareExchange(this.buffer, 1, 0n, 1n) === 0n &&
      Atomics.compareExchange(this.buffer, 0, 0n, 1n) === 0n
    ) {
      Atomics.notify(this.buffer, 0);
    }
  }

  /**
   * Waits until the current value is not zero or the counter is closed.
   */
  wait(timeout?: number): 'ok' | 'not-equal' | 'timed-out' {
    while (
      Atomics.load(this.buffer, 0) === 0n &&
      Atomics.load(this.buffer, 1) === 0n
    ) {
      const result = Atomics.wait(this.buffer, 0, 0n, timeout);
      if (result !== 'ok') {
        return result;
      }
    }
    return 'ok';
  }
}
