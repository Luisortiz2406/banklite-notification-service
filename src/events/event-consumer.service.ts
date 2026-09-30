import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * A diferencia de account-service (que solo escucha 'identity.verified'),
 * este consumer se suscribe con routing key '#' a TODO lo que se publique
 * en el exchange 'banklite.events'. Así, cuando agregues un microservicio
 * nuevo (Ledger, Card, etc.) que publique sus propios eventos, notification
 * -service los recibe automáticamente sin cambios de código aquí — solo hay
 * que mapear el evento en channel-policy.ts (si no está mapeado, cae en la
 * regla por defecto: in-app genérico).
 *
 * Igual que en el resto del proyecto: si RabbitMQ no está disponible, el
 * servicio sigue arriba en modo degradado (solo deja de recibir eventos;
 * POST /notifications interno sigue funcionando igual).
 */
@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer[notification-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      this.connection = await amqplib.connect(url);
      this.channel = await this.connection.createChannel();

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = this.config.get<string>('RABBITMQ_QUEUE', 'notification-service.all-events');

      await this.channel.assertExchange(exchange, 'topic', { durable: true });
      await this.channel.assertQueue(queue, { durable: true });
      await this.channel.bindQueue(queue, exchange, '#');

      await this.channel.consume(queue, (msg) => this.handleMessage(msg), { noAck: false });

      this.logger.log(`Escuchando TODOS los eventos ('#') en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en 5s.`,
      );
      setTimeout(() => this.connect(), 5000);
    }
  }

  private async handleMessage(msg: amqplib.ConsumeMessage | null) {
    if (!msg || !this.channel) return;
    try {
      const content = JSON.parse(msg.content.toString());
      const event: string | undefined = content?.event ?? msg.fields.routingKey;
      const occurredAt: string | undefined = content?.occurredAt;
      const idUser: string | undefined = content?.data?.idUser;

      if (!event || !idUser) {
        this.logger.warn(`Evento sin 'event' o sin 'idUser' en el payload, descartado: ${msg.fields.routingKey}`);
        this.channel.ack(msg);
        return;
      }

      await this.notifications.handleEvent(idUser, event, content.data ?? {}, occurredAt);
      this.logger.log(`Evento '${event}' procesado para idUser=${idUser}`);
      this.channel.ack(msg);
    } catch (err) {
      this.logger.error(`Error procesando evento: ${(err as Error).message}`);
      this.channel.nack(msg, false, false);
    }
  }

  async onModuleDestroy() {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
