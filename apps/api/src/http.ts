import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainError, type DomainErrorCode } from '@lab/db';
import { errorFields, type Logger } from '@lab/shared';

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  run_already_active: HttpStatus.CONFLICT,
  not_terminal: HttpStatus.CONFLICT,
  replay_in_progress: HttpStatus.CONFLICT,
  invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  payload_too_large: HttpStatus.PAYLOAD_TOO_LARGE,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { correlationId?: string }>();
    if (exception instanceof DomainError) {
      const statusCode = STATUS_BY_CODE[exception.code];
      res.status(statusCode).json({
        statusCode,
        error: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res
        .status(status)
        .json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }
    this.log.error('unhandled error', {
      correlationId: req.correlationId,
      path: req.url,
      ...errorFields(exception),
    });
    res
      .status(500)
      .json({ statusCode: 500, error: 'internal_error', message: 'Internal server error' });
  }
}

/** Assigns/propagates a correlation id and writes one structured access-log line per request. */
export function correlationMiddleware(log: Logger) {
  return (req: Request & { correlationId?: string }, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-correlation-id'];
    const id =
      typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.correlationId = id;
    res.setHeader('x-correlation-id', id);
    const started = Date.now();
    res.on('finish', () => {
      if (req.url.startsWith('/api/health')) return;
      log.info('http request', {
        correlationId: id,
        method: req.method,
        path: req.url.split('?')[0],
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });
    next();
  };
}

export type { NestMiddleware };
