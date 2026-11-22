import { diagnosticarConsultaOficial } from '../lib/ramajudicial.mjs';
const termino = process.argv.slice(2).join(' ') || 'hurto';
try {
  const resultado = await diagnosticarConsultaOficial(termino);
  console.log(JSON.stringify(resultado, null, 2));
  if (resultado.estado !== 'consulta_enviada_pendiente_validacion') process.exitCode = 2;
} catch (error) {
  console.error('Prueba no completada:', error.message);
  process.exitCode = 1;
}
