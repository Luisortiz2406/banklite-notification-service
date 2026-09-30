import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CHANNEL_POLICY, defaultRules } from './channel-policy';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { Notification } from './entities/notification.entity';
import { MailerService } from './mailer.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationsService');

  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Punto de entrada único, ya sea que el evento llegue por RabbitMQ
   * (event-consumer.service.ts) o por POST /notifications (uso interno,
   * para servicios que todavía no publican el evento en el exchange).
   */
  async handleEvent(
    idUser: string,
    event: string,
    payload: Record<string, unknown>,
    occurredAt: string = new Date().toISOString(),
  ): Promise<Notification[]> {
    const rules = CHANNEL_POLICY[event] ?? defaultRules(event);
    const created: Notification[] = [];

    for (const rule of rules) {
      if (rule.when && !rule.when(payload)) continue;

      const dedupeKey = `${idUser}:${event}:${rule.channel}:${occurredAt}`;
      const existing = await this.repo.findOne({ where: { dedupeKey } });
      if (existing) {
        created.push(existing);
        continue;
      }

      const { title, body } = rule.build(payload);
      let row = this.repo.create({
        idUser,
        event,
        channel: rule.channel,
        title,
        body,
        status: rule.channel === 'in_app' ? 'sent' : 'pending',
        read: false,
        metadata: payload,
        dedupeKey,
      });

      try {
        row = await this.repo.save(row);
      } catch (error) {
        // Unique violation por reentrega del mismo mensaje de RabbitMQ: ignorar.
        if ((error as any)?.code === '23505') continue;
        throw error;
      }

      if (rule.channel === 'email') {
        row = await this.deliverEmail(row, payload);
      } else if (rule.channel === 'whatsapp') {
        row = await this.deliverWhatsapp(row);
      }

      created.push(row);
    }

    return created;
  }

  private async deliverEmail(row: Notification, payload: Record<string, unknown>) {
    const to = (payload.email as string | undefined) ?? (payload.notifyEmail as string | undefined);
    if (!to) {
      this.logger.warn(
        `Evento '${row.event}' mapeado a canal email pero el payload no trae 'email'. Se deja pending.`,
      );
      return row;
    }
    const sent = await this.mailer.send(to, row.title, row.body);
    row.status = sent ? 'sent' : 'failed';
    return this.repo.save(row);
  }

  private async deliverWhatsapp(row: Notification) {
    // Mensajes libres de WhatsApp requieren plantilla aprobada por Meta
    // Los mensajes libres de WhatsApp requieren plantilla aprobada por Meta.
    // degradado, igual que RabbitMQ cuando no está disponible.
    this.logger.warn(`[degradado] canal whatsapp no implementado aún, notificación ${row.id} queda pending.`);
    return row;
  }

  /** GET /notifications/:idUser */
  async findForUser(
    idUser: string,
    requesterId: string,
    channel?: string,
    unreadOnly?: boolean,
  ) {
    if (requesterId !== idUser) {
      throw new ForbiddenException('No puedes consultar las notificaciones de otro usuario');
    }
    return this.repo.find({
      where: {
        idUser,
        ...(channel ? { channel: channel as Notification['channel'] } : {}),
        ...(unreadOnly ? { read: false } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /** PUT /notifications/:id/read */
  async markRead(id: string, requesterId: string) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Notificación no encontrada');
    if (row.idUser !== requesterId) {
      throw new ForbiddenException('No puedes modificar notificaciones de otro usuario');
    }
    row.read = true;
    return this.repo.save(row);
  }

  /** Atajo usado por POST /notifications (DTO -> handleEvent). */
  async createFromDto(dto: CreateNotificationDto) {
    return this.handleEvent(dto.idUser, dto.event, dto.payload ?? {});
  }
}
