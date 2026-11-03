/**
 * Marcas reales que se usaron antes en los nombres de comercios, convenios y
 * bancos, con su nombre inventado actual (card-service, payment-service y
 * transfer-service ya publican los nombres nuevos). Las notificaciones viejas
 * guardaron el nombre de entonces en title/body: al mostrarlas se traduce.
 * La base no se reescribe y los correos ya enviados no cambian.
 */
const LEGACY_NAMES: Readonly<Record<string, string>> = {
  // card-service: suscripciones y tiendas
  Netflix: 'Cine Demo Estelar',
  Spotify: 'Música Demo Sonar',
  'YouTube Premium': 'Video Demo Arcoíris',
  'Prime Video': 'Cine Demo Prisma',
  Max: 'Series Demo Aurora',
  'Paramount+': 'Cine Demo Cumbre',
  Crunchyroll: 'Anime Demo Sakura',
  'Apple Music': 'Música Demo Ritmo',
  Deezer: 'Música Demo Eco',
  'iCloud+': 'Nube Demo Cirro',
  'ChatGPT Plus': 'Asistente Demo IA',
  'Duolingo Super': 'Idiomas Demo Loro',
  'Xbox Game Pass': 'Juegos Demo Arcade',
  'PlayStation Plus': 'Juegos Demo Consola',
  Éxito: 'Supermercado Demo La Canasta',
  Falabella: 'Almacén Demo Plaza',
  'Juan Valdez Café': 'Café Demo Montaña',
  'Mercado Libre': 'Tienda en línea Demo Mercadito',
  Rappi: 'Domicilios Demo Rápido',
  // payment-service: convenios y operadores
  'Acueducto de Bogotá': 'Aguas Demo Sabana',
  'EPM Aguas': 'Aguas Demo Montaña',
  'Aguas de Cartagena': 'Aguas Demo Bahía',
  Emcali: 'Aguas Demo Valle',
  Aqualia: 'Aguas Demo Río',
  Veolia: 'Aguas Demo Manantial',
  'Enel Colombia': 'Energía Demo Sabana',
  'EPM Energía': 'Energía Demo Montaña',
  'Air-e': 'Energía Demo Brisa',
  Celsia: 'Energía Demo Valle',
  Afinia: 'Energía Demo Costa',
  Vanti: 'Gas Demo Sabana',
  'EPM Gas': 'Gas Demo Montaña',
  'Gases de Occidente': 'Gas Demo Valle',
  Surtigas: 'Gas Demo Bahía',
  'Gases del Caribe': 'Gas Demo Costa',
  'Claro Hogar': 'Internet Demo Colibrí',
  'Movistar Fibra': 'Internet Demo Tucán',
  'Tigo Hogar': 'Internet Demo Guacamaya',
  ETB: 'Internet Demo Cóndor',
  'Claro TV': 'TV Demo Colibrí',
  'Tigo TV': 'TV Demo Guacamaya',
  DirecTV: 'TV Demo Satélite',
  Claro: 'Móvil Demo Colibrí',
  Movistar: 'Móvil Demo Tucán',
  Tigo: 'Móvil Demo Guacamaya',
  WOM: 'Móvil Demo Toche',
  'Virgin Mobile': 'Móvil Demo Turpial',
  // transfer-service: bancos y billeteras
  Bancolombia: 'Banco Demo Cóndor',
  'Banco de Bogotá': 'Banco Demo Ceiba',
  Davivienda: 'Banco Demo Guadua',
  'BBVA Colombia': 'Banco Demo Frailejón',
  'Banco de Occidente': 'Banco Demo Orquídea',
  Nequi: 'Billetera Demo Colibrí',
  DaviPlata: 'Billetera Demo Tucán',
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
