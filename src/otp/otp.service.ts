import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { Repository } from 'typeorm';
import { OtpChallenge } from './entities/otp-challenge.entity';

const CODE_TTL_SECONDS = 5 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;
// Llamada a Meta: 2 intentos de 6 s + 1 s de pausa = 13 s, por debajo de los
// 15 s con los que auth-service espera a este servicio.
const WHATSAPP_ATTEMPTS = 2;
const WHATSAPP_TIMEOUT_MS = 6_000;
const WHATSAPP_RETRY_DELAY_MS = 1_000;
type OtpPurpose = 'registration' | 'password_reset';

@Injectable()
export class OtpService {
  private readonly logger = new Logger('OtpService');

  constructor(
    @InjectRepository(OtpChallenge)
    private readonly challenges: Repository<OtpChallenge>,
    private readonly config: ConfigService,
  ) {}

  async sendCode(idUser: string, phone: string, purpose: OtpPurpose = 'registration') {
    const normalizedPhone = phone.trim();
    let challenge = await this.challenges.findOne({ where: { idUser, purpose } });

    if (
      challenge &&
      !challenge.verified &&
      challenge.phone === normalizedPhone &&
      challenge.lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 > Date.now()
    ) {
      const remaining = Math.ceil(
        (challenge.lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000,
      );
      throw new ConflictException(`Espera ${remaining} segundos antes de solicitar otro código.`);
    }

    const code = String(randomInt(100000, 1000000));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000);

    await this.sendWhatsAppMessage(normalizedPhone, code);

    const values = {
      idUser,
      purpose,
      phone: normalizedPhone,
      codeHash: await bcrypt.hash(code, 12),
      expiresAt,
      lastSentAt: now,
      attempts: 0,
      verified: false,
    };
    if (!challenge) challenge = this.challenges.create(values);
    else Object.assign(challenge, values);
    await this.challenges.save(challenge);

    return {
      sent: true,
      phone: normalizedPhone,
      expiresInSeconds: CODE_TTL_SECONDS,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifyCode(idUser: string, phone: string, code: string, purpose: OtpPurpose = 'registration') {
    const challenge = await this.challenges.findOne({ where: { idUser, purpose } });
    if (!challenge || challenge.phone !== phone.trim()) {
      throw new BadRequestException('No existe un código pendiente para ese teléfono.');
    }
    if (challenge.verified) return { verified: true, phone: challenge.phone };
    if (challenge.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('El código ha expirado. Solicita uno nuevo.');
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Demasiados intentos. Solicita un código nuevo.');
    }

    challenge.attempts += 1;
    const valid = await bcrypt.compare(code, challenge.codeHash);
    if (!valid) {
      await this.challenges.save(challenge);
      throw new BadRequestException('Código de WhatsApp incorrecto.');
    }

    challenge.verified = true;
    await this.challenges.save(challenge);
    return { verified: true, phone: challenge.phone };
  }

  async isVerified(idUser: string, phone?: string) {
    const challenge = await this.challenges.findOne({ where: { idUser, purpose: 'registration' } });
    return Boolean(challenge?.verified && (!phone || challenge.phone === phone.trim()));
  }

  private async sendWhatsAppMessage(phone: string, code: string) {
    const accessToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!accessToken || !phoneNumberId) {
      throw new ServiceUnavailableException(
        'WhatsApp Cloud API no está configurada. Define WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID.',
      );
    }

    const version = this.config.get<string>('WHATSAPP_API_VERSION', 'v23.0');
    const templateName = this.config.get<string>('WHATSAPP_OTP_TEMPLATE_NAME', 'caedomi_codigo_verificacion');
    const languageCode = this.config.get<string>('WHATSAPP_OTP_TEMPLATE_LANGUAGE', 'es_CO');
    const includeButton = this.config.get<string>('WHATSAPP_OTP_INCLUDE_BUTTON', 'true') === 'true';
    const message = {
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          ...(includeButton
            ? [{
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: code }],
              }]
            : []),
        ],
      },
    };

    const request = () =>
      fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          ...message,
        }),
        signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS),
      });

    // Solo se reintentan fallos de red (DNS, conexión, tiempo agotado); si Meta
    // responde, aunque sea con error, no se reintenta. Un reintento tras un
    // tiempo agotado puede duplicar el mensaje, pero lleva el mismo código.
    let response: Response | null = null;
    for (let attempt = 1; attempt <= WHATSAPP_ATTEMPTS && !response; attempt++) {
      try {
        response = await request();
      } catch (error) {
        const cause = (error as any)?.cause;
        this.logger.warn(
          `WhatsApp Cloud API no respondió (intento ${attempt}/${WHATSAPP_ATTEMPTS}): ` +
            `${(error as Error).name}: ${(error as Error).message}` +
            (cause ? ` [${cause.code ?? cause.message ?? cause}]` : ''),
        );
        if (attempt < WHATSAPP_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, WHATSAPP_RETRY_DELAY_MS));
        }
      }
    }
    if (!response) {
      throw new ServiceUnavailableException('No se pudo contactar a WhatsApp Cloud API. Inténtalo de nuevo.');
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const metaMessage = typeof payload?.error?.message === 'string' ? payload.error.message : '';
      this.logger.warn(`WhatsApp Cloud API respondió ${response.status}: ${metaMessage || 'sin mensaje'}`);
      throw new ServiceUnavailableException(
        metaMessage
          ? `WhatsApp Cloud API rechazó el mensaje: ${metaMessage}`
          : 'WhatsApp Cloud API rechazó el mensaje.',
      );
    }
  }
}
