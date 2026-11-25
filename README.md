# notifications - EntradasYa (P4)

Envía el **correo de confirmación** de una compra pagada mediante Nodemailer y SMTP real (por ejemplo SendGrid). Mailpit queda como alternativa local opcional. Servicio interno, **sin base de datos**: solo lo llama orders, con un token exclusivo del par orders ↔ notifications. El estado del envío lo guarda orders en `notification_status`.


- Contrato HTTP: [`contracts/notifications.openapi.yaml`](../../contracts/notifications.openapi.yaml).
- Datos: [README de bases, sección P4](../../docs/database/README.md#6-p4--payments_db-y-notifications).
- Plan: tareas D4, D5 y D7 del [plan de implementación](../../docs/Plan_de_implementacion_EntradasYa_v1.md#p4---pago-correo-y-soporte-de-datos).

## Requisitos

- Node.js 20.11 o superior y pnpm.
- Cuenta/proveedor SMTP y remitente autorizado. Para pruebas sin entrega externa, Mailpit en `127.0.0.1:1025` es opcional.

## Preparar y ejecutar

```bash
cd notifications
pnpm install
cp .env.example .env      # completar INTERNAL_TOKEN_ORDERS
pnpm run dev
curl http://127.0.0.1:3006/health    # 200 si el SMTP responde y autentica; 503 si no
```

| Comando | Uso |
|---|---|
| `pnpm run dev` | Desarrollo con recarga. |
| `pnpm run build` y `pnpm start` | Compilar y ejecutar `dist/`. |
| `pnpm run typecheck` | Comprobar tipos. |
| `pnpm test` | Pruebas; no necesitan Mailpit. |

## Envío real con SendGrid

El proyecto de referencia `wabi_notification` utiliza Nodemailer con SendGrid y plantillas Handlebars. Este servicio mantiene el mismo patrón con configuración propia. Las variables originales `SENDGRID_HOST`, `SENDGRID_USER`, `SENDGRID_API_KEY` y `AWS_MAIL_USER` corresponden aquí a `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` y `MAIL_FROM`; no se copian claves del proyecto de referencia.

Configurar en `.env` los valores de [.env.smtp.example](.env.smtp.example), conservando el token interno, puerto y URL de la web existentes:

```dotenv
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASSWORD=tu-api-key-propia-de-sendgrid
MAIL_FROM="EntradasYa <tu-remitente-verificado@tu-dominio.com>"
```

SendGrid requiere una API key con permiso para enviar correo y un remitente verificado (por correo individual o dominio autenticado). `apikey` es el usuario literal, no la dirección del remitente. Reiniciar notifications después de cambiar `.env`. Con este SMTP ya no se necesita ejecutar Mailpit.

- Puerto 587: `SMTP_SECURE=false`; el servicio exige STARTTLS para SMTP fuera de loopback.
- Puerto 465: `SMTP_SECURE=true`; TLS desde el inicio.
- La validación de certificados permanece habilitada.
- El `200` indica aceptación por el servidor SMTP, no garantiza llegada a la bandeja de entrada: revisar spam/rebotes y la actividad de SendGrid.
- Usar un destinatario real en la cuenta de cliente. `cliente@demo.bo` es un destinatario de prueba, no una cuenta real.
- `PUBLIC_WEB_URL` debe apuntar al frontend accesible por quien recibe el correo. Un enlace a localhost funciona solo en el equipo que ejecuta la aplicación.
- `SMTP_TIMEOUT_MS` debe ser menor que el timeout HTTP de notifications en orders. Si se amplía para el proveedor real, ampliar también el timeout consumidor.
- El envío del correo real es independiente de que la compra sea simulada; el pie de la plantilla identifica la compra de demostración.

Configurar credenciales propias y remitente verificado en el `.env` ignorado. El servicio rechaza remitentes locales o los ejemplos sin completar antes de intentar enviar. Nunca colocar claves en Git.

Si falla un envío, `purchase_email_failed` incluye `smtpCode`, `smtpResponseCode`, `smtpCommand`, `smtpResponse` filtrada y `category` (`authentication`, `sender_not_verified`, `tls`, `timeout` o `smtp`), cuando estén disponibles. No registrar la respuesta completa, claves ni direcciones sin enmascarar. Cambiar el remitente requiere que esté verificado en la misma cuenta del proveedor que autoriza la API key. Tras corregirlo, reintentar desde la compra existente sin repetir el pago.

### Plantillas HBS

`src/email/templates/purchase-confirmation.hbs` contiene el diseño. `purchaseEmail.ts` prepara asunto, texto y variables; Handlebars genera el HTML y Nodemailer lo envía. HBS organiza el diseño, no determina el proveedor. Se usan llaves dobles para escapar los datos del evento.

`pnpm run build` copia las plantillas a `dist/email/templates`, de modo que funcionan tanto con `pnpm run dev` como con `pnpm start`. Al editar la plantilla durante desarrollo, reiniciar si el watcher no detecta el cambio (se compila al cargar el módulo).

## Variables

| Variable | Uso |
|---|---|
| `PORT`, `HOST` | `3006` y `127.0.0.1`. Solo loopback. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` o `silent`. |
| `INTERNAL_TOKEN_ORDERS` | Token del par orders ↔ notifications, ≥ 24 caracteres. **Igual** a `NOTIFICATIONS_INTERNAL_TOKEN` del `.env` de orders. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP real: host del proveedor, `587`/`false` o `465`/`true`. Alternativa local: `127.0.0.1`, `1025`, `false`. |
| `SMTP_USER`, `SMTP_PASSWORD` | Credenciales del proveedor (SendGrid: usuario literal `apikey` y API key). Deben configurarse juntas. |
| `SMTP_TIMEOUT_MS` | Límite de cada envío; `4000`. Menor que `HTTP_TIMEOUT_MS` de orders (`5000`), para responder antes de que orders corte. |
| `MAIL_FROM` | Remitente autorizado por el proveedor; obligatorio para SMTP externo. El valor `.local` es solo para pruebas. |
| `PUBLIC_WEB_URL` | URL pública de la web por Nginx, `http://localhost:8080`. |
| `MAIL_TIMEZONE` | Zona para la fecha del evento; `America/La_Paz`. |

## API interna

`POST /internal/notifications/purchase` con `X-Internal-Token`:

```json
{
  "orderId": "40000000-0000-4000-8000-000000000001",
  "to": "cliente@demo.bo",
  "event": { "title": "Noche de Rock", "venue": "Estadio Central", "startsAt": "2026-12-20T23:00:00.000Z" },
  "sector": { "name": "General" },
  "quantity": 2,
  "totalMinor": 10000,
  "currency": "BOB"
}
```

Es el cuerpo que ya arma orders en `src/builders/purchaseNotification.ts`. Campos extra → 400.

| Respuesta | Significado para orders |
|---|---|
| `200 { orderId, status: "sent", messageId, sentAt }` | El servidor SMTP aceptó el correo → `notification_status=sent`. |
| `400 VALIDATION_ERROR` | Cuerpo inválido; no se envía nada. |
| `401 UNAUTHORIZED` | Token interno ausente o incorrecto. |
| `503 SMTP_UNAVAILABLE` | No se pudo conectar o autenticar con el servidor SMTP → `failed`. |
| `504 SMTP_TIMEOUT` | El servidor SMTP no respondió en `SMTP_TIMEOUT_MS`; el correo pudo o no salir. orders lo registra hoy como `failed`. |

### Contenido del correo

- Asunto `Compra confirmada: <evento>`, versión texto y HTML.
- Evento, fecha en hora de La Paz, lugar, sector, cantidad, total (`100,00 BOB`, calculado desde unidades menores sin decimales binarios) y número de orden.
- Botón y enlace a `<PUBLIC_WEB_URL>/mis-entradas?orderId=<orderId>`. **Sin JWT, token ni ruta directa al PDF**: el cliente inicia sesión y tickets comprueba que las entradas son suyas.
- Los datos del evento se escapan en el HTML; el asunto y los campos de una línea rechazan saltos de línea (evita inyectar cabeceras).
- `Message-ID` fijo por orden (`<compra-<orderId>@entradasya.local>`) y cabecera `X-EntradasYa-Order`.

### Reintentos y fallos

SMTP no garantiza envío exactamente una vez. Si orders reintenta tras `failed` o `unknown`, puede llegar un segundo correo con el mismo `Message-ID`. Eso no duplica órdenes, pagos ni entradas y **nunca revierte la compra** (escenario V9).

### Seguridad y logs

- `/internal/*` exige `X-Internal-Token` (comparación en tiempo constante). Un JWT de cliente no sirve.
- Escucha en `127.0.0.1`; Nginx no tiene ruta hacia el puerto 3006.
- Los logs registran `orderId` y el destinatario enmascarado (`c***@demo.bo`); nunca el cuerpo ni el correo completo.

## Pruebas

```bash
pnpm test
```

Usan un servidor SMTP real en memoria (`smtp-server`) en lugar de Mailpit, un puerto cerrado para «Mailpit apagado» y un socket que nunca saluda para el timeout. Cubren: salud 200/503; token interno obligatorio; envío con destinatario, asunto, resumen, total y enlace; ausencia de JWT/token/ruta de PDF; escape de HTML; 400 por datos inválidos, saltos de línea o campos extra; reenvío con el mismo Message-ID; 503 `SMTP_UNAVAILABLE` y 504 `SMTP_TIMEOUT` dentro del límite.

Las pruebas de configuración y composición pueden ejecutarse sin abrir puertos: `pnpm test -- tests/smtp.test.ts` y `pnpm test -- tests/notifications.test.ts -t utilidades`. El resto utiliza sockets locales y no envía mensajes a destinatarios reales. La entrega con un proveedor requiere completar `.env`, comprobar `/health` y realizar una compra con un cliente cuyo correo puedas verificar.

## Estructura

```text
src/
├── server.ts, app.ts       # arranque, /health (verifica SMTP) y montaje de /internal
├── config.ts               # único lugar que lee process.env
├── logger.ts
├── http/                   # requestId, errores, token interno
├── routes/internal.ts      # validación zod y envío
└── email/
    ├── mailer.ts           # nodemailer con timeouts y clasificación de errores
    ├── purchaseEmail.ts    # datos, asunto, texto y compilación de HTML
    └── templates/purchase-confirmation.hbs # diseño del correo
```
