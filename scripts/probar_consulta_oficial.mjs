import assert from 'node:assert/strict';
import { interpretarFilas } from '../lib/consulta_oficial.mjs';
const fila = `Sala de Casación Penal\nID: 988480\nNÚMERO DE PROCESO: 74627\nNÚMERO DE PROVIDENCIA: AHP147-2026\nCLASE DE ACTUACIÓN: HÁBEAS CORPUS\nTIPO DE PROVIDENCIA: AUTO INTERLOCUTORIO\nFECHA: 15/10/2026\nPONENTE: MAGISTRADO DE PRUEBA\nTEMA: DOCUMENTO DISPONIBLE`;
const resultado = interpretarFilas(['', fila, fila]);
assert.equal(resultado.length, 1);
assert.equal(resultado[0].providencia, 'AHP147-2026');
assert.equal(resultado[0].radicado, '74627');
assert.equal(resultado[0].urlDocumento, null);
console.log('Extracción y deduplicación de metadatos: OK');
