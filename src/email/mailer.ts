import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  headers?: Record<string, string>;
}

export interface Mailer {
  /** Envía y devuelve el Message-ID aceptado por el servidor SMTP. */
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Comprueba que el servidor SMTP responde (para /health). */
  verify(): Promise<void>;
  close(): void;
}

/** Fallo del envío clasificado para responder a orders. */
export class SmtpError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'unavailable',
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT']);

function classify(error: unknown, secrets: string[] = []): SmtpError {
  if (error instanceof SmtpError) return error;
  const value = error as { code?: unknown; responseCode?: unknown; command?: unknown; response?: unknown; message?: unknown } | null;
  const code = value?.code;
  const raw = typeof value?.response === 'string' ? value.response : typeof value?.message === 'string' ? value.message : '';
  let description = raw;
  const patterns = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (patterns.length) description = description.replace(new RegExp(`(?:${patterns.join('|')})`, 'g'), '[redacted]');
  description = description.replace(/SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[credential]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[\r\n\t]/g, ' ').slice(0, 500);
  const category = /verified.*sender|sender.*identity|sender.*verif/i.test(raw) ? 'sender_not_verified'
    : code === 'EAUTH' ? 'authentication' : code === 'ETLS' || /certificate|STARTTLS/i.test(raw) ? 'tls'
    : TIMEOUT_CODES.has(String(code)) ? 'timeout' : 'smtp';
  const details = {
    category,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code) ? { smtpCode: code } : {}),
    ...(Number.isInteger(value?.responseCode) ? { smtpResponseCode: value!.responseCode } : {}),
    ...(typeof value?.command === 'string' && /^(CONN|STARTTLS|AUTH (PLAIN|LOGIN|XOAUTH2|CRAM-MD5)|MAIL FROM|RCPT TO|DATA)$/.test(value.command) ? { smtpCommand: value.command } : {}),
    ...(description ? { smtpResponse: description } : {}),
  };
  return TIMEOUT_CODES.has(String(code))
    ? new SmtpError('timeout', 'El servidor SMTP no respondió a tiempo', details)
    : new SmtpError('unavailable', 'El servidor SMTP no está disponible', details);
}

/** Corta cualquier operación que supere el límite, aunque el socket siga abierto. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError('timeout', 'El envío superó el tiempo máximo')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createSmtpMailer(smtp: Config['smtp'], from: string): Mailer {
  const secrets = smtp.password ? [smtp.password, Buffer.from(smtp.password).toString('base64'),
    Buffer.from(`\0${smtp.user ?? ''}\0${smtp.password}`).toString('base64')] : [];
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(smtp.host.toLowerCase());
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    // 465: TLS desde el inicio. 587: conexión inicial + STARTTLS obligatorio.
    // Solo el servidor de pruebas en loopback puede trabajar sin cifrado.
    ignoreTLS: local && !smtp.secure,
    requireTLS: !local && !smtp.secure,
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
    // Cada envío abre su conexión; no reutiliza un socket caído.
    pool: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return {
    async send(mail) {
      try {
        const info = await withDeadline(
          transport.sendMail({
            from,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            messageId: mail.messageId,
            headers: mail.headers,
          }),
          smtp.timeoutMs,
        );
        return { messageId: info.messageId };
      } catch (error) {
        throw classify(error, secrets);
      }
    },
    async verify() {
      try {
        await withDeadline(transport.verify(), smtp.timeoutMs);
      } catch (error) {
        throw classify(error, secrets);
      }
    },
    close() {
      transport.close();
    },
  };
}
