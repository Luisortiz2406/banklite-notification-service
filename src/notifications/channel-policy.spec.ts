import { CHANNEL_POLICY } from './channel-policy';

describe('account.closed', () => {
  const rules = CHANNEL_POLICY['account.closed'];
  const payload = {
    idUser: '11111111-1111-4111-8111-111111111111',
    cerradaEn: '2026-10-26T15:00:00.000Z',
    cuentas: ['10000001234', { accountNumber: '10000005678' }],
    nombreCompleto: 'Ana <b>Pérez</b>',
    email: 'ana@banklite.test',
  };

  it('solo manda correo (el cliente ya no puede entrar a la app)', () => {
    expect(rules.map((rule) => rule.channel)).toEqual(['email']);
  });

  it('confirma la cancelación con la fecha, las cuentas enmascaradas y la conservación de 10 años', () => {
    const { title, body } = rules[0].build(payload);
    expect(title).toBe('BankLite — Confirmamos la cancelación de tu cuenta');
    expect(body).toContain('26 de octubre de 2026');
    expect(body).toContain('····1234, ····5678');
    expect(body).not.toContain('10000001234');
    expect(body).toContain('Perdidos');
    expect(body).toContain('10 años (plazo referencial del Código de Comercio)');
    // El nombre se escapa.
    expect(body).toContain('Ana &lt;b&gt;Pérez&lt;/b&gt;');
  });

  it('sin cuentas ni fecha válidas no falla', () => {
    const { body } = rules[0].build({ idUser: payload.idUser, cerradaEn: 'no-es-fecha', cuentas: ['<script>'] });
    expect(body).toContain('—');
    expect(body).not.toContain('<script>');
  });
});
