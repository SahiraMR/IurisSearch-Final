import { diagnosticarConsultaOficial, PORTAL_CSJ } from './ramajudicial.mjs';

// No confundir resultados de la tabla con sentencias verificadas o con documentos descargados.
export function interpretarFilas(filas = []) {
  const encontrados = new Map();
  for (const fila of filas) {
    const valor = etiqueta => fila.match(new RegExp(`(?:^|\\n)${etiqueta}\\s*:\\s*([^\\n]+)`, 'i'))?.[1]?.trim() || '';
    const id = valor('ID');
    const providencia = valor('NÚMERO DE PROVIDENCIA');
    if (!id || !providencia) continue;
    const item = {
      id, providencia, radicado: valor('NÚMERO DE PROCESO'),
      fecha: valor('FECHA'), ponente: valor('PONENTE'),
      actuacion: valor('CLASE DE ACTUACIÓN'), tipo: valor('TIPO DE PROVIDENCIA'),
      tema: valor('TEMA'), origen: 'Consulta de Jurisprudencia de la Corte Suprema',
      urlDocumento: null, verificadoContenido: false
    };
    encontrados.set(`${id}:${providencia}`, item);
  }
  return [...encontrados.values()];
}
export async function consultarProvidenciasOficiales(termino) {
  const diagnostico = await diagnosticarConsultaOficial(termino);
  const resultados = interpretarFilas(diagnostico.filas || []);
  return {
    estado: diagnostico.estado, termino, portal: PORTAL_CSJ,
    resultados, totalExtraido: resultados.length,
    aviso: 'Resultados preliminares del portal oficial. No se verificó que el documento contenga el término buscado ni se descargó su texto. No se envían a Gemini.',
    advertencias: diagnostico.mensajes || []
  };
}
