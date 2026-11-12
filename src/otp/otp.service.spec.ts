import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { OtpChallenge } from './entities/otp-challenge.entity';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';

/**
 * Códigos de verificación por WhatsApp (Cloud API de Meta simulada con fetch: nunca se
 * envía un mensaje real). Lo que importa: el código solo se guarda como hash, vence a
 * los 5 minutos, tiene 5 intentos, no se reenvía antes de 60 s y un fallo de Meta nunca
 * deja un código "enviado" que el cliente no recibió.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const PHONE = '+573001234567';
const ENV = { WHATSAPP_ACCESS_TOKEN: 'token-meta', WHATSAPP_PHONE_NUMBER_ID: '123456789' };

function fakeChallenges() {
  const rows: Record<string, any>[] = [];
  return {
    rows,
    create: jest.fn((values: Record<string, any>) => ({ ...values })),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, any> }) =>
        rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null,
    ),
    save: jest.fn(async (row: Record<string, any>) => {
      row.id ??= randomUUID();
      if (!rows.includes(row)) rows.push(row);
      return row;
    }),
  };
}
const metaOk = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
const metaError = (status: number, message?: string) =>
  Promise.resolve({
    ok: false,
    status,
    json: async () => (message ? { error: { message } } : {}),
  } as unknown as Response);

describe('OtpService', () => {
  const realFetch = global.fetch;
  let challenges: ReturnType<typeof fakeChallenges>;
  let fetchMock: jest.Mock;
  const build = (env: Record<string, string> = ENV) =>
    new OtpService(challenges as unknown as Repository<OtpChallenge>, new ConfigService(env));
  /** El código que se mandó por WhatsApp (el último mensaje enviado a Meta). */
  const sentCode = () => {
    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    return body.template.components[0].parameters[0].text as string;
  };

  beforeEach(() => {
    challenges = fakeChallenges();
    fetchMock = jest.fn().mockImplementation(metaOk);
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  describe('enviar el código', () => {
    it('manda una plantilla de WhatsApp con el código de 6 dígitos y guarda solo su hash', async () => {
      const result = await build().sendCode(ANA, ` ${PHONE} `);

      expect(result).toMatchObject({ sent: true, phone: PHONE, expiresInSeconds: 300 });
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now() + 290_000);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v23.0/123456789/messages');
      expect(init.headers.Authorization).toBe('Bearer token-meta');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        messaging_product: 'whatsapp',
        to: PHONE,
        type: 'template',
        template: { name: 'caedomi_codigo_verificacion', language: { code: 'es_CO' } },
      });
      expect(sentCode()).toMatch(/^\d{6}$/);
      // Con botón por defecto: el código también va en el botón.
      expect(body.template.components[1]).toMatchObject({ type: 'button', parameters: [{ text: sentCode() }] });

      const [row] = challenges.rows;
      expect(row).toMatchObject({ idUser: ANA, phone: PHONE, purpose: 'registration', attempts: 0, verified: false });
      expect(row.codeHash).not.toContain(sentCode());
    });

    it('la plantilla, el idioma, la versión y el botón se pueden configurar', async () => {
      await build({
        ...ENV,
        WHATSAPP_API_VERSION: 'v99.0',
        WHATSAPP_OTP_TEMPLATE_NAME: 'mi_plantilla',
        WHATSAPP_OTP_TEMPLATE_LANGUAGE: 'es_MX',
        WHATSAPP_OTP_INCLUDE_BUTTON: 'false',
      }).sendCode(ANA, PHONE);

      expect(fetchMock.mock.calls[0][0]).toContain('/v99.0/');
      const { template } = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(template).toMatchObject({ name: 'mi_plantilla', language: { code: 'es_MX' } });
      expect(template.components).toHaveLength(1);
    });

    it('no reenvía antes de 60 segundos al mismo teléfono (409), pero sí a otro teléfono o pasado el tiempo', async () => {
      const otp = build();
      await otp.sendCode(ANA, PHONE);

      await expect(otp.sendCode(ANA, PHONE)).rejects.toBeInstanceOf(ConflictException);
      await expect(otp.sendCode(ANA, PHONE)).rejects.toThrow(/Espera \d+ segundos/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await expect(otp.sendCode(ANA, '+573117654321')).resolves.toMatchObject({ sent: true });

      challenges.rows[0].lastSentAt = new Date(Date.now() - 61_000);
      await expect(otp.sendCode(ANA, '+573117654321')).resolves.toMatchObject({ sent: true });
      expect(challenges.rows).toHaveLength(1); // se reutiliza la fila del usuario
    });

    it('el código de recuperación de clave es aparte del de registro', async () => {
      const otp = build();
      await otp.sendCode(ANA, PHONE);
      await expect(otp.sendCode(ANA, PHONE, 'password_reset')).resolves.toMatchObject({ sent: true });

      expect(challenges.rows.map((row) => row.purpose)).toEqual(['registration', 'password_reset']);
    });

    it('sin las variables de WhatsApp no envía nada ni guarda un código (503)', async () => {
      await expect(build({}).sendCode(ANA, PHONE)).rejects.toThrow('WhatsApp Cloud API no está configurada');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(challenges.rows).toHaveLength(0);
    });

    it('si Meta responde con error (por ejemplo, número inválido) no se reintenta y no se guarda el código', async () => {
      fetchMock.mockImplementation(() => metaError(400, 'Número no válido'));

      await expect(build().sendCode(ANA, PHONE)).rejects.toThrow(
        'WhatsApp Cloud API rechazó el mensaje: Número no válido',
      );
      fetchMock.mockImplementation(() => metaError(500));
      await expect(build().sendCode(ANA, PHONE)).rejects.toThrow('WhatsApp Cloud API rechazó el mensaje.');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(challenges.rows).toHaveLength(0);
    });

    it('un fallo de red se reintenta una vez con el mismo código; si vuelve a fallar es 503', async () => {
      jest.useFakeTimers();
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockImplementationOnce(metaOk);
      const pending = build().sendCode(ANA, PHONE);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ sent: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset().mockRejectedValue(new Error('timeout'));
      challenges.rows.length = 0;
      const failing = build().sendCode(ANA, PHONE);
      const assertion = expect(failing).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(challenges.rows).toHaveLength(0);
    });
  });

  describe('verificar el código', () => {
    const issue = async (otp = build(), purpose?: 'password_reset') => {
      await otp.sendCode(ANA, PHONE, purpose);
      return sentCode();
    };

    it('con el código correcto queda verificado, y volver a verificar responde lo mismo', async () => {
      const otp = build();
      const code = await issue(otp);

      expect(await otp.verifyCode(ANA, ` ${PHONE} `, code)).toEqual({ verified: true, phone: PHONE });
      expect(await otp.verifyCode(ANA, PHONE, '000000')).toEqual({ verified: true, phone: PHONE });
      expect(await otp.isVerified(ANA)).toBe(true);
      expect(await otp.isVerified(ANA, PHONE)).toBe(true);
      expect(await otp.isVerified(ANA, '+573117654321')).toBe(false);
    });

    it('un código incorrecto cuenta el intento y a los 5 intentos hay que pedir otro, aunque luego acierte', async () => {
      const otp = build();
      const code = await issue(otp);
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        await expect(otp.verifyCode(ANA, PHONE, wrong)).rejects.toThrow('Código de WhatsApp incorrecto');
      }
      expect(challenges.rows[0].attempts).toBe(5);
      await expect(otp.verifyCode(ANA, PHONE, code)).rejects.toThrow('Demasiados intentos');
      expect(await otp.isVerified(ANA)).toBe(false);
    });

    it('un código vencido o de otro teléfono o sin pedir se rechaza', async () => {
      const otp = build();
      await expect(otp.verifyCode(ANA, PHONE, '123456')).rejects.toThrow('No existe un código pendiente');
      const code = await issue(otp);

      await expect(otp.verifyCode(ANA, '+573117654321', code)).rejects.toThrow('No existe un código pendiente');
      challenges.rows[0].expiresAt = new Date(Date.now() - 1_000);
      await expect(otp.verifyCode(ANA, PHONE, code)).rejects.toBeInstanceOf(BadRequestException);
      await expect(otp.verifyCode(ANA, PHONE, code)).rejects.toThrow('El código ha expirado');
    });

    it('el de recuperación de clave no verifica el registro, ni al revés', async () => {
      const otp = build();
      const resetCode = await issue(otp, 'password_reset');

      await expect(otp.verifyCode(ANA, PHONE, resetCode)).rejects.toThrow('No existe un código pendiente');
      expect(await otp.verifyCode(ANA, PHONE, resetCode, 'password_reset')).toMatchObject({ verified: true });
      expect(await otp.isVerified(ANA)).toBe(false); // el estado de registro es aparte
    });
  });

  describe('OtpController', () => {
    const service = {
      sendCode: jest.fn().mockResolvedValue({ sent: true }),
      verifyCode: jest.fn().mockResolvedValue({ verified: true }),
      isVerified: jest.fn().mockResolvedValue(true),
    };
    const controller = new OtpController(service as unknown as OtpService);

    it('solo se llama con la clave interna y cada ruta usa su propósito', async () => {
      expect(Reflect.getMetadata('__guards__', OtpController)).toContain(InternalKeyGuard);

      await controller.send({ idUser: ANA, phone: PHONE });
      expect(service.sendCode).toHaveBeenLastCalledWith(ANA, PHONE);
      await controller.verify({ idUser: ANA, phone: PHONE, code: '123456' });
      expect(service.verifyCode).toHaveBeenLastCalledWith(ANA, PHONE, '123456');
      await controller.sendPasswordReset({ idUser: ANA, phone: PHONE });
      expect(service.sendCode).toHaveBeenLastCalledWith(ANA, PHONE, 'password_reset');
      await controller.verifyPasswordReset({ idUser: ANA, phone: PHONE, code: '123456' });
      expect(service.verifyCode).toHaveBeenLastCalledWith(ANA, PHONE, '123456', 'password_reset');
      expect(await controller.status(ANA)).toBe(true);
    });
  });
});
