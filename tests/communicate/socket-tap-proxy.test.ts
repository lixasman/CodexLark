import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer, Socket } from 'node:net';
import { startSocketTapProxy } from '../../src/communicate/workers/codex/socket-tap-proxy';

async function allocatePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForSocketData(socket: Socket): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for socket data.'));
    }, 2_000);
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

test('socket tap proxy logs and forwards bytes in both directions', async () => {
  const upstreamPort = await allocatePort();
  const proxyPort = await allocatePort();
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  let upstreamReceived = '';

  const upstreamServer = createServer((socket) => {
    socket.on('data', (chunk) => {
      upstreamReceived += chunk.toString('utf8');
      socket.write('WORLD');
    });
  });

  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(upstreamPort, '127.0.0.1', () => resolve());
  });

  const proxy = await startSocketTapProxy({
    listenPort: proxyPort,
    targetPort: upstreamPort,
    log: (event, detail) => {
      events.push({ event, detail });
    }
  });

  const client = createConnection({ host: '127.0.0.1', port: proxyPort });

  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    client.write('HELLO');
    const response = await waitForSocketData(client);

    assert.equal(response.toString('utf8'), 'WORLD');
    assert.equal(upstreamReceived, 'HELLO');
    assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_LISTENING'));
    assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_ACCEPT'));
    assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_UPSTREAM_CONNECTED'));
    assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_C2S' && entry.detail?.asciiPreview === 'HELLO'));
    assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_S2C' && entry.detail?.asciiPreview === 'WORLD'));
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test('socket tap proxy logs downstream backpressure and drain events', async () => {
  const upstreamPort = await allocatePort();
  const proxyPort = await allocatePort();
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const originalWrite = Socket.prototype.write;
  let simulatedBackpressure = false;

  const upstreamServer = createServer((socket) => {
    socket.on('data', () => {
      socket.write('WORLD');
    });
  });

  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(upstreamPort, '127.0.0.1', () => resolve());
  });

  const proxy = await startSocketTapProxy({
    listenPort: proxyPort,
    targetPort: upstreamPort,
    log: (event, detail) => {
      events.push({ event, detail });
    }
  });

  const client = createConnection({ host: '127.0.0.1', port: proxyPort });

  try {
    Socket.prototype.write = function (
      this: Socket,
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void
    ): boolean {
      const result = originalWrite.call(this, chunk as any, encoding as any, cb as any);
      if (!simulatedBackpressure && this.localPort === proxyPort && typeof this.remotePort === 'number') {
        simulatedBackpressure = true;
        queueMicrotask(() => this.emit('drain'));
        return false;
      }
      return result;
    };

    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    client.write('TRIGGER');
    const response = await waitForSocketData(client);
    assert.equal(response.toString('utf8'), 'WORLD');
  } finally {
    Socket.prototype.write = originalWrite;
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }

  assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_DOWNSTREAM_BACKPRESSURE'));
  assert.ok(events.some((entry) => entry.event === 'TCP_PROXY_DOWNSTREAM_DRAIN'));
});

test('socket tap proxy emits frame hints for json-rpc-like traffic', async () => {
  const upstreamPort = await allocatePort();
  const proxyPort = await allocatePort();
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];

  const upstreamServer = createServer((socket) => {
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('"method":"thread/read"')) {
        socket.write('{"jsonrpc":"2.0","id":19,"result":{"thread":{"id":"thread-1"}}}');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(upstreamPort, '127.0.0.1', () => resolve());
  });

  const proxy = await startSocketTapProxy({
    listenPort: proxyPort,
    targetPort: upstreamPort,
    log: (event, detail) => {
      events.push({ event, detail });
    }
  });

  const client = createConnection({ host: '127.0.0.1', port: proxyPort });

  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    client.write('{"jsonrpc":"2.0","id":7,"method":"thread/read","params":{"threadId":"thread-1"}}');
    const response = await waitForSocketData(client);
    assert.match(response.toString('utf8'), /"id":19/);
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }

  assert.ok(
    events.some(
      (entry) =>
        entry.event === 'TCP_PROXY_C2S_FRAME_HINT' &&
        entry.detail?.frameIdHint === 7 &&
        entry.detail?.methodHint === 'thread/read'
    )
  );
  assert.ok(
    events.some(
      (entry) =>
        entry.event === 'TCP_PROXY_S2C_FRAME_HINT' &&
        entry.detail?.frameIdHint === 19 &&
        entry.detail?.hasResultHint === true
    )
  );
});
