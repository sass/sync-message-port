// Copyright 2021 Google LLC. Use of this source code is governed by an
// MIT-style license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import {EventEmitter} from 'events';
import {
  MessageChannel,
  MessagePort,
  Transferable,
  receiveMessageOnPort,
} from 'worker_threads';
import {AtomicCounter} from './atomic_counter';

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
 * This also emits the same asynchronous events as `MessagePort`. Messages are
 * preferentially sent to {@link receiveMessage} if a call to it is outstanding,
 * and only sent to the event handler if they weren't received synchronously.
 */
export class SyncMessagePort extends EventEmitter {
  /** Creates a channel whose ports can be passed to `new SyncMessagePort()`. */
  static createChannel(): MessageChannel {
    const channel = new MessageChannel();
    // 16 bytes is required for `AtomicCounter`.
    const buffer1 = new SharedArrayBuffer(16);
    const buffer2 = new SharedArrayBuffer(16);

    // Queue up messages on each port so the caller doesn't have to explicitly
    // pass the buffer around along with them.
    channel.port1.postMessage(buffer1);
    channel.port1.postMessage(buffer2);
    channel.port2.postMessage(buffer2);
    channel.port2.postMessage(buffer1);
    return channel;
  }

  /**
   * An atomic counter of messages posted yet to be received.
   */
  private readonly postCounter: AtomicCounter;

  /**
   * An atomic counter of messages available to be received.
   */
  private readonly receiveCounter: AtomicCounter;

  /**
   * Creates a new message port. The `port` must be created by
   * `SyncMessagePort.createChannel()` and must connect to a port passed to
   * another `SyncMessagePort` in another worker.
   */
  constructor(private readonly port: MessagePort) {
    super();

    const buffer1 = receiveMessageOnPort(this.port)?.message;
    const buffer2 = receiveMessageOnPort(this.port)?.message;
    if (!buffer1 || !buffer2) {
      throw new Error(
        'new SyncMessagePort() must be passed a port from ' +
          'SyncMessagePort.createChannel().',
      );
    }
    this.postCounter = new AtomicCounter(buffer1 as SharedArrayBuffer);
    this.receiveCounter = new AtomicCounter(buffer2 as SharedArrayBuffer);

    const messageHandler = (): void => {
      this.receiveCounter.wait();
      this.receiveCounter.decrement();
    };
    this.port.on('messageerror', (error: Error): void => {
      messageHandler();
      if (!this.listenerCount('messageerror')) {
        throw error;
      }
    });
    this.on('newListener', (event, listener) => {
      if (event === 'message' && !this.listenerCount(event)) {
        this.port.on(event, messageHandler);
      }
      this.port.on(event, listener);
    });
    this.on('removeListener', (event, listener) => {
      this.port.removeListener(event, listener);
      if (event === 'message' && !this.listenerCount(event)) {
        this.port.removeListener(event, messageHandler);
      }
    });
  }

  /** See `MessagePort.postMesage()`. */
  postMessage(value: unknown, transferList?: Transferable[]): void {
    // @ts-expect-error: TypeScript gets confused with the overloads.
    this.port.postMessage(value, transferList);
    this.postCounter.increment();
  }

  /**
   * Returns the message sent by the other port, if one is available. This *does
   * not* block, and will return `undefined` immediately if no message is
   * available. In order to distinguish between a message with value `undefined`
   * and no message, a message is return in an object with a `message` field.
   *
   * It does *not* throw an error if the port is closed when this is called;
   * instead, it just returns `undefined`.
   */
  receiveMessageIfAvailable(): {message: unknown} | undefined {
    const message = receiveMessageOnPort(this.port);
    if (message) {
      this.receiveCounter.wait();
      this.receiveCounter.decrement();
    }
    return message;
  }

  /**
   * Blocks and returns the next message sent by the other port.
   *
   * Throws an error if the channel is closed and all messages are drained,
   * including if it closes while this is waiting for a message, unless
   * {@link ReceiveMessageOptions.closedValue} is passed.
   */
  receiveMessage(options?: ReceiveMessageOptions): unknown {
    if (!this.receiveCounter.wait(options?.timeout)) {
      if ('timeoutValue' in options!) return options.timeoutValue;
      throw new TimeoutException('SyncMessagePort.receiveMessage() timed out.');
    }

    const message = receiveMessageOnPort(this.port);
    if (message) {
      this.receiveCounter.decrement();
      return message.message;
    }

    // The port is closed and all remaining messages are drained.
    if (options && 'closedValue' in options) return options.closedValue;
    throw new Error("The SyncMessagePort's channel is closed.");
  }

  /** See `MessagePort.close()`. */
  close(): void {
    this.port.close();
    this.postCounter.close();
    this.receiveCounter.close();
  }
}
