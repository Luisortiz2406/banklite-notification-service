import { CHANNEL_POLICY, defaultRules } from './channel-policy';

/**
 * Plantillas de cada evento. Para todos: cada canal tiene su propio texto, el nombre
 * se escapa en el HTML, un número de cuenta nunca sale completo y nada falla con
 * datos incompletos o hostiles.
 */
const HOSTILE_NAME = 'Ana <script>alert(1)</script> "Pérez"\nLópez';
const ACCOUNT = '10000001234';
const payload = {
  idUser: '11111111-1111-4111-8111-111111111111',
  nombreCompleto: HOSTILE_NAME,
  email: 'ana@banklite.test',
  amount: 1234567.5,
  currency: 'COP',
  type: 'transfer',
  direction: 'out',
  sourceAccountNumber: ACCOUNT,
  destinationAccountNumber: '10000005678',
  description: '<img src=x onerror=alert(1)>',
  transactionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  createdAt: '2026-11-11T15:30:00.000Z',
  merchantName: 'Cineluz <b>',
  chargeDate: '2026-12-05',
  nextAttemptDate: '2026-12-06',
  cardLast4: '4242',
  reason: 'Saldo insuficiente.',
  attempt: 2,
  retriesLeft: 2,
  final: false,
  intentos: 5,
  cerradaEn: '2026-11-11T15:00:00.000Z',
  cuentas: [ACCOUNT],
};
const events = Object.entries(CHANNEL_POLICY).filter(([, rules]) => rules.length > 0);
const html = (text: string) => /<[a-z][\s\S]*>/i.test(text);

