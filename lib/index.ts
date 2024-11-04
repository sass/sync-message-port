// Copyright 2021 Google LLC. Use of this source code is governed by an
// MIT-style license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import {strict as assert} from 'assert';
import {EventEmitter} from 'events';
import {
  MessageChannel,
  MessagePort,
  TransferListItem,
  receiveMessageOnPort,
} from 'worker_threads';

/**
 * An enum of possible states for the shared buffer that two `SyncMessagePort`s
 * use to communicate.
 */
enum BufferState {
  /**
   * The initial state. When an endpoint is ready to receive messages, it'll set
   * the buffer to this state so that it can use `Atomics.wait()` to be notified
   * when it switches to `MessageSent`.
   */
  AwaitingMessage = 0b00,
  /**
   * The state indicating that a message has been sent. Whenever an endpoint
   * sends a message, it'll set the buffer to this state so that the other
   * endpoint's `Atomics.wait()` call terminates.
   */
  MessageSent = 0b01,
  /**
   * The bitmask indicating that the channel has been closed. This is masked on
   * top of AwaitingMessage and MessageSent state. It never transitions to any
   * other states once closed.
   */
  Closed = 0b10,
}

/**
 * Options that can be passed to {@link SyncMessagePort.receiveMessage}.
 */
export interface ReceiveMessageOptions {
  /**
   * The time (in milliseconds) to wait for a message before returning {@link
   * timeoutValue} (if set) or throwing a [TimeoutException] otherwise.
   */
  timeout?: number;

  /**
   * If a message isn't received within {@link timeout} milliseconds, this value
   * is returned. Ignored if {@link timeout} is not set.
   */
  timeoutValue?: unknown;

  /**
   * If the underlying channel is closed before calling {@link
   * SyncMessagePort.receiveMessage} or while a call is pending, return this
   * value.
   */
  closedValue?: unknown;
}

/**
 * An exception thrown by {@link SyncMessagePort.receiveMessage} if a message
 * isn't received within {@link ReceivedMessageOptions.timeout} milliseconds.
 */
export class TimeoutException extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A communication port that can receive messages synchronously from another
 * `SyncMessagePort`.
 *
 * This also emits the same asynchronous events as `MessagePort`.
 */
export class SyncMessagePort extends EventEmitter {
  /** Creates a channel whose ports can be passed to `new SyncMessagePort()`. */
  static createChannel(): MessageChannel {
    const channel = new MessageChannel();
    // Four bytes is the minimum necessary to use `Atomics.wait()`.
    const buffer = new SharedArrayBuffer(4);

    // Queue up messages on each port so the caller doesn't have to explicitly
    // pass the buffer around along with them.
    channel.port1.postMessage(buffer);
    channel.port2.postMessage(buffer);
    return channel;
  }

  /**
   * An Int32 view of the shared buffer.
   *
   * Each port sets this to `BufferState.AwaitingMessage` before checking for
   * new messages in `receiveMessage()`, and each port sets it to
   * `BufferState.MessageSent` after sending a new message. It's set to
   * `BufferState.Closed` when the channel is closed.
   */
  private readonly buffer: Int32Array;

  /**
   * Creates a new message port. The `port` must be created by
   * `SyncMessagePort.createChannel()` and must connect to a port passed to
   * another `SyncMessagePort` in another worker.
   */
  constructor(private readonly port: MessagePort) {
    super();

    const buffer = receiveMessageOnPort(this.port)?.message;
    if (!buffer) {
      throw new Error(
        'new SyncMessagePort() must be passed a port from ' +
          'SyncMessagePort.createChannel().',
      );
    }
    this.buffer = new Int32Array(buffer as SharedArrayBuffer);

    this.on('newListener', (event, listener) => {
      this.port.on(event, listener);
    });
    this.on('removeListener', (event, listener) =>
      this.port.removeListener(event, listener),
    );
  }

  /** See `MessagePort.postMesage()`. */
  postMessage(value: unknown, transferList?: TransferListItem[]): void {
    this.port.postMessage(value, transferList);

    // If the other port is waiting for a new message, notify it that the
    // message is ready. Use `Atomics.compareExchange` so that we don't
    // overwrite the "closed" state.
    if (
      Atomics.compareExchange(
        this.buffer,
        0,
        BufferState.AwaitingMessage,
        BufferState.MessageSent,
      ) === BufferState.AwaitingMessage
    ) {
      Atomics.notify(this.buffer, 0);
    }
  }

  /**
   * Returns the message sent by the other port, if one is available. This *does
   * not* block, and will return `undefined` immediately if no message is
   * available. In order to distinguish between a message with value `undefined`
   * and no message, a message is return in an object with a `message` field.
   *
   * This may not be called while this has a listener for the `'message'` event.
   * It does *not* throw an error if the port is closed when this is called;
   * instead, it just returns `undefined`.
   */
  receiveMessageIfAvailable(): {message: unknown} | undefined {
    if (this.listenerCount('message')) {
      throw new Error(
        'SyncMessageChannel.receiveMessageIfAvailable() may not be called ' +
          'while there are message listeners.',
      );
    }

    return receiveMessageOnPort(this.port);
  }

  /**
   * Blocks and returns the next message sent by the other port.
   *
   * This may not be called while this has a listener for the `'message'` event.
   * Throws an error if the channel is closed, including if it closes while this
   * is waiting for a message, unless {@link ReceiveMessageOptions.closedValue}
   * is passed.
   */
  receiveMessage(options?: ReceiveMessageOptions): unknown {
    if (this.listenerCount('message')) {
      throw new Error(
        'SyncMessageChannel.receiveMessage() may not be called while there ' +
          'are message listeners.',
      );
    }

    // Set the "new message" indicator to zero before we check for new messages.
    // That way if the other port sets it to 1 between the call to
    // `receiveMessageOnPort` and the call to `Atomics.wait()`, we won't
    // overwrite it. Use `Atomics.compareExchange` so that we don't overwrite
    // the "closed" state.
    const previousState = Atomics.compareExchange(
      this.buffer,
      0,
      BufferState.MessageSent,
      BufferState.AwaitingMessage,
    );
    if (previousState === BufferState.Closed) {
      if (options && 'closedValue' in options) return options.closedValue;
      throw new Error("The SyncMessagePort's channel is closed.");
    }

    let message = receiveMessageOnPort(this.port);
    if (message) return message.message;

    // If there's no new message, wait for the other port to flip the "new
    // message" indicator to 1. If it's been set to 1 since we stored 0, this
    // will terminate immediately.
    const result = Atomics.wait(
      this.buffer,
      0,
      BufferState.AwaitingMessage,
      options?.timeout,
    );
    message = receiveMessageOnPort(this.port);
    if (message) return message.message;

    if (result === 'timed-out') {
      if ('timeoutValue' in options!) return options.timeoutValue;
      throw new TimeoutException('SyncMessagePort.receiveMessage() timed out.');
    }

    // Update the state to 0b10 after the last message is consumed.
    const oldState = Atomics.and(this.buffer, 0, BufferState.Closed);
    // Assert the old state was either 0b10 or 0b11.
    assert.equal(oldState & BufferState.Closed, BufferState.Closed);
    if (options && 'closedValue' in options) return options.closedValue;
    throw new Error("The SyncMessagePort's channel is closed.");
  }

  /** See `MessagePort.close()`. */
  close(): void {
    Atomics.or(this.buffer, 0, BufferState.Closed);
    Atomics.notify(this.buffer, 0);
    this.port.close();
  }
}
