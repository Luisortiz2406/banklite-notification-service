import { currentNames } from './legacy-names';

describe('currentNames (notificaciones viejas con marcas reales)', () => {
  it('traduce los nombres de suscripciones, tiendas, convenios y bancos', () => {
    expect(currentNames('Próximo cobro de Netflix')).toBe('Próximo cobro de Cineluz');
    expect(currentNames('No pudimos cobrar Paramount+')).toBe('No pudimos cobrar Cumbre Play');
    expect(currentNames('Éxito · $ 20.000 COP. Motivo: límite diario')).toBe(
      'Supermercado Doña Canasta · $ 20.000 COP. Motivo: límite diario',
    );
    expect(currentNames('Agua · Acueducto de Bogotá · Ref. 123456')).toBe('Agua · Acueducto Montecielo · Ref. 123456');
    expect(currentNames('<strong>Transferencia a Bancolombia</strong>')).toBe(
      '<strong>Transferencia a Banco Cordillera</strong>',
    );
  });

  it('usa el nombre más largo primero', () => {
    expect(currentNames('Internet · Claro Hogar')).toBe('Internet · Ondanet Hogar');
    expect(currentNames('Claro TV y Claro')).toBe('Ondanet TV y Ondanet');
  });

  it('traduce también los nombres «Demo» que se guardaron antes', () => {
    expect(currentNames('Próximo cobro de Cine Demo Estelar')).toBe('Próximo cobro de Cineluz');
    expect(currentNames('Transferencia a Billetera Demo Colibrí')).toBe('Transferencia a Billetera Pulso');
    expect(currentNames('Internet · Internet Demo Colibrí')).toBe('Internet · Ondanet Hogar');
  });

  it('no cambia los nombres vigentes', () => {
    const vigentes = [
      'Banco Cordillera',
      'Banco Guayacán',
      'Banco Altamar',
      'Banco Meridiano',
      'Banco Sabanal',
      'Billetera Pulso',
      'Billetera Brío',
      'Acueducto Montecielo',
      'Aguas de Piedralinda',
      'Aguas de Bahía Serena',
      'Hidrocauce',
      'Acueducto Valleluna',
      'Aguas Brisaclara',
      'Energía Cumbre',
      'Voltaria',
      'Luz del Llano',
      'Fulgor Energía',
      'Energía Brisamar',
      'Gas Sabanero',
      'Gas del Río',
      'Calorandes',
      'Gasbahía',
      'Gas Llamarada',
      'Ondanet Hogar',
      'Telvia Fibra',
      'Celmar Hogar',
      'Teleandes',
      'Ondanet',
      'Telvia',
      'Celmar',
      'Fonik',
      'Lumo Móvil',
      'Satelvisión',
      'Ondanet TV',
      'Celmar TV',
      'Cineluz',
      'Ritmia',
      'Pantalla Viva',
      'Estreno Plus',
      'Serial+',
      'Cumbre Play',
      'AnimeCielo',
      'Melodía Plus',
      'Eco Música',
      'Nubia Drive',
      'Asistente Sabio',
      'LinguaLoro',
      'Arcadia Pass',
      'Consola Total',
      'Supermercado Doña Canasta',
      'Almacenes Mirador',
      'Café Cerro Alto',
      'Tienda Vitrina',
      'Mandaditos Ya',
    ];
    for (const name of vigentes) expect(currentNames(name)).toBe(name);
  });

  it('no toca palabras comunes ni los textos nuevos', () => {
    const text = '¡Identidad verificada con éxito! Es claro que el máximo es Maxi. Cineluz';
    expect(currentNames(text)).toBe(text);
  });
});
