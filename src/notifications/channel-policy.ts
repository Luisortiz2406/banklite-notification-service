import { NotificationChannel } from './entities/notification.entity';

export interface BuiltContent {
  title: string;
  body: string;
}

export interface ChannelRule {
  channel: NotificationChannel;
  // Si se define, decide si esta fila se genera para este payload en particular
  // (p. ej. solo mandar email de intento_fallido_login cuando la cuenta quedó
  // bloqueada, no en cada intento).
  when?: (payload: Record<string, any>) => boolean;
  build: (payload: Record<string, any>) => BuiltContent;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] as string);
}

function displayNameOf(p: Record<string, any>): string {
  return typeof p.nombreCompleto === 'string' && p.nombreCompleto.trim()
    ? p.nombreCompleto.trim().replace(/[\r\n]+/g, ' ')
    : 'Cliente';
}

function formatAmount(value: unknown): string {
  return Number.isFinite(Number(value))
    ? new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))
    : '0,00';
}

function currencyOf(p: Record<string, any>): string {
  return p.currency === 'USD' ? 'USD' : 'COP';
}

function maskedAccount(value: unknown): string {
  return typeof value === 'string' && value.length >= 4 ? ` ····${value.slice(-4)}` : '';
}

function formatBogotaDate(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(valid);
}

function formatBillingDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—';
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
}

function subscriptionName(p: Record<string, any>): string {
  const name = typeof p.merchantName === 'string' && p.merchantName.trim() ? p.merchantName.trim() : 'tu suscripción';
  return name.replace(/[\r\n]+/g, ' ');
}

function reasonText(p: Record<string, any>): string {
  return (typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : 'cobro rechazado').replace(/\.+$/, '');
}

function cardText(p: Record<string, any>): string {
  return typeof p.cardLast4 === 'string' && /^\d{4}$/.test(p.cardLast4) ? `tu tarjeta ····${p.cardLast4}` : 'tu tarjeta';
}

function cardOnlineTitle(p: Record<string, any>): string {
  return p.onlineEnabled ? 'Activaste las compras por internet' : 'Desactivaste las compras por internet';
}

/** Correo de suscripciones con la misma estética de los demás correos de BankLite. */
function subscriptionEmail(
  p: Record<string, any>,
  heading: string,
  intro: string,
  rows: [string, string][],
  alert?: { tone: 'warning' | 'danger'; html: string },
): string {
  const name = escapeHtml(displayNameOf(p));
  const detailRow = ([label, value]: [string, string]) =>
    `<tr><td style="padding:8px 0;color:#65736a;font-size:15px">${label}</td><td style="padding:8px 0;font-size:15px;font-weight:700;text-align:right">${escapeHtml(value)}</td></tr>`;
  const alertBox = alert
    ? `<div style="margin:24px 0 0;padding:16px 20px;border-left:4px solid ${alert.tone === 'danger' ? '#c43d32' : '#e07b00'};background:${alert.tone === 'danger' ? '#fbf1f0' : '#fff4e5'};font-size:15px;line-height:1.6">${alert.html}</div>`
    : '';
  return `<div style="margin:0;padding:32px 16px;background-color:#f3f6f4;font-family:Arial,sans-serif;color:#17241e">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dce5df;border-radius:8px;overflow:hidden">
    <div style="padding:32px 36px">
      <p style="margin:0 0 8px;color:#18794e;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase">BankLite</p>
      <h1 style="margin:0 0 24px;font-size:26px;line-height:1.3;color:#17241e">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">¡Hola, <strong>${name}</strong>!</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">${escapeHtml(intro)}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;border-top:1px solid #e5ebe7;border-bottom:1px solid #e5ebe7">
        ${rows.map(detailRow).join('\n        ')}
      </table>
      ${alertBox}
      <p style="margin:24px 0 0;font-size:16px;line-height:1.6">El equipo de BankLite</p>
    </div>
    <div style="padding:20px 36px;background:#f3f6f4;color:#65736a;font-size:12px;line-height:1.6">
      <p style="margin:0 0 8px"><em>Este es un mensaje automático enviado por BankLite. Por favor, no respondas a este correo.</em></p>
      <p style="margin:0"><em>© 2026 BankLite. Todos los derechos reservados.</em></p>
    </div>
  </div>
</div>`;
}

