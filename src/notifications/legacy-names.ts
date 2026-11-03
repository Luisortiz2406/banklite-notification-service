/**
 * Nombres que se usaron antes en comercios, convenios y bancos: primero marcas
 * reales y después nombres "Demo". Cada uno va con su nombre ficticio vigente
 * (card-service, payment-service y transfer-service ya publican los nombres
 * vigentes). Las notificaciones viejas guardaron el nombre de entonces en
 * title/body: al mostrarlas se traduce. La base no se reescribe y los correos ya
 * enviados no cambian.
 */
const LEGACY_NAMES: Readonly<Record<string, string>> = {
  // card-service: suscripciones y tiendas
  Netflix: 'Cineluz',
  'Cine Demo Estelar': 'Cineluz',
  Spotify: 'Ritmia',
  'Música Demo Sonar': 'Ritmia',
  'YouTube Premium': 'Pantalla Viva',
  'Video Demo Arcoíris': 'Pantalla Viva',
  'Prime Video': 'Estreno Plus',
  'Cine Demo Prisma': 'Estreno Plus',
  Max: 'Serial+',
  'Series Demo Aurora': 'Serial+',
  'Paramount+': 'Cumbre Play',
  'Cine Demo Cumbre': 'Cumbre Play',
  Crunchyroll: 'AnimeCielo',
  'Anime Demo Sakura': 'AnimeCielo',
  'Apple Music': 'Melodía Plus',
  'Música Demo Ritmo': 'Melodía Plus',
  Deezer: 'Eco Música',
  'Música Demo Eco': 'Eco Música',
  'iCloud+': 'Nubia Drive',
  'Nube Demo Cirro': 'Nubia Drive',
  'ChatGPT Plus': 'Asistente Sabio',
  'Asistente Demo IA': 'Asistente Sabio',
  'Duolingo Super': 'LinguaLoro',
  'Idiomas Demo Loro': 'LinguaLoro',
  'Xbox Game Pass': 'Arcadia Pass',
  'Juegos Demo Arcade': 'Arcadia Pass',
  'PlayStation Plus': 'Consola Total',
  'Juegos Demo Consola': 'Consola Total',
  Éxito: 'Supermercado Doña Canasta',
  'Supermercado Demo La Canasta': 'Supermercado Doña Canasta',
  Falabella: 'Almacenes Mirador',
  'Almacén Demo Plaza': 'Almacenes Mirador',
  'Juan Valdez Café': 'Café Cerro Alto',
  'Café Demo Montaña': 'Café Cerro Alto',
  'Mercado Libre': 'Tienda Vitrina',
  'Tienda en línea Demo Mercadito': 'Tienda Vitrina',
  Rappi: 'Mandaditos Ya',
  'Domicilios Demo Rápido': 'Mandaditos Ya',
  // payment-service: convenios y operadores
  'Acueducto de Bogotá': 'Acueducto Montecielo',
  'Aguas Demo Sabana': 'Acueducto Montecielo',
  'EPM Aguas': 'Aguas de Piedralinda',
  'Aguas Demo Montaña': 'Aguas de Piedralinda',
  'Aguas de Cartagena': 'Aguas de Bahía Serena',
  'Aguas Demo Bahía': 'Aguas de Bahía Serena',
  Emcali: 'Hidrocauce',
  'Aguas Demo Valle': 'Hidrocauce',
  Aqualia: 'Acueducto Valleluna',
  'Aguas Demo Río': 'Acueducto Valleluna',
  Veolia: 'Aguas Brisaclara',
  'Aguas Demo Manantial': 'Aguas Brisaclara',
  'Enel Colombia': 'Energía Cumbre',
  'Energía Demo Sabana': 'Energía Cumbre',
  'EPM Energía': 'Voltaria',
  'Energía Demo Montaña': 'Voltaria',
  'Air-e': 'Luz del Llano',
  'Energía Demo Brisa': 'Luz del Llano',
  Celsia: 'Fulgor Energía',
  'Energía Demo Valle': 'Fulgor Energía',
  Afinia: 'Energía Brisamar',
  'Energía Demo Costa': 'Energía Brisamar',
  Vanti: 'Gas Sabanero',
  'Gas Demo Sabana': 'Gas Sabanero',
  'EPM Gas': 'Gas del Río',
  'Gas Demo Montaña': 'Gas del Río',
  'Gases de Occidente': 'Calorandes',
  'Gas Demo Valle': 'Calorandes',
  Surtigas: 'Gasbahía',
  'Gas Demo Bahía': 'Gasbahía',
  'Gases del Caribe': 'Gas Llamarada',
  'Gas Demo Costa': 'Gas Llamarada',
  'Claro Hogar': 'Ondanet Hogar',
  'Internet Demo Colibrí': 'Ondanet Hogar',
  'Movistar Fibra': 'Telvia Fibra',
  'Internet Demo Tucán': 'Telvia Fibra',
  'Tigo Hogar': 'Celmar Hogar',
  'Internet Demo Guacamaya': 'Celmar Hogar',
  ETB: 'Teleandes',
  'Internet Demo Cóndor': 'Teleandes',
  Claro: 'Ondanet',
  'Móvil Demo Colibrí': 'Ondanet',
  Movistar: 'Telvia',
  'Móvil Demo Tucán': 'Telvia',
  Tigo: 'Celmar',
  'Móvil Demo Guacamaya': 'Celmar',
  WOM: 'Fonik',
  'Móvil Demo Toche': 'Fonik',
  'Virgin Mobile': 'Lumo Móvil',
  'Móvil Demo Turpial': 'Lumo Móvil',
  DirecTV: 'Satelvisión',
  'TV Demo Satélite': 'Satelvisión',
  'Claro TV': 'Ondanet TV',
  'TV Demo Colibrí': 'Ondanet TV',
  'Tigo TV': 'Celmar TV',
  'TV Demo Guacamaya': 'Celmar TV',
  // transfer-service: bancos y billeteras
  Bancolombia: 'Banco Cordillera',
  'Banco Demo Cóndor': 'Banco Cordillera',
  'Banco de Bogotá': 'Banco Guayacán',
  'Banco Demo Ceiba': 'Banco Guayacán',
  Davivienda: 'Banco Altamar',
  'Banco Demo Guadua': 'Banco Altamar',
  'BBVA Colombia': 'Banco Meridiano',
  'Banco Demo Frailejón': 'Banco Meridiano',
  'Banco de Occidente': 'Banco Sabanal',
  'Banco Demo Orquídea': 'Banco Sabanal',
  Nequi: 'Billetera Pulso',
  'Billetera Demo Colibrí': 'Billetera Pulso',
  DaviPlata: 'Billetera Brío',
  'Billetera Demo Tucán': 'Billetera Brío',
  'llave Bre-B': 'llave Banklite',
  'llaves Bre-B': 'llaves Banklite',
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Primero los nombres largos ("Claro Hogar" antes que "Claro"). Solo palabras
// completas y con la misma mayúscula: "claro" o "máximo" en un texto no cambian.
const PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${Object.keys(LEGACY_NAMES)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);

/** Texto con los nombres vigentes en lugar de las marcas que se usaron antes. */
export function currentNames(text: string): string {
  return typeof text === 'string' ? text.replace(PATTERN, (name) => LEGACY_NAMES[name] ?? name) : text;
}
