import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export type SendMailParams = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

@Injectable()
export class MailerService {
  private transporter: nodemailer.Transporter | null = null;
  private from: string = '';
  private initialized = false;

  constructor(private readonly config: ConfigService) {
    this.init();
  }

  private init(): void {
    const from = (this.config.get('EMAIL_FROM') ?? this.config.get('SMTP_USER') ?? '').toString().trim();
    if (!from) {
      return;
    }
    this.from = from;
    const smtpService = (this.config.get('SMTP_SERVICE') ?? '').toString().trim().toLowerCase();
    const smtpUser = (this.config.get('SMTP_USER') ?? '').toString().trim();
    const smtpHost = (this.config.get('SMTP_HOST') ?? '').toString().trim();
    const smtpPass = (this.config.get('SMTP_PASS') ?? '').toString().trim();
    const inferredGmail =
      smtpService === 'gmail' ||
      (smtpUser.toLowerCase().endsWith('@gmail.com') && !smtpHost);
    const host = inferredGmail ? 'smtp.gmail.com' : smtpHost;
    if (!host) {
      return;
    }
    const portRaw = (this.config.get('SMTP_PORT') ?? '').toString().trim();
    const port = portRaw ? Number(portRaw) : inferredGmail ? 465 : 587;
    const secure =
      (this.config.get('SMTP_SECURE') ?? '').toString().toLowerCase() === 'true' || (inferredGmail ? true : port === 465);
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: smtpUser ? { user: smtpUser, pass: smtpPass || undefined } : undefined,
    });
    this.initialized = true;
  }

  async send(params: SendMailParams): Promise<void> {
    if (!this.initialized || !this.transporter || !this.from) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[Mailer] DEV: would send to ${params.to}\nSubject: ${params.subject}\n${params.text ?? params.html ?? ''}`,
        );
      }
      return;
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });
    } catch (err) {
      console.error('[Mailer] Failed to send email:', err);
    }
  }
}
