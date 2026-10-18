import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { Notification } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

export class AdminNotificationsQueryDto {
  @IsOptional() @IsUUID() idUser?: string;
  @IsOptional() @IsIn(['pending', 'sent', 'failed']) status?: string;
  @IsOptional() @IsIn(['in_app', 'email', 'whatsapp']) channel?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class AdminAuditQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** Panel administrativo de Notification Service: envíos, reintentos y DLQ. */
@Controller('notifications/admin')
@UseGuards(StaffAuthGuard)
export class AdminNotificationsController {
  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
    private readonly notifications: NotificationsService,
    private readonly consumer: EventConsumerService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get('notifications')
  async list(@Query() q: AdminNotificationsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const [rows, total] = await this.repo.findAndCount({
      where: {
        ...(q.idUser ? { idUser: q.idUser } : {}),
        ...(q.status ? { status: q.status as Notification['status'] } : {}),
        ...(q.channel ? { channel: q.channel as Notification['channel'] } : {}),
      },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    // Sin el cuerpo completo ni metadata: el panel no necesita el contenido de los correos.
    const items = rows.map(({ body: _b, metadata: _m, dedupeKey: _d, ...rest }) => rest);
    return { items, total, page, limit };
  }

  @Get('summary')
  async summary() {
    const rows = await this.repo
      .createQueryBuilder('n')
      .select('n.channel', 'channel')
      .addSelect('n.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .where(`n.createdAt > now() - interval '7 days'`)
      .groupBy('n.channel')
      .addGroupBy('n.status')
      .getRawMany();
    return { since: new Date(Date.now() - 7 * 86400_000).toISOString(), byChannelAndStatus: rows };
  }

  @Post('notifications/:id/retry')
  @StaffRoles('support', 'admin')
  @HttpCode(200)
  async retry(@Param('id') id: string, @Req() req: any) {
    const row = await this.notifications.retryNow(id);
    await this.audit.record(req.staff, {
      action: 'notification.retry',
      targetType: 'notification',
      targetId: id,
      details: { status: row.status },
    });
    const { body: _b, metadata: _m, dedupeKey: _d, ...rest } = row;
    return rest;
  }

  @Get('dlq')
  dlq() {
    return this.consumer.deadLetterStats();
  }

  @Get('dlq/messages')
  async dlqMessages() {
    try {
      return await this.consumer.peekDeadLetters(20);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }

  @Post('dlq/requeue')
  @HttpCode(200)
  @StaffRoles('admin')
  async requeue(@Req() req: any) {
    try {
      const result = await this.consumer.requeueDeadLetters(100);
      await this.audit.record(req.staff, {
        action: 'dlq.requeue',
        targetType: 'queue',
        targetId: 'notification-service',
        details: result,
      });
      return result;
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }

  @Get('audit')
  auditLog(@Query() q: AdminAuditQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }
}
