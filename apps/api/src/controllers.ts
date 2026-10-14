import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Db } from '@lab/db';
import { DEFAULT_RUN_CONFIG, SCENARIO_CATALOG } from '@lab/shared';
import { CommandsService } from './commands.service';
import {
  CreateEventDto,
  CreateRunDto,
  DeadLettersQueryDto,
  ListEventsQueryDto,
  ReceiverStateQueryDto,
} from './dto';
import { QueueService } from './queue.service';
import { ReadModelsService } from './read-models.service';
import { DB } from './tokens';

@ApiTags('endpoints')
@Controller('endpoints')
export class EndpointsController {
  constructor(private readonly reads: ReadModelsService) {}

  @Get()
  @ApiOperation({ summary: 'Configured receiver endpoints (read-only; URLs are server-side allowlisted)' })
  list() {
    return this.reads.endpoints();
  }
}

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly commands: CommandsService,
    private readonly reads: ReadModelsService,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Committed to PostgreSQL; delivery happens asynchronously.' })
  async create(@Body() dto: CreateEventDto, @Req() req: Request) {
    const accepted = await this.commands.createEvent(dto, (req as Request & { correlationId?: string }).correlationId ?? null);
    return {
      eventId: accepted.eventId,
      runId: accepted.runId,
      deliveryIds: accepted.deliveryIds,
      payloadHash: accepted.payloadHash,
    };
  }

  @Get()
  list(@Query() q: ListEventsQueryDto) {
    return this.reads.listEvents({ ...q, limit: q.limit ?? 25, offset: q.offset ?? 0 });
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.reads.eventDetail(id);
  }
}

@ApiTags('deliveries')
@Controller()
export class DeliveriesController {
  constructor(
    private readonly commands: CommandsService,
    private readonly reads: ReadModelsService,
  ) {}

  @Get('deliveries/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reads.delivery(id);
  }

  @Get('deliveries/:id/attempts')
  attempts(@Param('id', ParseUUIDPipe) id: string) {
    return this.reads.attempts(id);
  }

  @Post('deliveries/:id/replay')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Replay a terminal delivery: same eventId and raw payload, new deliveryId, fresh attempt budget.',
  })
  replay(@Param('id', ParseUUIDPipe) id: string) {
    return this.commands.replay(id);
  }

  @Get('dead-letters')
  deadLetters(@Query() q: DeadLettersQueryDto) {
    return this.reads.deadLetters({ runId: q.runId, limit: q.limit ?? 25, offset: q.offset ?? 0 });
  }
}

@ApiTags('scenarios')
@Controller()
export class ScenariosController {
  constructor(
    private readonly commands: CommandsService,
    private readonly reads: ReadModelsService,
  ) {}

  @Get('scenarios')
  scenarios() {
    return { defaultConfig: DEFAULT_RUN_CONFIG, scenarios: SCENARIO_CATALOG };
  }

  @Post('scenarios/:type/runs')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Run created; 409 when another run is still active.' })
  createRun(@Param('type') type: string, @Body() dto: CreateRunDto) {
    return this.commands.createRun(type, dto);
  }

  @Get('runs')
  runs() {
    return this.reads.listRuns();
  }

  @Get('runs/:id')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.reads.run(id);
  }

  @Get('runs/:id/metrics')
  @ApiOkResponse({ description: 'Metric definitions are documented in docs/architecture.md' })
  metrics(@Param('id', ParseUUIDPipe) id: string) {
    return this.reads.metrics(id);
  }

  @Get('receiver/state')
  receiverState(@Query() q: ReceiverStateQueryDto) {
    return this.reads.receiverState(q.runId);
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks = { postgres: false, redis: false };
    try {
      await this.db.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      /* reported below */
    }
    checks.redis = await this.queue.ping();
    // Events are accepted into PostgreSQL even while Redis is down, so only PostgreSQL gates readiness;
    // the Redis state is reported for visibility.
    if (!checks.postgres) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: checks.redis ? 'ok' : 'degraded', checks };
  }
}
