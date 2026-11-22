// Utilidades de texto: normalización, tokenización y anonimización.

const STOP = new Set(`a al algo algun alguna algunas alguno algunos ante antes aquel aquella aquellas aquellos aqui asi aun
aunque cada como con conforme contra cual cuales cualquier cuando cuanto de del desde donde dos durante e el ella ellas
ello ellos en entre era eran es esa esas ese eso esos esta estaba estaban estado estan estar estas este esto estos fue
fueron ha habia habian han hasta hay la las le les lo los mas me mediante mi mientras mismo misma mismos mismas muy ni no
nos o otra otras otro otros para pero poco por porque pues que quien quienes se sea sean segun ser si sido siempre sin
sobre son su sus tal tambien tan tanto te tiene tienen todo toda todos todas tras tu un una uno unos unas y ya dicho
dicha dichos dichas cuyo cuya cuyos cuyas hecho hechos sala corte decision providencia articulo ley`.split(/\s+/));

// Expresión regular estándar para quitar tildes y diacríticos
export const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Tokenizador para la búsqueda léxica (BM25)
export function tokenizar(s) {
  const salida = [];
  for (const t of normalizar(s).match(/[a-z0-9]+/g) || []) {
    if (/^\d+$/.test(t)) { if (t.length === 3) salida.push(t); continue; }
    if (t.length < 3 || STOP.has(t)) continue;
    salida.push(t.length > 6 ? t.slice(0, 6) : t);
  }
  return salida;
}

// Anonimización conservadora: nunca reemplazar pares de palabras al azar.
// Los roles solo se asignan cuando aparecen expresamente en el documento.
const ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PERSONA = String.raw`[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+`;
const NOMBRE = String.raw`(?:${PERSONA}(?:\s+${PERSONA}){1,3})`;
const ROLES = [
  ['víctima', 'la víctima'], ['victima', 'la víctima'],
  ['acusado', 'el acusado'], ['acusada', 'la acusada'],
  ['procesado', 'el procesado'], ['procesada', 'la procesada'],
  ['imputado', 'el imputado'], ['imputada', 'la imputada'],
  ['testigo', 'el testigo'], ['denunciante', 'la persona denunciante'],
  ['investigado', 'la persona investigada'], ['investigada', 'la persona investigada']
];
const GENERAL = [
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/giu, 'correo electrónico reservado'],
  [/\b(?:c\.?\s*c\.?|c[eé]dula(?:\s+de\s+ciudadan[ií]a)?|t\.?\s*i\.?|documento\s+de\s+identidad)\s*(?:n[.°ºo]*\s*)?[:#-]?\s*\d[\d.\s-]{5,16}\d\b/giu, 'documento de identidad reservado'],
  [/\b(?:\+?57[\s-]?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/gu, 'número de contacto reservado'],
  [/\b(?:calle|cll\.?|carrera|cra\.?|avenida|av\.?|diagonal|transversal)\s+\d+[a-z]?\s*(?:#|n[.°ºo]*)\s*\d+[a-z]?\s*[- ]\s*\d+\b/giu, 'dirección reservada']
];
const NO_NOMBRES = new Set('corte suprema justicia sala casacion penal fiscalia general nacion tribunal superior distrito judicial republica colombia codigo procedimiento ley articulo magistrado ponente bogota medellin sentencia auto'.split(' '));
function plausibleNombre(s) {
  const palabras = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/);
  return palabras.length >= 2 && palabras.every(w => !NO_NOMBRES.has(w));
}
function rolGenerico(s) {
  const n = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ROLES.find(([r]) => r.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === n)?.[1] || 'la persona mencionada';
}
export function anonimizar(texto, { nombresConocidos = [] } = {}) {
  let t = String(texto || '');
  let reemplazos = 0;
  const sustituciones = new Map();
  const reemplazar = (re, rep) => { t = t.replace(re, () => { reemplazos++; return rep; }); };
  for (const [re, rep] of GENERAL) reemplazar(re, rep);

  // Sustituir primero los nombres identificados en el documento completo.
  // Así no quedan fragmentos como «GIAN CARLO la persona mencionada».
  const conocidos = nombresConocidos
    .map(item => typeof item === 'string' ? { nombre: item, rol: 'PERSONA RESERVADA' } : item)
    .filter(item => item && typeof item.nombre === 'string' && plausibleNombre(item.nombre))
    .sort((a, b) => b.nombre.length - a.nombre.length);
  for (const item of conocidos) {
    const patron = item.nombre.trim().split(/\s+/).map(ESC).join('\\s+');
    reemplazar(new RegExp(String.raw`(?<![\p{L}])${patron}(?![\p{L}])`, 'giu'), item.rol || 'PERSONA RESERVADA');
  }
  // No inferir nombres de palabras capitalizadas ni de roles genéricos:
  // esto corrompía fechas (Bogotá, D. C.) y dejaba nombres a medias.
  // Los participantes se identifican una sola vez sobre el documento original.
  // Los alias se incorporan únicamente mediante revisión explícita.
  // Normalizar etiquetas sin redundancias.
  t = t.replace(/\bcorreo\s+correo electrónico reservado\b/giu, 'correo electrónico reservado');
  t = t.replace(/\b(?:teléfono|telefono|celular)\s+número de contacto reservado\b/giu, 'número de contacto reservado');
  // Iniciales con puntos (p. ej., B.M.B.R.) en el cuerpo del documento.
  reemplazar(/(?<![\p{L}])(?:[A-Z]\.\s*){3,}[A-Z]?\.?(?![\p{L}])/gu, 'la persona mencionada');
  // Evitar duplicaciones cuando el rol ya aparece antes del nombre.
  t = t.replace(/\b(el acusado|la acusada|el procesado|la procesada|el imputado|la imputada|la víctima|el testigo|la persona denunciante)\s+\1\b/giu, '$1');
  // Los alias no identificados quedan señalados para revisión; no se altera el resto de la oración.
  return { texto: t, reemplazos, advertencia: 'Detección automática parcial: revisar nombres sin rol explícito, iniciales y datos no estructurados antes de publicar.' };
}