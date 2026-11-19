import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateBearer, isPrivateLanAddress } from './middleware.js';

export interface EventsChannel {
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  emit: (type: string, data: Record<string, unknown>) => void;
  close: () => void;
}

/**
 * /api/v1/events WS 事件通道骨架（API §9）：
 * - 握手鉴权 header-only（P7 冻结：ArkWS 支持自定义 Bearer header，query 兼容层不做）；
 * - 事件形状 { eventId, type, serverTime, data }；消息可丢——事件是即时通知，REST 是断线恢复来源，
 *   发送失败不缓冲、不重试。
 */
export function createEventsChannel(verifyToken: (token: string) => Promise<boolean>): EventsChannel {
  const server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const sockets = new Set<WebSocket>();

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/api/v1/events') {
      socket.destroy();
      return;
    }
    if (!isPrivateLanAddress(request.socket.remoteAddress ?? '')) {
      socket.destroy();
      return;
    }
    void (async () => {
      try {
        await authenticateBearer(request, url.pathname, { verifyToken });
      } catch {
        socket.destroy();
        return;
      }
      server.handleUpgrade(request, socket, head, (ws) => {
        sockets.add(ws);
        ws.on('close', () => sockets.delete(ws));
        ws.on('error', () => ws.terminate());
      });
    })();
  }

  function emit(type: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify({ eventId: `evt_${randomUUID()}`, type, serverTime: new Date().toISOString(), data });
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      socket.send(payload, () => undefined);
    }
  }

  function close(): void {
    for (const socket of sockets) socket.close();
    server.close();
  }

  return { handleUpgrade, emit, close };
}
