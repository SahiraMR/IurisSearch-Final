
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db,
  inicializarDB,
  registrarUsuario,
  loginUsuario,
  guardarDocumento,
  obtenerDocumentos,
  eliminarDocumento,
  guardarNotaDB,
  obtenerNotasDB,
  eliminarNotaDB,
  actualizarNotaDB,
  guardarHistorialDB,
  obtenerHistorialDB,
  obtenerEstadisticasDB
} from './lib/db.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));

const [mayor] = process.versions.node.split('.').map(Number);

if (mayor < 18) {
  console.error(`Necesitas Node.js 18 o superior (tienes ${process.versions.node}).`);
  process.exit(1);
}

// ======================================================
// VARIABLES DE ENTORNO
// ======================================================

function cargarEnv() {
  const ruta = path.join(RAIZ, '.env');

  if (!fs.existsSync(ruta)) return;

  for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);

    if (!m || linea.trim().startsWith('#')) continue;

    const valor = m[2].replace(/^["']|["']$/g, '');

    if (!(m[1] in process.env)) {
      process.env[m[1]] = valor;
    }
  }
}

cargarEnv();
await inicializarDB();

const { modelosTexto } = await import('./lib/gemini.mjs');

const {
  consultarYDescargar,
  analizarDocumentoOficial,
  compararDocumentosOficiales,
  revisarAnonimizacionDocumento,
  candidatosRevisionPrivacidad
} = await import('./lib/oficial_integrado.mjs');

const cacheOficial = new Map();
// No se conserva un caché de PDF para abrirlo desde Render.

const PUERTO = Number(process.env.PORT || 3000);
const MAX_BODY = 15_000_000;

const LIMITE = {
  ventanaMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_MAX || 20)
};

// El corpus local ya no participa en la búsqueda.
// Tampoco se generan embeddings al iniciar.

if (!process.env.GEMINI_API_KEY) {
  console.warn('Falta GEMINI_API_KEY en el archivo .env.');
}

// ======================================================
// UTILIDADES HTTP
// ======================================================

class ErrorUsuario extends Error {
  constructor(m, status = 400) {
    super(m);
    this.status = status;
  }
}

const visitas = new Map();

function permitido(ip) {
  const ahora = Date.now();

  const recientes = (visitas.get(ip) || [])
    .filter(t => ahora - t < LIMITE.ventanaMs);

  const ok = recientes.length < LIMITE.max;

  if (ok) recientes.push(ahora);

  visitas.set(ip, recientes);

  return ok;
}

function enviar(res, status, datos) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(datos));
}

async function leerCuerpo(req) {
  let body = '';

  for await (const c of req) {
    body += c;

    if (body.length > MAX_BODY) {
      throw new ErrorUsuario(
        'El documento es demasiado grande.',
        413
      );
    }
  }

  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new ErrorUsuario(
      'La solicitud no es un JSON válido.'
    );
  }
}

// ======================================================
// BÚSQUEDA OFICIAL
// ======================================================

// Cada consulta mantiene sus resultados en memoria durante 30 minutos.
// Así «Cargar más» no repite las búsquedas que ya terminaron.
const sesionesBusqueda = new Map();
const DURACION_SESION = 30 * 60 * 1000;

function variantesBusqueda(termino) {
  // Estrategia general: no asumir delitos ni introducir sinónimos que
  // alteren el significado jurídico de la consulta del usuario.
  const base = String(termino || '').trim().replace(/\s+/g, ' ');
  const palabras = base.split(' ').filter(Boolean);
  const candidatos = [base];
  if (palabras.length >= 3) candidatos.push(palabras.slice(0, -1).join(' '));
  if (palabras.length >= 2) candidatos.push(palabras.slice(0, 2).join(' '));
  // No reducir automáticamente a una palabra genérica: aumenta el ruido.
  return [...new Set(candidatos.map(x => x.toLocaleLowerCase('es-CO')))]
    .filter(x => x.length >= 3).slice(0, 3);
}

