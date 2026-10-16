import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';
import { DbService } from '../db/db.service';
import { idempotencyKeys } from '../db/schema';
import { AppRequest, IDEMPOTENT, NO_TRANSACTION } from './context';
import { stableStringify, sha256Hex } from './crypto';
import { AppError, badRequest, conflict } from './errors';

/**
 * Unit of Work: each request runs in ONE database transaction with transaction-local tenant
 * context. Business changes, ledger postings and audit entries commit or roll back together.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly dbs: DbService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const noTx = this.reflector.getAllAndOverride<boolean>(NO_TRANSACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (noTx) return next.handle();
    const req = context.switchToHttp().getRequest<AppRequest>();
    const tenantId = req.auth?.tenant?.id ?? null;
    const userId = req.auth?.userId ?? null;
    return from(
      this.dbs.runInTenant({ tenantId, userId }, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Idempotency for financial mutations. Runs INSIDE the request transaction: the key row is
 * inserted first, so a concurrent duplicate blocks on the unique key until the first request
 * commits, then replays its stored response. If the first request fails, its key row rolls back
 * and the client may retry with the same key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly dbs: DbService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!enabled) return next.handle();
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const raw = req.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !KEY_RE.test(key)) {
      throw badRequest(
        'idempotency_key_required',
        'An Idempotency-Key header (8-128 safe characters) is required',
      );
    }
    const tenantId = req.auth?.tenant?.id;
    const userId = req.auth?.userId;
    if (!tenantId || !userId) throw new AppError('no_active_tenant', 403, 'Select a company to continue');
    const path = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : req.path;
    const requestHash = sha256Hex(
      `${req.method} ${req.originalUrl.split('?')[0]} ${stableStringify(req.body ?? null)}`,
    );

    const db = this.dbs.db;
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ tenantId, key, userId, method: req.method, path, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [existing] = await db
        .select()
        .from(idempotencyKeys)
        .where(sql`${idempotencyKeys.tenantId} = ${tenantId} AND ${idempotencyKeys.key} = ${key}`);
      if (!existing) throw conflict('idempotency_retry', 'Please retry the request');
      if (existing.requestHash !== requestHash || existing.userId !== userId) {
        throw new AppError(
          'idempotency_key_reused',
          422,
          'This Idempotency-Key was already used for a different request',
        );
      }
      if (existing.responseStatus === null)
        throw conflict('idempotency_in_progress', 'The original request is still being processed');
      res.status(existing.responseStatus);
      res.setHeader('Idempotent-Replayed', 'true');
      return existing.responseBody;
    }

    const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
    const status =
      res.statusCode && res.statusCode !== 200 ? res.statusCode : req.method === 'POST' ? 201 : 200;
    await db
      .update(idempotencyKeys)
      .set({ responseStatus: status, responseBody: (result ?? null) as object })
      .where(sql`${idempotencyKeys.tenantId} = ${tenantId} AND ${idempotencyKeys.key} = ${key}`);
    return result;
  }
}
