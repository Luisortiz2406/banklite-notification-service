# Notification Service (`notification-service`)

[![CI](https://github.com/Luisortiz2406/banklite-notification-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-notification-service/actions/workflows/ci.yml)

Notificaciones de BankLite: correo (Gmail API), WhatsApp OTP y bandeja dentro de la app, a partir de eventos.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Escucha los eventos del sistema y avisa al cliente por el canal que corresponda:
bandeja de la app (`in_app`), correo o WhatsApp. También envía y verifica los
**códigos OTP** de WhatsApp que usa auth-service. Cada envío tiene una `dedupe_key`
para que procesar el mismo evento dos veces no duplique el aviso.

**Reglas de negocio principales**

- Idempotencia por `dedupe_key` (`<usuario>:<evento>:<canal>:<fecha del evento>`).
- OTP con vencimiento e intentos máximos; el código se guarda con hash.
- Reintentos con cola `.retry` y DLQ; el panel puede reintentar un envío fallido.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — |
| Consume eventos | `usuario_autenticado`, `intento_fallido_login`, `account.created` (auth)<br>`identity.rejected`, `identity.email_confirmed` (kyc)<br>`transaction.completed` (ledger)<br>`fraud.alert` (fraud)<br>`account.closed` (account: correo que confirma la cancelación de la cuenta)<br>`subscription.*`, `card.controls_changed`, `card.charge_declined` (card) |
| Llama a | — |
| Lo llaman | auth-service: `/otp/*` y `POST /notifications`<br>api-gateway (rutas `/notifications/*`) |
| Integraciones externas | Gmail API (OAuth)<br>WhatsApp Cloud API (Meta) con plantilla de OTP |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/notifications`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`notification_db`)

| Tabla | Contenido |
|---|---|
| `notifications` | Avisos enviados por canal, estado y `dedupe_key`. |
| `otp_challenges` | Códigos OTP (hash, intentos, vencimiento). |
| `user_contacts` | Correo y nombre del cliente (proyección de eventos). |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb notification_db
psql "postgres://usuario:clave@localhost:5432/notification_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-notification-service .
docker run --env-file .env -p 3005:3005 banklite-notification-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3005/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/notifications/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/notifications/:id_user` | Bandeja del cliente (canal `in_app`). |
| PUT | `/notifications/:id/read` | Marca un aviso como leído. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/notifications/admin/notifications` | cualquier empleado | Envíos recientes con filtros. |
| GET | `/notifications/admin/summary` | cualquier empleado | Totales por canal y estado. |
| POST | `/notifications/admin/notifications/:id/retry` | support, admin | Reintenta un envío fallido. |
| GET | `/notifications/admin/dlq` | cualquier empleado | Mensajes en la cola de errores (DLQ). |
| GET | `/notifications/admin/dlq/messages` | cualquier empleado | Contenido de los mensajes de la DLQ. |
| POST | `/notifications/admin/dlq/requeue` | admin | Reencola mensajes de la DLQ (solo administradores). |
| GET | `/notifications/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/notifications` | Crea una notificación directamente (servicio a servicio). |
| POST | `/otp/send` | Envía un OTP por WhatsApp. |
| POST | `/otp/verify` | Verifica un OTP. |
| POST | `/otp/password-reset/send` | OTP para recuperar la contraseña. |
| POST | `/otp/password-reset/verify` | Verifica el OTP de recuperación. |
| GET | `/otp/status/:id_user` | Estado de la verificación del celular. |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3005` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://notification_svc:<DB_PASSWORD_NOTIFICATION>@localhost:5432/notification_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `INTERNAL_TRUSTED_KEYS` | **Sí** (no arranca sin ella) | `auth:<clave-de-auth>` | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `RABBITMQ_QUEUE` | No | `notification-service.all-events` | Cola propia del servicio (con `<cola>.retry` y `<cola>.dlq`). |
| `GMAIL_CLIENT_ID` | Sí | — | OAuth de Gmail API (envío de correos). |
| `GMAIL_CLIENT_SECRET` | Sí | — | OAuth de Gmail API. |
| `GMAIL_REFRESH_TOKEN` | Sí | — | Refresh token de la cuenta remitente. |
| `GMAIL_SENDER` | Sí | — | Correo remitente. |
| `WHATSAPP_API_VERSION` | No | `v23.0` | Versión de la Graph API de Meta. |
| `WHATSAPP_ACCESS_TOKEN` | Sí | — | Token de WhatsApp Cloud API. |
| `WHATSAPP_PHONE_NUMBER_ID` | Sí | — | Número emisor en WhatsApp Cloud API. |
| `WHATSAPP_OTP_TEMPLATE_NAME` | No | `caedomi_codigo_verificacion` | Plantilla aprobada para el código OTP. |
| `WHATSAPP_OTP_TEMPLATE_LANGUAGE` | No | `es_CO` | Idioma de la plantilla. |
| `WHATSAPP_OTP_INCLUDE_BUTTON` | No | `true` | Si la plantilla lleva botón de copiar código. |
| `EVENT_MAX_RETRIES` | No | `5` | Reintentos de un evento antes de mandarlo a la DLQ. |
| `EVENT_RETRY_DELAY_MS` | No | `10000` | Espera entre reintentos de un evento. |

## Pruebas

`npm test` (Jest, sin base de datos): textos de los avisos, p. ej. el correo de `account.closed` (fecha, cuentas enmascaradas, contacto de soporte, nombre escapado). Las reglas de negocio se prueban de punta a punta con los scripts de `scripts/pruebas/` del repositorio principal.

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`): `railway.json` en la
raíz define el build por `Dockerfile` y el health check en `/health`; cada push a
`main` redespliega el servicio. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `notification-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/notifications/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Lo llama:** OTP y correos<br>**Recibe:** `usuario_autenticado`, `intento_fallido_login`, `account.created` |
| [banklite-kyc-service](https://github.com/Luisortiz2406/banklite-kyc-service) | **Recibe:** `identity.rejected`, `identity.email_confirmed` |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Recibe:** `transaction.completed` |
| [banklite-fraud-service](https://github.com/Luisortiz2406/banklite-fraud-service) | **Recibe:** `fraud.alert` |
| [banklite-card-service](https://github.com/Luisortiz2406/banklite-card-service) | **Recibe:** `subscription.*`, `card.controls_changed`, `card.charge_declined` |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Recibe:** `account.closed` (correo de confirmación de la cancelación) |
