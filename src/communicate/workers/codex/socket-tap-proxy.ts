import { createConnection, createServer, type Server, type Socket } from 'node:net';

export type SocketTapProxyLogger = (event: string, detail?: Record<string, unknown>) => void;

export type SocketTapProxyHandle = {
  listenPort: number;
  targetPort: number;
  close: () => Promise<void>;
};

type ProxyDirection = 'c2s' | 's2c';

type ChunkSummary = {
  bytes: number;
  asciiPreview: string;
  hexPreview: string;
};

type FrameHint = {
  frameIdHint?: string | number;
  frameIdType?: string;
  methodHint?: string;
  hasResultHint?: boolean;
  hasErrorHint?: boolean;
};

function summarizeChunk(chunk: Buffer, previewBytes: number): ChunkSummary {
  const slice = chunk.subarray(0, Math.max(1, previewBytes));
  const asciiPreview = slice
    .toString('utf8')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[^\x20-\x7E]/g, '.');
  return {
    bytes: chunk.length,
    asciiPreview,
    hexPreview: slice.toString('hex')
  };
}

function extractJsonRpcFrameHint(chunk: Buffer): FrameHint | null {
  const text = chunk.toString('utf8');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const hint: FrameHint = {};
    if (typeof parsed.id === 'string' || typeof parsed.id === 'number') {
      hint.frameIdHint = parsed.id;
      hint.frameIdType = typeof parsed.id;
    }
    if (typeof parsed.method === 'string') {
      hint.methodHint = parsed.method;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'result')) {
      hint.hasResultHint = true;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'error')) {
      hint.hasErrorHint = true;
    }
    return Object.keys(hint).length > 0 ? hint : null;
  } catch {
    return null;
  }
}

export async function startSocketTapProxy(input: {
  listenPort: number;
  targetPort: number;
  host?: string;
  previewBytes?: number;
  log: SocketTapProxyLogger;
}): Promise<SocketTapProxyHandle> {
  const host = input.host ?? '127.0.0.1';
  const previewBytes = input.previewBytes ?? 96;
  const log = input.log;
  const server = createServer();
  const openSockets = new Set<Socket>();
  let nextConnectionId = 1;

  server.on('connection', (clientSocket) => {
    const connectionId = nextConnectionId++;
    openSockets.add(clientSocket);
    const upstreamSocket = createConnection({ host, port: input.targetPort });
    openSockets.add(upstreamSocket);
    let clientToServerBytes = 0;
    let serverToClientBytes = 0;

    const logChunk = (direction: ProxyDirection, chunk: Buffer) => {
      const summary = summarizeChunk(chunk, previewBytes);
      log(direction === 'c2s' ? 'TCP_PROXY_C2S' : 'TCP_PROXY_S2C', {
        connectionId,
        ...summary
      });
      const frameHint = extractJsonRpcFrameHint(chunk);
      if (frameHint) {
        log(direction === 'c2s' ? 'TCP_PROXY_C2S_FRAME_HINT' : 'TCP_PROXY_S2C_FRAME_HINT', {
          connectionId,
          chunkBytes: chunk.length,
          ...frameHint
        });
      }
    };

    const closePeer = (socket: Socket): void => {
      if (socket.destroyed) return;
      socket.destroy();
    };

    const logClose = (side: 'client' | 'upstream', socket: Socket, hadError: boolean) => {
      log('TCP_PROXY_SOCKET_CLOSED', {
        connectionId,
        side,
        hadError,
        bytesRead: socket.bytesRead,
        bytesWritten: socket.bytesWritten,
        clientToServerBytes,
        serverToClientBytes
      });
    };

    log('TCP_PROXY_ACCEPT', {
      connectionId,
      clientAddress: clientSocket.remoteAddress ?? null,
      clientPort: clientSocket.remotePort ?? null,
      listenPort: input.listenPort,
      targetPort: input.targetPort
    });

    clientSocket.on('data', (chunk) => {
      clientToServerBytes += chunk.length;
      logChunk('c2s', chunk);
      if (!upstreamSocket.write(chunk)) {
        clientSocket.pause();
      }
    });
    upstreamSocket.on('drain', () => clientSocket.resume());

    upstreamSocket.on('data', (chunk) => {
      serverToClientBytes += chunk.length;
      logChunk('s2c', chunk);
      if (!clientSocket.write(chunk)) {
        log('TCP_PROXY_DOWNSTREAM_BACKPRESSURE', {
          connectionId,
          chunkBytes: chunk.length,
          writableLength: clientSocket.writableLength
        });
        upstreamSocket.pause();
      }
    });
    clientSocket.on('drain', () => {
      log('TCP_PROXY_DOWNSTREAM_DRAIN', {
        connectionId,
        writableLength: clientSocket.writableLength
      });
      upstreamSocket.resume();
    });

    clientSocket.on('end', () => {
      log('TCP_PROXY_SOCKET_END', { connectionId, side: 'client' });
      upstreamSocket.end();
    });
    upstreamSocket.on('end', () => {
      log('TCP_PROXY_SOCKET_END', { connectionId, side: 'upstream' });
      clientSocket.end();
    });

    clientSocket.on('error', (error) => {
      log('TCP_PROXY_SOCKET_ERROR', {
        connectionId,
        side: 'client',
        message: error.message
      });
      closePeer(upstreamSocket);
    });
    upstreamSocket.on('error', (error) => {
      log('TCP_PROXY_SOCKET_ERROR', {
        connectionId,
        side: 'upstream',
        message: error.message
      });
      closePeer(clientSocket);
    });

    clientSocket.on('close', (hadError) => {
      openSockets.delete(clientSocket);
      logClose('client', clientSocket, hadError);
      closePeer(upstreamSocket);
    });
    upstreamSocket.on('close', (hadError) => {
      openSockets.delete(upstreamSocket);
      logClose('upstream', upstreamSocket, hadError);
      closePeer(clientSocket);
    });

    upstreamSocket.on('connect', () => {
      log('TCP_PROXY_UPSTREAM_CONNECTED', {
        connectionId,
        targetPort: input.targetPort
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(input.listenPort, host);
  });

  log('TCP_PROXY_LISTENING', {
    listenPort: input.listenPort,
    targetPort: input.targetPort,
    host
  });

  return {
    listenPort: input.listenPort,
    targetPort: input.targetPort,
    async close(): Promise<void> {
      const socketClosePromises = Array.from(openSockets, (socket) => {
        if (socket.destroyed) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
        });
      });
      for (const socket of openSockets) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
      await Promise.allSettled(socketClosePromises);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      log('TCP_PROXY_CLOSED', {
        listenPort: input.listenPort,
        targetPort: input.targetPort
      });
    }
  };
}
