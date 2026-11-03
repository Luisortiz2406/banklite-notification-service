import { currentNames } from './legacy-names';

describe('currentNames (notificaciones viejas con marcas reales)', () => {
  it('traduce los nombres de suscripciones, tiendas, convenios y bancos', () => {
    expect(currentNames('Próximo cobro de Netflix')).toBe('Próximo cobro de Cine Demo Estelar');
    expect(currentNames('No pudimos cobrar Paramount+')).toBe('No pudimos cobrar Cine Demo Cumbre');
    expect(currentNames('Éxito · $ 20.000 COP. Motivo: límite diario')).toBe(
      'Supermercado Demo La Canasta · $ 20.000 COP. Motivo: límite diario',
    );
    expect(currentNames('Agua · Acueducto de Bogotá · Ref. 123456')).toBe('Agua · Aguas Demo Sabana · Ref. 123456');
    expect(currentNames('<strong>Transferencia a Bancolombia</strong>')).toBe(
      '<strong>Transferencia a Banco Demo Cóndor</strong>',
    );
  });

  it('usa el nombre más largo primero', () => {
    expect(currentNames('Internet · Claro Hogar')).toBe('Internet · Internet Demo Colibrí');
    expect(currentNames('Claro TV y Claro')).toBe('TV Demo Colibrí y Móvil Demo Colibrí');
  });

  it('no toca palabras comunes ni los textos nuevos', () => {
    const text = '¡Identidad verificada con éxito! Es claro que el máximo es Maxi. Cine Demo Estelar';
    expect(currentNames(text)).toBe(text);
  });
});