/**
 * Mapa evento -> reglas por canal. Este archivo es la "tabla" del diseño que
 * hablamos: un mismo evento puede generar 0, 1 o varias filas (una por canal),
 * y CADA canal tiene su propio texto — nunca se copia el mismo contenido.
 *
 * Para agregar un evento nuevo (p. ej. cuando implementes Ledger y publiques
 * transaction.completed), solo hay que agregar una entrada aquí. El consumer
 * de RabbitMQ ya está suscrito a '#' (todos los routing keys), así que no hay
 * que tocar nada más.
 */
export const CHANNEL_POLICY: Record<string, ChannelRule[]> = {
  // Cuenta creada correctamente: bienvenida únicamente por correo.
  'account.created': [
    {
      channel: 'email',
      build: (p) => {
        const displayName = typeof p.nombreCompleto === 'string' && p.nombreCompleto.trim()
          ? p.nombreCompleto.trim().replace(/[\r\n]+/g, ' ')
          : 'Cliente';
        const name = escapeHtml(displayName);
        return {
          title: `¡Todo listo, ${displayName}! Te damos la bienvenida a Banklite 📱`,
          body: `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Accede a tu cuenta y toma el control de tu dinero hoy mismo.</div>
<div style="margin:0;padding:32px 16px;background-color:#f3f6f4;font-family:Arial,sans-serif;color:#17241e">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dce5df;border-radius:8px;overflow:hidden">
    <div style="padding:32px 36px 12px">
      <p style="margin:0 0 8px;color:#18794e;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase">BankLite</p>
      <h1 style="margin:0;font-size:28px;line-height:1.25;color:#17241e">¡Todo listo, ${name}! 📱✨</h1>
      <h2 style="margin:10px 0 28px;font-size:20px;font-weight:400;color:#18794e">Te damos la bienvenida a BankLite</h2>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">¡Hola, <strong>${name}</strong>!</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">Felicidades por abrir tu cuenta en <strong>BankLite</strong>. A partir de este momento, formas parte de una manera más fácil, rápida y transparente de gestionar tus finanzas, sin filas ni papeleos.</p>
      <p style="margin:0 0 12px;font-size:16px;line-height:1.6">Aquí tienes los accesos directos para empezar a mover tu dinero:</p>
      <div style="padding:16px 0;border-top:1px solid #e5ebe7">
        <p style="margin:0 0 5px;font-size:16px;line-height:1.5">🚀 <strong>Banca Móvil</strong></p>
        <p style="margin:0 0 0 28px;color:#43534a;font-size:15px;line-height:1.6">Navega desde nuestra app oficial para operar desde cualquier lugar.</p>
      </div>
      <div style="padding:16px 0;border-top:1px solid #e5ebe7">
        <p style="margin:0 0 5px;font-size:16px;line-height:1.5">💳 <strong>Tu Tarjeta Virtual BankLite</strong></p>
        <p style="margin:0 0 0 28px;color:#43534a;font-size:15px;line-height:1.6">Ya puedes activarla desde la aplicación para realizar tus compras seguras por internet o añadirla a tu billetera digital.</p>
      </div>
      <div style="padding:16px 0;border-top:1px solid #e5ebe7;border-bottom:1px solid #e5ebe7">
        <p style="margin:0 0 5px;font-size:16px;line-height:1.5">🔒 <strong>Tu Seguridad es Primero</strong></p>
        <p style="margin:0 0 0 28px;color:#43534a;font-size:15px;line-height:1.6">Recuerda que en <strong>BankLite</strong> nunca te solicitaremos contraseñas ni claves dinámicas por correo electrónico, SMS o llamada telefónica.</p>
      </div>
      <p style="margin:22px 0;font-size:16px;line-height:1.6">Queremos que disfrutes de la comodidad de tener el control financiero en tus manos.</p>
      <p style="margin:0 0 28px;font-size:16px;line-height:1.6">El equipo de BankLite</p>
    </div>
    <div style="padding:20px 36px;background:#f3f6f4;color:#65736a;font-size:12px;line-height:1.6">
      <p style="margin:0 0 8px"><em>Este es un mensaje automático enviado por BankLite. Por favor, no respondas a este correo.</em></p>
      <p style="margin:0"><em>© 2026 BankLite. Todos los derechos reservados.</em></p>
    </div>
  </div>
</div>`,
        };
      },
    },
  ],

  // KYC aprobado: lo consume Account Service para activar cuentas. No se notifica
  // aquí porque en el registro la identidad se verifica ANTES de conocer el
  // correo; la confirmación por email sale con 'identity.email_confirmed'.
  'identity.verified': [],

  // KYC Service lo publica cuando el correo verificado llega a una identidad aprobada.
  'identity.email_confirmed': [
    {
      channel: 'email',
      build: (p) => {
        const displayName = typeof p.nombreCompleto === 'string' && p.nombreCompleto.trim()
          ? p.nombreCompleto.trim().replace(/[\r\n]+/g, ' ')
          : 'Cliente';
        const name = escapeHtml(displayName);
        return {
          title: '¡Identidad verificada con éxito! 🎉 Tu cuenta BankLite te espera',
          body: `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Tu verificación fue aprobada. Ya puedes abrir tu cuenta y operar.</div>
<div style="margin:0;padding:32px 16px;background-color:#f3f6f4;font-family:Arial,sans-serif;color:#17241e">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dce5df;border-radius:8px;overflow:hidden">
    <div style="padding:32px 36px">
      <p style="margin:0 0 8px;color:#18794e;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase">BankLite</p>
      <h1 style="margin:0;font-size:28px;line-height:1.25;color:#17241e">¡Identidad verificada! ✅</h1>
      <h2 style="margin:10px 0 28px;font-size:20px;font-weight:400;color:#18794e">Tu cuenta BankLite ya está lista para activarse</h2>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">¡Hola, <strong>${name}</strong>!</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">Queremos informarte que tu proceso de verificación de identidad ha sido <strong>aprobado con éxito</strong>. En <strong>BankLite</strong> nos tomamos la seguridad muy en serio, y este paso garantiza la protección de tus fondos y de tu identidad.</p>
      <p style="margin:0;padding:18px 20px;border-left:4px solid #18794e;background:#f3f6f4;font-size:16px;line-height:1.6"><strong>¡Ya no hay límites!</strong> Estás a un solo clic de comenzar tu experiencia financiera digital.</p>
    </div>
  </div>
</div>`,
        };
      },
    },
  ],

  // Publicado por Ledger (vía outbox) una vez por cada titular afectado.
  'transaction.completed': [
    {
      channel: 'in_app',
      // Los cobros de suscripciones se notifican con subscription.charged (más detalle).
      when: (p) => p.type !== 'payment',
      build: (p) => {
        const amount = `${formatAmount(p.amount)} ${currencyOf(p)}`;
        const incoming = p.direction === 'in';
        switch (p.type) {
          case 'credit':
            return { title: 'Abono recibido', body: `Se abonaron ${amount} a tu cuenta.` };
          case 'deposit':
            return { title: 'Consignación recibida', body: `Se consignaron ${amount} a tu cuenta.` };
          case 'debit':
            return { title: 'Cargo a tu cuenta', body: `Se debitaron ${amount} de tu cuenta.` };
          case 'reversal':
            return incoming
              ? { title: 'Reverso recibido', body: `Se reintegraron ${amount} a tu cuenta.` }
              : { title: 'Reverso aplicado', body: `Se reversaron ${amount} de tu cuenta.` };
          default:
            return incoming
              ? { title: 'Transferencia recibida', body: `Recibiste ${amount} desde la cuenta${maskedAccount(p.sourceAccountNumber)}.` }
              : { title: 'Transferencia realizada', body: `Enviaste ${amount} a la cuenta${maskedAccount(p.destinationAccountNumber)}.` };
        }
      },
    },
    {
      // Comprobante por correo solo para quien envía una transferencia.
      channel: 'email',
      when: (p) => p.type === 'transfer' && p.direction === 'out',
      build: (p) => {
        const name = escapeHtml(displayNameOf(p));
        const amount = `${formatAmount(p.amount)} ${currencyOf(p)}`;
        const destination = maskedAccount(p.destinationAccountNumber).trim() || 'BankLite';
        const description = typeof p.description === 'string' && p.description.trim()
          ? escapeHtml(p.description.trim())
          : 'Transferencia';
        const reference = typeof p.transactionId === 'string' ? p.transactionId.slice(0, 8).toUpperCase() : '—';
        const detailRow = (label: string, value: string) =>
          `<tr><td style="padding:8px 0;color:#65736a;font-size:15px">${label}</td><td style="padding:8px 0;font-size:15px;font-weight:700;text-align:right">${value}</td></tr>`;
        return {
          title: `Transferencia enviada: ${amount} a la cuenta ${destination}`,
          body: `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Enviaste ${amount} a la cuenta ${destination}.</div>
<div style="margin:0;padding:32px 16px;background-color:#f3f6f4;font-family:Arial,sans-serif;color:#17241e">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dce5df;border-radius:8px;overflow:hidden">
    <div style="padding:32px 36px">
      <p style="margin:0 0 8px;color:#18794e;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase">BankLite</p>
      <h1 style="margin:0 0 24px;font-size:26px;line-height:1.3;color:#17241e">Transferencia enviada ✅</h1>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">¡Hola, <strong>${name}</strong>!</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">Tu transferencia se realizó con éxito. Estos son los detalles:</p>
      <p style="margin:0 0 20px;font-size:30px;font-weight:700;color:#17241e">${amount}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;border-top:1px solid #e5ebe7;border-bottom:1px solid #e5ebe7">
        ${detailRow('Cuenta destino', destination)}
        ${detailRow('Descripción', description)}
        ${detailRow('Fecha y hora', `${formatBogotaDate(p.createdAt)} (hora de Colombia)`)}
        ${detailRow('Referencia', reference)}
      </table>
      <div style="margin:24px 0 0;padding:16px 20px;border-left:4px solid #c43d32;background:#fbf1f0;font-size:15px;line-height:1.6">
        <strong>¿No reconoces esta transferencia?</strong> Cambia tu clave de inmediato desde la app con la opción de recuperar clave y comunícate con BankLite. Nunca compartas tu clave ni tus códigos de seguridad.
      </div>
      <p style="margin:24px 0 0;font-size:16px;line-height:1.6">El equipo de BankLite</p>
    </div>
    <div style="padding:20px 36px;background:#f3f6f4;color:#65736a;font-size:12px;line-height:1.6">
      <p style="margin:0 0 8px"><em>Este es un mensaje automático enviado por BankLite. Por favor, no respondas a este correo.</em></p>
      <p style="margin:0"><em>© 2026 BankLite. Todos los derechos reservados.</em></p>
    </div>
  </div>
</div>`,
        };
      },
    },
  ],

  // ---- Suscripciones (card-service) ----

  // 3 días antes del cobro.
  'subscription.charge_upcoming': [
    {
      channel: 'in_app',
      build: (p) => ({
        title: `Próximo cobro de ${subscriptionName(p)}`,
        body: `El ${formatBillingDate(p.chargeDate)} cobraremos ${formatAmount(p.amount)} ${currencyOf(p)} a ${cardText(p)}.`,
      }),
    },
    {
      channel: 'email',
      build: (p) => ({
        title: `Próximo cobro de ${subscriptionName(p)}: ${formatAmount(p.amount)} ${currencyOf(p)}`,
        body: subscriptionEmail(p, `Tu cobro de ${subscriptionName(p)} se acerca 📅`,
          'En 3 días cobraremos tu suscripción. Ten saldo disponible en tu cuenta para que el pago salga sin problema.',
          [
            ['Servicio', `${subscriptionName(p)}${p.plan ? ` · ${p.plan}` : ''}`],
            ['Valor', `${formatAmount(p.amount)} ${currencyOf(p)}`],
            ['Fecha de cobro', formatBillingDate(p.chargeDate)],
            ['Medio de pago', cardText(p)],
          ],
          { tone: 'warning', html: 'Si ya no quieres este servicio, puedes <strong>pausar o cancelar</strong> la suscripción desde la app antes de la fecha de cobro.' }),
      }),
    },
  ],

  'subscription.charged': [
    {
      channel: 'in_app',
      build: (p) => ({
        title: `Pago de ${subscriptionName(p)} realizado`,
        body: `Cobramos ${formatAmount(p.amount)} ${currencyOf(p)} a ${cardText(p)}.${p.nextChargeDate ? ` Próximo cobro: ${formatBillingDate(p.nextChargeDate)}.` : ''}`,
      }),
    },
    {
      channel: 'email',
      build: (p) => ({
        title: `Pago de ${subscriptionName(p)}: ${formatAmount(p.amount)} ${currencyOf(p)}`,
        body: subscriptionEmail(p, `Pago de ${subscriptionName(p)} realizado ✅`,
          'Tu suscripción se cobró correctamente. Estos son los detalles:',
          [
            ['Servicio', `${subscriptionName(p)}${p.plan ? ` · ${p.plan}` : ''}`],
            ['Valor', `${formatAmount(p.amount)} ${currencyOf(p)}`],
            ['Periodo', typeof p.period === 'string' ? p.period : '—'],
            ['Medio de pago', cardText(p)],
            ['Próximo cobro', formatBillingDate(p.nextChargeDate)],
            ['Referencia', typeof p.transactionId === 'string' ? p.transactionId.slice(0, 8).toUpperCase() : '—'],
          ]),
      }),
    },
  ],

  'subscription.charge_rejected': [
    {
      channel: 'in_app',
      build: (p) => ({
        title: `No pudimos cobrar ${subscriptionName(p)}`,
        body: p.final
          ? `Motivo: ${reasonText(p)}. Era el último intento.`
          : `Motivo: ${reasonText(p)}. Lo intentaremos de nuevo el ${formatBillingDate(p.nextAttemptDate)}.`,
      }),
    },
    {
      channel: 'email',
      build: (p) => ({
        title: `No pudimos cobrar ${subscriptionName(p)}`,
        body: subscriptionEmail(p, `No pudimos cobrar ${subscriptionName(p)} ⚠️`,
          'Intentamos cobrar tu suscripción, pero el pago fue rechazado.',
          [
            ['Servicio', subscriptionName(p)],
            ['Valor', `${formatAmount(p.amount)} ${currencyOf(p)}`],
            ['Motivo', typeof p.reason === 'string' ? p.reason : 'Cobro rechazado'],
            ['Intento', String(p.attempt ?? 1)],
            ['Próximo intento', p.final ? 'No habrá más intentos' : formatBillingDate(p.nextAttemptDate)],
          ],
          { tone: p.final ? 'danger' : 'warning', html: p.final
            ? 'Este era el último intento: la suscripción quedará <strong>suspendida</strong>.'
            : 'Revisa que tu tarjeta esté activa y que tengas saldo disponible antes del próximo intento.' }),
      }),
    },
  ],

  'subscription.suspended': [
    {
      channel: 'in_app',
      build: (p) => ({
        title: `${subscriptionName(p)} quedó suspendida`,
        body: 'No pudimos cobrarla después de 3 reintentos. Puedes reactivarla desde Mis suscripciones.',
      }),
    },
    {
      channel: 'email',
      build: (p) => ({
        title: `${subscriptionName(p)} quedó suspendida`,
        body: subscriptionEmail(p, `Tu suscripción a ${subscriptionName(p)} está suspendida`,
          'No pudimos cobrar tu suscripción después de 3 reintentos, así que la suspendimos y no haremos más cobros.',
          [
            ['Servicio', subscriptionName(p)],
            ['Valor mensual', `${formatAmount(p.amount)} ${currencyOf(p)}`],
            ['Último motivo', typeof p.reason === 'string' ? p.reason : 'Cobro rechazado'],
          ],
          { tone: 'danger', html: 'Para reactivarla, entra a <strong>Mis suscripciones</strong> en la app y toca <strong>Reactivar</strong>: cobraremos el mes en ese momento.' }),
      }),
    },
  ],

  // ---- Controles de la tarjeta (card-service) ----

  // Cambio de compras por internet o del límite diario: aviso de seguridad.
  'card.controls_changed': [
    {
      channel: 'in_app',
      build: (p) => ({
        title: p.field === 'daily_limit' ? 'Cambiaste el límite diario de tu tarjeta' : cardOnlineTitle(p),
        body: p.field === 'daily_limit'
          ? `El nuevo límite de compras de ${cardText(p)} es ${formatAmount(p.dailyLimit)} ${currencyOf(p)} al día.`
          : `${p.onlineEnabled ? 'Ya puedes' : 'Ya no puedes'} usar ${cardText(p)} en tiendas online, apps y suscripciones.`,
      }),
    },
    {
      channel: 'email',
      build: (p) => ({
        title: p.field === 'daily_limit' ? 'Cambiaste el límite diario de tu tarjeta' : cardOnlineTitle(p),
        body: subscriptionEmail(p, p.field === 'daily_limit' ? 'Nuevo límite diario de compras 🔒' : `${cardOnlineTitle(p)} 🔒`,
          'Se hizo este cambio en los controles de tu tarjeta:',
          [
            ['Tarjeta', cardText(p)],
            p.field === 'daily_limit'
              ? ['Límite diario', `${formatAmount(p.dailyLimit)} ${currencyOf(p)}`]
              : ['Compras por internet', p.onlineEnabled ? 'Activadas' : 'Desactivadas'],
            ['Fecha', formatBogotaDate(undefined)],
          ],
          { tone: 'warning', html: 'Si no hiciste este cambio, <strong>congela tu tarjeta</strong> desde la app y cambia tu contraseña.' }),
      }),
    },
  ],

  // Compra con la tarjeta rechazada (los cobros de suscripciones avisan con subscription.charge_rejected).
  'card.charge_declined': [
    {
      channel: 'in_app',
      build: (p) => ({
        title: 'Compra rechazada',
        body: `${subscriptionName(p)} · ${formatAmount(p.amount)} ${currencyOf(p)}. Motivo: ${reasonText(p)}.`,
      }),
    },
    {
      channel: 'email',
      build: (p) => ({
        title: `Compra rechazada en ${subscriptionName(p)}`,
        body: subscriptionEmail(p, 'Rechazamos una compra con tu tarjeta ⚠️',
          'Intentaron hacer una compra con tu tarjeta y no la aprobamos.',
          [
            ['Comercio', subscriptionName(p)],
            ['Canal', p.channel === 'online' ? 'Por internet' : 'Tienda física'],
            ['Valor', `${formatAmount(p.amount)} ${currencyOf(p)}`],
            ['Tarjeta', cardText(p)],
            ['Motivo', typeof p.reason === 'string' ? p.reason : 'Compra rechazada'],
          ],
          { tone: 'warning', html: 'Si no reconoces esta compra, <strong>congela tu tarjeta</strong> desde la app.' }),
      }),
    },
  ],

  // KYC rechazado: el usuario necesita enterarse aunque no vuelva a abrir la app.
  'identity.rejected': [
    {
      channel: 'in_app',
      build: () => ({
        title: 'No pudimos verificar tu identidad',
        body: 'Revisa tus datos e intenta la verificación de identidad nuevamente.',
      }),
    },
    {
      channel: 'email',
      build: () => ({
        title: 'BankLite — No pudimos verificar tu identidad',
        body: '<div style="font-family:Arial,sans-serif"><h2>BankLite</h2><p>No pudimos validar tu documento o antecedentes con el proveedor. Revisa los datos ingresados e inténtalo de nuevo desde la app.</p></div>',
      }),
    },
  ],

  // Publicado por Fraud Service cuando una transacción supera el umbral de
  // revisión. Nunca acusa al cliente de nada: solo informa que se está
  // revisando. La decisión (confirmar/descartar) la toma soporte/cumplimiento
  // desde el panel admin, nunca de forma automática.
  'fraud.alert': [
    {
      channel: 'in_app',
      build: () => ({
        title: 'Estamos revisando un movimiento de tu cuenta',
        body: 'Detectamos actividad inusual en una transacción reciente y nuestro equipo la está revisando. No necesitas hacer nada por ahora.',
      }),
    },
    {
      channel: 'email',
      build: (p) => {
        const name = escapeHtml(displayNameOf(p));
        return {
          title: 'BankLite — Estamos revisando un movimiento de tu cuenta',
          body: `<div style="margin:0;padding:32px 16px;background-color:#f3f6f4;font-family:Arial,sans-serif;color:#17241e">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dce5df;border-radius:8px;overflow:hidden">
    <div style="padding:32px 36px">
      <p style="margin:0 0 8px;color:#18794e;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase">BankLite</p>
      <h1 style="margin:0 0 24px;font-size:26px;line-height:1.3;color:#17241e">Estamos revisando un movimiento tuyo 🔎</h1>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">¡Hola, <strong>${name}</strong>!</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">Como parte de nuestros controles de seguridad, detectamos actividad inusual en una transacción reciente de tu cuenta y nuestro equipo la está revisando. Es una medida preventiva: no implica que hayas hecho algo indebido.</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">No necesitas hacer nada por ahora. Si identificamos algo que requiera tu atención, te lo haremos saber.</p>
      <p style="margin:24px 0 0;font-size:16px;line-height:1.6">El equipo de BankLite</p>
    </div>
    <div style="padding:20px 36px;background:#f3f6f4;color:#65736a;font-size:12px;line-height:1.6">
      <p style="margin:0 0 8px"><em>Este es un mensaje automático enviado por BankLite. Por favor, no respondas a este correo.</em></p>
      <p style="margin:0"><em>© 2026 BankLite. Todos los derechos reservados.</em></p>
    </div>
  </div>
</div>`,
        };
      },
    },
  ],

  // Login exitoso: demasiado frecuente para notificar por defecto. Se deja
  // documentado y desactivado (array vacío) en vez de omitir la clave, para
  // que quede explícito que fue una decisión y no un olvido.
  usuario_autenticado: [],

  // Intento fallido de login: solo correo cuando la cuenta queda bloqueada.
  intento_fallido_login: [
    {
      channel: 'email',
      when: (p) => p.intentos >= 5, // debe coincidir con MAX_INTENTOS_FALLIDOS de auth-service
      build: (p) => {
        const displayName = typeof p.nombreCompleto === 'string' && p.nombreCompleto.trim()
          ? p.nombreCompleto.trim().replace(/[\r\n]+/g, ' ')
          : 'Cliente';
        const name = escapeHtml(displayName);
        const attempts = Number.isFinite(Number(p.intentos)) ? Number(p.intentos) : 5;
        const eventDate = typeof p.fechaHora === 'string' ? new Date(p.fechaHora) : new Date();
        const validDate = Number.isNaN(eventDate.getTime()) ? new Date() : eventDate;
        const formattedDate = new Intl.DateTimeFormat('es-CO', {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: 'America/Bogota',
        }).format(validDate);
        return {
          title: '⚠️ Alerta de seguridad: Múltiples intentos de inicio de sesión fallidos en tu cuenta',
          body: `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Hemos detectado ${attempts} intentos incorrectos. Tu cuenta se desbloqueará automáticamente en 30 minutos.</div>
<div style="margin:0;padding:32px 16px;background-color:#f4f6f5;font-family:Arial,sans-serif;color:#202824">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dce3df;border-radius:8px;overflow:hidden">
    <div style="height:6px;background:#c43d32"></div>
    <div style="padding:32px 36px">
      <p style="margin:0 0 8px;color:#a52d26;font-size:14px;font-weight:700;text-transform:uppercase">Alerta de Seguridad 🔒</p>
      <h1 style="margin:0 0 24px;font-size:26px;line-height:1.3;color:#202824">Detectamos actividad inusual en tu acceso</h1>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">¡Hola, <strong>${name}</strong>!</p>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6">Te informamos que se han registrado <strong>${attempts} intentos consecutivos de inicio de sesión incorrectos</strong> (usuario o contraseña inválidos) en tu cuenta de <strong>BankLite</strong>.</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6">Como medida de protección inmediata y para garantizar que nadie más tenga acceso a tus fondos, <strong>hemos bloqueado temporalmente el acceso a tu banca en línea</strong>.</p>
      <div style="padding:18px 20px;background:#f4f6f5;border:1px solid #e1e7e3;border-radius:6px">
        <p style="margin:0 0 8px;font-size:15px;font-weight:700">Detalles del intento de acceso</p>
        <p style="margin:0;font-size:15px;line-height:1.6"><strong>Fecha y hora:</strong> ${formattedDate} (hora de Colombia)</p>
      </div>
      <h2 style="margin:28px 0 14px;font-size:19px;line-height:1.4;color:#202824">🛠️ ¿Qué debes hacer ahora?</h2>
      <div style="padding:0 0 16px;border-bottom:1px solid #e5ebe7">
        <p style="margin:0;font-size:15px;line-height:1.7"><strong>Si fuiste tú:</strong> no te preocupes, tu cuenta se desbloqueará automáticamente en <strong>30 minutos</strong>. Si necesitas ingresar con urgencia o requieres ayuda, responde a este correo. No compartas tu contraseña ni códigos de seguridad.</p>
      </div>
      <div style="padding:16px 0 0">
        <p style="margin:0;font-size:15px;line-height:1.7"><strong>Si NO fuiste tú:</strong> alguien pudo intentar adivinar tus datos de acceso. Cambia de inmediato la contraseña de tu correo electrónico personal y responde a este mensaje para que nuestro equipo pueda ayudarte a asegurar tu cuenta.</p>
      </div>
      <p style="margin:24px 0 16px;font-size:16px;line-height:1.6">En <strong>BankLite</strong> tu seguridad es nuestra máxima prioridad.</p>
      <p style="margin:0;font-size:16px;line-height:1.6">El equipo de Seguridad BankLite</p>
    </div>
    <div style="padding:20px 36px;background:#f4f6f5;color:#65716a;font-size:12px;line-height:1.6">
      <p style="margin:0 0 8px"><em>Este es un mensaje automático del sistema de alertas de BankLite. Por favor, no lo ignores si no reconoces la actividad.</em></p>
      <p style="margin:0"><em>© 2026 BankLite. Todos los derechos reservados.</em></p>
    </div>
  </div>
</div>`,
        };
      },
    },
  ],
};

/**
 * Regla por defecto para eventos que aún no están en el mapa de arriba:
 * solo in-app, con un texto genérico. Así el servicio nunca "pierde" un
 * evento nuevo silenciosamente — aparece en el dashboard aunque nadie haya
 * escrito todavía su copy definitivo.
 */
export function defaultRules(event: string): ChannelRule[] {
  return [
    {
      channel: 'in_app',
      build: () => ({
        title: event,
        body: `Tienes una actualización relacionada con: ${event}.`,
      }),
    },
  ];
}
