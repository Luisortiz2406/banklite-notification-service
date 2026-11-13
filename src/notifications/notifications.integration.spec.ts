import { randomUUID } from 'crypto';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as amqplib from 'amqplib';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { Notification } from './entities/notification.entity';
import { UserContact } from './entities/user-contact.entity';
import { MailerService } from './mailer.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Integración del aviso de una transferencia de punta a punta: el mensaje llega por RabbitMQ (simulado),
 * lo procesa el consumidor real, la política de canales y NotificationsService deciden qué avisos crear, el
 * correo sale por MailerService y el cliente de la Gmail API (la red, con `fetch` simulado: nunca se envía un
 * correo real) y el cliente lo consulta por HTTP con su JWT. Solo se simulan los bordes: base de datos
 * (repositorios en memoria), bus de mensajes y Gmail. La app Nest se levanta de verdad en un puerto libre.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const JWT_SECRET = 'secreto-de-prueba-para-el-jwt-de-clientes-0123456789';
const CLAVE_ACCOUNT = 'clave-interna-de-prueba-de-account-0123456789';

type Row = Record<string, any>;

function fakeRepo() {
  const rows: Row[] = [];
  const isIn = (value: any) => value && typeof value === 'object' && value._type === 'in';
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, expected]) =>
      isIn(expected) ? expected._value.includes(row[key]) : row[key] === expected,
    );
  return {
    rows,
    create: (values: Row) => ({ ...values }) as Row,
    findOne: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
    find: async ({ where, take }: { where: Row; take?: number }) => {
      const found = rows.filter((row) => matches(row, where));
      return found.sort((a, b) => b.createdAt - a.createdAt).slice(0, take ?? found.length);
    },
    save: async (row: Row) => {
      if (row.dedupeKey && rows.some((other) => other !== row && other.dedupeKey === row.dedupeKey)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      row.id ??= randomUUID();
      row.createdAt ??= new Date(Date.now() + rows.length);
      row.updatedAt = new Date();
      if (!rows.includes(row)) rows.push(row);
      return row;
    },
  };
}

const respuesta = (status: number, cuerpo: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => cuerpo,
    text: async () => 'error simulado',
  }) as Response;

const notificaciones = fakeRepo();
const contactos = fakeRepo();
const jwt = new JwtService({});
const canalRabbit = {
  on: jest.fn(),
  assertExchange: jest.fn().mockResolvedValue(undefined),
  assertQueue: jest.fn().mockResolvedValue(undefined),
  unbindQueue: jest.fn().mockResolvedValue(undefined),
  bindQueue: jest.fn().mockResolvedValue(undefined),
  consume: jest.fn().mockResolvedValue(undefined),
  sendToQueue: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MailerService,
    EventConsumerService,
    InternalKeyGuard,
    JwtAuthGuard,
    { provide: JwtService, useValue: jwt },
    {
      provide: ConfigService,
      useValue: new ConfigService({
        JWT_SECRET,
        INTERNAL_TRUSTED_KEYS: `account:${CLAVE_ACCOUNT}`,
        RABBITMQ_URL: 'amqp://rabbit.falso',
        GMAIL_CLIENT_ID: 'id-de-prueba',
        GMAIL_CLIENT_SECRET: 'secreto-de-prueba',
        GMAIL_REFRESH_TOKEN: 'refresh-de-prueba',
        GMAIL_SENDER: 'avisos@banklite.test',
      }),
    },
    { provide: getRepositoryToken(Notification), useValue: notificaciones },
    { provide: getRepositoryToken(UserContact), useValue: contactos },
  ],
})
class NotificacionesDePruebaModule {}

