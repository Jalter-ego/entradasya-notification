import { readFileSync } from 'node:fs';
import Handlebars from 'handlebars';

// Ruta relativa a este módulo: funciona tanto en src/ (tsx) como en dist/.
// {{valor}} escapa el HTML del evento; no usar triple llave para datos externos.
const purchaseTemplate = Handlebars.compile(readFileSync(new URL('./templates/purchase-confirmation.hbs', import.meta.url), 'utf8'), { strict: true });

export interface PurchaseNotification {
  orderId: string;
  to: string;
  event: { title: string; venue: string; startsAt: string };
  sector: { name: string };
  quantity: number;
  totalMinor: number;
  currency: string;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
  ticketsUrl: string;
}

/** 123456 -> "1.234,56" sin pasar por números decimales. */
export function formatMinor(amountMinor: number): string {
  const units = Math.floor(amountMinor / 100);
  const cents = String(amountMinor % 100).padStart(2, '0');
  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${cents}`;
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-BO', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Enlace público a Mis entradas filtrado por la orden. No lleva JWT ni ruta al PDF:
 * el comprador inicia sesión y tickets comprueba que las entradas son suyas.
 */
export function ticketsLink(publicWebUrl: string, orderId: string): string {
  const url = new URL('/mis-entradas', `${publicWebUrl}/`);
  url.searchParams.set('orderId', orderId);
  return url.toString();
}

export function buildPurchaseEmail(
  input: PurchaseNotification,
  options: { publicWebUrl: string; timezone: string },
): EmailContent {
  const ticketsUrl = ticketsLink(options.publicWebUrl, input.orderId);
  const when = formatDate(input.event.startsAt, options.timezone);
  const total = `${formatMinor(input.totalMinor)} ${input.currency}`;
  const entries = input.quantity === 1 ? '1 entrada' : `${input.quantity} entradas`;

  const rows: [string, string][] = [
    ['Evento', input.event.title],
    ['Fecha', when],
    ['Lugar', input.event.venue],
    ['Sector', input.sector.name],
    ['Cantidad', entries],
    ['Total pagado', total],
    ['N.º de orden', input.orderId],
  ];

  const subject = `Compra confirmada: ${input.event.title}`;

  const text = [
    '¡Gracias por tu compra en EntradasYa!',
    '',
    'Tu pago fue aprobado y tus entradas ya están listas.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Descarga tus entradas (PDF con código QR) desde Mis entradas:',
    ticketsUrl,
    '',
    'Inicia sesión con la misma cuenta con la que compraste. Cada entrada es válida para un solo ingreso.',
    '',
    'Correo de demostración: no se cobró dinero real.',
  ].join('\n');

  const html = purchaseTemplate({ rows: rows.map(([label, value]) => ({ label, value })), ticketsUrl });

  return { subject, text, html, ticketsUrl };
}
