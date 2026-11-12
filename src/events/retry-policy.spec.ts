import type { Logger } from '@nestjs/common';
import type * as amqplib from 'amqplib';
import {
  assertRetryQueues,
  handleFailure,
  originalRoutingKey,
  peekDeadLetters,
  PoisonMessageError,
  queueStats,
  requeueDeadLetters,
} from './retry-policy';

/**
 * Reintentos de los eventos de RabbitMQ: un evento que falla espera y se reintenta, y si
 * agota los intentos (o es basura) va a la DLQ para revisión; nunca se pierde ni bloquea la cola.
 */
const QUEUE = 'servicio.eventos';
const logger = { warn: jest.fn(), error: jest.fn() } as unknown as Logger & { warn: jest.Mock; error: jest.Mock };

const message = (headers: Record<string, unknown> = {}, routingKey = 'account.closed', body: unknown = { a: 1 }) =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey },
    properties: { headers, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

function fakeChannel(stored: Record<string, amqplib.GetMessage[]> = {}) {
  return {
    assertQueue: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    checkQueue: jest.fn(async (queue: string) => ({
      messageCount: (stored[queue] ?? []).length,
      consumerCount: queue === QUEUE ? 2 : 0,
    })),
    get: jest.fn(async (queue: string) => stored[queue]?.shift() ?? false),
  };
}
const asChannel = (channel: ReturnType<typeof fakeChannel>) => channel as unknown as amqplib.Channel;

describe('retry-policy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('crea las colas de espera (con TTL que devuelve a la cola principal) y la DLQ', async () => {
    const channel = fakeChannel();

    await assertRetryQueues(asChannel(channel), QUEUE);

    expect(channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.retry`, {
      durable: true,
      arguments: expect.objectContaining({
        'x-message-ttl': expect.any(Number),
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': QUEUE,
      }),
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
  });

  it('el routing key original es el del encabezado si el mensaje ya fue reintentado', () => {
    expect(originalRoutingKey(message({}, 'account.closed'))).toBe('account.closed');
    expect(originalRoutingKey(message({ 'x-original-routing-key': 'fraud.alert' }, ''))).toBe('fraud.alert');
  });

  describe('después de un fallo (handleFailure)', () => {
    it('el primer fallo va a la cola de espera con el contador, el motivo y el routing key original, y confirma el original', () => {
      const channel = fakeChannel();
      const msg = message({}, 'account.closed');

      handleFailure(asChannel(channel), QUEUE, msg, new Error('base caída'), logger);

      const [target, content, options] = channel.sendToQueue.mock.calls[0];
      expect(target).toBe(`${QUEUE}.retry`);
      expect(content).toBe(msg.content);
      expect(options).toMatchObject({
        persistent: true,
        headers: { 'x-retry-count': 1, 'x-original-routing-key': 'account.closed', 'x-last-error': 'base caída' },
      });
      expect(channel.ack).toHaveBeenCalledWith(msg);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('el contador sigue creciendo en cada reintento y el motivo se recorta a 500 caracteres', () => {
      const channel = fakeChannel();

      handleFailure(asChannel(channel), QUEUE, message({ 'x-retry-count': 3 }), new Error('x'.repeat(900)), logger);

      const [target, , options] = channel.sendToQueue.mock.calls[0];
      expect(target).toBe(`${QUEUE}.retry`);
      expect(options.headers['x-retry-count']).toBe(4);
      expect(options.headers['x-last-error']).toHaveLength(500);
    });

    it('al agotar los intentos va a la DLQ y se registra como error', () => {
      const channel = fakeChannel();

      handleFailure(asChannel(channel), QUEUE, message({ 'x-retry-count': 5 }), new Error('sigue fallando'), logger);

      expect(channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('enviado a servicio.eventos.dlq'));
    });

    it('un mensaje imposible de procesar (basura) va directo a la DLQ, sin reintentos', () => {
      const channel = fakeChannel();

      handleFailure(asChannel(channel), QUEUE, message(), new PoisonMessageError('no es JSON'), logger);

      expect(channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);
      expect(channel.ack).toHaveBeenCalled();
    });

    it('si el canal está cerrado no confirma: RabbitMQ reentregará el original', () => {
      const channel = fakeChannel();
      channel.sendToQueue.mockImplementation(() => {
        throw new Error('canal cerrado');
      });

      expect(() => handleFailure(asChannel(channel), QUEUE, message(), new Error('x'), logger)).not.toThrow();

      expect(channel.ack).not.toHaveBeenCalled();
    });
  });

  describe('panel de la DLQ', () => {
    const dead = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...(message({ 'x-original-routing-key': 'account.closed', 'x-retry-count': 5, 'x-last-error': 'falló' }, '', {
          idUser: `u${i}`,
        }) as unknown as amqplib.GetMessage),
      }));

    it('cuenta los mensajes de la cola, la espera de reintento y la DLQ', async () => {
      const channel = fakeChannel({ [`${QUEUE}.retry`]: dead(1), [`${QUEUE}.dlq`]: dead(3) });

      expect(await queueStats(asChannel(channel), QUEUE)).toEqual({
        queue: QUEUE,
        ready: 0,
        consumers: 2,
        waitingRetry: 1,
        deadLetters: 3,
      });
    });

    it('lista los mensajes de la DLQ sin sacarlos (los devuelve con nack) y tolera los que no son JSON', async () => {
      const bad = { ...message({}, 'x', 'esto no es json') } as unknown as amqplib.GetMessage;
      const channel = fakeChannel({ [`${QUEUE}.dlq`]: [...dead(2), bad] });

      const items = await peekDeadLetters(asChannel(channel), QUEUE, 10);

      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({
        routingKey: 'account.closed',
        attempts: 5,
        lastError: 'falló',
        message: { idUser: 'u0' },
      });
      expect(items[2].message).toBe('esto no es json');
      expect(channel.nack).toHaveBeenCalledTimes(3);
      expect(channel.nack.mock.calls.every((call) => call[1] === false && call[2] === true)).toBe(true);
    });

    it('lista como máximo lo pedido', async () => {
      const channel = fakeChannel({ [`${QUEUE}.dlq`]: dead(5) });
      expect(await peekDeadLetters(asChannel(channel), QUEUE, 2)).toHaveLength(2);
    });

    it('devuelve a la cola principal hasta el máximo, con el contador de intentos en cero', async () => {
      const channel = fakeChannel({ [`${QUEUE}.dlq`]: dead(3) });

      expect(await requeueDeadLetters(asChannel(channel), QUEUE, 2)).toEqual({ moved: 2 });

      expect(channel.sendToQueue).toHaveBeenCalledTimes(2);
      const [target, , options] = channel.sendToQueue.mock.calls[0];
      expect(target).toBe(QUEUE);
      expect(options.headers).not.toHaveProperty('x-retry-count');
      expect(options.headers['x-original-routing-key']).toBe('account.closed');
      expect(channel.ack).toHaveBeenCalledTimes(2);
    });

    it('con la DLQ vacía no mueve nada', async () => {
      expect(await requeueDeadLetters(asChannel(fakeChannel()), QUEUE)).toEqual({ moved: 0 });
    });
  });
});
