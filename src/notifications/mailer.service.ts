import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GmailApiClient, readGmailCredentials } from './gmail-api.client';

@Injectable()
export class MailerService {
  private readonly logger = new Logger('MailerService[notification-service]');
  private gmail: GmailApiClient | null = null;

  constructor(private readonly config: ConfigService) {}

  private getGmail(): GmailApiClient | null {
    if (this.gmail) return this.gmail;
    const creds = readGmailCredentials((key) => this.config.get<string>(key));
    if (!creds) return null;
    this.gmail = new GmailApiClient(creds, 'GmailApiClient[notification-service]');
    return this.gmail;
  }

  /** Devuelve true si logró enviar, false si falló (nunca lanza). */
  async send(to: string, subject: string, html: string): Promise<boolean> {
    const gmail = this.getGmail();
    if (!gmail) {
      this.logger.warn(
        `GMAIL_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/SENDER no configurados. [degradado] correo a ${maskEmail(to)}: ${subject}`,
      );
      return false;
    }
    try {
      await gmail.send({ to, subject, html });
      return true;
    } catch (error) {
      this.logger.error(`No se pudo enviar correo a ${maskEmail(to)}: ${(error as Error).message}`);
      return false;
    }
  }
}

/** Para logs: 'laura.gomez@gmail.com' -> 'la***@gmail.com'. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain ?? ''}`;
}
