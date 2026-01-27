// Copyright 2021 Google LLC. Use of this source code is governed by an
// MIT-style license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import * as fs from 'fs';
import * as p from 'path';
import {MessagePort, Worker} from 'worker_threads';

import {SyncMessagePort, TimeoutException} from './index';

describe('SyncMessagePort', () => {
  describe('sends a message', () => {
    it('before the other endpoint calls receiveMessage()', () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      port1.postMessage('hi there!');

      const port2 = new SyncMessagePort(channel.port2);
      expect(port2.receiveMessage()).toEqual('hi there!');
    });

    it('after the other endpoint calls receiveMessage()', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          // Wait a little bit just to make entirely sure that the parent thread
          // is awaiting a message.
          setTimeout(() => {
            port.postMessage('done!');
            port.close();
          }, 100);
        `,
        channel.port2,
      );

      expect(port.receiveMessage()).toEqual('done!');
      expect(() => port.receiveMessage()).toThrow();
    });

    it('multiple times before the other endpoint starts reading', () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      port1.postMessage('message1');
      port1.postMessage('message2');
      port1.postMessage('message3');
      port1.postMessage('message4');

      const port2 = new SyncMessagePort(channel.port2);
      expect(port2.receiveMessage()).toEqual('message1');
      expect(port2.receiveMessage()).toEqual('message2');
      expect(port2.receiveMessage()).toEqual('message3');
      expect(port2.receiveMessage()).toEqual('message4');
    });

    it('multiple times and closes', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          port.postMessage('message1');
          port.postMessage('done!');
          port.close();
        `,
        channel.port2,
      );

      expect(port.receiveMessage()).toEqual('message1');
      expect(port.receiveMessage()).toEqual('done!');
      expect(() => port.receiveMessage()).toThrow();
    });

    it('multiple times and closes without race condition', () => {
      const iterations = 10;
      for (let i = 0; i < iterations; i++) {
        const messages = i * 1000;
        const channel = SyncMessagePort.createChannel();
        const port = new SyncMessagePort(channel.port1);

        spawnWorker(
          `
            for (let i = 0; i < ${messages}; i++) {
              port.postMessage(i);
            }
            port.close();
          `,
          channel.port2,
        );

        for (let j = 0; j < messages; j++) {
          expect(port.receiveMessage()).toEqual(j);
        }
        expect(() => port.receiveMessage()).toThrow();
        port.close();
      }
    });
  });

  describe('supports two-way blocking communications', () => {
    it('receiveMessage() on both ports', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          for (let i = 0; i < 50; i++) {
            port.postMessage(port.receiveMessage() + 1);
          }
          port.postMessage(port.receiveMessage());
          port.close();
        `,
        channel.port2,
      );
      port.postMessage(0);
      for (let i = 0; i < 50; i++) {
        port.postMessage((port.receiveMessage() as number) + 1);
      }
      expect(port.receiveMessage()).toEqual(100);
      port.close();
    });
  });

  describe('receiveMessageIfAvailable()', () => {
    it('without a queued message', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);
      expect(port.receiveMessageIfAvailable()).toBe(undefined);
      port.close();
    });

    it('with a queued message', () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const port2 = new SyncMessagePort(channel.port2);

      port1.postMessage('done!');
      expect(port2.receiveMessageIfAvailable()?.message).toBe('done!');
      port1.close();
    });

    it('on a closed channel', () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const port2 = new SyncMessagePort(channel.port2);

      port1.close();
      expect(port2.receiveMessageIfAvailable()).toBe(undefined);
    });

    it('between receiving blocking messages', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          // Wait a little bit just to make entirely sure that the parent thread
          // is awaiting a message.
          setTimeout(() => {
            port.postMessage('first');
            port.postMessage('second');

            setTimeout(() => {
              port.postMessage('third');
              port.close();
            }, 100);
          }, 100);
        `,
        channel.port2,
      );

      expect(port.receiveMessage()).toEqual('first');
      // The wWorker thread can be slow enough that the message may not be
      // immediately available.
      let message;
      do {
        message = port.receiveMessageIfAvailable();
      } while (message === undefined);
      expect(message.message).toEqual('second');
      expect(port.receiveMessage()).toEqual('third');
    });
  });

  describe('timeout', () => {
    it("returns a value if it's already available", () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const port2 = new SyncMessagePort(channel.port2);
      port1.postMessage('message');
      expect(port2.receiveMessage({timeout: 0})).toBe('message');
    });

    it('returns a value if it becomes available before the timeout', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          port.postMessage('ready');
          setTimeout(() => {
            port.postMessage('message');
            port.close();
          }, 100);
        `,
        channel.port2,
      );

      expect(port.receiveMessage()).toEqual('ready');
      expect(port.receiveMessage({timeout: 200})).toEqual('message');
    });

    it('throws an error if it times out before a value is available', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);
      expect(() => port.receiveMessage({timeout: 0})).toThrow(TimeoutException);
    });

    it('returns timeoutValue if it times out before a value is available', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);
      expect(port.receiveMessage({timeout: 0, timeoutValue: 'timed out'})).toBe(
        'timed out',
      );
    });

    it('throws an error if the channel closes before the request times out', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          port.postMessage('ready');
          setTimeout(() => {
            port.close();
          }, 100);
        `,
        channel.port2,
      );

      expect(port.receiveMessage()).toEqual('ready');
      // timeoutValue shouldn't take precedence over this error
      expect(() =>
        port.receiveMessage({timeout: 10000, timeoutValue: 'timed out'}),
      ).toThrow();
    });
  });

  describe('with an asynchronous listener', () => {
    it('receives a message sent before listening', async () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      port1.postMessage('hi there!');

      const port2 = new SyncMessagePort(channel.port2);

      // Wait a macrotask to make sure the message is as queued up as it's going
      // to be.
      await new Promise(process.nextTick);

      const promise = new Promise(resolve => port2.once('message', resolve));
      await expect(promise).resolves.toEqual('hi there!');
      port1.close();
    });

    it('receives a message sent after listening', async () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const promise = new Promise(resolve => port1.once('message', resolve));

      // Wait a macrotask to make sure the message is as queued up as it's going
      // to be.
      await new Promise(process.nextTick);
      const port2 = new SyncMessagePort(channel.port2);
      port2.postMessage('hi there!');

      await expect(promise).resolves.toEqual('hi there!');
      port1.close();
    });

    it('receiveMessage() receives a message after listening', () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      spawnWorker(
        `
          setTimeout(() => {
            port.postMessage('hi there!');
          }, 100);
        `,
        channel.port2,
      );
      port1.on('message', () => {});
      expect(port1.receiveMessage()).toEqual('hi there!');
      port1.close();
    });

    it('receives a message after listening after receiveMessage()', async () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const promise = new Promise(resolve => port1.once('message', resolve));

      spawnWorker(
        `
          setTimeout(() => {
            port.postMessage('first');
            port.postMessage('second');
            port.close()
          }, 100);
        `,
        channel.port2,
      );
      expect(port1.receiveMessage()).toEqual('first');
      await expect(promise).resolves.toEqual('second');
      expect(() => port1.receiveMessage()).toThrow();
      port1.close();
    });
  });

  describe('close()', () => {
    it('closing one port closes the other', async () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const port2 = new SyncMessagePort(channel.port2);

      port1.close();

      // Should resolve.
      await new Promise(resolve => port2.once('close', resolve));
    });

    it("receiveMessage() throws an error for a port that's already closed", () => {
      const channel = SyncMessagePort.createChannel();
      const port1 = new SyncMessagePort(channel.port1);
      const port2 = new SyncMessagePort(channel.port2);

      port1.close();
      expect(() => port1.receiveMessage()).toThrow();
      expect(() => port2.receiveMessage()).toThrow();
    });

    it('receiveMessage() throws an error when a port closes', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          setTimeout(() => {
            port.close();
          }, 100);
        `,
        channel.port2,
      );

      expect(() => port.receiveMessage()).toThrow();
    });

    it(
      "receiveMessage() returns option.closedValue for a port that's " +
        'already closed',
      () => {
        const channel = SyncMessagePort.createChannel();
        const port1 = new SyncMessagePort(channel.port1);
        const port2 = new SyncMessagePort(channel.port2);

        port1.close();
        expect(port1.receiveMessage({closedValue: 'closed'})).toBe('closed');
        expect(port2.receiveMessage({closedValue: 'closed'})).toBe('closed');
      },
    );

    it('receiveMessage() throws an error when a port closes', () => {
      const channel = SyncMessagePort.createChannel();
      const port = new SyncMessagePort(channel.port1);

      spawnWorker(
        `
          setTimeout(() => {
            port.close();
          }, 100);
        `,
        channel.port2,
      );

      expect(port.receiveMessage({closedValue: 'closed'})).toBe('closed');
    });
  });
});

/**
 * Spawns a worker that executes the given TypeScript `source`.
 *
 * Automatically initializes a `SyncMessageChannel` named `port` connected to
 * `port`.
 */
function spawnWorker(source: string, port: MessagePort): Worker {
  fs.mkdirSync('spec/sandbox', {recursive: true});
  const file = p.join('spec/sandbox', `${Math.random()}.ts`.slice(2));
  fs.writeFileSync(
    file,
    `
      const {SyncMessagePort} = require(${JSON.stringify(
        p.join(p.dirname(__filename), 'index'),
      )});
      const {workerData} = require('worker_threads');

      const port = new SyncMessagePort(workerData);

      ${source}
    `,
  );

  const worker = new Worker(
    `
      require('ts-node').register();
      require(${JSON.stringify(p.resolve(file.substring(0, file.length - 3)))});
    `,
    {eval: true, workerData: port, transferList: [port]},
  );

  worker.on('error', error => {
    throw error;
  });
  worker.on('exit', () => fs.unlinkSync(file));

  return worker;
}
