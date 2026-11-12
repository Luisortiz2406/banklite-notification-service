import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { CHANNEL_POLICY } from '../notifications/channel-policy';
import { NotificationsService } from '../notifications/notifications.service';
import { EventConsumerService } from './event-consumer.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Consumidor de eventos (RabbitMQ simulado): se suscribe solo a los eventos que generan
 * avisos, procesa cada mensaje con la política de canales y manda a reintento o a la
 * DLQ lo que falle. account.closed pasa por aquí hasta el correo de cancelación.
 */
const QUEUE = 'notification-service.all-events';
const ANA = '11111111-1111-4111-8111-111111111111';

function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = {
    connection: {},
    channel: {},
  };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    unbindQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    checkQueue: jest.fn().mockResolvedValue({ messageCount: 0, consumerCount: 1 }),
    get: jest.fn().mockResolvedValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}
const delivery = (body: unknown, routingKey = 'account.closed') =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey },
    properties: { headers: {}, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

describe('EventConsumerService', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  let notifications: { handleEvent: jest.Mock };

  const build = (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) =>
    new EventConsumerService(new ConfigService(env), notifications as unknown as NotificationsService);
  /** Conecta el servicio y devuelve la función que RabbitMQ llamaría con cada mensaje. */
  const started = async (service = build()) => {
    await service.onModuleInit();
    const onMessage = broker.channel.consume.mock.calls[0][1] as (msg: amqplib.ConsumeMessage | null) => Promise<void>;
    return { service, onMessage };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    notifications = { handleEvent: jest.fn().mockResolvedValue([]) };
  });
  afterEach(() => jest.useRealTimers());

  describe('conexión', () => {
    it('sin RABBITMQ_URL no intenta conectar (modo degradado)', async () => {
      await build({}).onModuleInit();
      expect(connect).not.toHaveBeenCalled();
    });

    it('declara el exchange y la cola, suelta el binding "#" viejo y se suscribe solo a los eventos que generan avisos', async () => {
      await started();

      expect(broker.channel.assertExchange).toHaveBeenCalledWith('banklite.events', 'topic', { durable: true });
      expect(broker.channel.assertQueue).toHaveBeenCalledWith(QUEUE, { durable: true });
      expect(broker.channel.unbindQueue).toHaveBeenCalledWith(QUEUE, 'banklite.events', '#');
      const bound = broker.channel.bindQueue.mock.calls.map((call) => call[2]);
      expect(bound).toContain('account.closed');
      expect(bound).toContain('transaction.completed');
      expect(bound).not.toContain('identity.verified'); // sin reglas: no se escucha
      expect(bound.sort()).toEqual(
        Object.keys(CHANNEL_POLICY)
          .filter((event) => CHANNEL_POLICY[event].length > 0)
          .sort(),
      );
      expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
    });

    it('el nombre del exchange y de la cola son configurables', async () => {
      await started(
        build({ RABBITMQ_URL: 'amqp://rabbit', RABBITMQ_EXCHANGE: 'otro.exchange', RABBITMQ_QUEUE: 'otra-cola' }),
      );

      expect(broker.channel.assertExchange).toHaveBeenCalledWith('otro.exchange', 'topic', { durable: true });
      expect(broker.channel.consume.mock.calls[0][0]).toBe('otra-cola');
    });

    it('si RabbitMQ no está disponible reintenta a los 5 s sin tumbar el servicio', async () => {
      jest.useFakeTimers();
      connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const service = build();

      await service.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(broker.channel.consume).toHaveBeenCalled();
    });

    it('si la conexión se cae después de arrancar, vuelve a conectar', async () => {
      jest.useFakeTimers();
      await started();

      broker.handlers.connection.close();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('cerrar el módulo cierra el canal y la conexión, y cancela el reintento pendiente', async () => {
      jest.useFakeTimers();
      const { service } = await started();
      await service.onModuleDestroy();
      expect(broker.channel.close).toHaveBeenCalled();
      expect(broker.connection.close).toHaveBeenCalled();

      const second = await started(build());
      broker.handlers.connection.close();
      await second.service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('los errores de la conexión y del canal solo se registran (si no, tumbarían el proceso)', async () => {
      await started();

      expect(() => broker.handlers.connection.error(new Error('conexión'))).not.toThrow();
      expect(() => broker.handlers.channel.error(new Error('canal'))).not.toThrow();
      broker.handlers.channel.close();
      expect(broker.connection.close).toHaveBeenCalled();
    });
  });

  describe('mensajes', () => {
    it('un evento se procesa con la política de canales (usuario, evento, datos y momento) y se confirma', async () => {
      const { onMessage } = await started();
      const msg = delivery({
        event: 'account.closed',
        occurredAt: '2026-11-11T10:00:00.000Z',
        data: { idUser: ANA, email: 'ana@banklite.test', cuentas: ['10000001234'] },
      });

      await onMessage(msg);

      expect(notifications.handleEvent).toHaveBeenCalledWith(
        ANA,
        'account.closed',
        { idUser: ANA, email: 'ana@banklite.test', cuentas: ['10000001234'] },
        '2026-11-11T10:00:00.000Z',
      );
      expect(broker.channel.ack).toHaveBeenCalledWith(msg);
    });

    it('si el cuerpo no trae el nombre del evento, usa el routing key', async () => {
      const { onMessage } = await started();

      await onMessage(delivery({ data: { idUser: ANA } }, 'fraud.alert'));

      expect(notifications.handleEvent).toHaveBeenCalledWith(ANA, 'fraud.alert', { idUser: ANA }, undefined);
    });

    it('un mensaje sin idUser se descarta (se confirma para no bloquear la cola) y no genera avisos', async () => {
      const { onMessage } = await started();
      const msg = delivery({ event: 'account.closed', data: {} });

      await onMessage(msg);

      expect(notifications.handleEvent).not.toHaveBeenCalled();
      expect(broker.channel.ack).toHaveBeenCalledWith(msg);
      expect(broker.channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('un mensaje que no es JSON va directo a la DLQ', async () => {
      const { onMessage } = await started();

      await onMessage(delivery('esto no es json'));

      expect(notifications.handleEvent).not.toHaveBeenCalled();
      expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);
    });

    it('si procesar el evento falla, va a la cola de espera para reintentarlo (no se pierde el aviso)', async () => {
      const { onMessage } = await started();
      notifications.handleEvent.mockRejectedValueOnce(new Error('base caída'));
      const msg = delivery({ event: 'account.closed', data: { idUser: ANA } });

      await onMessage(msg);

      expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.retry`);
      expect(broker.channel.ack).toHaveBeenCalledWith(msg);
    });

    it('la entrega nula que manda RabbitMQ al cancelar el consumo se ignora', async () => {
      const { onMessage } = await started();

      await onMessage(null);

      expect(notifications.handleEvent).not.toHaveBeenCalled();
    });
  });

  describe('panel de la DLQ', () => {
    it('sin conexión informa que no está conectado y no deja listar ni reencolar', async () => {
      const service = build({});

      expect(await service.deadLetterStats()).toEqual({ connected: false });
      await expect(service.peekDeadLetters(5)).rejects.toThrow('RabbitMQ no está conectado');
      await expect(service.requeueDeadLetters(5)).rejects.toThrow('RabbitMQ no está conectado');
    });

    it('conectado, informa el estado de la cola y puede listar y reencolar', async () => {
      const { service } = await started();

      expect(await service.deadLetterStats()).toMatchObject({ connected: true, queue: QUEUE, consumers: 1 });
      expect(await service.peekDeadLetters(5)).toEqual([]);
      expect(await service.requeueDeadLetters(5)).toEqual({ moved: 0 });
    });
  });
});
