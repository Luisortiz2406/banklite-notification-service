import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CHANNEL_POLICY, defaultRules } from './channel-policy';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { Notification } from './entities/notification.entity';
import { UserContact } from './entities/user-contact.entity';
import { MailerService } from './mailer.service';

// Eventos cuyo payload trae el contacto del usuario; sirven para reconstruir la
// proyección de usuarios registrados antes de que existiera user_contacts.
const CONTACT_EVENTS = ['account.created', 'identity.email_confirmed', 'intento_fallido_login'];

// Espera antes de cada reintento de un correo fallido: 1 min, 5 min, 15 min y 1 h.
// Tras el último, la notificación queda 'failed' (se puede reintentar desde el panel).
const EMAIL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const RETRY_SCAN_INTERVAL_MS = 30_000;
const RETRY_BATCH_SIZE = 20;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('NotificationsService');
  private retryTimer: NodeJS.Timeout | null = null;
  private retrying = false;

  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
    @InjectRepository(UserContact) private readonly contacts: Repository<UserContact>,
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
    payload = await this.withContact(idUser, payload);
    const rules = CHANNEL_POLICY[event] ?? defaultRules(event);
    const created: Notification[] = [];

    for (const rule of rules) {
      if (rule.when && !rule.when(payload)) continue;
      // Sin destinatario no se crea la fila de email (quedaría 'pending' para siempre).
      if (rule.channel === 'email' && !this.emailRecipient(payload)) {
        this.logger.warn(`Evento '${event}' mapeado a email pero el payload no trae 'email'. Se omite ese canal.`);
        continue;
      }

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

  /**
   * Guarda el email/nombre que traiga el evento y completa los que falten con lo
   * conocido del usuario (p. ej. transaction.completed de Ledger no trae email).
   */
  private async withContact(idUser: string, payload: Record<string, unknown>) {
    const email = this.text(payload.email);
    const nombreCompleto = this.text(payload.nombreCompleto);
    if (email || nombreCompleto) await this.rememberContact(idUser, email, nombreCompleto);

    const needsEmail = !email && !this.text(payload.notifyEmail);
    if (!needsEmail && nombreCompleto) return payload;
    const contact = await this.findContact(idUser);
    if (!contact) return payload;

    const enriched = { ...payload };
    if (needsEmail && contact.email) enriched.email = contact.email;
    if (!nombreCompleto && contact.nombreCompleto) enriched.nombreCompleto = contact.nombreCompleto;
    return enriched;
  }

  private async findContact(idUser: string): Promise<UserContact | null> {
    const contact = await this.contacts.findOne({ where: { idUser } });
    if (contact?.email && contact.nombreCompleto) return contact;

    // Usuarios registrados antes de existir la proyección: se reconstruye desde su historial.
    const history = await this.repo.find({
      where: { idUser, event: In(CONTACT_EVENTS) },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    let email = contact?.email ?? null;
    let nombreCompleto = contact?.nombreCompleto ?? null;
    for (const row of history) {
      email ??= this.text(row.metadata?.email);
      nombreCompleto ??= this.text(row.metadata?.nombreCompleto);
    }
    if (!email && !nombreCompleto) return contact;
    return this.rememberContact(idUser, email, nombreCompleto);
  }

  private async rememberContact(idUser: string, email: string | null, nombreCompleto: string | null) {
    const row = (await this.contacts.findOne({ where: { idUser } }))
      ?? this.contacts.create({ idUser, email: null, nombreCompleto: null });
    const nextEmail = email ? email.toLowerCase() : row.email;
    const nextName = nombreCompleto ?? row.nombreCompleto;
    if (row.email === nextEmail && row.nombreCompleto === nextName && row.updatedAt) return row;
    row.email = nextEmail;
    row.nombreCompleto = nextName;
    try {
      return await this.contacts.save(row);
    } catch (error) {
      // Dos eventos del mismo usuario a la vez: el otro ya creó la fila.
      if ((error as any)?.code === '23505') return row;
      throw error;
    }
  }

  private text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private emailRecipient(payload: Record<string, unknown>): string | null {
    const to = payload.email ?? payload.notifyEmail;
    return typeof to === 'string' && to.trim() ? to.trim() : null;
  }

  private async deliverEmail(row: Notification, payload: Record<string, unknown>) {
    const to = this.emailRecipient(payload);
    if (!to) return row;
    const sent = await this.mailer.send(to, row.title, row.body);
    row.deliveryAttempts = (row.deliveryAttempts ?? 0) + 1;
    if (sent) {
      Object.assign(row, { status: 'sent', nextAttemptAt: null, lastError: null });
    } else if (row.deliveryAttempts > EMAIL_RETRY_DELAYS_MS.length) {
      Object.assign(row, { status: 'failed', nextAttemptAt: null, lastError: 'No se pudo enviar el correo tras varios intentos.' });
      this.logger.error(`Correo de la notificación ${row.id} marcado como fallido tras ${row.deliveryAttempts} intentos.`);
    } else {
      const delay = EMAIL_RETRY_DELAYS_MS[row.deliveryAttempts - 1];
      Object.assign(row, { status: 'pending', nextAttemptAt: new Date(Date.now() + delay), lastError: 'No se pudo enviar el correo.' });
      this.logger.warn(`Correo de la notificación ${row.id} falló (intento ${row.deliveryAttempts}); se reintenta en ${delay / 60_000} min.`);
    }
    return this.repo.save(row);
  }

  onModuleInit() {
    this.retryTimer = setInterval(() => void this.retryDueEmails(), RETRY_SCAN_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  /**
   * Reenvía los correos pendientes cuyo reintento ya toca. También recoge los que
   * quedaron 'pending' sin programar (p. ej. el proceso se reinició a mitad del envío).
   */
  async retryDueEmails() {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const due = await this.repo.manager.transaction(async (manager) => {
        // SKIP LOCKED + reserva de 5 min: con varias réplicas, cada correo lo envía solo una.
        const rows = await manager
          .createQueryBuilder(Notification, 'n')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .where(`n.channel = 'email' AND n.status = 'pending'`)
          .andWhere(`(n.nextAttemptAt <= now() OR (n.nextAttemptAt IS NULL AND n.createdAt < now() - interval '2 minutes'))`)
          .orderBy('n.createdAt', 'ASC')
          .limit(RETRY_BATCH_SIZE)
          .getMany();
        for (const row of rows) row.nextAttemptAt = new Date(Date.now() + 5 * 60_000);
        return rows.length ? manager.save(rows) : rows;
      });
      for (const row of due) await this.deliverEmail(row, row.metadata ?? {});
    } catch (error) {
      this.logger.error(`Error reintentando correos: ${(error as Error).message}`);
    } finally {
      this.retrying = false;
    }
  }

  /** Panel administrativo: fuerza un nuevo envío de un correo fallido o pendiente. */
  async retryNow(id: string) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Notificación no encontrada');
    if (row.channel !== 'email') throw new BadRequestException('Solo se pueden reintentar notificaciones por correo.');
    if (row.status === 'sent') throw new BadRequestException('La notificación ya fue enviada.');
    row.deliveryAttempts = 0;
    return this.deliverEmail(row, row.metadata ?? {});
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
