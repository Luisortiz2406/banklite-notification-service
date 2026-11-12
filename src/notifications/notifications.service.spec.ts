import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CHANNEL_POLICY, ChannelRule } from './channel-policy';
import { Notification } from './entities/notification.entity';
import { UserContact } from './entities/user-contact.entity';
import { MailerService } from './mailer.service';
import { NotificationsService } from './notifications.service';

/**
 * Lógica de canales y entrega de NotificationsService con repositorios en memoria y
 * el correo simulado (nunca se envía nada real). Lo que importa: un aviso no se
 * duplica por reentrega, el correo fallido se reintenta con espera creciente y al
 * final queda como fallido, y no se manda correo sin destinatario.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60_000;

type Row = Record<string, any>;

function fakeRepo() {
  const rows: Row[] = [];
  const isIn = (value: any) => value && typeof value === 'object' && value._type === 'in';
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, expected]) =>
      isIn(expected) ? expected._value.includes(row[key]) : row[key] === expected,
    );
  const repo = {
    rows,
    create: jest.fn((values: Row) => ({ ...values }) as Row),
    findOne: jest.fn(async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null),
    find: jest.fn(async ({ where, take }: { where: Row; take?: number }) => {
      const found = rows.filter((row) => matches(row, where));
      return found.sort((a, b) => b.createdAt - a.createdAt).slice(0, take ?? found.length);
    }),
    save: jest.fn(async (row: Row) => {
      if (row.dedupeKey && rows.some((other) => other !== row && other.dedupeKey === row.dedupeKey)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      row.id ??= randomUUID();
      row.createdAt ??= new Date(Date.now() + rows.length);
      row.updatedAt = new Date();
      if (!rows.includes(row)) rows.push(row);
      return row;
    }),
  };
  return repo;
}

describe('NotificationsService', () => {
  let notifications: ReturnType<typeof fakeRepo>;
  let contacts: ReturnType<typeof fakeRepo>;
  let mailer: { send: jest.Mock };
  let service: NotificationsService;

  beforeEach(() => {
    notifications = fakeRepo();
    contacts = fakeRepo();
    mailer = { send: jest.fn().mockResolvedValue(true) };
    service = new NotificationsService(
      notifications as unknown as Repository<Notification>,
      contacts as unknown as Repository<UserContact>,
      mailer as unknown as MailerService,
    );
  });
  afterEach(() => jest.useRealTimers());

  const at = '2026-11-11T10:00:00.000Z';
  const transfer = {
    type: 'transfer',
    direction: 'out',
    amount: 50_000,
    currency: 'COP',
    destinationAccountNumber: '10000000002',
    email: 'ana@banklite.test',
    nombreCompleto: 'Ana Pérez',
  };

  describe('canales de un evento (handleEvent)', () => {
    it('una transferencia enviada genera el aviso en la app (enviado) y el correo con el comprobante', async () => {
      const created = await service.handleEvent(ANA, 'transaction.completed', transfer, at);

      expect(created.map((row) => [row.channel, row.status])).toEqual([
        ['in_app', 'sent'],
        ['email', 'sent'],
      ]);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        'ana@banklite.test',
        expect.stringContaining('Transferencia enviada'),
        expect.stringContaining('Ana Pérez'),
      );
      expect(created[0]).toMatchObject({ read: false, metadata: expect.objectContaining({ amount: 50_000 }) });
    });

    it('una transferencia recibida solo genera el aviso en la app; un pago de suscripción no genera nada aquí', async () => {
      const received = await service.handleEvent(ANA, 'transaction.completed', { ...transfer, direction: 'in' }, at);
      expect(received.map((row) => row.channel)).toEqual(['in_app']);
      expect(mailer.send).not.toHaveBeenCalled();

      expect(await service.handleEvent(ANA, 'transaction.completed', { ...transfer, type: 'payment' }, at)).toEqual([]);
    });

    it('un evento que no está en la política se guarda igual, con un aviso genérico en la app', async () => {
      const [row] = await service.handleEvent(ANA, 'evento.nuevo', {}, at);

      expect(row).toMatchObject({ channel: 'in_app', title: 'evento.nuevo', status: 'sent' });
    });

    it('un evento sin reglas (identity.verified) no crea nada', async () => {
      expect(await service.handleEvent(ANA, 'identity.verified', {}, at)).toEqual([]);
      expect(notifications.rows).toHaveLength(0);
    });

    it('la misma entrega (mismo evento y mismo occurredAt) no duplica ni vuelve a enviar el correo', async () => {
      await service.handleEvent(ANA, 'transaction.completed', transfer, at);
      const again = await service.handleEvent(ANA, 'transaction.completed', transfer, at);

      expect(again).toHaveLength(2);
      expect(notifications.rows).toHaveLength(2);
      expect(mailer.send).toHaveBeenCalledTimes(1);

      // Otro momento = otro evento.
      await service.handleEvent(ANA, 'transaction.completed', transfer, '2026-11-11T10:05:00.000Z');
      expect(notifications.rows).toHaveLength(4);
    });

    it('una carrera por la clave única de otra réplica se ignora y no deja un correo fantasma', async () => {
      notifications.findOne.mockResolvedValueOnce(null);
      const key = `${ANA}:transaction.completed:in_app:${at}`;
      notifications.rows.push({ id: 'previa', dedupeKey: key, idUser: ANA, channel: 'in_app' });

      const created = await service.handleEvent(ANA, 'transaction.completed', { ...transfer, direction: 'in' }, at);

      expect(created).toEqual([]);
      expect(notifications.rows).toHaveLength(1);
    });

    it('otro error al guardar se propaga', async () => {
      notifications.save.mockRejectedValueOnce(new Error('base caída'));
      await expect(service.handleEvent(ANA, 'evento.nuevo', {}, at)).rejects.toThrow('base caída');
    });

    it('sin correo del destinatario no se crea la fila de email (quedaría pendiente para siempre)', async () => {
      const { email: _email, ...withoutEmail } = transfer;

      const created = await service.handleEvent(ANA, 'transaction.completed', withoutEmail, at);

      expect(created.map((row) => row.channel)).toEqual(['in_app']);
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it('acepta el correo en notifyEmail y lo recorta', async () => {
      const { email: _email, ...rest } = transfer;
      await service.handleEvent(ANA, 'transaction.completed', { ...rest, notifyEmail: '  otro@banklite.test ' }, at);

      expect(mailer.send).toHaveBeenCalledWith('otro@banklite.test', expect.any(String), expect.any(String));
    });

    it('un canal de WhatsApp queda pendiente (degradado) y no intenta enviar nada', async () => {
      const rule: ChannelRule = { channel: 'whatsapp', build: () => ({ title: 'WA', body: 'hola' }) };
      CHANNEL_POLICY['evento.whatsapp'] = [rule];
      try {
        const [row] = await service.handleEvent(ANA, 'evento.whatsapp', {}, at);

        expect(row).toMatchObject({ channel: 'whatsapp', status: 'pending' });
        expect(mailer.send).not.toHaveBeenCalled();
      } finally {
        delete CHANNEL_POLICY['evento.whatsapp'];
      }
    });

    it('createFromDto aplica la misma política (payload vacío si no viene)', async () => {
      const created = await service.createFromDto({ idUser: ANA, event: 'evento.nuevo' } as never);
      expect(created).toHaveLength(1);
    });
  });

  describe('contacto del usuario', () => {
    it('guarda el correo (en minúsculas) y el nombre que traiga el evento', async () => {
      await service.handleEvent(
        ANA,
        'account.created',
        { email: 'ANA@Banklite.Test', nombreCompleto: 'Ana Pérez' },
        at,
      );

      expect(contacts.rows).toEqual([
        expect.objectContaining({ idUser: ANA, email: 'ana@banklite.test', nombreCompleto: 'Ana Pérez' }),
      ]);
    });

    it('completa el correo y el nombre de un evento que no los trae (como el del ledger)', async () => {
      await service.handleEvent(
        ANA,
        'account.created',
        { email: 'ana@banklite.test', nombreCompleto: 'Ana Pérez' },
        at,
      );
      mailer.send.mockClear();
      const { email: _e, nombreCompleto: _n, ...ledgerEvent } = transfer;

      await service.handleEvent(ANA, 'transaction.completed', ledgerEvent, '2026-11-11T11:00:00.000Z');

      expect(mailer.send).toHaveBeenCalledWith(
        'ana@banklite.test',
        expect.any(String),
        expect.stringContaining('Ana Pérez'),
      );
    });

    it('reconstruye el contacto desde el historial de quien se registró antes de existir la proyección', async () => {
      notifications.rows.push({
        id: 'vieja',
        idUser: ANA,
        event: 'account.created',
        metadata: { email: 'vieja@banklite.test', nombreCompleto: 'Ana Antigua' },
        createdAt: new Date('2026-01-01'),
      });
      const { email: _e, nombreCompleto: _n, ...ledgerEvent } = transfer;

      await service.handleEvent(ANA, 'transaction.completed', ledgerEvent, at);

      expect(contacts.rows[0]).toMatchObject({ email: 'vieja@banklite.test', nombreCompleto: 'Ana Antigua' });
      expect(mailer.send).toHaveBeenCalledWith('vieja@banklite.test', expect.any(String), expect.any(String));
    });

    it('un usuario sin ningún contacto conocido no recibe correo, pero sí el aviso en la app', async () => {
      const { email: _e, nombreCompleto: _n, ...ledgerEvent } = transfer;
      const created = await service.handleEvent(CARLOS, 'transaction.completed', ledgerEvent, at);

      expect(created.map((row) => row.channel)).toEqual(['in_app']);
    });

    it('dos eventos a la vez del mismo usuario (clave única al guardar el contacto) no fallan', async () => {
      contacts.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      await expect(
        service.handleEvent(ANA, 'account.created', { email: 'ana@banklite.test', nombreCompleto: 'Ana' }, at),
      ).resolves.toHaveLength(1);

      contacts.save.mockRejectedValueOnce(new Error('base caída'));
      await expect(
        service.handleEvent(CARLOS, 'account.created', { email: 'c@banklite.test', nombreCompleto: 'Carlos' }, at),
      ).rejects.toThrow('base caída');
    });
  });

  describe('reintentos del correo', () => {
    const delayOf = (row: Row) => row.nextAttemptAt.getTime() - Date.now();
    const closeTo = (actual: number, expected: number) => Math.abs(actual - expected) < 5_000;

    it('si el correo falla queda pendiente y se reintenta a 1, 5, 15 y 60 minutos; luego queda fallido', async () => {
      mailer.send.mockResolvedValue(false);
      const [, email] = await service.handleEvent(ANA, 'transaction.completed', transfer, at);
      expect(email).toMatchObject({
        status: 'pending',
        deliveryAttempts: 1,
        lastError: 'No se pudo enviar el correo.',
      });
      expect(closeTo(delayOf(email), 1 * MINUTE)).toBe(true);

      for (const expected of [5, 15, 60]) {
        await (service as any).deliverEmail(email, email.metadata);
        expect(email.status).toBe('pending');
        expect(closeTo(delayOf(email), expected * MINUTE)).toBe(true);
      }
      await (service as any).deliverEmail(email, email.metadata);
      expect(email).toMatchObject({
        status: 'failed',
        nextAttemptAt: null,
        lastError: 'No se pudo enviar el correo tras varios intentos.',
        deliveryAttempts: 5,
      });
    });

    it('un reintento que sale bien lo deja enviado y limpia el error', async () => {
      mailer.send.mockResolvedValueOnce(false);
      const [, email] = await service.handleEvent(ANA, 'transaction.completed', transfer, at);

      await (service as any).deliverEmail(email, email.metadata);

      expect(email).toMatchObject({ status: 'sent', nextAttemptAt: null, lastError: null, deliveryAttempts: 2 });
    });

    it('el panel puede forzar el reenvío de uno fallido (reinicia los intentos); uno enviado o de otro canal no', async () => {
      mailer.send.mockResolvedValue(false);
      const [inApp, email] = await service.handleEvent(ANA, 'transaction.completed', transfer, at);
      Object.assign(email, { status: 'failed', deliveryAttempts: 5 });
      mailer.send.mockResolvedValue(true);

      const retried = await service.retryNow(email.id);

      expect(retried).toMatchObject({ status: 'sent', deliveryAttempts: 1 });
      await expect(service.retryNow(email.id)).rejects.toThrow('ya fue enviada');
      await expect(service.retryNow(inApp.id)).rejects.toThrow('Solo se pueden reintentar notificaciones por correo');
      await expect(service.retryNow('no-existe')).rejects.toBeInstanceOf(NotFoundException);
    });

    function fakeQueryBuilder(due: Row[]) {
      const builder: Record<string, jest.Mock> = {};
      for (const method of ['setLock', 'setOnLocked', 'where', 'andWhere', 'orderBy', 'limit']) {
        builder[method] = jest.fn(() => builder);
      }
      builder.getMany = jest.fn(async () => due);
      const manager = {
        createQueryBuilder: jest.fn(() => builder),
        save: jest.fn(async (rows: Row[]) => rows),
      };
      (notifications as any).manager = { transaction: jest.fn(async (work: any) => work(manager)) };
      return { builder, manager };
    }

    it('el reintento periódico toma los correos vencidos, los reserva 5 minutos y los reenvía', async () => {
      mailer.send.mockResolvedValueOnce(false);
      const [, email] = await service.handleEvent(ANA, 'transaction.completed', transfer, at);
      const { builder, manager } = fakeQueryBuilder([email]);
      mailer.send.mockResolvedValue(true);

      await service.retryDueEmails();

      expect(builder.setOnLocked).toHaveBeenCalledWith('skip_locked');
      expect(builder.limit).toHaveBeenCalledWith(20);
      expect(manager.save).toHaveBeenCalled();
      expect(email.status).toBe('sent');
    });

    it('si no hay nada vencido no hace nada; un error se registra y no detiene el proceso', async () => {
      fakeQueryBuilder([]);
      await service.retryDueEmails();
      expect(mailer.send).not.toHaveBeenCalled();

      (notifications as any).manager = { transaction: jest.fn().mockRejectedValue(new Error('base caída')) };
      await expect(service.retryDueEmails()).resolves.toBeUndefined();
      // El candado interno se libera: la siguiente vuelta sí corre.
      const { manager } = fakeQueryBuilder([]);
      await service.retryDueEmails();
      expect(manager.createQueryBuilder).toHaveBeenCalled();
    });

    it('el proceso periódico arranca a los 30 s y se detiene al cerrar el módulo', () => {
      jest.useFakeTimers();
      const retry = jest.spyOn(service, 'retryDueEmails').mockResolvedValue(undefined);

      service.onModuleInit();
      jest.advanceTimersByTime(30_000);
      expect(retry).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      jest.advanceTimersByTime(120_000);
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });

  describe('consultas del cliente', () => {
    beforeEach(async () => {
      await service.handleEvent(ANA, 'transaction.completed', transfer, at);
      await service.handleEvent(CARLOS, 'transaction.completed', { ...transfer, direction: 'in' }, at);
    });

    it('solo se consultan las propias, filtradas por canal y por no leídas', async () => {
      const inApp = await service.findForUser(ANA, ANA, 'in_app');
      expect(inApp).toHaveLength(1);
      expect(inApp[0].idUser).toBe(ANA);
      expect(await service.findForUser(ANA, ANA, 'email')).toHaveLength(1);
      expect(await service.findForUser(ANA, ANA)).toHaveLength(2);

      await service.markRead(inApp[0].id, ANA);
      expect(await service.findForUser(ANA, ANA, 'in_app', true)).toHaveLength(0);
      await expect(service.findForUser(ANA, CARLOS)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('marcar como leída es solo del dueño; una inexistente da 404', async () => {
      const [row] = await service.findForUser(CARLOS, CARLOS, 'in_app');

      await expect(service.markRead(row.id, ANA)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.markRead('no-existe', ANA)).rejects.toBeInstanceOf(NotFoundException);
      expect(await service.markRead(row.id, CARLOS)).toMatchObject({ read: true });
    });

    it('los avisos viejos con marcas reales se muestran con el nombre vigente', async () => {
      notifications.rows.push({
        id: 'vieja',
        idUser: ANA,
        channel: 'in_app',
        read: false,
        title: 'Transferencia a Bancolombia',
        body: 'Enviaste dinero a Nequi',
        createdAt: new Date(),
      });

      const [row] = await service.findForUser(ANA, ANA, 'in_app');
      const old = (await service.findForUser(ANA, ANA, 'in_app')).find((item) => item.id === 'vieja')!;

      expect(old.title).not.toContain('Bancolombia');
      expect(old.body).not.toContain('Nequi');
      expect(row).toBeDefined();
    });
  });
});
