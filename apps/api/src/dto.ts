import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { DELIVERY_STATES, EVENT_TYPE_LIST } from '@lab/shared';

export class CreateEventDto {
  @ApiProperty({ enum: EVENT_TYPE_LIST })
  @IsIn(EVENT_TYPE_LIST)
  type!: (typeof EVENT_TYPE_LIST)[number];

  @ApiProperty({ example: 'counter-demo' })
  @IsString()
  @Length(1, 128)
  aggregateId!: string;

  @ApiProperty({
    example: 1,
    description: 'Logical sequence of the aggregate (used by order snapshots).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sequence!: number;

  @ApiProperty({ example: { delta: 1 }, description: 'Validated against the event type schema.' })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Defaults to the singleton manual run.' })
  @IsOptional()
  @IsUUID()
  runId?: string;

  @ApiPropertyOptional({ description: 'Client supplied event id (409 if it already exists).' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Defaults to every enabled endpoint.' })
  @IsOptional()
  @IsUUID()
  endpointId?: string;
}

export class PageQueryDto {
  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class ListEventsQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  runId?: string;

  @ApiPropertyOptional({ enum: EVENT_TYPE_LIST })
  @IsOptional()
  @IsIn(EVENT_TYPE_LIST)
  type?: string;

  @ApiPropertyOptional({ description: 'Exact event id or aggregateId substring.' })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  q?: string;

  @ApiPropertyOptional({
    enum: DELIVERY_STATES,
    description: 'Events having a delivery in this state.',
  })
  @IsOptional()
  @IsIn(DELIVERY_STATES as unknown as string[])
  state?: string;

  @ApiPropertyOptional({ description: 'ISO-8601, created_at >= from' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601, created_at < to' })
  @IsOptional()
  @IsString()
  to?: string;
}

export class DeadLettersQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  runId?: string;
}

export class CreateRunDto {
  @ApiPropertyOptional({
    description: 'Seed for deterministic fault/jitter selection (default: random, recorded).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  seed?: number;

  @ApiPropertyOptional({
    description: 'Bounded overrides, see GET /api/scenarios for the allowed fields.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class ReceiverStateQueryDto {
  @ApiProperty()
  @IsUUID()
  runId!: string;
}