// Evaluación preliminar y explicable de pertinencia. Solo usa páginas ya
// anonimizadas; jamás analiza ni devuelve texto original de un PDF bloqueado.
// No sustituye la valoración jurídica de una persona.
function coincidenciaMetadatos(doc, consulta, descripcionCaso = '') {
  // Solo se evalúa texto que superó la revisión de privacidad.
  const normalizar = valor => String(valor || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const paginas = doc.aptoGemini === true && Array.isArray(doc.paginas)
    ? doc.paginas.map(normalizar) : null;
  const tema = normalizar(doc.tema);
  const contexto = normalizar([doc.actuacion, doc.tipo].join(' '));
  const expresion = normalizar(consulta);
  const palabrasConsulta = [...new Set(expresion.split(' ').filter(p => p.length >= 4))];
  const enTema = expresion.length >= 4 && tema.includes(expresion);
  const enTexto = paginas ? paginas.some(p => p.includes(expresion)) : false;
  const coincidenciasTema = palabrasConsulta.filter(p => tema.split(' ').includes(p));
  const coincidenciasContexto = palabrasConsulta.filter(p => contexto.split(' ').includes(p));
  const sinEvaluar = {
    nivel: 'sin_confirmar', terminos: [], aviso: 'Evaluación automática preliminar, no dictamen jurídico.',
    pertinencia: { nivel: 'sin_evaluar', justificacion: 'No se dispone de texto anonimizado aprobado para evaluar la pertinencia.', evidencias: [], evaluacionAutomatica: true, confirmadaPorHumano: false }
  };
  if (!paginas) return sinEvaluar;

  const excluir = new Set(`sobre entre desde contra durante despues antes para como cuando donde porque tambien persona personas caso casos hipotetico hechos hecho fiscalia defensa acusado acusada procesado procesada victima victimas testigo testigos testimonio testimonios delito delitos penal juridico juridica proceso procesos etapa audiencia prueba pruebas sentencia sentencias corte sala busca jurisprudencia discutir discute investigado investigada existe existen fueron puede pueden habia tiene tienen juez juicio oral documento documentos determinar establece sostiene afirma cuestiona investigacion elementos procesales imputacion acusacion resultado derecho ley articulo codigo colombia abogados abogado abogada tribunal instancia recurso casacion resolucion magistrado magistrada conducta responsabilidad`.split(' '));
  const tokensRelato = normalizar(descripcionCaso).split(' ').filter(Boolean);
  const terminosRelato = [...new Set(tokensRelato.filter(p => p.length >= 5 && !excluir.has(p) && !palabrasConsulta.includes(p)))];
  const pares = [...new Set(tokensRelato.slice(0, -1).map((p, i) => {
    const q = tokensRelato[i + 1];
    return p.length >= 5 && q.length >= 5 && !excluir.has(p) && !excluir.has(q) &&
      !palabrasConsulta.includes(p) && !palabrasConsulta.includes(q) ? `${p} ${q}` : '';
  }).filter(Boolean))];
  const textoUnido = paginas.join(' ');
  const terminosEncontrados = terminosRelato.filter(p => new RegExp(`\\b${p}\\b`).test(textoUnido));
  const paresEncontrados = pares.filter(p => paginas.some(t => t.includes(p)));
  const paginasConRelato = new Set();
  paginas.forEach((p, i) => {
    if (terminosEncontrados.filter(t => new RegExp(`\\b${t}\\b`).test(p)).length >= 4) paginasConRelato.add(i + 1);
  });

  // Una providencia puede mencionar un delito sin resolver su problema jurídico.
  // Las señales deben estar próximas a la mención del delito, no en páginas aisladas.
  const patronProblema = /problema juridico|cuestion juridica|corresponde (?:a la sala|determinar)|tipicidad|elementos del tipo|configuracion del delito|responsabilidad penal|la sala (?:considera|advierte|concluye)|se (?:analiza|examina|estudia|discute)/;
  const patronDecision = /resuelve|decide|confirma|revoca|casa la sentencia|no casa|declara|condena|absuelve|parte resolutiva|consideraciones de la sala/;
  const temaAjeno = /\b(extradicion|conflicto de competencia|recurso de queja|habeas corpus)\b/.test(tema) && !enTema;
  const evidencias = [];
  let mencionesConAnalisis = 0;
  let mencionesConRelato = 0;
  for (let i = 0; i < paginas.length; i++) {
    const pagina = paginas[i];
    const posiciones = [];
    let desde = 0, posicion;
    if (expresion.length >= 4) {
      while ((posicion = pagina.indexOf(expresion, desde)) !== -1 && posiciones.length < 8) {
        posiciones.push(posicion);
        desde = posicion + expresion.length;
      }
    }
    for (const pos of posiciones) {
      const fragmento = pagina.slice(Math.max(0, pos - 320), Math.min(pagina.length, pos + expresion.length + 320));
      const analisis = patronProblema.test(fragmento);
      const relato = paresEncontrados.some(p => fragmento.includes(p)) ||
        terminosEncontrados.filter(t => new RegExp(`\\b${t}\\b`).test(fragmento)).length >= 3;
      if (analisis) mencionesConAnalisis++;
      if (relato) mencionesConRelato++;
      // Fragmento extraído exclusivamente del texto anonimizado, con longitud acotada.
      if (evidencias.length < 5) evidencias.push({ pagina: i + 1,
        fragmento: fragmento.slice(0, 430).trim(), contextoJuridico: analisis, coincidenciaFactica: relato });
    }
  }
  const cobertura = terminosRelato.length ? terminosEncontrados.length / terminosRelato.length : 0;
  const similitudFactica = terminosRelato.length >= 8 && terminosEncontrados.length >= 6 &&
    cobertura >= 0.28 && paginasConRelato.size >= 2 && paresEncontrados.length >= 2 && mencionesConRelato > 0;
  const relacionJuridica = mencionesConAnalisis > 0 && patronDecision.test(textoUnido);
  const fundamentoFuerte = !temaAjeno && enTexto && similitudFactica && relacionJuridica;
  let nivel, justificacion;
  if (fundamentoFuerte) {
    nivel = 'alta';
    justificacion = `Coincidencia preliminar del delito, ${terminosEncontrados.length} términos y ${paresEncontrados.length} expresiones específicas del relato, con discusión jurídica próxima a la mención y decisión identificable. Requiere validación jurídica humana.`;
  } else if (!temaAjeno && (enTexto || enTema) && (mencionesConAnalisis > 0 || (terminosEncontrados.length >= 4 && paginasConRelato.size >= 1))) {
    nivel = 'media';
    justificacion = 'Hay referencias al delito y señales de análisis o hechos relacionados, pero no se acredita suficiente correspondencia entre hechos, problema jurídico y decisión.';
  } else if (!temaAjeno && (enTexto || enTema)) {
    nivel = 'baja';
    justificacion = 'Se encontró una mención del delito, pero no evidencia suficiente de correspondencia entre hechos, problema jurídico y decisión.';
  } else {
    nivel = 'baja';
    justificacion = temaAjeno ? 'El tema oficial apunta a otra cuestión procesal; no se acreditó relación jurídica directa.' :
      'Solo se encontraron coincidencias parciales o insuficientes.';
  }
  return {
    nivel: enTema ? 'coincidencia_en_tema' : coincidenciasContexto.length ? 'coincidencia_en_clasificacion' :
      enTexto ? 'coincidencia_en_texto' : 'sin_confirmar',
    terminos: [...new Set([...coincidenciasTema, ...coincidenciasContexto])],
    aviso: 'Evaluación automática preliminar, no dictamen jurídico.',
    pertinencia: { nivel, justificacion, evidencias: evidencias.slice(0, 3),
      evaluacionAutomatica: true, confirmadaPorHumano: false }
  };
}

async function ejecutarBusquedaOficial(termino, desplazamiento = 0, cantidad = 10, opciones = {}) {
  if (typeof termino !== 'string' || !termino.trim() || termino.length > 120) {
    throw new ErrorUsuario('Escribe un término de hasta 120 caracteres.');
  }
  const consulta = termino.trim();
  const clave = consulta.toLowerCase().replace(/\s+/g, ' ');
  const offset = Math.max(0, Math.min(500, Number(desplazamiento) || 0));
  const limite = Math.max(1, Math.min(20, Number(cantidad) || 10));
  const ahora = Date.now();
  for (const [k, s] of sesionesBusqueda) {
    if (ahora - s.creado > DURACION_SESION) sesionesBusqueda.delete(k);
  }
  let sesion = sesionesBusqueda.get(clave);
  if (!sesion) {
    sesion = {
      creado: ahora, variantes: variantesBusqueda(consulta), indice: 0,
      resultados: [], ids: new Set(), advertencias: [],
      totalFilas: 0, paginasConsultadas: 0, consultas: [], cursores: {}, fallosContinuacion: {}
    };
    sesionesBusqueda.set(clave, sesion);
  }
  // Evitar dos consultas concurrentes que mezclen o dupliquen resultados.
  if (sesion.ocupada) await sesion.ocupada;
  let liberar;
  sesion.ocupada = new Promise(resolve => { liberar = resolve; });
  try {
    // Como máximo 5 nuevas consultas al portal por petición para no saturarlo.
    let nuevas = 0;
    const fechaLimite = opciones.fechaLimite || Infinity;
    while (sesion.resultados.length < offset + limite &&
           sesion.indice < sesion.variantes.length && nuevas < 2 && Date.now() < fechaLimite) {
      const variante = sesion.variantes[sesion.indice];
      const cursorAnterior = sesion.cursores[variante] || 0;
      opciones.onProgreso?.({ etapa: 'Consultando portal oficial', termino: variante, registros: sesion.resultados.length });
      nuevas++;
      console.log('[OFICIAL] Consulta oficial:', variante);
      try {
        const registrarDocumento = doc => {
          const identidad = `${doc.providencia}|${doc.radicado}`.toLowerCase();
          // El ID data-rk puede repetirse entre consultas: la identidad oficial manda.
          if (sesion.ids.has(identidad)) return;
          sesion.ids.add(identidad);
          const entrada = { ...doc, consultaOrigen: variante, coincidencia: coincidenciaMetadatos(doc, consulta, opciones.descripcionCaso || '') };
          sesion.resultados.push(entrada);
          cacheOficial.set(String(doc.id), { documento: doc, creado: Date.now() });
          if (typeof opciones.onProgreso === 'function') opciones.onProgreso({
            etapa: 'Verificando providencias oficiales', termino: variante,
            registros: sesion.resultados.length,
            pdfVerificados: sesion.resultados.filter(d => d.verificado).length,
            listosGemini: sesion.resultados.filter(d => d.aptoGemini).length
          });
        };
        const datos = await consultarYDescargar(variante, {
          maxResultados: Math.min(20, Math.max(5, offset + limite - sesion.resultados.length)),
          maxPaginas: 40, desplazamiento: cursorAnterior, fechaLimite,
          onDocumento: registrarDocumento
        });
        // Continuar la misma variante en futuras peticiones. El desplazamiento
        // pertenece al portal (filas elegibles), no al listado deduplicado.
        const cursorNuevo = Math.max(cursorAnterior, Number(datos.siguienteDesplazamiento) || 0);
        sesion.cursores[variante] = cursorNuevo;
        if (cursorNuevo <= cursorAnterior) sesion.fallosContinuacion[variante] = (sesion.fallosContinuacion[variante] || 0) + 1;
        else sesion.fallosContinuacion[variante] = 0;
        // Una navegación bloqueada o un timeout no significan que se hayan
        // agotado las sentencias. Mantener la variante activa para que
        // «Cargar más sentencias» pueda reintentar en otra petición.
        // El límite maxPaginas se aplica dentro del scraper; el cursor
        // representa filas elegibles y no debe compararse con 40 páginas.
        if (!datos.puedeCargarMas) {
          sesion.indice++;
        }
        sesion.consultas.push({ termino: variante,
          encontrados: datos.totalFilas, verificados: datos.resultados.filter(d => d.verificado === true).length });
        sesion.totalFilas += datos.totalFilas;
        sesion.paginasConsultadas += datos.paginasConsultadas;
        sesion.advertencias.push(...(datos.advertencias || [])
          .map(a => `${variante}: ${a}`));
        // Registrar también cualquier resultado final no emitido por el callback.
        for (const doc of datos.resultados) registrarDocumento(doc);
      } catch (error) {
        console.warn('[OFICIAL] Falló variante', variante, error.message);
        sesion.advertencias.push(`${variante}: ${error.message}`);
        // Fallo temporal: conservar la variante y el cursor para un reintento.
        // El usuario puede continuar desde «Cargar más sentencias».
        sesion.fallosContinuacion[variante] = (sesion.fallosContinuacion[variante] || 0) + 1;
      }
    }
    const bloque = sesion.resultados.slice(offset, offset + limite);
    for (const doc of bloque) {

      cacheOficial.set(String(doc.id), { documento: doc, creado: Date.now() });
    }
    return {
      termino: consulta,
      portal: 'https://consultajurisprudencial.ramajudicial.gov.co/WebRelatoria/csj/index.xhtml',
      resultados: bloque.map(({ paginas, pdfOriginal, paginasOriginalesPrivadas, ...resto }) => ({
        ...resto,
        motivoRevision: !resto.verificado && resto.motivoRevision ? mensajePortalPublico(resto.motivoRevision) : resto.motivoRevision,
        caracteres: Array.isArray(paginas) ? paginas.join('').length : 0
      })),
      advertencias: [...new Set(sesion.advertencias.map(mensajePortalPublico))],
      totalRegistros: bloque.length,
      pdfVerificados: bloque.filter(d => d.verificado === true).length,
      pendientesDescarga: bloque.filter(d => !d.verificado).length,
      listosGemini: bloque.filter(d => d.verificado === true && d.aptoGemini).length,
      totalFilas: sesion.totalFilas,
      paginasConsultadas: sesion.paginasConsultadas,
      consultas: sesion.consultas,
      desplazamiento: offset,
      siguienteDesplazamiento: offset + bloque.length,
      puedeCargarMas: offset + bloque.length < sesion.resultados.length ||
        sesion.indice < sesion.variantes.length
    };
  } finally {
    liberar();
    sesion.ocupada = null;
  }
}

// Los diagnósticos detallados permanecen en el servidor; nunca se envían
// trazas de Playwright ni mensajes internos al usuario final.
function mensajePortalPublico(valor) {
  const texto = String(valor || '');
  const prefijo = texto.match(/^([^:]{1,110}):\s*(.*)$/s);
  const consulta = prefijo && !/^(?:page|Error|Timeout|https?)\b/i.test(prefijo[1]) ? prefijo[1] + ': ' : '';
  const detalle = prefijo ? prefijo[2] : texto;
  const documento = detalle.match(/\b((?:AP|SP|CP|AHP|ATP|STP|SEP)\s*[-–]?\s*\d+\s*[-–]\s*\d{4})\s*:/i);
  const identificador = documento ? documento[1].replace(/\s+/g, '') + ': ' : '';
  if (/No se recibió una descarga|download|descarga PDF/i.test(detalle))
    return consulta + identificador + 'No fue posible recuperar este documento por el momento.';
  if (/PDF no confirma|no coincide|providencia.*no.*confirm/i.test(detalle))
    return consulta + identificador + 'No fue posible verificar la identidad del documento oficial.';
  if (/No avanzó|waitForFunction|navegaci[oó]n|paginaci[oó]n/i.test(detalle))
    return consulta + 'La consulta se interrumpió temporalmente. Se conservaron los resultados; puedes usar «Cargar más sentencias».';
  if (/Tiempo de consulta agotado|tiempo.*agot|timeout|l[ií]mite de tiempo/i.test(detalle))
    return consulta + 'La búsqueda se pausó. Se conservaron los resultados y puedes continuar con «Cargar más sentencias».';
  if (/AJAX|PrimeFaces|tabla|fila|DOM|selector/i.test(detalle))
    return consulta + 'El portal no confirmó los resultados de esta consulta. Puedes intentarlo nuevamente.';
  return consulta + 'No fue posible completar una operación del portal. Los resultados obtenidos se conservaron.';
}

// Trabajo progresivo: el navegador consulta el estado sin esperar a que termine Playwright.
const trabajosOficiales = new Map();
const VIDA_TRABAJO = 15 * 60 * 1000;
function limpiarTrabajos() {
  for (const [id, t] of trabajosOficiales) if (Date.now() - t.creado > VIDA_TRABAJO) trabajosOficiales.delete(id);
}
function resultadoSeguro(doc) {
  const { paginas, pdfOriginal, paginasOriginalesPrivadas, ...resto } = doc;
  return { ...resto,
        motivoRevision: !resto.verificado && resto.motivoRevision ? mensajePortalPublico(resto.motivoRevision) : resto.motivoRevision,
        caracteres: Array.isArray(paginas) ? paginas.join('').length : 0 };
}
function iniciarTrabajoOficial(termino, desplazamiento, cantidad, descripcionCaso = '') {
  if (typeof termino !== 'string' || !termino.trim() || termino.length > 120) throw new ErrorUsuario('Escribe un término de hasta 120 caracteres.');
  limpiarTrabajos();
  const id = crypto.randomUUID();
  const trabajo = { creado: Date.now(), estado: 'ejecutando', etapa: 'Iniciando consulta oficial',
    termino, registros: 0, pdfVerificados: 0, listosGemini: 0, resultados: [], advertencias: [],
    puedeCargarMas: false, siguienteDesplazamiento: desplazamiento || 0 };
  trabajosOficiales.set(id, trabajo);
  // No se espera aquí: se devuelve el identificador inmediatamente.
  void ejecutarBusquedaOficial(termino, desplazamiento, cantidad, {
    fechaLimite: Date.now() + 180000, descripcionCaso,
    onProgreso: p => {
      Object.assign(trabajo, p);
      // Solo los registros ya procesados y saneados son visibles durante la búsqueda.
      const clave = termino.trim().toLowerCase().replace(/\s+/g, ' ');
      const sesion = sesionesBusqueda.get(clave);
      if (sesion) trabajo.resultados = sesion.resultados.slice(desplazamiento || 0, (desplazamiento || 0) + (cantidad || 10)).map(d => ({ ...resultadoSeguro(d), coincidencia: coincidenciaMetadatos(d, termino, descripcionCaso) }));
    }
  }).then(datos => {
    Object.assign(trabajo, datos, { estado: 'finalizado', etapa: 'Búsqueda finalizada' });
    trabajo.resultados = (datos.resultados || []).map(d => { const original = cacheOficial.get(String(d.id))?.documento; return { ...d, coincidencia: original ? coincidenciaMetadatos(original, termino, descripcionCaso) : d.coincidencia }; });
  }).catch(err => {
    trabajo.estado = 'error'; trabajo.etapa = 'No se completó la búsqueda';
    trabajo.error = err.message;
  });
  return { id, estado: trabajo.estado };
}

// ======================================================
// RUTAS
// ======================================================

const rutas = {

  // REGISTRO

  'POST /api/registro': async req => {
    const { usuario, password } = await leerCuerpo(req);

    if (!usuario || !password) {
      throw new ErrorUsuario('Faltan datos');
    }

    return await registrarUsuario(usuario, password);
  },

  // INICIO DE SESIÓN

  'POST /api/login': async req => {
    const { usuario, password } = await leerCuerpo(req);

    if (!usuario || !password) {
      throw new ErrorUsuario('Faltan datos');
    }

    return await loginUsuario(usuario, password);
  },

  // GUARDAR DOCUMENTO

  'POST /api/documentos': async req => {
    const { usuario_id, sentencia } = await leerCuerpo(req);

    if (!usuario_id || !sentencia) {
      throw new ErrorUsuario('Faltan datos.');
    }

    await guardarDocumento(usuario_id, sentencia);

    return {
      ok: true,
      mensaje: 'Documento guardado'
    };
  },

  // CONSULTAR DOCUMENTOS

  'GET /api/documentos': async req => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');

    if (!usuario_id) {
      return { documentos: [] };
    }

    const docs = await obtenerDocumentos(usuario_id);

    return { documentos: docs };
  },

  // ELIMINAR DOCUMENTO

  'DELETE /api/documentos': async req => {
    const urlObj = new URL(req.url, 'http://localhost');

    const usuario_id = urlObj.searchParams.get('usuario_id');
    const id = urlObj.searchParams.get('id');

    if (!usuario_id || !id) {
      throw new ErrorUsuario('Faltan datos.');
    }

    await eliminarDocumento(usuario_id, id);

    return { ok: true };
  },

  // GUARDAR NOTA

  'POST /api/notas': async req => {
    const {
      usuario_id,
      sentencia_id,
      texto
    } = await leerCuerpo(req);

    if (!usuario_id || !sentencia_id || !texto) {
      throw new ErrorUsuario('Faltan datos.');
    }

    await guardarNotaDB(
      usuario_id,
      sentencia_id,
      texto
    );

    return {
      ok: true,
      mensaje: 'Nota guardada'
    };
  },

  // CONSULTAR NOTAS

  'GET /api/notas': async req => {
    const urlObj = new URL(req.url, 'http://localhost');

    const usuario_id = urlObj.searchParams.get('usuario_id');
    const sentencia_id = urlObj.searchParams.get('sentencia_id');

    if (!usuario_id || !sentencia_id) {
      return { notas: [] };
    }

    const notas = await obtenerNotasDB(
      usuario_id,
      sentencia_id
    );

    return { notas };
  },

  // ELIMINAR NOTA

  'DELETE /api/notas': async req => {
    const urlObj = new URL(req.url, 'http://localhost');
    const id = urlObj.searchParams.get('id');

    if (!id) {
      throw new ErrorUsuario('Falta el ID de la nota.');
    }

    await eliminarNotaDB(id);

    return { ok: true };
  },

  // ACTUALIZAR NOTA

  'PUT /api/notas': async req => {
    const urlObj = new URL(req.url, 'http://localhost');
    const id = urlObj.searchParams.get('id');
    const { texto } = await leerCuerpo(req);

    if (!id || !texto) {
      throw new ErrorUsuario(
        'Falta el ID de la nota o el texto.'
      );
    }

    await actualizarNotaDB(id, texto);

    return {
      ok: true,
      mensaje: 'Nota actualizada'
    };
  },

  // PERFIL

  'GET /api/perfil': async req => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');

    if (!usuario_id) {
      return { estadisticas: {} };
    }

    return {
      estadisticas: await obtenerEstadisticasDB(
        usuario_id
      )
    };
  },

  // ETIQUETAS

  'PATCH /api/etiqueta': async req => {
    const {
      usuario_id,
      sentencia_id,
      etiqueta
    } = await leerCuerpo(req);

    if (!usuario_id || !sentencia_id) {
      throw new ErrorUsuario('Faltan datos');
    }

    await db.execute({
      sql: `UPDATE documentos
            SET etiqueta = ?
            WHERE usuario_id = ?
            AND sentencia_id = ?`,
      args: [
        etiqueta,
        usuario_id,
        sentencia_id
      ]
    });

    return { ok: true };
  },

  // HISTORIAL

  'GET /api/historial': async req => {
    const urlObj = new URL(req.url, 'http://localhost');
    const usuario_id = urlObj.searchParams.get('usuario_id');

    if (!usuario_id) {
      return { historial: [] };
    }

    return {
      historial: await obtenerHistorialDB(usuario_id)
    };
  },

  // CONSULTA PROGRESIVA: inicio y lectura del trabajo en memoria.
  'POST /api/oficial/iniciar': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) throw new ErrorUsuario('Demasiadas consultas.', 429);
    const { termino, descripcionCaso = '', desplazamiento = 0, cantidad = 10 } = await leerCuerpo(req);
    return iniciarTrabajoOficial(termino, Math.max(0, Math.min(500, Number(desplazamiento) || 0)), Math.max(1, Math.min(20, Number(cantidad) || 10)), String(descripcionCaso).slice(0,6000));
  },
  'GET /api/oficial/progreso': async req => {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const trabajo = trabajosOficiales.get(String(id));
    if (!trabajo || Date.now() - trabajo.creado > VIDA_TRABAJO) throw new ErrorUsuario('Consulta expirada.', 404);
    return trabajo;
  },

  // BUSCAR JURISPRUDENCIA OFICIAL

  'POST /api/oficial/buscar': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) {
      throw new ErrorUsuario(
        'Demasiadas consultas. Espera unos minutos.',
        429
      );
    }

    const { termino, desplazamiento, cantidad } = await leerCuerpo(req);

    return ejecutarBusquedaOficial(termino, desplazamiento, cantidad);
  },

  // DESCARGAR Y VERIFICAR PROVIDENCIAS OFICIALES

  'POST /api/oficial/descargar': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) {
      throw new ErrorUsuario(
        'Demasiadas consultas.',
        429
      );
    }

    const { termino, desplazamiento, cantidad } = await leerCuerpo(req);

    return ejecutarBusquedaOficial(termino, desplazamiento, cantidad);
  },

  // Solo nombres candidatos de una sentencia concreta, nunca páginas originales.
  'GET /api/oficial/candidatos-privacidad': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) throw new ErrorUsuario('Demasiadas solicitudes.', 429);
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const guardado = cacheOficial.get(String(id));
    if (!guardado || Date.now() - guardado.creado > DURACION_SESION || !guardado.documento.verificado) {
      throw new ErrorUsuario('La sentencia ya no está disponible; realiza otra búsqueda.', 404);
    }
    return { ok: true, id: String(id), providencia: guardado.documento.providencia,
      ...candidatosRevisionPrivacidad(guardado.documento) };
  },

  // REVISIÓN DE ANONIMIZACIÓN: solo se devuelven páginas anonimizadas.
  'POST /api/oficial/revisar-privacidad': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) throw new ErrorUsuario('Demasiadas solicitudes.', 429);
    const { id, nombres = [] } = await leerCuerpo(req);
    if (!Array.isArray(nombres) || nombres.length > 30 || nombres.some(n => typeof n !== 'string' || n.length > 100)) {
      throw new ErrorUsuario('Indica como máximo 30 nombres válidos.');
    }
    const guardado = cacheOficial.get(String(id));
    if (!guardado || Date.now() - guardado.creado > DURACION_SESION || !guardado.documento.verificado) {
      throw new ErrorUsuario('La sentencia ya no está disponible; realiza otra búsqueda.', 404);
    }
    try {
      const total = revisarAnonimizacionDocumento(guardado.documento, nombres.map(n => n.trim()).filter(Boolean));
      return { ok: true, aptoGemini: true, totalPaginas: total, mensaje: 'Anonimización actualizada. Revisa el texto antes de utilizar el análisis.' };
    } catch (error) {
      throw new ErrorUsuario('Todavía requiere revisión: ' + error.message, 409);
    }
  },

  // ANALIZAR CON GEMINI

  'POST /api/oficial/analizar': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) {
      throw new ErrorUsuario(
        'Demasiadas consultas.',
        429
      );
    }

    const { id, consulta } = await leerCuerpo(req);

    const guardado = cacheOficial.get(String(id));

    if (
      !guardado ||
      Date.now() - guardado.creado > 30 * 60 * 1000
    ) {
      throw new ErrorUsuario(
        'Documento no disponible. Realiza una nueva búsqueda oficial.',
        404
      );
    }

    if (!guardado.documento.aptoGemini) {
      throw new ErrorUsuario('Esta providencia requiere revisión de privacidad antes del análisis con Gemini.', 409);
    }
    return analizarDocumentoOficial(
      guardado.documento,
      String(consulta || '')
    );
  },

  // COMPARACIÓN DE VARIAS PROVIDENCIAS VERIFICADAS

  'POST /api/oficial/comparar': async req => {
    if (!permitido(req.socket.remoteAddress || 'local')) {
      throw new ErrorUsuario(
        'Demasiadas consultas.',
        429
      );
    }

    const { ids, consulta } = await leerCuerpo(req);

    if (
      !Array.isArray(ids) ||
      ids.length < 2 ||
      ids.length > 8 ||
      new Set(ids).size !== ids.length
    ) {
      throw new ErrorUsuario(
        'Selecciona entre 2 y 8 sentencias distintas.'
      );
    }

    const documentos = ids.map(id => {
      const entrada = cacheOficial.get(String(id));

      if (
        !entrada ||
        Date.now() - entrada.creado > 30 * 60 * 1000
      ) {
        throw new ErrorUsuario(
          'Una sentencia ya no está en memoria. Repite la búsqueda.',
          404
        );
      }

      if (!entrada.documento.aptoGemini) {
        throw new ErrorUsuario('Una de las providencias requiere revisión de privacidad.', 409);
      }
      return entrada.documento;
    });

    return compararDocumentosOficiales(
      documentos,
      String(consulta || '')
    );
  },

  // CONSULTAR SENTENCIA ANONIMIZADA

  'GET /api/oficial/texto': async req => {
    const id = new URL(
      req.url,
      'http://localhost'
    ).searchParams.get('id');

    const guardado = cacheOficial.get(String(id));

    if (
      !guardado ||
      Date.now() - guardado.creado > 30 * 60 * 1000
    ) {
      throw new ErrorUsuario(
        'Documento no disponible.',
        404
      );
    }

    const { paginas, pdfOriginal, paginasOriginalesPrivadas, ...meta } = guardado.documento;
    if (!guardado.documento.aptoGemini || !Array.isArray(paginas)) {
      throw new ErrorUsuario('Texto no disponible hasta completar la anonimización segura.', 409);
    }
    return {
      ...meta,
      paginas: paginas.map((texto, i) => ({
        pagina: i + 1,
        texto
      }))
    };
  },

  // ESTADO DEL SISTEMA

  'GET /api/estado': async () => ({
    fuente: 'Corte Suprema de Justicia · Rama Judicial',
    busqueda_oficial: true,
    clave_configurada: Boolean(process.env.GEMINI_API_KEY)
  }),

  // DESACTIVAR ANTIGUAS RUTAS DEL CORPUS

  'POST /api/analyze': async () => {
    throw new ErrorUsuario(
      'La búsqueda local está desactivada. Utiliza la búsqueda oficial.',
      410
    );
  },

  'GET /api/metricas': async () => {
    throw new ErrorUsuario(
      'Las métricas del corpus local están desactivadas.',
      410
    );
  },

  'POST /api/evaluar': async () => {
    throw new ErrorUsuario(
      'La evaluación del corpus local está desactivada.',
      410
    );
  },

  'POST /api/etica': async () => {
    throw new ErrorUsuario(
      'Las pruebas del corpus local están desactivadas.',
      410
    );
  }

};

