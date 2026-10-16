import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestInfo {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestInfo>();

export function currentRequestInfo(): RequestInfo | undefined {
  return storage.getStore();
}

/** Express middleware: makes request metadata available to deeper layers (audit, logging). */
export function requestInfoMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader('X-Request-Id', id);
  storage.run(
    {
      requestId: id,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
    },
    () => next(),
  );
}
