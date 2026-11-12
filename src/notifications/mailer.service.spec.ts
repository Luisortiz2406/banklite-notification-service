import { ConfigService } from '@nestjs/config';
import { GmailApiClient, readGmailCredentials } from './gmail-api.client';
import { MailerService } from './mailer.service';

/**
 * Correo por la API de Gmail (fetch simulado: nunca se envía nada real). Lo que
 * importa: el remitente siempre es GMAIL_SENDER, un token vencido se renueva una
 * sola vez aunque lleguen varios correos a la vez, y el servicio de correo nunca
 * lanza: devuelve false para que la notificación se reintente.
 */
const creds = {
  clientId: 'id',
  clientSecret: 'secreto',
  refreshToken: 'refresh',
  sender: 'BankLite <no-reply@banklite.test>',
};
const json = (status: number, body: unknown = {}) =>
  Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

describe('readGmailCredentials', () => {
  it('lee las cuatro variables recortadas; si falta alguna devuelve null', () => {
    const env: Record<string, string> = {
      GMAIL_CLIENT_ID: ' id ',
      GMAIL_CLIENT_SECRET: 'secreto',
      GMAIL_REFRESH_TOKEN: 'refresh',
      GMAIL_SENDER: 'a@b.co',
    };
    expect(readGmailCredentials((key) => env[key])).toEqual({
      clientId: 'id',
      clientSecret: 'secreto',
      refreshToken: 'refresh',
      sender: 'a@b.co',
    });
    for (const key of Object.keys(env)) {
      expect(readGmailCredentials((k) => (k === key ? '  ' : env[k]))).toBeNull();
    }
  });
});

describe('GmailApiClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const routes = (overrides: { token?: () => Promise<Response>; send?: () => Promise<Response> } = {}) => {
    fetchMock.mockImplementation((url: string) =>
      url === TOKEN_URL
        ? (overrides.token?.() ?? json(200, { access_token: 'token-1', expires_in: 3600 }))
        : (overrides.send?.() ?? json(200, { id: 'm1' })),
    );
  };
  const sendCalls = () => fetchMock.mock.calls.filter((call) => call[0] === SEND_URL);
  const tokenCalls = () => fetchMock.mock.calls.filter((call) => call[0] === TOKEN_URL);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('arma el correo con el remitente configurado (aunque el mensaje traiga otro) y lo manda con el token', async () => {
    routes();
    const client = new GmailApiClient(creds, 'Prueba');

    await client.send({
      to: 'ana@banklite.test',
      subject: 'Hola ñandú',
      html: '<b>Texto</b>',
      from: 'otro@x.co',
    } as never);

    const [, init] = sendCalls()[0];
    expect(init.headers.Authorization).toBe('Bearer token-1');
    const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: ana@banklite.test');
    expect(raw).toContain('no-reply@banklite.test');
    expect(raw).not.toContain('otro@x.co');
    expect(raw).toContain('<b>Texto</b>');
    expect(tokenCalls()[0][1].body.toString()).toContain('grant_type=refresh_token');
  });

  it('reutiliza el token mientras vale y renueva uno solo cuando varios correos lo piden a la vez', async () => {
    routes();
    const client = new GmailApiClient(creds, 'Prueba');

    await Promise.all([1, 2, 3].map(() => client.send({ to: 'a@b.co', subject: 's', html: 'x' })));
    await client.send({ to: 'a@b.co', subject: 's', html: 'x' });

    expect(tokenCalls()).toHaveLength(1);
    expect(sendCalls()).toHaveLength(4);
  });

  it('un 401 al enviar descarta el token para pedir otro en el siguiente correo', async () => {
    routes({ send: () => json(401, 'token vencido') });
    const client = new GmailApiClient(creds, 'Prueba');

    await expect(client.send({ to: 'a@b.co', subject: 's', html: 'x' })).rejects.toThrow('Gmail API respondió 401');
    routes();
    await client.send({ to: 'a@b.co', subject: 's', html: 'x' });

    expect(tokenCalls()).toHaveLength(2);
  });

  it('si Gmail rechaza el envío, el error trae el estado y un extracto de la respuesta', async () => {
    routes({ send: () => json(403, 'x'.repeat(1000)) });
    const client = new GmailApiClient(creds, 'Prueba');

    const error = await client.send({ to: 'a@b.co', subject: 's', html: 'x' }).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/^Gmail API respondió 403: x{300}$/);
  });

  it('si Google rechaza el refresh token (invalid_grant) lo dice claro y no se envía nada', async () => {
    routes({ token: () => json(400, { error: 'invalid_grant', error_description: 'Token has been revoked' }) });
    const client = new GmailApiClient(creds, 'Prueba');

    await expect(client.send({ to: 'a@b.co', subject: 's', html: 'x' })).rejects.toThrow(
      'No se pudo renovar el access token de Gmail: invalid_grant Token has been revoked',
    );
    expect(sendCalls()).toHaveLength(0);
  });

  it('una respuesta de token sin access_token o sin JSON también es un error', async () => {
    routes({ token: () => json(200, {}) });
    await expect(new GmailApiClient(creds, 'P').send({ to: 'a@b.co', subject: 's', html: 'x' })).rejects.toThrow(
      'No se pudo renovar el access token de Gmail',
    );
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        status: 502,
        ok: false,
        json: async () => {
          throw new Error('no es JSON');
        },
      } as unknown as Response),
    );
    await expect(new GmailApiClient(creds, 'P').send({ to: 'a@b.co', subject: 's', html: 'x' })).rejects.toThrow('502');
  });
});

describe('MailerService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const env = {
    GMAIL_CLIENT_ID: 'id',
    GMAIL_CLIENT_SECRET: 'secreto',
    GMAIL_REFRESH_TOKEN: 'refresh',
    GMAIL_SENDER: 'no-reply@banklite.test',
  };

  beforeEach(() => {
    fetchMock = jest.fn((url: string) => (url === TOKEN_URL ? json(200, { access_token: 't' }) : json(200)));
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sin credenciales de Gmail no envía, devuelve false y no hace ninguna llamada de red', async () => {
    const mailer = new MailerService(new ConfigService({}));

    expect(await mailer.send('ana@banklite.test', 'Asunto', '<p>Hola</p>')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con credenciales envía por Gmail y devuelve true; reutiliza el mismo cliente', async () => {
    const mailer = new MailerService(new ConfigService(env));

    expect(await mailer.send('ana@banklite.test', 'Asunto', '<p>Hola</p>')).toBe(true);
    expect(await mailer.send('ana@banklite.test', 'Otro', '<p>Hola</p>')).toBe(true);

    expect(fetchMock.mock.calls.filter((call) => call[0] === TOKEN_URL)).toHaveLength(1);
  });

  it('si Gmail falla devuelve false (nunca lanza) para que la notificación se reintente', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === TOKEN_URL ? json(200, { access_token: 't' }) : json(500, 'error de Gmail'),
    );
    const mailer = new MailerService(new ConfigService(env));

    await expect(mailer.send('laura.gomez@gmail.com', 'Asunto', '<p>Hola</p>')).resolves.toBe(false);
  });
});
