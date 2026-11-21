import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSmtpMailer, SmtpError } from '../src/email/mailer.js';
import { loadConfig } from '../src/config.js';
import { buildPurchaseEmail } from '../src/email/purchaseEmail.js';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function smtpTransport() {
  const sendMail = vi.fn(async () => ({ messageId: 'smtp-message-id' }));
  const verify = vi.fn(async () => undefined);
  const close = vi.fn();
  vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail, verify, close } as never);
  return { sendMail, verify, close };
}

describe('SMTP real sin dependencia de Mailpit', () => {
  it('conserva el rechazo de remitente de SendGrid sin registrar claves o direcciones', async () => {
    const transport = smtpTransport();
    transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('Rejected'), {
      code: 'EENVELOPE', responseCode: 550, command: 'MAIL FROM',
      response: '550 The from address sender@example.com does not match a verified Sender Identity. smtp-secret',
    }));
    const mailer = createSmtpMailer({ host: 'smtp.sendgrid.net', port: 587, secure: false,
      timeoutMs: 4000, user: 'apikey', password: 'smtp-secret' }, 'sender@example.com');
    const failure = await mailer.send({ to: 'customer@example.com', subject: 'Test', html: '<p>Test</p>', text: 'Test', messageId: '<test@example.com>' }).catch((error) => error);
    expect(failure).toBeInstanceOf(SmtpError);
    expect(failure.details).toMatchObject({ category: 'sender_not_verified', smtpCode: 'EENVELOPE', smtpResponseCode: 550, smtpCommand: 'MAIL FROM' });
    expect(JSON.stringify(failure.details)).not.toContain('smtp-secret');
    expect(JSON.stringify(failure.details)).not.toContain('sender@example.com');
  });
  it('distingue credenciales rechazadas de un timeout', async () => {
    const transport = smtpTransport();
    const mailer = createSmtpMailer({ host: 'smtp.sendgrid.net', port: 587, secure: false, timeoutMs: 4000 }, 'sender@example.com');
    transport.verify.mockRejectedValueOnce(Object.assign(new Error('Authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }));
    await expect(mailer.verify()).rejects.toMatchObject({ kind: 'unavailable', details: { category: 'authentication', smtpResponseCode: 535 } });
    transport.verify.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
    await expect(mailer.verify()).rejects.toMatchObject({ kind: 'timeout', details: { category: 'timeout' } });
  });
  it.each([
    { host: 'smtp.example.com', port: 587, secure: false, ignoreTLS: false, requireTLS: true },
    { host: 'smtp.example.com', port: 465, secure: true, ignoreTLS: false, requireTLS: false },
    { host: '127.0.0.1', port: 1025, secure: false, ignoreTLS: true, requireTLS: false },
  ])('configura TLS para $host:$port', ({ host, port, secure, ignoreTLS, requireTLS }) => {
    smtpTransport();
    createSmtpMailer({ host, port, secure, timeoutMs: 4000, user: 'smtp-user', password: 'smtp-secret' }, 'EntradasYa <sender@example.com>');
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host, port, secure, ignoreTLS, requireTLS,
      auth: { user: 'smtp-user', pass: 'smtp-secret' } }));
  });

  it('entrega HTML compilado desde HBS y texto con el destinatario solicitado', async () => {
    const transport = smtpTransport();
    const mailer = createSmtpMailer({ host: 'smtp.example.com', port: 587, secure: false, timeoutMs: 4000 }, 'EntradasYa <sender@example.com>');
    const email = buildPurchaseEmail({ orderId: '40000000-0000-4000-8000-000000000001', to: 'customer@example.com',
      event: { title: '<Evento & Prueba>', venue: 'Teatro', startsAt: '2026-12-20T23:00:00Z' }, sector: { name: 'General' },
      quantity: 2, totalMinor: 15830, currency: 'BOB' }, { publicWebUrl: 'http://localhost:5173', timezone: 'America/La_Paz' });
    expect(email.html).toContain('&lt;Evento &amp; Prueba&gt;');
    expect(email.text).toContain('158,30 BOB');
    await expect(mailer.send({ to: 'customer@example.com', subject: email.subject, text: email.text, html: email.html, messageId: '<test@example.com>' }))
      .resolves.toEqual({ messageId: 'smtp-message-id' });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'customer@example.com',
      from: 'EntradasYa <sender@example.com>', html: email.html, text: email.text }));
    await mailer.verify(); mailer.close();
    expect(transport.verify).toHaveBeenCalledOnce(); expect(transport.close).toHaveBeenCalledOnce();
  });
});

describe('configuración SMTP', () => {
  function env() {
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) vi.stubEnv(key, '');
    vi.stubEnv('INTERNAL_TOKEN_ORDERS', 'test-internal-notifications-0123456789');
    vi.stubEnv('PUBLIC_WEB_URL', 'http://localhost:5173');
  }
  it('mantiene el modo local como alternativa y configura 587 para SMTP remoto', () => {
    env(); expect(loadConfig().smtp.port).toBe(1025);
    vi.stubEnv('SMTP_HOST', 'smtp.example.com'); vi.stubEnv('MAIL_FROM', 'EntradasYa <sender@example.com>');
    expect(loadConfig().smtp).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false });
  });
  it('rechaza combinaciones de puerto/TLS inválidas y credenciales incompletas', () => {
    env(); vi.stubEnv('SMTP_PORT', '465');
    expect(() => loadConfig()).toThrow('SMTP_SECURE=true');
    vi.stubEnv('SMTP_PORT', '587'); vi.stubEnv('SMTP_SECURE', 'true');
    expect(() => loadConfig()).toThrow('SMTP_SECURE=false');
    vi.stubEnv('SMTP_SECURE', 'false'); vi.stubEnv('SMTP_USER', 'user');
    expect(() => loadConfig()).toThrow('SMTP_USER y SMTP_PASSWORD van juntos');
  });
  it('exige remitente para SMTP externo', () => {
    env(); vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    expect(() => loadConfig()).toThrow('MAIL_FROM');
  });
  it('rechaza remitentes de ejemplo/local antes de intentar enviar', () => {
    env(); vi.stubEnv('SMTP_HOST', 'smtp.sendgrid.net');
    for (const sender of ['EntradasYa <correo-autorizado@tu-dominio.com>', 'EntradasYa <no-reply@entradasya.local>']) {
      vi.stubEnv('MAIL_FROM', sender);
      expect(() => loadConfig()).toThrow('remitente de ejemplo/local');
    }
  });
});
