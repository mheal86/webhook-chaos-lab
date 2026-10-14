import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppConfig } from '@lab/shared';
import { ReceiverService } from './receiver.service';
import { APP_CONFIG } from './tokens';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Controller()
export class ReceiverController {
  constructor(
    private readonly service: ReceiverService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The webhook endpoint. The body is a raw Buffer (see main.ts) so the HMAC covers the exact bytes. */
  @Post('webhooks/:consumerId')
  @HttpCode(200)
  async webhook(
    @Param('consumerId') consumerId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await this.service.handleWebhook({ consumerId, headers: req.headers, rawBody });
    if (out.delayMs) await sleep(out.delayMs);
    if (res.writableEnded || res.destroyed) return;
    if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.status(out.status).json(out.body);
  }

  /** Internal fixture diagnostics; guarded by a control token and bound to localhost by default. */
  @Get('internal/diagnostics')
  async diagnostics(
    @Headers('x-lab-control-token') token: string | undefined,
    @Query('runId') runId?: string,
  ) {
    const expected = Buffer.from(this.config.LAB_CONTROL_TOKEN);
    const given = Buffer.from(token ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException();
    }
    return this.service.diagnostics(runId);
  }

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready() {
    try {
      await this.service.ping();
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', db: 'down' });
    }
    return { status: 'ok', db: 'up' };
  }
}
