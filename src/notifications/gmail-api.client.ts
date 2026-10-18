import { Logger } from '@nestjs/common';
import MailComposer = require('nodemailer/lib/mail-composer');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TOKEN_CACHE_MS = 55 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sender: string;
}

export interface GmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Envía correo con la Gmail API por HTTPS (Railway bloquea los puertos SMTP).
 * Nodemailer solo arma el MIME; el envío va a users/me/messages/send.
 * Copia idéntica en auth-service/src/auth/gmail-api.client.ts.
 */
export class GmailApiClient {
  private readonly logger: Logger;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly creds: GmailCredentials,
    loggerContext: string,
  ) {
    this.logger = new Logger(loggerContext);
  }

  async send(message: GmailMessage): Promise<void> {
    // El remitente siempre es GMAIL_SENDER, aunque el mensaje traiga otro.
    const mime: Buffer = await new MailComposer({ ...message, from: this.creds.sender }).compile().build();
    const token = await this.getAccessToken();
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: mime.toString('base64url') }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) this.accessToken = null;
    if (!res.ok) {
      throw new Error(`Gmail API respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    // Si varios correos piden token a la vez, comparten una sola renovación.
    this.pendingToken ??= this.refreshAccessToken().finally(() => (this.pendingToken = null));
    return this.pendingToken;
  }

  private async refreshAccessToken(): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        this.logger.error(
          'Google rechazó GMAIL_REFRESH_TOKEN (invalid_grant): el token venció o fue revocado. ' +
            'Hay que regenerar GMAIL_REFRESH_TOKEN en OAuth Playground y actualizarlo en las variables del servicio. ' +
            'Ningún correo se enviará hasta entonces.',
        );
      }
      throw new Error(
        `No se pudo renovar el access token de Gmail: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim(),
      );
    }
    const expiresInMs = (body.expires_in ?? 3600) * 1000;
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.min(TOKEN_CACHE_MS, expiresInMs - 60_000);
    return body.access_token;
  }
}

/** Lee GMAIL_* de la configuración; devuelve null si falta alguna. */
export function readGmailCredentials(get: (key: string) => string | undefined): GmailCredentials | null {
  const clientId = get('GMAIL_CLIENT_ID')?.trim();
  const clientSecret = get('GMAIL_CLIENT_SECRET')?.trim();
  const refreshToken = get('GMAIL_REFRESH_TOKEN')?.trim();
  const sender = get('GMAIL_SENDER')?.trim();
  if (!clientId || !clientSecret || !refreshToken || !sender) return null;
  return { clientId, clientSecret, refreshToken, sender };
}
