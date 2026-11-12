import { ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { AdminNotificationsController } from './admin-notifications.controller';
import { Notification } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

const staff = { id: 'emp-1', username: 'laura', role: 'admin' };
const req = { staff };

describe('AdminNotificationsController', () => {
  const rows = [
    {
      id: 'n1',
      idUser: 'u1',
      channel: 'email',
      status: 'failed',
      title: 'Transferencia a Bancolombia',
      body: '<html>cuerpo del correo</html>',
      metadata: { email: 'ana@banklite.test' },
      dedupeKey: 'clave',
    },
  ];
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['select', 'addSelect', 'where', 'groupBy', 'addGroupBy'])
    queryBuilder[method] = jest.fn(() => queryBuilder);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([{ channel: 'email', status: 'sent', count: 3 }]);
  const repo = {
    findAndCount: jest.fn().mockResolvedValue([rows, 1]),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const notifications = { retryNow: jest.fn().mockResolvedValue({ ...rows[0], status: 'sent' }) };
  const consumer = {
    deadLetterStats: jest.fn().mockResolvedValue({ connected: true, deadLetters: 2 }),
    peekDeadLetters: jest.fn().mockResolvedValue([{ routingKey: 'account.closed' }]),
    requeueDeadLetters: jest.fn().mockResolvedValue({ moved: 2 }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined), list: jest.fn().mockResolvedValue({ items: [] }) };
  const controller = new AdminNotificationsController(
    repo as unknown as Repository<Notification>,
    notifications as unknown as NotificationsService,
    consumer as unknown as EventConsumerService,
    audit as unknown as AdminAuditService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('solo el personal con sesión de empleado entra, y reintentar o reencolar tiene su rol', () => {
    expect(Reflect.getMetadata('__guards__', AdminNotificationsController)).toContain(StaffAuthGuard);
    expect(Reflect.getMetadata('staffRoles', AdminNotificationsController.prototype.retry)).toEqual([
      'support',
      'admin',
    ]);
    expect(Reflect.getMetadata('staffRoles', AdminNotificationsController.prototype.requeue)).toEqual(['admin']);
  });

  it('la lista filtra y pagina, y nunca devuelve el cuerpo del correo, los datos del evento ni la clave de deduplicación', async () => {
    const result = await controller.list({ idUser: 'u1', status: 'failed', channel: 'email', page: 2, limit: 10 });

    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idUser: 'u1', status: 'failed', channel: 'email' },
        skip: 10,
        take: 10,
      }),
    );
    expect(result).toMatchObject({ total: 1, page: 2, limit: 10 });
    expect(Object.keys(result.items[0])).not.toEqual(expect.arrayContaining(['body']));
    expect(JSON.stringify(result)).not.toMatch(/cuerpo del correo|ana@banklite|clave"/);
    expect(result.items[0].title).not.toContain('Bancolombia');
    await controller.list({});
    expect(repo.findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({ where: {}, skip: 0, take: 25 }));
  });

  it('el resumen agrupa por canal y estado de los últimos 7 días', async () => {
    const summary = await controller.summary();
    expect(summary.byChannelAndStatus).toEqual([{ channel: 'email', status: 'sent', count: 3 }]);
    expect(Date.parse(summary.since)).toBeLessThan(Date.now() - 6 * 86_400_000);
  });

  it('reintentar un correo queda en la auditoría del empleado', async () => {
    const result = await controller.retry('n1', req);

    expect(notifications.retryNow).toHaveBeenCalledWith('n1');
    expect(audit.record).toHaveBeenCalledWith(staff, {
      action: 'notification.retry',
      targetType: 'notification',
      targetId: 'n1',
      details: { status: 'sent' },
    });
    expect(result).not.toHaveProperty('body');
  });

  it('la DLQ: estado, mensajes y reencolar (auditado); si RabbitMQ no está conectado, 503 y sin auditoría', async () => {
    expect(await controller.dlq()).toMatchObject({ deadLetters: 2 });
    expect(await controller.dlqMessages()).toHaveLength(1);
    expect(await controller.requeue(req)).toEqual({ moved: 2 });
    expect(audit.record).toHaveBeenCalledWith(
      staff,
      expect.objectContaining({ action: 'dlq.requeue', details: { moved: 2 } }),
    );

    audit.record.mockClear();
    consumer.peekDeadLetters.mockRejectedValueOnce(new Error('RabbitMQ no está conectado.'));
    await expect(controller.dlqMessages()).rejects.toBeInstanceOf(ServiceUnavailableException);
    consumer.requeueDeadLetters.mockRejectedValueOnce(new Error('RabbitMQ no está conectado.'));
    await expect(controller.requeue(req)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el registro de auditoría usa la página y el filtro pedidos', async () => {
    await controller.auditLog({ q: 'retry', page: 3, limit: 20 });
    expect(audit.list).toHaveBeenCalledWith(3, 20, 'retry');
    await controller.auditLog({});
    expect(audit.list).toHaveBeenLastCalledWith(1, 50, undefined);
  });
});
