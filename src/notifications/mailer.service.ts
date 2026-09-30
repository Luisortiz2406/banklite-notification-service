import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailerService {
  private readonly logger = new Logger('MailerService[notification-service]');
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  private getTransporter(): nodemailer.Transporter | null {
    if (this.transporter) return this.transporter;
    const user = this.config.get<string>('GMAIL_SMTP_USER');
    const pass = this.config.get<string>('GMAIL_SMTP_APP_PASSWORD');
    if (!user || !pass) return null;
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      // Gmail muestra la App Password con espacios; se quitan igual que en auth-service.
      auth: { user, pass: pass.replace(/\s+/g, '') },
    });
    return this.transporter;
  }

  /** Devuelve true si logró enviar, false si falló (nunca lanza). */
  async send(to: string, subject: string, html: string): Promise<boolean> {
    const transporter = this.getTransporter();
    if (!transporter) {
      this.logger.warn(
        `GMAIL_SMTP_USER/APP_PASSWORD no configurados. [degradado] correo a ${to}: ${subject}`,
      );
      return false;
    }
    try {
      await transporter.sendMail({
        from: this.config.get<string>('GMAIL_SMTP_USER'),
        to,
        subject,
        html,
      });
      return true;
    } catch (error) {
      this.logger.error(`No se pudo enviar correo a ${to}: ${(error as Error).message}`);
      return false;
    }
  }
}
