import { anonimizar } from '../lib/texto.mjs';
import assert from 'node:assert/strict';
const ejemplos = [
  ['La víctima MARÍA FERNANDA LÓPEZ declaró.', 'MARÍA FERNANDA LÓPEZ'],
  ['El acusado Juan Carlos Pérez fue escuchado.', 'Juan Carlos Pérez'],
  ['La víctima juan carlos pérez declaró.', 'juan carlos pérez'],
  ['C.C. 1.023.456.789 y correo juan@example.com', '1.023.456.789'],
  ['Conocido como «El Mono», teléfono 3001234567.', '3001234567'],
];
for (const [entrada, secreto] of ejemplos) {
  const salida = anonimizar(entrada);
  assert.ok(!salida.texto.toLowerCase().includes(secreto.toLowerCase()), `Dato expuesto: ${secreto}`);
  console.log('ENTRADA:', entrada, '\nSALIDA:  ', salida.texto, '\n');
}
const tecnico = anonimizar('La Corte Suprema de Justicia resolvió el recurso de casación.');
assert.match(tecnico.texto, /Corte Suprema de Justicia/);
console.log('Pruebas básicas completadas. No equivalen a una garantía de anonimización total.');
