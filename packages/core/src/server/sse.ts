import type { FastifyRequest } from 'fastify';
import type { FastifyReply } from 'fastify';
import type { EventEmitter } from 'node:events';
import type { SessionEvent } from './session-manager.js';

/**
 * Allowed origins for SSE. Only localhost origins are permitted since the
 * API server binds to 127.0.0.1. This replaces the previous wildcard CORS
 * policy (CWE-942 mitigation).
 */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost',
  'http://127.0.0.1',
]);

/** Validate and return the origin to use for SSE CORS headers. */
export function resolveSseOrigin(req: FastifyRequest): string | undefined {
  const rawOrigin = req.headers['origin'];
  if (typeof rawOrigin !== 'string') return undefined;
  // Security: only allow explicitly allowlisted localhost origins.
  // Reject any externally-set Origin to prevent cross-origin SSE hijacking.
  if (ALLOWED_ORIGINS.has(rawOrigin)) return rawOrigin;
  return undefined;
}

/**
 * Pipe a session's `emitter` (event-named "event", payload SessionEvent) to
 * a Fastify reply as a Server-Sent Events stream. Heartbeat every 30 s keeps
 * intermediate proxies from idling out.
 *
 * CORS is set dynamically based on the request's Origin header — only
 * allowlisted localhost origins are permitted.
 */
export function streamSseFromEmitter(
  reply: FastifyReply,
  emitter: EventEmitter,
  allowedOrigin?: string,
): void {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Vary'] = 'Origin';
  }
  reply.raw.writeHead(200, headers);
  // Disable Nagle so each SSE frame is flushed to the wire immediately
  // — without this, token-level deltas can sit in the kernel buffer.
  const sock = reply.raw.socket;
  if (sock && 'setNoDelay' in sock) {
    sock.setNoDelay(true);
  }

  const handler = (event: SessionEvent) => {
    reply.raw.write(`event: ${event.kind}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  emitter.on('event', handler);

  reply.raw.write('event: ready\ndata: {}\n\n');

  const heartbeat = setInterval(() => {
    reply.raw.write(': heartbeat\n\n');
  }, 30_000);

  reply.raw.on('close', () => {
    clearInterval(heartbeat);
    emitter.off('event', handler);
  });
}