// ======================================================
// SERVIDOR PRINCIPAL
// ======================================================

http.createServer(async (req, res) => {
  const ruta = (req.url || '/').split('?')[0];

  try {
    const manejador = rutas[`${req.method} ${ruta}`];

    if (manejador) {
      return enviar(
        res,
        200,
        await manejador(req)
      );
    }

    // Bloquear acceso al corpus anterior.

    if (
      req.method === 'GET' &&
      /^\/api\/documento\/[\w.-]+$/.test(ruta)
    ) {
      throw new ErrorUsuario(
        'Consulta local desactivada. Utiliza la fuente oficial.',
        410
      );
    }

    // LOGIN

    if (
      req.method === 'GET' &&
      ruta === '/login'
    ) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });

      return res.end(
        fs.readFileSync(
          path.join(RAIZ, 'public', 'login.html')
        )
      );
    }

    // LIBRERÍA DE EXPORTACIÓN WORD

    if (
      req.method === 'GET' &&
      ruta === '/html-docx.min.js'
    ) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript'
      });

      return res.end(
        fs.readFileSync(
          path.join(
            RAIZ,
            'public',
            'html-docx.min.js'
          )
        )
      );
    }

    // PÁGINA PRINCIPAL

    if (
      req.method === 'GET' &&
      (
        ruta === '/' ||
        ruta === '/index.html'
      )
    ) {
      const cookies = req.headers.cookie || '';

      if (!cookies.includes('usuario_id=')) {
        res.writeHead(302, {
          Location: '/login'
        });

        return res.end();
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });

      return res.end(
        fs.readFileSync(
          path.join(
            RAIZ,
            'public',
            'index.html'
          )
        )
      );
    }

    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end('No encontrado');

  } catch (error) {
    if (error instanceof ErrorUsuario) {
      return enviar(
        res,
        error.status,
        { error: error.message }
      );
    }

    console.error(error);

    enviar(res, 500, {
      error: error.message || 'Error interno.'
    });
  }

}).listen(PUERTO, '0.0.0.0', async () => {
  console.log('');
  console.log('  Jurisprudencia Penal · MVP');
  console.log(
    `  Abre en tu navegador: http://127.0.0.1:${PUERTO}`
  );
  console.log(
    '  Fuente principal: Corte Suprema de Justicia · consulta oficial en vivo'
  );

  if (process.env.GEMINI_API_KEY) {
    try {
      const modelos = await modelosTexto();

      console.log(
        `  Modelo de IA: ${modelos[0]}${
          modelos.length > 1
            ? ' (respaldo automático: ' +
              modelos.slice(1).join(', ') + ')'
            : ''
        }`
      );
    } catch (error) {
      console.error('  ' + error.message);
    }
  }

  console.log(
    '  Para detener el servidor: Ctrl + C'
  );
  console.log('');
});