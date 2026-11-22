import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const RAIZ_MODULO = path.dirname(fileURLToPath(import.meta.url));
import { readFile } from 'node:fs/promises';
import { anonimizar } from './texto.mjs';
import { generarJSON } from './gemini.mjs';

export const PORTAL =
  'https://consultajurisprudencial.ramajudicial.gov.co/WebRelatoria/csj/index.xhtml';

const MAX_PDF = 12 * 1024 * 1024;

// Reutiliza únicamente PDF oficiales ya verificados durante esta ejecución.
// Evita descargar de nuevo una misma providencia al consultar variantes.
const pdfVerificadosEnMemoria = new Map();
const VIDA_CACHE_PDF = 30 * 60 * 1000;
function claveProvidencia(meta) {
  return `${String(meta.providencia || '').trim().toUpperCase()}|${String(meta.radicado || '').replace(/\D/g, '')}`;
}
function recuperarPdfVerificado(meta) {
  const clave = claveProvidencia(meta);
  const entrada = pdfVerificadosEnMemoria.get(clave);
  if (!entrada) return null;
  if (Date.now() - entrada.fecha > VIDA_CACHE_PDF) {
    pdfVerificadosEnMemoria.delete(clave);
    return null;
  }
  return entrada.documento;
}


function enlacePdfOficial(valor) {
  try {
    const u = new URL(valor);
    if (u.protocol !== 'https:' || !/(^|\.)ramajudicial\.gov\.co$|(^|\.)cortesuprema\.gov\.co$/i.test(u.hostname)) return '';
    // Solo enlaces HTTP(S) directos al archivo, no rutas JSF o blob temporales.
    if (!/\.pdf$/i.test(u.pathname)) return '';
    return u.href;
  } catch { return ''; }
}


const normal = valor =>
  String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const pausa = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

// ======================================================
// 1. LECTURA DE DOCUMENTOS PDF
// ======================================================

export async function leerPDF(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.subarray(0, 5).toString() !== '%PDF-'
  ) {
    throw new Error('La descarga no es un PDF válido.');
  }

  if (buffer.length > MAX_PDF) {
    throw new Error('El PDF supera el límite de 12 MB.');
  }

  let pdf;

  try {
    ({ default: pdf } = await import('pdf-parse'));
  } catch {
    throw new Error('No se pudo cargar pdf-parse.');
  }

  const paginas = [];

  const salida = await pdf(buffer, {
    pagerender: async page => {
      const contenido = await page.getTextContent({
        normalizeWhitespace: false
      });

      let texto = '';
      let anterior = null;

      for (const item of contenido.items) {
        if (!item.str) continue;

        if (anterior) {
          const yAnterior = anterior.transform?.[5] ?? 0;
          const yActual = item.transform?.[5] ?? 0;

          const xFinal =
            (anterior.transform?.[4] ?? 0) +
            (anterior.width ?? 0);

          const xActual = item.transform?.[4] ?? 0;

          if (
            anterior.hasEOL ||
            Math.abs(yActual - yAnterior) > 2
          ) {
            texto += '\n';
          } else if (
            xActual - xFinal > 1.5 &&
            !/\s$/.test(texto) &&
            !/^\s/.test(item.str)
          ) {
            texto += ' ';
          }
        }

        texto += item.str;
        anterior = item;
      }

      paginas.push(texto.trim());
      return texto;
    }
  });

  if (
    !paginas.length ||
    paginas.join('').trim().length < 100
  ) {
    throw new Error(
      'PDF sin texto extraíble. Requiere revisión manual.'
    );
  }

  return {
    paginas,
    total: salida.numpages
  };
}

// ======================================================
// 2. VERIFICACIÓN DE PROVIDENCIA Y RADICADO
// ======================================================

export function verificarDocumento(paginas, providencia, radicado) {
  // Los encabezados de los PDF oficiales pueden escribir AP612-2026 como
  // "AP 612 / 2026" y pueden comenzar después de una portada.
  const cabecera = normal(paginas.slice(0, 5).join(' '));
  const compacto = cabecera.replace(/[^a-z0-9]/g, '');
  const numero = normal(providencia).replace(/[^a-z0-9]/g, '');
  const rad = String(radicado || '').replace(/\D/g, '');
  if (!numero || !compacto.includes(numero)) {
    throw new Error(`Identidad no confirmada: el texto extraído de las primeras 5 páginas no contiene ${providencia}. PDF pendiente de verificación manual.`);
  }
  if (rad && !compacto.includes(rad)) {
    throw new Error(`Identidad no confirmada: el texto extraído de las primeras 5 páginas no contiene el radicado ${radicado}. PDF pendiente de verificación manual.`);
  }
  return true;
}

// ======================================================
// 3. IDENTIFICACIÓN DE DATOS PERSONALES
// ======================================================

// Se buscan nombres vinculados EXPLÍCITAMENTE a una persona del proceso.
// No se infieren nombres de cualquier secuencia de palabras capitalizadas.
const PALABRA_NOMBRE = String.raw`(?:[A-ZÁÉÍÓÚÜÑ]{2,}|[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{1,})`;
const NOMBRE_CANDIDATO = String.raw`(${PALABRA_NOMBRE}(?:\s+(?:de|del|la|los|las)\s+|\s+)(?:${PALABRA_NOMBRE})){1,5}`;
const ROL_PERSONA = String.raw`(?:v[ií]ctima|acusad[oa]|procesad[oa]|imputad[oa]|condenad[oa]|accionante|recurrente|denunciante|testigo|investigad[oa]|sentenciad[oa]|querellante|demandante|peticionari[oa]|agresor|ofendid[oa])`;
const PATRONES_PERSONAS = [
  new RegExp(String.raw`\b${ROL_PERSONA}\s*(?:[:–-]\s*|de\s+nombre\s+|identificad[oa]\s+como\s+|llamad[oa]\s+|denominad[oa]\s+|es\s+)?${NOMBRE_CANDIDATO}`, 'gu'),
  new RegExp(String.raw`\b(?:h[áa]beas\s+corpus\s+(?:promovid[oa]|presentad[oa]|interpuest[oa])\s+por|solicitud\s+de\s+h[áa]beas\s+corpus\s+formulada\s+por|(?:conden[oó]|condenaron)\s+a)\s+${NOMBRE_CANDIDATO}`, 'giu'),
  new RegExp(String.raw`\b(?:ACCIONANTE|ACCIONADO|PROCESADO|ACUSADO|CONDENADO|V[ÍI]CTIMA|RECURRENTE|DENUNCIANTE)\s*:\s*${NOMBRE_CANDIDATO}`, 'gu')
];
const NO_PERSONA = new Set(`CORTE SUPREMA JUSTICIA SALA CASACION PENAL TRIBUNAL SUPERIOR FISCALIA GENERAL NACION DISTRITO JUDICIAL BOGOTA MAGISTRADO PONENTE REPUBLICA COLOMBIA PROCURADURIA DEFENSORIA JUZGADO JUEZ CONSTITUCIONAL SENTENCIA PROVIDENCIA AUTO RADICADO LEY CODIGO ARTICULO CORPUS HABEAS POLICIA NACIONAL INSTITUTO PENITENCIARIO`.split(' '));
const CORTE_NOMBRE = new Set(`FUE ERA ES ESTA ESTABA DECLARO DIJO SOSTUVO MANIFESTO INFORMO AFIRMO SOLICITO PRESENTO INDICO NARRO RELATO EXPLICO EXPRESO QUIEN QUE POR ANTE EN CON PARA DEL AL SE SU SUS Y EL LA LOS LAS UN UNA COMO MEDIANTE`.split(' '));
function nombreValido(candidato) {
  const palabras = candidato.trim().split(/\s+/);
  const conectores = new Set(['DE','DEL','LA','LOS','LAS']);
  const reales = palabras.filter(w => !conectores.has(normal(w).toUpperCase()));
  return reales.length >= 2 && reales.length <= 6 &&
    reales.every(w => !NO_PERSONA.has(normal(w).toUpperCase()) && !CORTE_NOMBRE.has(normal(w).toUpperCase()));
}
// Identificar nombres en el ORIGINAL, antes de cualquier sustitución.
// La captura se limita a tokens con forma de nombre y a contextos explícitos.
function detectarParticipantesExplicitos(paginas) {
  const texto = paginas.join('\n');
  const hallados = new Set();
  const token = String.raw`(?:[A-ZÁÉÍÓÚÜÑ]{2,}|[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{1,})`;
  const nombre = String.raw`(${token}(?:[ \t]+${token}){1,5})`;
  const contextos = [
    String.raw`\b(?:defensa\s+de|defensor\s+de|defensora\s+de|conden[oó]\s+a|contra|procesado|procesada|acusado|acusada|imputado|imputada|v[ií]ctima|denunciante|testigo|accionante|recurrente)\s+(?:de\s+nombre\s+|identificad[oa]\s+como\s+|llamad[oa]\s+)?${nombre}`,
    String.raw`\b(?:ACCIONANTE|ACCIONADO|PROCESADO|ACUSADO|CONDENADO|V[ÍI]CTIMA|RECURRENTE|DENUNCIANTE)\s*:\s*${nombre}`
  ];
  for (const fuente of contextos) {
    const patron = new RegExp(fuente, 'gu');
    for (const m of texto.matchAll(patron)) {
      const palabras = m[1].trim().split(/\s+/);
      const aceptadas = [];
      for (const palabra of palabras) {
        if (NO_PERSONA.has(normal(palabra).toUpperCase()) || CORTE_NOMBRE.has(normal(palabra).toUpperCase())) break;
        aceptadas.push(palabra);
      }
      const candidato = aceptadas.join(' ');
      if (nombreValido(candidato)) hallados.add(candidato);
    }
  }
  // Eliminar candidatos que sean partes de otro nombre completo detectado.
  return [...hallados].sort((a,b)=>b.length-a.length).filter((nombre, i, todos) =>
    !todos.some((otro,j)=>j<i && patronNombre(nombre).test(otro))
  );
}

