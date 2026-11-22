# IurisSearch: una sola carpeta para probar y corregir

Esta entrega es la base única de pruebas. **No reemplaces la carpeta ni descargues otro ZIP para cada error.** Los cambios se aplican a los archivos de esta misma carpeta.

## Preparación en Windows PowerShell

1. Extrae el ZIP y abre `Asistente-Jurisprudencia-main` en VS Code.
2. Copia tu `.env` local en la raíz del proyecto; **no lo compartas ni lo incluyas en un ZIP**.
3. Ejecuta:

```powershell
npm install
npx playwright install chromium
npm run probar:anonimizacion
npm run probar:pdf
npm start
```

4. Abre http://localhost:3000. La búsqueda oficial es la opción principal; el corpus local se muestra como demostración independiente.
5. Prueba `hurto` desde la sección oficial. Si hay una sentencia descargada, usa «Ver texto anonimizado» y luego «Analizar con Gemini y citas».

## Si aparece un error

No vuelvas a extraer el ZIP. Copia el error completo de la terminal y el mensaje de la interfaz. Si se corrige un archivo, reemplaza **solo ese archivo** y reinicia `npm start` (Ctrl+C, `npm start`).

## Límites y protección de datos

- Los documentos que no superan la verificación o la anonimización conservadora se omiten y muestran un aviso; nunca se presentan como resultados verificados.
- No se garantiza anonimización exhaustiva de todas las formas de datos personales. Los documentos con datos sensibles dudosos requieren revisión humana **antes de enviarlos a Gemini o mostrarlos públicamente**.
- Las citas se anclan a fragmentos y páginas reales; se añade un filtro de coincidencia textual, pero eso no demuestra por sí solo la pertinencia jurídica. Revisar cada afirmación.
- El portal externo puede cambiar sus controles, exigir validaciones o bloquear automatizaciones. Se prueban hasta 3 páginas y hasta 5 PDF por consulta.
- No se ha podido ejecutar en este entorno el flujo completo con tus servicios Gemini/Turso ni una consulta en vivo de punta a punta.
