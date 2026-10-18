import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import {
  assertRetryQueues,
  handleFailure,
  peekDeadLetters,
  queueStats,
  requeueDeadLetters,
  originalRoutingKey,
  PoisonMessageError,
} from './retry-policy';
import { CHANNEL_POLICY } from '../notifications/channel-policy';
import { NotificationsService } from '../notifications/notifications.service';

const RECONNECT_DELAY_MS = 5000;
const SUBSCRIBED_EVENTS = Object.keys(CHANNEL_POLICY).filter((event) => CHANNEL_POLICY[event].length > 0);

/**
 * Se suscribe SOLO a los eventos que generan algún aviso: los mapeados con al
 * menos un canal en channel-policy.ts (mínimo privilegio: antes escuchaba '#',
 * todo el bus, y guardaba payloads que no necesitaba). Para notificar un
 * evento nuevo basta con mapearlo en channel-policy.ts; el binding se crea
 * solo al arrancar.
 *
 * Igual que en el resto del proyecto: si RabbitMQ no está disponible, el
 * servicio sigue arriba en modo degradado (solo deja de recibir eventos;
 * POST /notifications interno sigue funcionando igual) y reintenta la
 * conexión en segundo plano, también si se cae después de arrancar.
 *
 * Si un evento falla al procesarse, se reintenta varias veces con espera y, si
 * sigue fallando, queda en la DLQ (<cola>.dlq) en lugar de perderse. Los
 * reintentos no duplican avisos: handleEvent deduplica por occurredAt.
 */
@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer[notification-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private queue: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      const connection = await amqplib.connect(url);
      this.connection = connection;
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.logger.warn('Conexión con RabbitMQ cerrada.');
        this.scheduleReconnect();
      });
      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      this.channel = channel;

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = this.config.get<string>('RABBITMQ_QUEUE', 'notification-service.all-events');

      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.assertQueue(queue, { durable: true });
      // Versiones anteriores enlazaban '#'; el binding persiste en la cola durable.
      await channel.unbindQueue(queue, exchange, '#');
      for (const routingKey of SUBSCRIBED_EVENTS) await channel.bindQueue(queue, exchange, routingKey);
      await assertRetryQueues(channel, queue);
      this.queue = queue;

      await channel.consume(queue, (msg) => this.handleMessage(channel, queue, msg), { noAck: false });

      this.logger.log(`Escuchando ${SUBSCRIBED_EVENTS.join(', ')} en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
      );
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  // Se usa el canal por el que llegó el mensaje: el ack debe ir por ese mismo canal.
  private async handleMessage(channel: amqplib.Channel, queue: string, msg: amqplib.ConsumeMessage | null) {
    if (!msg) return;
    try {
      let content: any;
      try {
        content = JSON.parse(msg.content.toString());
      } catch {
        throw new PoisonMessageError('El mensaje no es JSON válido.');
      }
      const event: string | undefined = content?.event ?? originalRoutingKey(msg);
      const occurredAt: string | undefined = content?.occurredAt;
      const idUser: string | undefined = content?.data?.idUser;

      if (!event || !idUser) {
        this.logger.warn(`Evento sin 'event' o sin 'idUser' en el payload, descartado: ${msg.fields.routingKey}`);
        channel.ack(msg);
        return;
      }

      await this.notifications.handleEvent(idUser, event, content.data ?? {}, occurredAt);
      this.logger.log(`Evento '${event}' procesado para idUser=${idUser}`);
      channel.ack(msg);
    } catch (err) {
      handleFailure(channel, queue, msg, err as Error, this.logger);
    }
  }

  /** Panel administrativo: estado de la cola, sus reintentos y su DLQ. */
  async deadLetterStats() {
    if (!this.channel || !this.queue) return { connected: false };
    return { connected: true, ...(await queueStats(this.channel, this.queue)) };
  }

  async peekDeadLetters(max: number) {
    if (!this.channel || !this.queue) throw new Error('RabbitMQ no está conectado.');
    return peekDeadLetters(this.channel, this.queue, max);
  }

  async requeueDeadLetters(max: number) {
    if (!this.channel || !this.queue) throw new Error('RabbitMQ no está conectado.');
    return requeueDeadLetters(this.channel, this.queue, max);
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
