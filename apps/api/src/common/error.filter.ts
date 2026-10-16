import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { getEnv } from '../config/env';
import { AppError, UNIQUE_CONSTRAINT_MESSAGES } from './errors';

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}

function unwrapPg(err: unknown): PgLikeError | null {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { code?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return cur as PgLikeError;
    cur = c.cause;
  }
  return null;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function toErrorResponse(err: unknown): { status: number; body: ErrorBody; log: boolean } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details } },
      log: false,
    };
  }
  if (err instanceof ZodValidationException) {
    const zerr = err.getZodError() as {
      issues?: Array<{ path: PropertyKey[]; message: string; code: string }>;
    };
    const issues = (zerr.issues ?? []).map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
      code: i.code,
    }));
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      body: { error: { code: 'validation_failed', message: 'Some fields are invalid', details: { issues } } },
      log: false,
    };
  }
  if (err instanceof ThrottlerException) {
    return {
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Too many requests, please slow down' } },
      log: false,
    };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const codeByStatus: Record<number, string> = {
      400: 'bad_request',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not_found',
      405: 'method_not_allowed',
      413: 'payload_too_large',
      415: 'unsupported_media_type',
    };
    const msg = status === 404 ? 'Resource not found' : err.message;
    return {
      status,
      body: { error: { code: codeByStatus[status] ?? 'http_error', message: msg } },
      log: status >= 500,
    };
  }
  const pg = unwrapPg(err);
  if (pg?.code) {
    switch (pg.code) {
      case '23505': {
        const mapped = pg.constraint ? UNIQUE_CONSTRAINT_MESSAGES[pg.constraint] : undefined;
        return {
          status: HttpStatus.CONFLICT,
          body: {
            error: {
              code: mapped?.code ?? 'duplicate',
              message: mapped?.message ?? 'This record already exists',
            },
          },
          log: !mapped,
        };
      }
      case '23P01': {
        // Exclusion constraint (e.g. overlapping test drives): mapped by constraint name like unique violations.
        const mapped = pg.constraint ? UNIQUE_CONSTRAINT_MESSAGES[pg.constraint] : undefined;
        return {
          status: HttpStatus.CONFLICT,
          body: { error: { code: mapped?.code ?? 'conflict', message: mapped?.message ?? 'This conflicts with an existing record' } },
          log: !mapped,
        };
      }
      case '23503':
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: {
            error: {
              code: 'invalid_reference',
              message: 'A referenced record does not exist or is still in use',
            },
          },
          log: false,
        };
      case '23514':
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: {
            error: {
              code: 'constraint_violation',
              message: 'The data violates a business rule',
              details: { constraint: pg.constraint },
            },
          },
          log: true,
        };
      case '40001':
      case '40P01':
      case '55P03':
        return {
          status: HttpStatus.CONFLICT,
          body: {
            error: {
              code: 'concurrent_update',
              message: 'The record was changed by another user. Please retry.',
            },
          },
          log: true,
        };
      case '42501':
        return {
          status: HttpStatus.FORBIDDEN,
          body: { error: { code: 'forbidden', message: 'Access denied' } },
          log: true,
        };
      case '22P02':
        return {
          status: HttpStatus.BAD_REQUEST,
          body: { error: { code: 'bad_request', message: 'Malformed identifier or value' } },
          log: false,
        };
      case 'AH001':
        return {
          status: HttpStatus.CONFLICT,
          body: { error: { code: 'immutable_record', message: 'Posted records cannot be modified' } },
          log: true,
        };
      case 'AH002':
        return {
          status: 500,
          body: {
            error: { code: 'ledger_unbalanced', message: 'Financial posting failed integrity checks' },
          },
          log: true,
        };
      case '57014':
        return {
          status: 503,
          body: { error: { code: 'timeout', message: 'The operation took too long' } },
          log: true,
        };
    }
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Unexpected server error' } },
    log: true,
  };
}

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const { status, body, log } = toErrorResponse(exception);
    body.error.requestId = req?.id ? String(req.id) : undefined;
    if (log || process.env.DEBUG_ERRORS) {
      if (process.env.DEBUG_ERRORS) console.error(exception);
      const e = exception as Error;
      this.logger.error(
        {
          err: { message: e?.message, stack: getEnv().NODE_ENV === 'production' ? undefined : e?.stack },
          requestId: req?.id,
        },
        'request failed',
      );
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }
}