describe('Aviso de una transferencia de punta a punta (RabbitMQ, política de canales, Gmail y HTTP)', () => {
  const fetchReal = global.fetch;
  let app: INestApplication;
  let base: string;
  let alRecibirMensaje: (msg: amqplib.ConsumeMessage | null) => Promise<void>;
  let fetchGmail: jest.Mock;
  let gmailResponde: number;

  const token = (idUser: string) => `Bearer ${jwt.sign({ sub: idUser, type: 'access' }, { secret: JWT_SECRET })}`;

  /** Petición HTTP real a la app (con el fetch verdadero, no el simulado de Gmail). */
  const http = async (
    metodo: string,
    ruta: string,
    opciones: { autorizacion?: string; claveInterna?: string; cuerpo?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opciones.autorizacion) headers.Authorization = opciones.autorizacion;
    if (opciones.claveInterna) headers['x-internal-key'] = opciones.claveInterna;
    const res = await fetchReal(`${base}${ruta}`, {
      method: metodo,
      headers,
      body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  /** Lo que ledger publica en el bus cuando termina una transferencia. */
  const mensaje = (data: Row, occurredAt: string, event = 'transaction.completed') =>
    ({
      content: Buffer.from(JSON.stringify({ event, occurredAt, data })),
      fields: { routingKey: event },
      properties: { headers: {}, contentType: 'application/json', messageId: randomUUID() },
    }) as unknown as amqplib.ConsumeMessage;

  const transferenciaEnviada = (over: Row = {}) => ({
    idUser: ANA,
    type: 'transfer',
    direction: 'out',
    amount: 50_000,
    currency: 'COP',
    destinationAccountNumber: '10000000002',
    email: 'ana@banklite.test',
    nombreCompleto: 'Ana Pérez',
    ...over,
  });

  /** Correos que salieron por la Gmail API (la solicitud ya decodificada). */
  const correosEnviados = () =>
    fetchGmail.mock.calls
      .filter(([url]) => String(url).includes('gmail.googleapis.com'))
      .map(([, init]) => Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8'));

  beforeAll(async () => {
    (amqplib.connect as unknown as jest.Mock).mockResolvedValue({
      on: jest.fn(),
      createChannel: jest.fn().mockResolvedValue(canalRabbit),
      close: jest.fn().mockResolvedValue(undefined),
    });
    app = await NestFactory.create(NotificacionesDePruebaModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    // Lo que RabbitMQ llamaría con cada mensaje de la cola
    alRecibirMensaje = canalRabbit.consume.mock.calls[0][1];
  });

  afterAll(async () => {
    global.fetch = fetchReal;
    await app.close();
  });

  beforeEach(() => {
    notificaciones.rows.length = 0;
    contactos.rows.length = 0;
    canalRabbit.ack.mockClear();
    gmailResponde = 200;
    fetchGmail = jest.fn(async (url: unknown) =>
      String(url).includes('oauth2.googleapis.com')
        ? respuesta(200, { access_token: 'access-de-prueba', expires_in: 3600 })
        : respuesta(gmailResponde, { id: 'mensaje-1' }),
    );
    global.fetch = fetchGmail as never;
  });

  it('una transferencia enviada llega por RabbitMQ y el cliente ve el aviso en la app y recibe el comprobante por correo', async () => {
    const msg = mensaje(transferenciaEnviada(), '2026-11-13T10:00:00.000Z');

    await alRecibirMensaje(msg);

    expect(canalRabbit.ack).toHaveBeenCalledWith(msg);
    // Un solo correo, al destinatario del evento, por la Gmail API con el token renovado
    const correos = correosEnviados();
    expect(correos).toHaveLength(1);
    expect(correos[0]).toContain('To: ana@banklite.test');
    expect(correos[0]).toContain('From: avisos@banklite.test');
    const envio = fetchGmail.mock.calls.find(([url]) => String(url).includes('gmail.googleapis.com'))!;
    expect(envio[1].headers.Authorization).toBe('Bearer access-de-prueba');

    // El cliente consulta por HTTP: por defecto solo ve lo de la app
    const enApp = await http('GET', `/notifications/${ANA}`, { autorizacion: token(ANA) });
    expect(enApp.status).toBe(200);
    expect(enApp.body).toHaveLength(1);
    expect(enApp.body[0]).toMatchObject({
      channel: 'in_app',
      status: 'sent',
      read: false,
      title: 'Transferencia realizada',
    });
    expect(enApp.body[0].body).toContain('0002'); // cuenta destino enmascarada

    // Y el correo quedó registrado como enviado
    const porCorreo = await http('GET', `/notifications/${ANA}?channel=email`, { autorizacion: token(ANA) });
    expect(porCorreo.body).toHaveLength(1);
    expect(porCorreo.body[0]).toMatchObject({ channel: 'email', status: 'sent', deliveryAttempts: 1 });
  });

  it('marcar el aviso como leído lo saca de los no leídos; nadie lee ni marca los de otra persona y sin token es 401', async () => {
    await alRecibirMensaje(mensaje(transferenciaEnviada({ direction: 'in' }), '2026-11-13T10:01:00.000Z'));
    const [aviso] = (await http('GET', `/notifications/${ANA}`, { autorizacion: token(ANA) })).body;
    expect(aviso.title).toBe('Transferencia recibida');
    expect(correosEnviados()).toHaveLength(0); // recibir no genera correo

    expect((await http('GET', `/notifications/${ANA}`)).status).toBe(401);
    expect((await http('GET', `/notifications/${ANA}`, { autorizacion: token(CARLOS) })).status).toBe(403);
    expect((await http('PUT', `/notifications/${aviso.id}/read`, { autorizacion: token(CARLOS) })).status).toBe(403);

    expect((await http('PUT', `/notifications/${aviso.id}/read`, { autorizacion: token(ANA) })).status).toBe(200);
    const sinLeer = await http('GET', `/notifications/${ANA}?unread=true`, { autorizacion: token(ANA) });
    expect(sinLeer.body).toEqual([]);
  });

  it('si RabbitMQ entrega dos veces el mismo mensaje, no se duplican los avisos ni el correo', async () => {
    const original = mensaje(transferenciaEnviada(), '2026-11-13T10:02:00.000Z');
    const reentrega = mensaje(transferenciaEnviada(), '2026-11-13T10:02:00.000Z');

    await alRecibirMensaje(original);
    await alRecibirMensaje(reentrega);

    expect(canalRabbit.ack).toHaveBeenCalledWith(original);
    expect(canalRabbit.ack).toHaveBeenCalledWith(reentrega);
    expect(notificaciones.rows).toHaveLength(2); // app + correo, una sola vez
    expect(correosEnviados()).toHaveLength(1);
  });

  it('si Gmail falla, el aviso de la app igual llega, el correo queda pendiente con su reintento y luego se puede reenviar', async () => {
    gmailResponde = 500;

    await alRecibirMensaje(mensaje(transferenciaEnviada(), '2026-11-13T10:03:00.000Z'));

    const enApp = await http('GET', `/notifications/${ANA}`, { autorizacion: token(ANA) });
    expect(enApp.body[0]).toMatchObject({ channel: 'in_app', status: 'sent' });
    const [correo] = (await http('GET', `/notifications/${ANA}?channel=email`, { autorizacion: token(ANA) })).body;
    expect(correo).toMatchObject({ status: 'pending', deliveryAttempts: 1, lastError: 'No se pudo enviar el correo.' });
    expect(correo.nextAttemptAt).toBeTruthy();

    // Gmail se recupera y el panel reenvía el correo
    gmailResponde = 200;
    const reenviado = await app.get(NotificationsService).retryNow(correo.id);
    expect(reenviado).toMatchObject({ status: 'sent', nextAttemptAt: null, lastError: null });
  });

  it('el correo de bienvenida que llega por la ruta interna deja el contacto, y el comprobante posterior (sin correo en el evento) usa ese contacto', async () => {
    const bienvenida = await http('POST', '/notifications', {
      claveInterna: CLAVE_ACCOUNT,
      cuerpo: {
        idUser: ANA,
        event: 'account.created',
        payload: { email: 'Ana@Banklite.test', nombreCompleto: 'Ana Pérez' },
      },
    });
    expect(bienvenida.status).toBe(201);
    expect(correosEnviados()).toHaveLength(1);

    // ledger no incluye el correo en transaction.completed
    await alRecibirMensaje(
      mensaje(transferenciaEnviada({ email: undefined, nombreCompleto: undefined }), '2026-11-13T10:04:00.000Z'),
    );

    const correos = correosEnviados();
    expect(correos).toHaveLength(2);
    expect(correos[1]).toContain('To: ana@banklite.test'); // correo recordado, en minúsculas
  });

  it('la ruta interna exige la clave de un servicio de confianza y un cuerpo válido', async () => {
    const cuerpo = { idUser: ANA, event: 'account.created', payload: { email: 'ana@banklite.test' } };

    expect((await http('POST', '/notifications', { cuerpo })).status).toBe(401);
    expect((await http('POST', '/notifications', { cuerpo, claveInterna: 'otra-clave' })).status).toBe(401);
    expect(
      (
        await http('POST', '/notifications', {
          cuerpo: { ...cuerpo, idUser: 'no-es-uuid' },
          claveInterna: CLAVE_ACCOUNT,
        })
      ).status,
    ).toBe(400);

    expect(notificaciones.rows).toHaveLength(0);
    expect(correosEnviados()).toHaveLength(0);
  });

  it('un mensaje sin idUser se descarta con ack (no se reintenta eternamente) y no crea avisos ni correos', async () => {
    const msg = mensaje({ type: 'transfer', amount: 1_000 }, '2026-11-13T10:05:00.000Z');

    await alRecibirMensaje(msg);

    expect(canalRabbit.ack).toHaveBeenCalledWith(msg);
    expect(notificaciones.rows).toHaveLength(0);
    expect(correosEnviados()).toHaveLength(0);
  });
});