function patronNombre(nombre) {
  const letras = {
    a: '[aá]',
    e: '[eé]',
    i: '[ií]',
    o: '[oó]',
    u: '[uúü]',
    n: '[nñ]'
  };

  const escape = s =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const palabras = nombre.split(/\s+/).map(p =>
    [...normal(p)]
      .map(c => letras[c] || escape(c))
      .join('')
  );

  return new RegExp(
    String.raw`(?<![\p{L}])${palabras.join(
      String.raw`\s+`
    )}(?![\p{L}])`,
    'giu'
  );
}

// Normalización única para la revisión y sustitución de nombres.
function claveNombrePrivado(valor) {
  return normal(valor).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nombresUnicosPrivados(nombres) {
  const mapa = new Map();
  for (const candidato of nombres) {
    const nombre = String(candidato || '').replace(/\s+/g, ' ').trim();
    if (!nombreValido(nombre)) continue;
    const clave = claveNombrePrivado(nombre);
    if (!mapa.has(clave)) mapa.set(clave, nombre);
  }
  // Preferir el nombre más completo; quitar variantes contenidas dentro de él.
  return [...mapa.values()].sort((a, b) => b.length - a.length).filter((nombre, i, todos) =>
    !todos.some((otro, j) => j < i && claveNombrePrivado(otro).split(' ').join(' ').includes(claveNombrePrivado(nombre)) &&
      new RegExp(String.raw`(?:^| )${claveNombrePrivado(nombre).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(claveNombrePrivado(otro))));
}

// ======================================================
// 4. ANONIMIZACIÓN OBLIGATORIA
// ======================================================

export function anonimizarPaginas(paginas, { nombresAdicionales = [] } = {}) {
  if (
    !Array.isArray(paginas) ||
    !paginas.length ||
    paginas.some(p => typeof p !== 'string')
  ) {
    throw new Error(
      'Páginas inválidas; revisión manual requerida.'
    );
  }

  // Conservar variantes para sustituirlas, aunque la interfaz muestre una sola.
  // Un nombre corto puede aparecer solo en otra página del mismo documento.
  const explicitos = detectarParticipantesExplicitos(paginas);
  const largos = candidatosNombresLargos(paginas);
  const adicionales = Array.isArray(nombresAdicionales) ? nombresAdicionales : [];
  const participantes = nombresUnicosPrivados([...explicitos, ...adicionales, ...largos]);

  if (!participantes.length) {
    throw new Error('No se pudieron identificar nombres para anonimizar; revisión manual requerida.');
  }

  // Primero los nombres largos, luego sus variantes y apellidos compuestos.
  // Todas las variantes de una persona usan el mismo identificador.
  const sustituciones = [];
  participantes.forEach((persona, i) => {
    const rol = `PERSONA_${i + 1}`;
    sustituciones.push({ nombre: persona, rol });
    const partes = persona.trim().split(/\s+/);
    if (partes.length >= 3) {
      const apellido = partes.slice(-2).join(' ');
      if (nombreValido(apellido)) {
        const compartido = participantes.some((otra, j) => j !== i && patronNombre(apellido).test(otra));
        if (!compartido) sustituciones.push({ nombre: apellido, rol });
      }
    }
  });
  // No asignar un identificador distinto a una variante corta del mismo nombre.
  const variantes = [...explicitos, ...adicionales, ...largos]
    .filter(n => typeof n === 'string' && nombreValido(n))
    .sort((a, b) => b.length - a.length);
  for (const variante of variantes) {
    if (sustituciones.some(s => claveNombrePrivado(s.nombre) === claveNombrePrivado(variante))) continue;
    const dueños = participantes.filter(p => patronNombre(variante).test(p));
    if (dueños.length === 1) {
      const dueño = participantes.indexOf(dueños[0]);
      sustituciones.push({ nombre: variante, rol: `PERSONA_${dueño + 1}` });
    }
  }
  sustituciones.sort((a, b) => b.nombre.length - a.nombre.length);

  const seguras = paginas.map(pagina => {
    let base = anonimizar(pagina, { nombresConocidos: sustituciones }).texto;
    for (const { nombre, rol } of sustituciones) {
      base = base.replace(patronNombre(nombre), rol);
    }
    return base.replace(/\b(la víctima|el acusado|la acusada|el procesado|la procesada)\s+la persona mencionada\b/giu, '$1');
  });

  // Nunca aprobar un documento si queda alguna variante conocida sin sustituir.
  if (seguras.some(pagina => sustituciones.some(({ nombre }) => patronNombre(nombre).test(pagina)))) {
    throw new Error('Persisten nombres identificados sin anonimizar; se mantiene el bloqueo.');
  }

  // La detección de restos se hace con el texto original y se revisa manualmente.
  // No bloquear por dos personas que compartan un nombre de pila.
  const sospechosos = [
    /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu,
    /\b(?:c[eé]dula|C\.?\s*C\.?|documento de identidad)\s*(?:n[°º.]?\s*)?\d{6,}/iu,
    /\b(?:\+?57\s*)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/u
  ];

  if (
    seguras.some(pagina =>
      sospechosos.some(re => re.test(pagina))
    )
  ) {
    throw new Error(
      'Se detectaron datos personales sin anonimizar; revisión manual requerida.'
    );
  }

  // Barrera conservadora adicional: nombres completos de tres o más palabras
  // con capitalización de nombre propio, incluso sin un rol inmediatamente
  // anterior. Si sobreviven al saneamiento, el documento queda BLOQUEADO.
  // No se transmiten candidatos ni textos originales al cliente o a Gemini.
  // Se comprueban nombres en formato convencional y en MAYÚSCULAS.
  const candidatosOriginales = new Set(candidatosNombresLargos(paginas));
  // Segunda sustitución sobre el texto ya saneado: algunos nombres completos
  // sobreviven al anonimizador general por cambios de formato o solapamientos.
  // Se usa solo la lista detectada en el PDF original; no se inventan nombres.
  const restantes = nombresUnicosPrivados([...candidatosOriginales]).filter(nombre =>
    seguras.some(pagina => patronNombre(nombre).test(pagina)));
  for (const nombre of restantes.sort((a, b) => b.length - a.length)) {
    // Etiqueta estable, sin revelar el nombre en mensajes o registros.
    const indice = participantes.findIndex(persona =>
      claveNombrePrivado(persona) === claveNombrePrivado(nombre) ||
      patronNombre(nombre).test(persona));
    const etiqueta = indice >= 0 ? `PERSONA_${indice + 1}` : 'PERSONA_RESERVADA';
    for (let i = 0; i < seguras.length; i++) {
      seguras[i] = seguras[i].replace(patronNombre(nombre), etiqueta);
    }
  }
  const aunVisibles = [...candidatosOriginales].filter(nombre =>
    seguras.some(pagina => patronNombre(nombre).test(pagina)));
  if (aunVisibles.length) {
    throw new Error(`Quedan ${aunVisibles.length} posibles nombres completos sin anonimizar; revisión manual requerida.`);
  }

  // Control adicional sobre nombres de DOS palabras, variantes y saltos de línea.
  // Un resultado dudoso se bloquea: nunca se declara apto para Gemini.
  const patronesResiduales = [
    /\b(?:señor(?:a)?|sr\.?|sra\.?|testigo|investigador(?:a)?|procesad[oa]|acusad[oa]|condenad[oa]|defensor(?:a)?|ciudadan[oa])\s+([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,}\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,})/gu,
    /\b(?:señor(?:a)?|sr\.?|sra\.?)\s+([A-ZÁÉÍÓÚÜÑ]{3,}\s+[A-ZÁÉÍÓÚÜÑ]{3,})/gu,
    /\b(?:testimonio de|declaración de|perteneciente a|voces de|de la defensa de)\s+([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,}\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,})/giu,
    /\b(?:señor|señora)\s+(PERSONA_\d+)\s+([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,})/gu
  ];
  for (const pagina of seguras) {
    for (const patron of patronesResiduales) {
      patron.lastIndex = 0;
      for (const m of pagina.matchAll(patron)) {
        const candidato = m[1] || '';
        if (candidato.startsWith('PERSONA_') || nombreValido(candidato)) {
          throw new Error('Posible nombre personal residual en contexto procesal; revisión manual requerida.');
        }
      }
    }
  }

  // Comprobación final independiente: no aprobar si quedan menciones
  // identificables en contextos de participación procesal.
  const pendientes = detectarParticipantesExplicitos(seguras);
  if (pendientes.length) {
    throw new Error(`Persisten ${pendientes.length} posibles nombres de participantes; revisión manual requerida.`);
  }
  return seguras;
}

// Reintento local con candidatos de nombre largo extraídos del PDF original.
// Se mantienen TODAS las comprobaciones de anonimizarPaginas; si no se puede
// certificar el texto saneado, el documento sigue bloqueado.
function candidatosNombresLargos(paginas) {
  const patron = /(?<![\p{L}])(?:[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,}[ \t]+){2,4}[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,}(?![\p{L}])/gu;
  const candidatos = new Set();
  for (const pagina of paginas) {
    for (const m of pagina.matchAll(patron)) {
      const nombre = m[0].trim();
      const palabras = nombre.split(/\s+/);
      if (palabras.some(p => NO_PERSONA.has(normal(p).toUpperCase()) || CORTE_NOMBRE.has(normal(p).toUpperCase()))) continue;
      if (nombreValido(nombre)) candidatos.add(nombre);
    }
  }
  // Los encabezados de las providencias suelen escribir nombres en MAYÚSCULAS.
  // Detectarlos además de los nombres con capitalización convencional.
  const patronMayusculas = /(?<![\p{L}])(?:[A-ZÁÉÍÓÚÜÑ]{3,}[ \t]+){2,4}[A-ZÁÉÍÓÚÜÑ]{3,}(?![\p{L}])/gu;
  for (const pagina of paginas) {
    for (const m of pagina.matchAll(patronMayusculas)) {
      const candidato = m[0].trim();
      const palabras = candidato.split(/\s+/);
      if (palabras.some(p => NO_PERSONA.has(normal(p).toUpperCase()) || CORTE_NOMBRE.has(normal(p).toUpperCase()))) continue;
      if (nombreValido(candidato)) candidatos.add(candidato);
    }
  }
  // Nombres de dos palabras asociados a una persona; pueden no aparecer
  // en los patrones de tres o más palabras.
  const patronContextual = /\b(?:señor(?:a)?|testimonio de|declaración de|perteneciente a|investigador(?:a)?|acusad[oa]|procesad[oa])\s+([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,}\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{2,}|[A-ZÁÉÍÓÚÜÑ]{3,}\s+[A-ZÁÉÍÓÚÜÑ]{3,})/giu;
  for (const pagina of paginas) {
    for (const m of pagina.matchAll(patronContextual)) {
      if (nombreValido(m[1])) candidatos.add(m[1]);
    }
  }
  return nombresUnicosPrivados([...candidatos]).slice(0, 150);
}

// Segunda pasada LOCAL y opcional. Se invoca solo si la anonimización habitual
// bloquea el PDF. Nunca se envía texto original a servicios externos.
// Los candidatos se usan para REINTENTAR el saneamiento existente; la validación
// conservadora final sigue siendo obligatoria.
async function anonimizarConSegundaPasada(paginas, errorInicial) {
  // Primero reintentar sin iniciar Python, protegiendo nombres largos que
  // disparan el bloqueo conservador. Nunca se omite la verificación final.
  try {
    const candidatos = candidatosNombresLargos(paginas);
    if (candidatos.length) {
      const seguras = anonimizarPaginas(paginas, { nombresAdicionales: candidatos });
      console.log('[PRIVACIDAD] Reintento local seguro con', candidatos.length, 'candidatos');
      return seguras;
    }
  } catch { /* El bloqueo permanece; se intenta el detector local. */ }
  if (process.env.IURIS_NER_LOCAL === '0') throw errorInicial;
  const inicioDetector = Date.now();
  const python = process.env.IURIS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(RAIZ_MODULO, 'anonimizador_local.py');
  let respuesta;
  try {
    const { spawn } = await import('node:child_process');
    respuesta = await new Promise((resolve, reject) => {
      const hijo = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let salida = '', error = '';
      const reloj = setTimeout(() => hijo.kill(), 6000);
      hijo.stdout.setEncoding('utf8');
      hijo.stdout.on('data', x => { salida += x; if (salida.length > 200000) hijo.kill(); });
      hijo.stderr.setEncoding('utf8');
      hijo.stderr.on('data', x => { error += x; if (error.length > 10000) hijo.kill(); });
      hijo.on('error', reject);
      hijo.on('close', codigo => { clearTimeout(reloj); codigo === 0 ? resolve(JSON.parse(salida)) : reject(new Error('Detector local no disponible')); });
      hijo.stdin.on('error', () => {});
      hijo.stdin.end(JSON.stringify({ paginas }));
    });
  } catch {
    console.warn('[PRIVACIDAD] Detector local no completado en', Date.now() - inicioDetector, 'ms');
    throw errorInicial;
  }
  console.log('[PRIVACIDAD] Detector local:', Date.now() - inicioDetector, 'ms, candidatos:', Array.isArray(respuesta?.nombres) ? respuesta.nombres.length : 0);
  if (!respuesta?.ok || !Array.isArray(respuesta.nombres)) throw errorInicial;
  // Combinar candidatos spaCy y nombres largos del texto original.
  // La validación estricta se ejecuta nuevamente sobre el resultado.
  return anonimizarPaginas(paginas, {
    nombresAdicionales: [...respuesta.nombres, ...candidatosNombresLargos(paginas)]
  });
}

// Candidatos de revisión calculados localmente; nunca se envía texto completo.
// Son sugerencias, no una aprobación de privacidad.
export function candidatosRevisionPrivacidad(documento) {
  if (!documento?.verificado || !Array.isArray(documento.paginasOriginalesPrivadas)) {
    throw new Error('No hay documento verificado para revisar.');
  }
  const paginas = documento.paginasOriginalesPrivadas;
  const identificados = nombresUnicosPrivados(detectarParticipantesExplicitos(paginas));
  const otros = nombresUnicosPrivados(candidatosNombresLargos(paginas)).filter(n =>
    !identificados.some(identificado => patronNombre(n).test(identificado) || patronNombre(identificado).test(n)));
  return {
    identificados: identificados.slice(0, 30),
    posiblesPendientes: otros.slice(0, 30),
    masCandidatos: otros.length > 30 || identificados.length > 30,
    aviso: 'Los candidatos pueden incluir autoridades, instituciones o falsos positivos. Comprueba cada nombre en el documento oficial; no equivalen a una verificación automática.'
  };
}

export function revisarAnonimizacionDocumento(documento, nombres) {
  if (!Array.isArray(documento?.paginasOriginalesPrivadas)) throw new Error('No hay texto original temporal para revisar.');
  const paginas = anonimizarPaginas(documento.paginasOriginalesPrivadas, { nombresAdicionales: nombres });
  documento.paginas = paginas;
  documento.aptoGemini = true;
  documento.estado = 'listo';
  documento.motivoRevision = '';
  return paginas.length;
}

// ======================================================
// 5. SELECTORES Y METADATOS
// ======================================================

const TABLA = '[id="resultForm:jurisTable"]';
const FILAS = `${TABLA} tbody tr[data-rk]`;

function obtenerDato(texto, clave) {
  const escape = s =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return texto.match(
    new RegExp(
      `(?:^|\\n)\\s*${escape(clave)}\\s*:\\s*([^\\n]+)`,
      'i'
    )
  )?.[1]?.trim() || '';
}

function extraerMetadatos(texto) {
  // Las filas de PrimeFaces pueden separar etiqueta y valor con saltos de
  // línea o espacios. Se exige un número de providencia y un radicado reales.
  const limpio = String(texto || '').replace(/\u00a0/g, ' ').replace(/\r/g, '');
  const campos = [
    ['providencia', 'NÚMERO DE PROVIDENCIA'],
    ['radicado', 'NÚMERO DE PROCESO'],
    ['fecha', 'FECHA'],
    ['ponente', 'PONENTE'],
    ['actuacion', 'CLASE DE ACTUACIÓN'],
    ['tipo', 'TIPO DE PROVIDENCIA'],
    ['tema', 'TEMA']
  ];
  const etiquetas = campos.map(([, titulo]) => titulo);
  const escapar = valor => valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternancia = etiquetas.map(escapar).join('|');
  const salida = {};
  for (const [clave, etiqueta] of campos) {
    const re = new RegExp('(?:^|\\n|\\s{2,})\\s*' + escapar(etiqueta) +
      '\\s*:?\\s*([\\s\\S]*?)(?=\\s*(?:' + alternancia + ')\\s*:|$)', 'i');
    const match = limpio.match(re);
    salida[clave] = (match?.[1] || '').replace(/\s+/g, ' ').trim();
  }
  // Un formato imprevisto no debe producir una identidad documental falsa.
  if (!/\b(?:SP|AP|AHP|STP|ATP|CP|CSJ|SEP|SPV|AH|AT|AC)\s*[-–]?\s*\d{2,7}\s*[-–]?\s*20\d{2}\b/i.test(salida.providencia)) {
    const m = limpio.match(/\b(?:SP|AP|AHP|STP|ATP|CP|CSJ|SEP|SPV|AH|AT|AC)\s*[-–]?\s*\d{2,7}\s*[-–]?\s*20\d{2}\b/i);
    if (m) salida.providencia = m[0].replace(/\s+/g, '');
  }
  if (!/^\d{4,8}$/.test(salida.radicado)) {
    const m = limpio.match(/(?:N[ÚU]MERO\s+DE\s+PROCESO|RADICADO)\s*:?\s*(\d{4,8})/i);
    if (m) salida.radicado = m[1];
  }
  // Las notas de relatoría pueden rectificar la identificación publicada.
  // Solo aceptar una corrección explícita que conserve el mismo radicado.
  const nota = limpio.match(/NOTA\s+DE\s+RELATOR[IÍ]A[\s\S]{0,240}?(?:N[ÚU]MERO\s+CORRECTO\s+DE\s+LA\s+PROVIDENCIA\s+ES|PROVIDENCIA\s+CORRECTA\s+ES)\s*(?:EL|LA)?\s*([A-Z]{2,4})\s*[-–]?\s*(\d{2,7})\s*[-–]?\s*(20\d{2})\s*\(\s*(\d{4,8})\s*\)/i);
  if (nota && nota[4] === salida.radicado) {
    salida.providenciaPublicada = salida.providencia;
    salida.providencia = `${nota[1].toUpperCase()}${nota[2]}-${nota[3]}`;
    salida.rectificacionRelatoria = true;
  }
  return salida;
}

async function recuperarMetadatosFila(page, fila) {
  let meta = extraerMetadatos(fila.texto);
  if (meta.providencia && /^\d{4,8}$/.test(meta.radicado)) return meta;
  // Si el DOM estaba actualizándose, leer la misma fila una vez más.
  await page.waitForTimeout(650);
  const textoSeguro = await page.locator(
    '[id="resultForm:jurisTable"] tbody tr[data-rk="' + String(fila.id).replace(/[^\w-]/g, '') + '"]'
  ).first().innerText({ timeout: 2000 }).catch(() => '');
  if (textoSeguro) meta = extraerMetadatos(textoSeguro);
  if (!meta.providencia || !/^\d{4,8}$/.test(meta.radicado)) {
    console.warn('[PORTAL] Metadatos incompletos en fila', fila.id,
      'texto:', String(textoSeguro || fila.texto).replace(/\s+/g, ' ').slice(0, 450));
  }
  return meta;
}

// ======================================================
// 6. DIAGNÓSTICO DE RESULTADOS
// ======================================================

async function diagnosticarTabla(page) {
  return page.evaluate(() => {
    const tabla = document.getElementById(
      'resultForm:jurisTable'
    );

    if (!tabla) {
      return {
        encontrada: false,
        filas: 0,
        filasConId: 0,
        vacia: false,
        texto: ''
      };
    }

    const filas = [
      ...tabla.querySelectorAll('tbody tr')
    ];

    const filasConId = filas.filter(
      fila => fila.hasAttribute('data-rk')
    );

    const vacia = Boolean(
      tabla.querySelector(
        'tr.ui-datatable-empty-message'
      )
    );

    return {
      encontrada: true,
      filas: filas.length,
      filasConId: filasConId.length,
      vacia,
      texto: tabla.innerText.slice(0, 500)
    };
  });
}

// ======================================================
// 7. ESPERA DE AJAX DE PRIMEFACES
// ======================================================

// Se utiliza el identificador del botón para
// distinguir la búsqueda de otras peticiones POST.

function esPeticionBusqueda(request) {
  if (request.method() !== 'POST') {
    return false;
  }

  if (!request.url().includes('/WebRelatoria/')) {
    return false;
  }

  const datos = request.postData() || '';

  return (
    datos.includes('searchForm%3AsearchButton') ||
    datos.includes('searchForm:searchButton')
  );
}

// Capturamos la respuesta ANTES del clic, y verificamos el término
// efectivamente enviado por el navegador (no solamente el valor visual).
function terminoEnPeticion(request, terminoEsperado = '') {
  const params = new URLSearchParams(request.postData() || '');
  const entradas = [...params.entries()];
  const esperado = normal(terminoEsperado).trim().replace(/\s+/g, ' ');
  // En JSF el id DOM puede diferir del atributo name enviado en POST.
  // Inspeccionar todas las claves en vez de asumir fulltxtInput.
  const campos = entradas.filter(([clave]) =>
    /fulltxt|texto|search|query|keyword|consulta|palabra|criterio/i.test(clave) &&
    !/javax\.faces\.|searchButton|options1/i.test(clave)
  );
  const exacto = entradas.find(([, valor]) =>
    normal(valor).trim().replace(/\s+/g, ' ') === esperado
  );
  console.log('[PORTAL] Campos candidatos en POST:',
    campos.map(([clave, valor]) => ({ clave, valor: String(valor).slice(0, 140) })));
  console.log('[PORTAL] Campo con coincidencia exacta:', exacto?.[0] || '(ninguno)');
  return { valor: exacto?.[1] || '', clave: exacto?.[0] || '', campos };
}

async function esperarBusquedaAjax(page, accion, terminoEsperado) {
  const esperado = normal(terminoEsperado).trim().replace(/\s+/g, ' ');
  // Se arma el listener ANTES de hacer clic. Se exige respuesta del botón,
  // no se acepta una tabla que ya estuviera visible antes de la consulta.
  const respuestaPromesa = page.waitForResponse(
    r => esPeticionBusqueda(r.request()),
    { timeout: 35000 }
  );
  await accion();
  const respuesta = await respuestaPromesa;
  const peticion = respuesta.request();
  const params = new URLSearchParams(peticion.postData() || '');
  const detalleEnvio = terminoEnPeticion(peticion, terminoEsperado);
  const enviada = detalleEnvio.valor;
  const cuerpo = await respuesta.text();

  console.log('[PORTAL] Término enviado en POST:', JSON.stringify(enviada));
  console.log('[PORTAL] Estado de respuesta:', respuesta.status());
  console.log('[PORTAL] Parámetros JSF:', {
    source: params.get('javax.faces.source'),
    execute: params.get('javax.faces.partial.execute'),
    render: params.get('javax.faces.partial.render'),
    opcion: params.get('searchForm:options1'),
    sala: params.get('searchForm:spenal')
  });

  if (normal(enviada).trim().replace(/\s+/g, ' ') !== esperado) {
    throw new Error(`No se encontró el término ${JSON.stringify(terminoEsperado)} en los campos del POST. Revisar Campos candidatos en POST y el name real del input.`);
  }
  if (!respuesta.ok()) throw new Error(`Respuesta HTTP ${respuesta.status()} del portal.`);

  // Extraer las actualizaciones reales del XML PrimeFaces. Un simple
  // includes('resultForm:jurisTable') también coincide con scripts y no
  // demuestra que la tabla se haya actualizado.
  const actualizaciones = [...cuerpo.matchAll(
    /<update\s+id=["']([^"']+)["']/gi
  )].map(m => m[1].replaceAll('&amp;', '&'));
  console.log('[PORTAL] Componentes actualizados por JSF:', actualizaciones);
  const actualizaResultados = actualizaciones.some(id =>
    id === 'resultForm' || id === 'resultForm:jurisTable' ||
    id.startsWith('resultForm:jurisTable_')
  );
  if (!actualizaResultados) {
    throw new Error('La respuesta JSF no actualizó la tabla de resultados; se bloquea el uso de datos anteriores.');
  }

  // Esperar a que PrimeFaces aplique la respuesta y termine la petición.
  // No depender de un cambio en innerText, pues dos consultas podrían
  // mostrar el mismo contenido.
  await page.waitForFunction(() => {
    const tabla = document.getElementById('resultForm:jurisTable');
    const cola = window.PrimeFaces?.ajax?.Queue;
    return Boolean(tabla && (!cola || typeof cola.isEmpty !== 'function' || cola.isEmpty()));
  }, null, { timeout: 12000 }).catch(() => {
    console.warn('[PORTAL] PrimeFaces no confirmó cola vacía; se revisará el DOM.');
  });
  await page.waitForTimeout(400);
  return [{ status: respuesta.status(), url: respuesta.url(), cuerpo }];
}

// ======================================================
// 8. CONFIRMACIÓN DE RESULTADOS
// ======================================================

async function confirmarResultados(page) {
  await page.locator(TABLA).waitFor({ state: 'attached', timeout: 20000 });
  const inicio = Date.now();
  while (Date.now() - inicio < 7000) {
    const estado = await diagnosticarTabla(page);
    if (estado.filasConId > 0 || estado.vacia) return estado;
    await page.waitForTimeout(350);
  }
  return diagnosticarTabla(page);
}

// Diagnóstico independiente: no modifica la búsqueda ni los datos personales.
// Distingue el contador de resultados, el HTML AJAX y los controles DOM.
async function diagnosticarCantidadOficial(page, respuestas = []) {
  const dom = await page.evaluate(() => {
    const contador = document.getElementById('resultForm:pagText2');
    const tabla = document.getElementById('resultForm:jurisTable');
    const paginadores = [...document.querySelectorAll('.ui-paginator')];
    return {
      contador: contador?.innerText?.trim().slice(0, 250) ?? null,
      contadorHTML: contador?.outerHTML?.slice(0, 650) ?? null,
      tablaExiste: Boolean(tabla),
      filasConId: tabla?.querySelectorAll('tbody tr[data-rk]').length ?? 0,
      paginadoresGlobales: paginadores.length,
      controlesSiguienteGlobales: document.querySelectorAll('.ui-paginator-next').length,
      textoPaginadores: paginadores.map(p => p.innerText.trim().slice(0, 100)),
      tablasEnPagina: document.querySelectorAll('.ui-datatable').length
    };
  });
  const ajax = respuestas.map(r => {
    const xml = String(r.cuerpo || '');
    const extraer = id => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = xml.match(new RegExp(`<update\\s+id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/update>`, "i"));
      if (!match) return null;
      const contenido = match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
      return { longitud: contenido.length, filasConDataRk: (contenido.match(/data-rk=/g) || []).length,
        tienePaginador: contenido.includes('ui-paginator'),
        textoBreve: contenido.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) };
    };
    return { tabla: extraer('resultForm:jurisTable'), contador: extraer('resultForm:pagText2') };
  });
  console.log('[PORTAL] DIAGNÓSTICO CANTIDAD (DOM):', JSON.stringify(dom));
  console.log('[PORTAL] DIAGNÓSTICO CANTIDAD (AJAX):', JSON.stringify(ajax));
}

// Diagnóstico del paginador real de PrimeFaces. Puede estar fuera de la tabla.
async function estadoPaginacion(page) {
  return page.evaluate(() => {
    const tabla = document.getElementById('resultForm:jurisTable');
    const contenedor = tabla?.closest('.ui-datatable') || tabla?.parentElement;
    const paginadores = [...document.querySelectorAll('.ui-paginator')]
      .filter(p => p.closest('[id="resultForm:jurisTable"]') ||
        (contenedor && contenedor.contains(p)) ||
        p.id?.startsWith('resultForm:jurisTable'));
    const siguientes = paginadores.flatMap(p => [...p.querySelectorAll('.ui-paginator-next')]);
    const habilitados = siguientes.filter(el =>
      !el.classList.contains('ui-state-disabled') &&
      el.getAttribute('aria-disabled') !== 'true');
    return {
      paginadores: paginadores.length,
      siguientes: siguientes.length,
      habilitados: habilitados.length,
      texto: paginadores.map(p => p.innerText.trim()).join(' | ').slice(0, 300),
      filasDOM: tabla?.querySelectorAll('tbody tr[data-rk]').length || 0
    };
  });
}

// Navegación por registro: este portal muestra "Resultado: n / total" y
// no necesariamente utiliza el paginador .ui-paginator de PrimeFaces.
// No se adivinan IDs ni se fabrican solicitudes JSF: se usa un control
// visible y explícito de la página, y se confirma el avance del contador.
async function navegarAlSiguienteResultado(page) {
  const leerEstado = () => page.evaluate(() => {
    const texto = document.getElementById('resultForm:pagText2')?.textContent || '';
    const m = texto.match(/Resultado\s*:\s*(\d+)\s*\/\s*(\d+)/i);
    const fila = document.querySelector('[id="resultForm:jurisTable"] tbody tr[data-rk]');
    return { actual: m ? Number(m[1]) : null,
      total: m ? Number(m[2]) : null, id: fila?.getAttribute('data-rk') || null, firma: (fila?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500) };
  });
  const antes = await leerEstado();
  if (!Number.isFinite(antes.actual) || !Number.isFinite(antes.total)) {
    return { avanzado: false, motivo: 'No se pudo interpretar el contador oficial.' };
  }
  if (antes.actual >= antes.total) return { avanzado: false, fin: true };

  // No repetir el clic si el portal ya avanzó: primero comprobar el contador.
  // Un avance confirmado exige un número mayor Y una fila distinta.
  const comprobar = async () => {
    const estado = await leerEstado();
    return estado.actual === antes.actual + 1 &&
      Boolean(estado.id || estado.firma) && (estado.id !== antes.id || (Boolean(estado.firma) && estado.firma !== antes.firma));
  };
  let ultimoError = '';
  for (let intento = 1; intento <= 2; intento++) {
    if (await comprobar()) return { avanzado: true };
    const actual = await leerEstado();
    if (actual.actual !== antes.actual) {
      if (actual.actual === antes.actual + 1) {
        try {
          await page.waitForFunction(({ id, firma }) => {
            const fila = document.querySelector('[id="resultForm:jurisTable"] tbody tr[data-rk]');
            return Boolean(fila && (fila.getAttribute('data-rk') !== id ||
              (fila.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500) !== firma));
          }, { id: antes.id, firma: antes.firma }, { timeout: 6000, polling: 250 });
          if (await comprobar()) return { avanzado: true };
        } catch (_) { /* No marcar avance sin una fila confirmada. */ }
      }
      return { avanzado: false, motivo: `El contador cambió de ${antes.actual} a ${actual.actual} sin confirmar la fila. Se detiene para evitar saltos.` };
    }
    const colaOcupada = await page.evaluate(() => {
      const cola = window.PrimeFaces?.ajax?.Queue;
      return Boolean(cola && typeof cola.isEmpty === 'function' && !cola.isEmpty());
    }).catch(() => false);
    if (colaOcupada) {
      try {
        await page.waitForFunction(() => {
          const cola = window.PrimeFaces?.ajax?.Queue;
          return !cola || typeof cola.isEmpty !== 'function' || cola.isEmpty();
        }, null, { timeout: 8000, polling: 250 });
      } catch (_) {
        return { avanzado: false, motivo: 'El portal sigue procesando la navegación; se conservará la posición.' };
      }
      if (await comprobar()) return { avanzado: true };
    }
    const boton = page.locator('button.pageButton:has(.rightIcon)');
    if (await boton.count() !== 1 || !(await boton.isVisible()) || !(await boton.isEnabled())) {
      return { avanzado: false, motivo: 'El botón oficial Siguiente no está disponible de forma inequívoca.' };
    }
    console.log(`[PORTAL] Siguiente desde ${antes.actual}/${antes.total}, intento ${intento}/2`);
    try {
      // Esperar el resultado del AJAX, no solo el clic. No fabricar peticiones JSF.
      await boton.click({ timeout: 12000 });
      await page.waitForFunction(({ actual, id, firma }) => {
        const t = document.getElementById('resultForm:pagText2')?.textContent || '';
        const m = t.match(/Resultado\s*:\s*(\d+)\s*\/\s*(\d+)/i);
        const fila = document.querySelector('[id="resultForm:jurisTable"] tbody tr[data-rk]');
        return Boolean(m && Number(m[1]) === actual + 1 &&
          fila && (fila.getAttribute('data-rk') !== id || (fila.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500) !== firma));
      }, { actual: antes.actual, id: antes.id, firma: antes.firma }, { timeout: 22000, polling: 250 });
      console.log('[PORTAL] Avance confirmado:', (await leerEstado()).actual);
      return { avanzado: true };
    } catch (error) {
      ultimoError = error.message;
      if (await comprobar()) return { avanzado: true };
      const despues = await leerEstado();
      if (despues.actual !== antes.actual) {
        // El contador puede actualizarse antes que la fila en la respuesta JSF.
        // No volver a pulsar: esperar la sincronización real de ambos elementos.
        if (despues.actual === antes.actual + 1) {
          try {
            await page.waitForFunction(({ actual, id, firma }) => {
              const t = document.getElementById('resultForm:pagText2')?.textContent || '';
              const m = t.match(/Resultado\s*:\s*(\d+)\s*\/\s*(\d+)/i);
              const fila = document.querySelector('[id="resultForm:jurisTable"] tbody tr[data-rk]');
              return Boolean(m && Number(m[1]) === actual + 1 &&
                fila && (fila.getAttribute('data-rk') !== id || (fila.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500) !== firma));
            }, { actual: antes.actual, id: antes.id, firma: antes.firma }, { timeout: 8500, polling: 200 });
            console.log('[PORTAL] Avance confirmado tras sincronización tardía:', (await leerEstado()).actual);
            return { avanzado: true };
          } catch (_) { /* Se conserva el bloqueo ante un estado inconsistente. */ }
        }
        const final = await leerEstado();
        return { avanzado: false, motivo: `Navegación sin confirmar: contador ${final.actual}, fila ${final.id || 'sin identificador'} (anterior ${antes.id || 'sin identificador'}); no se repetirá el clic para evitar saltos.` };
      }
      // Permitir que termine el AJAX antes de decidir; no asumir
      // que un clic sin respuesta avanzó.
      await page.waitForTimeout(1200 * intento);
      if (await comprobar()) return { avanzado: true };
      // Si PrimeFaces sigue procesando, no generar otro clic sobre una petición pendiente.
      const ajaxPendiente = await page.evaluate(() => {
        const cola = window.PrimeFaces?.ajax?.Queue;
        return Boolean(cola && typeof cola.isEmpty === 'function' && !cola.isEmpty());
      }).catch(() => false);
      if (ajaxPendiente) {
        try {
          await page.waitForFunction(() => {
            const cola = window.PrimeFaces?.ajax?.Queue;
            return !cola || typeof cola.isEmpty !== 'function' || cola.isEmpty();
          }, null, { timeout: 7000, polling: 200 });
        } catch (_) {
          return { avanzado: false, motivo: `El AJAX del portal sigue pendiente desde Resultado: ${antes.actual}; no se repetirá el clic.` };
        }
        if (await comprobar()) return { avanzado: true };
        const trasAjax = await leerEstado();
        if (trasAjax.actual !== antes.actual) {
          return { avanzado: false, motivo: `El contador cambió a ${trasAjax.actual} pero no se confirmó una fila nueva; no se repetirá el clic.` };
        }
      }
    }
  }
  return { avanzado: false, motivo: `No avanzó desde Resultado: ${antes.actual} / ${antes.total} tras 2 intentos: ${ultimoError}` };
}

async function leerFilas(page) {
  return page.locator(FILAS).evaluateAll(
    elementos =>
      elementos.map(elemento => ({
        id: elemento.getAttribute('data-rk'),
        texto: elemento.innerText
      })).filter(fila => fila.id)
  );
}

// ======================================================
// 9. BÚSQUEDA OFICIAL Y DESCARGA
// ======================================================

// La tabla PrimeFaces puede reconstruir las filas después de un AJAX.
// Comprobar el estado sobre una fila recién localizada evita falsos negativos.
async function asegurarSeleccionProvidencia(page, idFila, intentos = 3) {
  const selector = `[data-rk="${String(idFila).replace(/[^\w-]/g, '')}"]`;
  const estado = async () => page.locator(selector).first().evaluate(fila => ({
    checkbox: Boolean(fila.querySelector('input[type="checkbox"]:checked')),
    activo: Boolean(fila.querySelector('.ui-chkbox-box.ui-state-active')),
    icono: Boolean(fila.querySelector('.ui-chkbox-icon.ui-icon-check')),
    aria: fila.getAttribute('aria-selected') === 'true'
  })).catch(() => null);
  const confirmado = valor => Boolean(valor &&
    (valor.checkbox || valor.activo || valor.icono || valor.aria));

  for (let intento = 1; intento <= intentos; intento++) {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
    if (confirmado(await estado())) return;

    await page.locator(selector).first().locator('.ui-chkbox-box').click({ timeout: 12000 });
    // Esperar hasta 3 s por la actualización asíncrona de PrimeFaces.
    try {
      await page.waitForFunction(sel => {
        const fila = document.querySelector(sel);
        return Boolean(fila && (
          fila.querySelector('input[type="checkbox"]:checked') ||
          fila.querySelector('.ui-chkbox-box.ui-state-active') ||
          fila.querySelector('.ui-chkbox-icon.ui-icon-check') ||
          fila.getAttribute('aria-selected') === 'true'
        ));
      }, selector, { timeout: 3000, polling: 100 });
    } catch {
      // La siguiente vuelta reubica la fila tras el AJAX.
    }
    if (confirmado(await estado())) return;
    console.warn(`[PORTAL] Selección no confirmada, intento ${intento}/${intentos}:`, idFila);
    await page.waitForTimeout(400);
  }
  throw new Error('No se confirmó la selección de la casilla de la providencia tras varios intentos.');
}

export async function consultarYDescargar(
  termino,
  {
    maxResultados = 10,
    maxPaginas = 20,
    desplazamiento = 0,
    onDocumento = null,
    fechaLimite = Infinity
  } = {}
) {
  if (
    typeof termino !== 'string' ||
    !termino.trim() ||
    termino.length > 120
  ) {
    throw new Error(
      'Término inválido (1-120 caracteres).'
    );
  }

  maxResultados = Math.max(
    1,
    Math.min(20, Number(maxResultados) || 10)
  );

  maxPaginas = Math.max(
    1,
    Math.min(40, Number(maxPaginas) || 20)
  );

  desplazamiento = Math.max(0, Math.min(500, Number(desplazamiento) || 0));
  const resultados = [];
  const advertencias = [];
  let filasElegibles = 0;
  let ultimaPaginaCompleta = false;
  let hayPaginaSiguiente = false;
  const vistos = new Set();

  let totalFilas = 0;
  let paginasConsultadas = 0;

  console.log(
    '[PORTAL] Abriendo Corte Suprema de Justicia...'
  );

  const browser = await chromium.launch({
    headless: true
  });

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: 'es-CO'
    });

    const page = await context.newPage();

    await page.goto(PORTAL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log(
      '[PORTAL] Página principal cargada.'
    );

    // ----------------------------------------------
    // 9.1. Campo de búsqueda
    // ----------------------------------------------

    const campo = page.locator(
      '[id="searchForm:fulltxtInput"]'
    );

    if (!(await campo.isVisible())) {
      await page.locator(
        '[id="searchForm:set-fulltxt"] legend'
      ).click();
    }

    await campo.waitFor({
      state: 'visible',
      timeout: 15000
    });

    // ----------------------------------------------
    // 9.2. Opción de búsqueda
    // ----------------------------------------------

    const radio = page.locator(
      '[id="searchForm:options1:0"]'
    );

    if (
      await radio.count() &&
      !(await radio.isChecked())
    ) {
      await page.locator(
        'label[for="searchForm:options1:0"]'
      ).click();
    }

    // ----------------------------------------------
    // 9.3. Sala de Casación Penal
    // ----------------------------------------------

    const penal = page.locator(
      '[id="searchForm:spenal:2"]'
    );

    if (
      await penal.count() &&
      !(await penal.isChecked())
    ) {
      await page.locator(
        '[id="searchForm:spenal"] .ui-selectcheckboxmenu-trigger'
      ).click();

      await page.locator(
        '[id="searchForm:spenal_panel"] label'
      ).filter({
        hasText: /^Sala de Casación Penal$/
      }).click();
    }

    if (
      await penal.count() &&
      !(await penal.isChecked())
    ) {
      throw new Error(
        'No se pudo seleccionar la Sala Penal.'
      );
    }

    console.log(
      '[PORTAL] Filtros aplicados:',
      {
        textoCompletoVisible:
          await campo.isVisible(),
        opcionBusqueda:
          await radio.isChecked().catch(() => null),
        salaPenal:
          await penal.isChecked().catch(() => null)
      }
    );

    const diagnosticoFiltros = await page.evaluate(() => ({
      radios: [...document.querySelectorAll('input[name="searchForm:options1"]')]
        .map(e => ({ id: e.id, value: e.value, checked: e.checked,
          etiqueta: document.querySelector(`label[for="${e.id}"]`)?.innerText?.trim() || '' })),
      campo: document.getElementById('searchForm:fulltxtInput')?.value || ''
    }));
    console.log('[PORTAL] Modos de búsqueda disponibles:', diagnosticoFiltros.radios);

    // ----------------------------------------------
    // 9.4. Enviar búsqueda
    // ----------------------------------------------

    // No pulsar Tab: algunos formularios JSF vuelven a renderizar
    // el campo al perder el foco y pueden borrar el término.
    await campo.fill(termino.trim());
    let valorCampo = await campo.inputValue();
    if (valorCampo.trim() !== termino.trim()) {
      console.warn('[PORTAL] El valor cambió tras fill; reintentando con eventos nativos.');
      await campo.evaluate((elemento, valor) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'value'
        )?.set;
        if (!setter) throw new Error('No se pudo acceder al campo de búsqueda.');
        setter.call(elemento, valor);
        elemento.dispatchEvent(new Event('input', { bubbles: true }));
        elemento.dispatchEvent(new Event('change', { bubbles: true }));
      }, termino.trim());
      valorCampo = await campo.inputValue();
    }
    console.log('[PORTAL] Valor del campo antes de buscar:', JSON.stringify(valorCampo));
    console.log('[PORTAL] Atributos reales del campo:', await campo.evaluate(el => ({ id: el.id, name: el.name, outerHTML: el.outerHTML.slice(0, 500) })));
    if (normal(valorCampo).trim() !== normal(termino).trim()) {
      // El portal JSF puede reescribir el input al perder el foco.
      // No bloquear aquí: la petición POST se corrige y valida más abajo.
      console.warn('[PORTAL] El campo cambió; se comprobará el valor real del POST.');
    }

    console.log(
      `[PORTAL] Buscando: ${termino.trim()}`
    );

    // Algunos eventos JSF limpian fulltxtInput entre fill() y el POST.
    // Interceptamos SOLO la petición del botón Buscar y reponemos el valor
    // si el navegador lo envía vacío. No alteramos las demás solicitudes.
    const corregirPostBusqueda = async route => {
      const request = route.request();
      if (!esPeticionBusqueda(request)) return route.continue();
      const params = new URLSearchParams(request.postData() || '');
      const actual = params.get('searchForm:fulltxtInput') || '';
      if (normal(actual).trim() !== normal(termino).trim()) {
        console.log('[PORTAL] Corrigiendo término en POST:',
          JSON.stringify(actual), '→', JSON.stringify(termino.trim().toUpperCase()));
        params.set('searchForm:fulltxtInput', termino.trim().toUpperCase());
        return route.continue({
          postData: params.toString(),
          headers: { ...request.headers(), 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });
      }
      return route.continue();
    };
    await page.route('**/WebRelatoria/**', corregirPostBusqueda);
    let respuestas;
    try {
      respuestas = await esperarBusquedaAjax(
      page,
      async () => {
        await page.locator(
          '[id="searchForm:searchButton"]'
        ).click();
      },
      termino.trim()
      );
    } finally {
      await page.unroute('**/WebRelatoria/**', corregirPostBusqueda);
    }

    console.log(
      '[PORTAL] Respuestas AJAX identificadas:',
      respuestas.length
    );

    for (const respuesta of respuestas) {
      console.log(
        '[PORTAL] Respuesta de búsqueda:',
        {
          status: respuesta.status,
          contieneTabla:
            respuesta.cuerpo.includes(
              'resultForm:jurisTable'
            ),
          esPartialResponse:
            respuesta.cuerpo.includes(
              'partial-response'
            ),
          longitud:
            respuesta.cuerpo.length
        }
      );
    }

    // ----------------------------------------------
    // 9.5. Confirmar tabla actualizada
    // ----------------------------------------------

    const estado = await confirmarResultados(page);
    await diagnosticarCantidadOficial(page, respuestas);
    console.log('[PORTAL] Fila(s) visibles tras respuesta:', estado.filasConId);

    console.log(
      '[PORTAL] Diagnóstico de tabla:',
      estado
    );

    if (estado.filasConId === 0) {
      const huboRespuestaTabla =
        respuestas.some(respuesta =>
          respuesta.cuerpo.includes(
            'resultForm:jurisTable'
          )
        );

      if (!respuestas.length) {
        advertencias.push(
          'No se identificó la respuesta AJAX específica del botón Buscar.'
        );
      } else if (!huboRespuestaTabla) {
        advertencias.push(
          'La respuesta AJAX no confirmó una actualización de la tabla de providencias.'
        );
      } else if (estado.vacia) {
        advertencias.push(
          'La tabla actualizada aparece vacía. Deben revisarse los criterios de búsqueda o el contenido de la respuesta oficial.'
        );
      } else {
        advertencias.push(
          'No se identificaron filas de providencias en la tabla.'
        );
      }
    }

    // ----------------------------------------------
    // 9.6. Recorrer resultados
    // ----------------------------------------------

    for (
      let numeroPagina = 0;
      numeroPagina < maxPaginas &&
      Date.now() < fechaLimite &&
      resultados.length < maxResultados;
      numeroPagina++
    ) {
      const filas = await leerFilas(page);

      paginasConsultadas++;
      totalFilas += filas.length;

      console.log(
        `[PORTAL] Página ${numeroPagina + 1}: ${filas.length} filas.`
      );

      if (!filas.length) break;

      for (const fila of filas) {
        if (Date.now() >= fechaLimite) break;
        if (
          resultados.length >= maxResultados
        ) {
          break;
        }

        if (vistos.has(fila.id)) continue;

        vistos.add(fila.id);

        const meta = await recuperarMetadatosFila(page, fila);

        console.log(
          `[PORTAL] Providencia ${fila.id}:`,
          meta.providencia,
          meta.radicado
        );

        if (
          !meta.providencia ||
          !/^\d{4,8}$/.test(meta.radicado)
        ) {
          advertencias.push(
            `Registro ${fila.id}: faltan metadatos verificables.`
          );
          continue;
        }

        filasElegibles++;
        if (filasElegibles <= desplazamiento) continue;

        const reutilizado = recuperarPdfVerificado(meta);
        if (reutilizado) {
          console.log('[PORTAL] PDF verificado reutilizado sin nueva descarga:', meta.providencia, meta.radicado);
          resultados.push({ ...reutilizado, id: fila.id });
          if (typeof onDocumento === 'function') onDocumento(resultados.at(-1));
          continue;
        }

        const objetivo = page.locator(
          `[data-rk="${fila.id}"]`
        ).first();

        try {
          try {
            await asegurarSeleccionProvidencia(page, fila.id);

            // Cada intento reconstruye el menú PrimeFaces. Un menú viejo
            // puede quedar abierto/cerrado después de un POST AJAX fallido.
            // Nunca damos por verificado un PDF hasta leer sus bytes.
            let descarga = null;
            const erroresDescarga = [];
            for (let intento = 1; intento <= 2 && !descarga && Date.now() < fechaLimite; intento++) {
              try {
                if (intento > 1) {
                  console.warn(`[PORTAL] Reintento PDF ${intento}/2:`, meta.providencia);
                  await page.waitForTimeout(1200);
                }
                const boton = page.locator(
                  '[id="resultForm"] button.ui-splitbutton-menubutton'
                ).first();
                await boton.waitFor({ state: 'visible', timeout: 15000 });

                // Revalidar sobre la fila actual, sin alternar una casilla ya marcada.
                await asegurarSeleccionProvidencia(page, fila.id);

                // Cerrar el menú anterior, si está abierto, antes de abrirlo.
                const enlacesPDF = page.locator('a.ui-menuitem-link').filter({
                  hasText: /^\s*Pdf\s*$/i
                });
                const visibleAntes = await enlacesPDF.filter({ visible: true }).count();
                if (visibleAntes) {
                  await page.keyboard.press('Escape').catch(() => {});
                }
                await boton.click({ timeout: 12000 });
                const opcionPDF = enlacesPDF.filter({ visible: true }).first();
                await opcionPDF.waitFor({ state: 'visible', timeout: 12000 });

                // Instalar la espera antes del clic; el clic y la espera
                // forman una sola operación para no perder eventos rápidos.
                // La relatoría puede entregar el PDF como descarga o como
                // respuesta HTTP (incluso en otra pestaña). Escuchar antes
                // del clic y aceptar únicamente bytes con firma PDF.
                const contexto = page.context();
                const candidatos = [];
                let urlPdfHttp = '';
                const registrarRespuesta = respuesta => {
                  try {
                    const u = new URL(respuesta.url());
                    if (!/(^|\.)ramajudicial\.gov\.co$|(^|\.)cortesuprema\.gov\.co$/i.test(u.hostname)) return;
                    const tipo = String(respuesta.headers()['content-type'] || '').toLowerCase();
                    const disposicion = String(respuesta.headers()['content-disposition'] || '').toLowerCase();
                    // JSF a veces sirve el PDF como octet-stream o adjunto sin extensión.
                    if (/pdf|octet-stream/.test(tipo) || /\.pdf(?:$|[?#])/i.test(respuesta.url()) || /filename[^;]*\.pdf/i.test(disposicion)) {
                      candidatos.push(respuesta);
                    }
                  } catch (_) { /* Solo respuestas de dominios oficiales. */ }
                };
                contexto.on('response', registrarRespuesta);
                // No usar Promise.race con un valor null temprano: puede perder
                // una respuesta HTTP que llegó mientras se esperaba la descarga.
                const esperaDescarga = page.waitForEvent('download', { timeout: 22000 })
                  .then(archivo => ({ archivo })).catch(() => null);
                try {
                  await opcionPDF.click({ timeout: 12000 });
                  const limiteEspera = Date.now() + 22000;
                  let archivoDetectado = null;
                  let respuestaDetectada = null;
                  while (Date.now() < limiteEspera && !archivoDetectado && !respuestaDetectada) {
                    archivoDetectado = await Promise.race([
                      esperaDescarga,
                      page.waitForTimeout(400).then(() => null)
                    ]);
                    if (!archivoDetectado && candidatos.length) {
                      // Verificar firma real, no confiar solo en la cabecera HTTP.
                      for (const respuesta of candidatos.splice(0)) {
                        try {
                          const cuerpo = await Promise.race([
                            respuesta.body(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Respuesta PDF tardía')), 6000))
                          ]);
                          if (cuerpo.length <= MAX_PDF && cuerpo.subarray(0, 5).toString() === '%PDF-') {
                            respuestaDetectada = cuerpo;
                            urlPdfHttp = respuesta.url();
                            break;
                          }
                        } catch (error) {
                          console.warn('[PORTAL] Respuesta PDF no legible:', error.message);
                        }
                      }
                    }
                  }
                  if (archivoDetectado?.archivo) descarga = archivoDetectado.archivo;
                  else if (respuestaDetectada) descarga = { bytesHttp: respuestaDetectada, urlHttp: urlPdfHttp };
                } finally {
                  contexto.off('response', registrarRespuesta);
                }
              } catch (error) {
                erroresDescarga.push(`intento ${intento}: ${error.message}`);
                console.warn('[PORTAL] Descarga PDF no confirmada:',
                  meta.providencia, `intento ${intento}/2`, error.message);
              }
            }
            if (!descarga) {
              throw new Error('No se recibió una descarga PDF tras dos intentos. ' +
                erroresDescarga.map(e => e.slice(0, 180)).join(' | '));
            }

            const bytes = descarga.bytesHttp
              ? descarga.bytesHttp
              : await (async () => {
                  const archivo = await descarga.path();
                  if (!archivo) throw new Error('No se obtuvo un archivo descargado.');
                  return readFile(archivo);
                })();

            console.log(
              '[PORTAL] PDF descargado:',
              meta.providencia
            );

            // Extraer texto.
            const {
              paginas,
              total
            } = await leerPDF(bytes);

            // Verificar identidad documental.
            verificarDocumento(
              paginas,
              meta.providencia,
              meta.radicado
            );

            // Verificación de PDF y anonimización son estados independientes.
            // Nunca se envía el texto sin anonimizar al cliente ni a Gemini.
            let paginasSeguras = null;
            let motivoRevision = '';
            const inicioPrivacidad = Date.now();
            try {
              paginasSeguras = anonimizarPaginas(paginas);
            } catch (error) {
              try {
                paginasSeguras = await anonimizarConSegundaPasada(paginas, error);
              } catch (fallo) {
                motivoRevision = fallo.message;
                console.warn('[PORTAL] PDF verificado, revisión de privacidad:', meta.providencia, motivoRevision);
              }
            }
            console.log('[PRIVACIDAD] Evaluación total:', meta.providencia, Date.now() - inicioPrivacidad, 'ms, estado:', paginasSeguras ? 'listo' : 'revision_privacidad');
            const documentoVerificado = {
              id: fila.id,
              ...meta,
              paginas: paginasSeguras,
              totalPaginas: total,
              archivoOriginal: descarga.bytesHttp
                ? `${meta.providencia}(${meta.radicado}).pdf`
                : descarga.suggestedFilename(),
              // El PDF se procesa para verificar la fuente, pero no se guarda para servirlo.
              paginasOriginalesPrivadas: paginas,
              urlPdfDirecto: enlacePdfOficial(descarga.bytesHttp ? descarga.urlHttp : descarga.url()),
              verificado: true,
              estado: paginasSeguras ? 'listo' : 'revision_privacidad',
              aptoGemini: Boolean(paginasSeguras),
              motivoRevision,
              origen: 'Rama Judicial en vivo'
            };
            resultados.push(documentoVerificado);
            if (typeof onDocumento === 'function') onDocumento(documentoVerificado);
            pdfVerificadosEnMemoria.set(claveProvidencia(meta), {
              fecha: Date.now(), documento: documentoVerificado
            });

            console.log(
              '[PORTAL] Documento verificado:',
              meta.providencia
            );

          } finally {
            if (await objetivo.count()) {
              const seleccionado = await objetivo.evaluate(fila =>
                Boolean(fila.querySelector('input[type="checkbox"]:checked')) ||
                Boolean(fila.querySelector('.ui-chkbox-box.ui-state-active')) ||
                Boolean(fila.querySelector('.ui-chkbox-icon.ui-icon-check')) ||
                fila.getAttribute('aria-selected') === 'true'
              );

              if (seleccionado) {
                await objetivo.locator(
                  '.ui-chkbox-box'
                ).click({
                  timeout: 5000
                }).catch(() => {});
              }
            }
          }

        } catch (error) {
          console.warn(
            `[PORTAL] Error con ${meta.providencia}:`,
            error.message
          );

          advertencias.push(`${meta.providencia}: ${error.message}`);
          resultados.push({
            id: fila.id, ...meta, paginas: null, totalPaginas: null,
            archivoOriginal: '', verificado: false,
            estado: 'registro_oficial', aptoGemini: false,
            motivoRevision: error.message,
            origen: 'Rama Judicial en vivo'
          });
          if (typeof onDocumento === 'function') onDocumento(resultados.at(-1));
        }
      }

      ultimaPaginaCompleta = filas.length > 0;

      // --------------------------------------------
      // 9.7. Paginación
      // --------------------------------------------

      if (
        resultados.length >= maxResultados
      ) {
        break;
      }

      if (Date.now() >= fechaLimite) {
        // El plazo se agotó, pero todavía puede haber más páginas.
        // No marcar la consulta como terminada: el servidor conservará
        // el cursor para continuar con «Cargar más sentencias».
        hayPaginaSiguiente = true;
        if (!advertencias.some(a => /navegaci[oó]n|no avanz[oó]|consulta se interrumpi[oó]/i.test(a))) {
          advertencias.push('Tiempo de consulta agotado; los resultados se conservaron y puedes continuar con «Cargar más sentencias».');
        }
        break;
      }
      const paginacion = await estadoPaginacion(page);
      console.log('[PORTAL] Diagnóstico de paginación:', paginacion);
      const avance = await navegarAlSiguienteResultado(page);
      if (!avance.avanzado) {
        if (avance.motivo) {
          console.warn('[PORTAL] Navegación pendiente:', avance.motivo);
          advertencias.push(avance.motivo);
          hayPaginaSiguiente = true;
        }
        break;
      }
      hayPaginaSiguiente = false;
    }

    // Alcanzar el límite de páginas de esta ejecución no equivale a
    // agotar el listado oficial. El cursor se conserva para continuar.
    if (paginasConsultadas >= maxPaginas && ultimaPaginaCompleta) {
      hayPaginaSiguiente = true;
    }

    console.log(
      '[PORTAL] Consulta finalizada:',
      {
        filasConsultadas: totalFilas,
        paginasConsultadas,
        documentosVerificados:
          resultados.filter(d => d.verificado === true).length,
        registrosSinPdf: resultados.filter(d => !d.verificado).length,
        advertencias:
          advertencias.length
      }
    );

    return {
      termino,
      portal: PORTAL,
      resultados,
      advertencias,
      totalFilas,
      paginasConsultadas,
      desplazamiento,
      siguienteDesplazamiento: filasElegibles,
      puedeCargarMas: hayPaginaSiguiente || (resultados.length >= maxResultados && ultimaPaginaCompleta)
    };

  } finally {
    await browser.close();
  }
}

// ======================================================
// 10. CONSTRUCCIÓN DE FRAGMENTOS
// ======================================================

export function construirFragmentos(
  documento,
  termino,
  limite = 14
) {
  const palabras = normal(termino)
    .split(/\s+/)
    .filter(palabra => palabra.length > 3);

  const fragmentos = [];

  for (
    let i = 0;
    i < documento.paginas.length;
    i++
  ) {
    const texto = documento.paginas[i];

    const bloques = texto.split(
      /\n{2,}|(?=\n\s*\d{1,2}\.\s)/
    ).filter(
      bloque => bloque.trim().length > 35
    );

    for (const bloque of bloques) {
      const score = palabras.reduce(
        (n, palabra) =>
          n + (
            normal(bloque).includes(palabra)
              ? 1
              : 0
          ),
        0
      );

      fragmentos.push({
        pagina: i + 1,
        texto: bloque.trim().slice(0, 1250),
        score
      });
    }
  }

  return fragmentos
    .sort((a, b) => b.score - a.score)
    .slice(0, limite)
    .map(({ pagina, texto }, i) => ({
      id: `F${i + 1}`,
      pagina,
      texto
    }));
}

// ======================================================
// 11. ANÁLISIS JURÍDICO CON GEMINI
// ======================================================

export async function analizarDocumentoOficial(
  documento,
  consulta
) {
  if (!documento?.aptoGemini || !Array.isArray(documento.paginas)) {
    throw new Error('Documento pendiente de anonimización segura; Gemini está bloqueado.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'Configura GEMINI_API_KEY para analizar con Gemini.'
    );
  }

  const fragmentos = construirFragmentos(
    documento,
    consulta,
    18
  );

  if (!fragmentos.length) {
    throw new Error(
      'No se encontraron fragmentos legibles.'
    );
  }

  const prompt =
    `Analiza SOLO estos extractos anonimizados de una providencia oficial colombiana. Caso o consulta del usuario: ${String(consulta || '').slice(0, 1500)}. Separa hechos y conclusiones del documento de cualquier comparación con el caso del usuario. No inventes datos, jurisprudencia adicional, penas ni normas. Si la consulta es solo una palabra o no describe hechos, indica que NO se pueden determinar similitudes ni diferencias concretas. No cites nombres de particulares. Las otras decisiones SOLO pueden mencionarse si están expresamente citadas en los extractos; de lo contrario, devuelve lista vacía. Devuelve exclusivamente JSON con esta estructura: {"resumen":"...","hechos":"...","problema_juridico":"...","argumentos":"...","decision":"...","pena":"...","normas":["..."],"analisis_caso":"...","similitudes":["..."],"diferencias":["..."],"otras_decisiones":[{"referencia":"...","relacion":"...","fragmentos":["F1"]}],"conclusion":"...","afirmaciones":[{"texto":"...","fragmentos":["F1"]}]}. Para el campo pena, distingue expresamente (a) pena o sanción impuesta en las instancias anteriores y (b) consecuencia procesal de la decisión de esta providencia. Si se conoce la decisión procesal, explícala aunque no conste la duración de la pena; indica por separado que la pena concreta no consta en los extractos. Si no hay datos suficientes sobre ninguna de las dos, responde "No consta en los fragmentos examinados". Nunca confundas inadmisión de casación con imposición de una pena ni inventes condenas. Cada afirmación debe identificar fragmentos que la respaldan. Documento: ${documento.providencia}, radicado ${documento.radicado}.\n` +
    fragmentos.map(f => `[${f.id}] PÁGINA ${f.pagina}: ${f.texto}`).join('\n');

  const ia = await generarJSON(
    prompt,
    { temperatura: 0.1 }
  );

  // Protección adicional de la salida: la IA no debe reintroducir nombres
  // presentes en el original ni reproducirlos en citas o resúmenes.
  // Si se detecta una identidad no saneada, se bloquea la respuesta entera.
  const nombresProtegidos = Array.isArray(documento.paginasOriginalesPrivadas)
    ? nombresUnicosPrivados([
        ...detectarParticipantesExplicitos(documento.paginasOriginalesPrivadas),
        ...candidatosNombresLargos(documento.paginasOriginalesPrivadas)
      ])
    : [];
  const sanearSalidaIA = valor => {
    if (typeof valor === 'string') {
      let salida = valor;
      for (const nombre of nombresProtegidos) salida = salida.replace(patronNombre(nombre), 'PERSONA_ANONIMIZADA');
      return salida;
    }
    if (Array.isArray(valor)) return valor.map(sanearSalidaIA);
    if (valor && typeof valor === 'object') return Object.fromEntries(
      Object.entries(valor).map(([clave, dato]) => [clave, sanearSalidaIA(dato)]));
    return valor;
  };
  const iaSegura = sanearSalidaIA(ia);
  // No se considera que una decisión de inadmisión equivalga a pena.
  const penaInformada = String(iaSegura.pena || '').trim();
  const decisionInformada = String(iaSegura.decision || '').trim();
  const penaSinDato = !penaInformada || /^(?:no consta|no se especifica|no se indica|no aparece)(?:[\s.]|$)/i.test(penaInformada);
  const penaExplicada = penaSinDato && decisionInformada &&
    !/^(?:no consta|no se especifica|no se indica)(?:[\s.]|$)/i.test(decisionInformada)
      ? `Pena concreta: no consta en los fragmentos examinados. Consecuencia de esta providencia: ${decisionInformada}`
      : penaInformada || 'No consta en los fragmentos examinados';

  const mapa = new Map(
    fragmentos.map(fragmento => [
      fragmento.id,
      fragmento
    ])
  );

  const tokens = texto => [
    ...new Set(
      normal(texto).match(
        /[a-záéíóúñ]{5,}/g
      ) || []
    )
  ].filter(palabra => ![
    'sobre', 'entre', 'desde',
    'hasta', 'cuando', 'donde',
    'tiene', 'fueron', 'segun',
    'dicho', 'misma', 'mismo',
    'contra', 'tambien', 'parte',
    'consta', 'porque'
  ].includes(palabra));

  const afirmaciones = [];
  const rechazadas = [];

  for (
    const afirmacion of (
      Array.isArray(iaSegura.afirmaciones)
        ? iaSegura.afirmaciones
        : []
    )
  ) {
    const texto = String(
      afirmacion.texto || ''
    ).trim();

    const ids = Array.isArray(
      afirmacion.fragmentos
    ) ? afirmacion.fragmentos : [];

    const candidatos = ids
      .filter(id => mapa.has(id))
      .map(id => mapa.get(id));

    const palabras = tokens(texto);

    const fuentes = candidatos.filter(
      fragmento => {
        const contenido = normal(
          fragmento.texto
        );

        const coincidencias =
          palabras.filter(
            palabra =>
              contenido.includes(palabra)
          ).length;

        return (
          palabras.length >= 2 &&
          coincidencias >= Math.min(
            2,
            palabras.length
          ) &&
          coincidencias /
            palabras.length >= 0.35
        );
      }
    );

    if (texto && fuentes.length) {
      afirmaciones.push({
        texto,
        fuentes,
        verificacion:
          'Coincidencia léxica preliminar; requiere revisión humana'
      });
    } else if (texto) {
      rechazadas.push({
        texto,
        motivo:
          'No se comprobó respaldo textual suficiente'
      });
    }
  }

  return {
    providencia: documento.providencia,
    radicado: documento.radicado,
    resumen:
      iaSegura.resumen || 'No consta',
    problema_juridico:
      iaSegura.problema_juridico || 'No consta',
    decision:
      iaSegura.decision || 'No consta',
    normas:
      Array.isArray(iaSegura.normas)
        ? iaSegura.normas
        : [],
    hechos: iaSegura.hechos || 'No consta',
    argumentos: iaSegura.argumentos || 'No consta',
    pena: penaExplicada,
    analisis_caso: iaSegura.analisis_caso || 'No consta',
    similitudes: Array.isArray(iaSegura.similitudes) ? iaSegura.similitudes : [],
    diferencias: Array.isArray(iaSegura.diferencias) ? iaSegura.diferencias : [],
    otras_decisiones: (Array.isArray(iaSegura.otras_decisiones) ? iaSegura.otras_decisiones : []).filter(x => Array.isArray(x.fragmentos) && x.fragmentos.some(id => mapa.has(id))).map(x => ({ referencia: String(x.referencia || ''), relacion: String(x.relacion || ''), fuentes: x.fragmentos.filter(id => mapa.has(id)).map(id => mapa.get(id)) })),
    conclusion: iaSegura.conclusion || 'No consta',
    afirmaciones,
    afirmacionesSinRespaldo:
      rechazadas,
    fragmentos,
    advertencia:
      'Solo se muestran afirmaciones con fragmentos y coincidencia textual preliminar. La verificación semántica y jurídica requiere revisión humana.'
  };
}

// Comparación limitada a evidencias recuperadas de documentos verificados.
export async function compararDocumentosOficiales(documentos, consulta = '') {
  if (!Array.isArray(documentos) || documentos.some(d => !d?.aptoGemini || !Array.isArray(d.paginas))) {
    throw new Error('La comparación requiere documentos anonimizados y habilitados para Gemini.');
  }

  if (!process.env.GEMINI_API_KEY) throw new Error('Configura GEMINI_API_KEY.');
  if (!Array.isArray(documentos) || documentos.length < 2 || documentos.length > 8)
    throw new Error('Selecciona entre 2 y 8 sentencias.');
  const fuentes = documentos.map((d, i) => ({
    codigo: `S${i + 1}`, providencia: d.providencia, radicado: d.radicado,
    fragmentos: construirFragmentos(d, consulta || d.providencia, 8).map(f => ({ pagina: f.pagina, texto: f.texto.slice(0, 700) }))
  }));
  const prompt = `Compara SOLO la evidencia anonimizada siguiente. No inventes decisiones, normas ni relaciones. Identifica coincidencias y diferencias entre providencias, y señala la página y código S correspondiente para cada referencia. Responde JSON con claves resumen, similitudes (arreglo de textos), diferencias (arreglo de textos), decisiones (arreglo de objetos con codigo, decision y paginas (arreglo de números)), advertencias (arreglo de textos). Caso del usuario: ${String(consulta).slice(0, 1800)}. Evidencia: ${JSON.stringify(fuentes)}`;
  const resultado = await generarJSON(prompt, { temperatura: 0.1 });
  return { ...resultado, documentos: fuentes.map(({ fragmentos, ...resto }) => resto), advertencia: 'Comparación generada por IA a partir de fragmentos; comprueba cada afirmación en el visor. Las páginas mencionadas no están verificadas semánticamente.' };
}