describe('plantillas de CHANNEL_POLICY', () => {
  it('los eventos sin aviso (identity.verified, usuario_autenticado) están declarados explícitamente vacíos', () => {
    expect(CHANNEL_POLICY['identity.verified']).toEqual([]);
    expect(CHANNEL_POLICY['usuario_autenticado']).toEqual([]);
    expect(events.length).toBeGreaterThanOrEqual(13);
  });

  describe.each(events)('%s', (_event, rules) => {
    it('cada canal tiene su propio texto: no se copia el mismo contenido', () => {
      const built = rules.filter((rule) => !rule.when || rule.when(payload)).map((rule) => rule.build(payload));
      expect(built.length).toBeGreaterThan(0);
      for (const item of built) {
        expect(item.title.trim().length).toBeGreaterThan(0);
        expect(item.body.trim().length).toBeGreaterThan(0);
      }
      const bodies = built.map((item) => item.body);
      expect(new Set(bodies).size).toBe(bodies.length);
    });

    it('el correo es HTML con el nombre escapado y el asunto no admite saltos de línea', () => {
      for (const rule of rules.filter((r) => !r.when || r.when(payload))) {
        const { title, body } = rule.build(payload);
        expect(body).not.toContain('<script>');
        expect(body).not.toContain('<img src=x');
        expect(title).not.toMatch(/[\r\n]/); // un salto de línea en el asunto permitiría inyectar encabezados
        if (rule.channel === 'email') expect(html(body)).toBe(true);
      }
    });

    it('con un payload vacío no falla', () => {
      for (const rule of rules) {
        if (rule.when && !rule.when({})) continue;
        expect(() => rule.build({})).not.toThrow();
        expect(rule.build({}).title.length).toBeGreaterThan(0);
      }
    });

    it('con valores de tipo equivocado tampoco falla', () => {
      const weird = {
        nombreCompleto: 42,
        amount: 'mucho',
        currency: null,
        cuentas: 'x',
        cardLast4: 7,
        chargeDate: 5,
        reason: {},
      };
      for (const rule of rules) {
        if (rule.when && !rule.when(weird)) continue;
        expect(() => rule.build(weird)).not.toThrow();
      }
    });
  });

  describe('transaction.completed', () => {
    const [inApp, email] = CHANNEL_POLICY['transaction.completed'];

    it('el aviso en la app dice qué pasó según el tipo y la dirección, con el monto en pesos colombianos', () => {
      const text = (extra: object) => inApp.build({ ...payload, ...extra });

      expect(text({ type: 'credit' })).toMatchObject({ title: 'Abono recibido' });
      expect(text({ type: 'deposit' })).toMatchObject({ title: 'Consignación recibida' });
      expect(text({ type: 'debit' })).toMatchObject({ title: 'Cargo a tu cuenta' });
      expect(text({ type: 'reversal', direction: 'in' })).toMatchObject({ title: 'Reverso recibido' });
      expect(text({ type: 'reversal', direction: 'out' })).toMatchObject({ title: 'Reverso aplicado' });
      const sent = text({ type: 'transfer', direction: 'out' });
      expect(sent.title).toBe('Transferencia realizada');
      expect(sent.body).toContain('1.234.567,50 COP');
      expect(sent.body).toContain('····5678');
      expect(text({ type: 'transfer', direction: 'in' }).body).toContain('····1234');
      expect(text({ amount: 'x', currency: 'USD' }).body).toContain('0,00 USD');
    });

    it('un cobro de suscripción no se avisa aquí, y el correo es solo para quien envía una transferencia', () => {
      expect(inApp.when!({ ...payload, type: 'payment' })).toBe(false);
      expect(inApp.when!({ ...payload, type: 'credit' })).toBe(true);
      expect(email.when!({ ...payload, type: 'transfer', direction: 'out' })).toBe(true);
      expect(email.when!({ ...payload, type: 'transfer', direction: 'in' })).toBe(false);
      expect(email.when!({ ...payload, type: 'debit', direction: 'out' })).toBe(false);
    });

    it('el comprobante por correo enmascara la cuenta, escapa la descripción y trae una referencia corta', () => {
      const { title, body } = email.build(payload);

      expect(title).toBe('Transferencia enviada: 1.234.567,50 COP a la cuenta ····5678');
      expect(body).toContain('ABCDEF12');
      expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(body).toContain('(hora de Colombia)');
      expect(body).not.toContain('10000005678');
      expect(email.build({ ...payload, transactionId: undefined, description: ' ' }).body).toContain('Transferencia');
    });
  });

  describe('intento_fallido_login', () => {
    const [rule] = CHANNEL_POLICY['intento_fallido_login'];

    it('solo avisa por correo cuando la cuenta quedó bloqueada (5 intentos), no en cada intento', () => {
      expect(rule.channel).toBe('email');
      expect(rule.when!({ intentos: 1 })).toBe(false);
      expect(rule.when!({ intentos: 4 })).toBe(false);
      expect(rule.when!({ intentos: 5 })).toBe(true);
      expect(rule.when!({ intentos: 9 })).toBe(true);
      expect(rule.when!({})).toBe(false);
      expect(rule.build(payload).title).toContain('Alerta de seguridad');
    });
  });

  describe('suscripciones y tarjeta', () => {
    it('los avisos nombran el servicio sin romper el HTML y la tarjeta solo con sus últimos 4 dígitos', () => {
      const [upcoming] = CHANNEL_POLICY['subscription.charge_upcoming'];
      expect(upcoming.build(payload).title).toBe('Próximo cobro de Cineluz <b>');
      expect(upcoming.build(payload).body).toContain('5 de diciembre de 2026');
      expect(upcoming.build(payload).body).toContain('tu tarjeta ····4242');
      expect(upcoming.build({ ...payload, chargeDate: 'no-fecha', cardLast4: '12' }).body).toContain('—');
      expect(upcoming.build({ ...payload, merchantName: '  ' }).title).toBe('Próximo cobro de tu suscripción');

      const email = CHANNEL_POLICY['subscription.charge_upcoming'][1].build(payload);
      expect(email.body).toContain('Cineluz &lt;b&gt;');
    });

    it('un rechazo explica el motivo y los reintentos; la suspensión avisa que ya no se cobra', () => {
      const [rejectedApp, rejectedMail] = CHANNEL_POLICY['subscription.charge_rejected'];
      expect(rejectedApp.build(payload).title).toBe('No pudimos cobrar Cineluz <b>');
      expect(rejectedApp.build(payload).body).toContain('Saldo insuficiente');
      expect(rejectedMail.build({ ...payload, final: true }).body.length).toBeGreaterThan(100);

      const [suspendedApp] = CHANNEL_POLICY['subscription.suspended'];
      expect(suspendedApp.build(payload).title).toBe('Cineluz <b> quedó suspendida');
    });

    it('los cambios de la tarjeta distinguen el límite diario de las compras por internet', () => {
      const [app] = CHANNEL_POLICY['card.controls_changed'];
      expect(app.build({ field: 'daily_limit' }).title).toBe('Cambiaste el límite diario de tu tarjeta');
      expect(app.build({ field: 'online', onlineEnabled: true }).title).toBe('Activaste las compras por internet');
      expect(app.build({ field: 'online', onlineEnabled: false }).title).toBe('Desactivaste las compras por internet');

      const [declinedApp, declinedMail] = CHANNEL_POLICY['card.charge_declined'];
      expect(declinedApp.build(payload).title).toBe('Compra rechazada');
      expect(declinedMail.build(payload).title).toBe('Compra rechazada en Cineluz <b>');
    });
  });

  describe('cierre de cuenta, fraude e identidad', () => {
    it('la alerta de fraude nunca acusa al cliente: solo informa que se está revisando', () => {
      const [app, email] = CHANNEL_POLICY['fraud.alert'];
      expect(app.build(payload).body).toContain('No necesitas hacer nada');
      expect(`${app.build(payload).body}${email.build(payload).body}`).not.toMatch(/fraude|fraudulent|culpable/i);
    });

    it('la identidad rechazada avisa por la app y por correo', () => {
      expect(CHANNEL_POLICY['identity.rejected'].map((rule) => rule.channel)).toEqual(['in_app', 'email']);
    });

    it('el correo de bienvenida y el de identidad verificada usan el nombre escapado y un asunto sin saltos de línea', () => {
      const welcome = CHANNEL_POLICY['account.created'][0].build(payload);
      expect(welcome.title).toContain('Ana <script>alert(1)</script> "Pérez" López');
      expect(welcome.body).toContain('Ana &lt;script&gt;alert(1)&lt;/script&gt; &quot;Pérez&quot; López');
      expect(CHANNEL_POLICY['account.created'][0].build({}).title).toContain('¡Todo listo, Cliente!');
      expect(CHANNEL_POLICY['identity.email_confirmed'][0].build(payload).body).toContain('aprobado con éxito');
    });
  });

  it('un evento desconocido tiene una regla por defecto solo para la app, con su nombre', () => {
    const [rule] = defaultRules('evento.raro');

    expect(defaultRules('x')).toHaveLength(1);
    expect(rule.channel).toBe('in_app');
    expect(rule.build({})).toEqual({
      title: 'evento.raro',
      body: 'Tienes una actualización relacionada con: evento.raro.',
    });
  });
});
