# IurisSearch — entrega ampliada (21 de noviembre de 2026)

## Implementado y comprobado localmente
- Conserva diseño, guardado y exportación de la versión anterior (no se hicieron pruebas con Turso).
- Consulta oficial desde la interfaz: endpoint `POST /api/oficial/buscar`, basado en Playwright y el formulario real.
- Extrae metadatos de filas oficiales y elimina duplicados; **no inventa enlaces**.
- Los resultados oficiales se muestran como preliminares, separados de las sentencias del corpus.
- Corrige los ejemplos probados de anonimización sin borrar verbos.
- Agrega extracto anonimizado del corpus en las tarjetas para inspección; **no es trazabilidad de afirmaciones individuales**.
- Pruebas locales: `npm run probar:anonimizacion` y `npm run probar:metadatos`.

## Pendientes: no afirmar funcionalidad completa
- Extraer enlaces directos y descargar texto de cada providencia oficial. El portal puede cambiar, bloquear o tardar.
- Integrar el texto oficial verificado al análisis de Gemini y comprobar relevancia real de la búsqueda.
- Anonimización exhaustiva: el detector actual es heurístico, no garantiza ocultar todos los datos personales. Revisar antes de publicar o enviar documentos sensibles.
- Trazabilidad por afirmación: los extractos del corpus no demuestran que cada conclusión de Gemini esté sustentada.
- Verificar análisis jurídico completo, permisos de sesiones, Turso, Gemini, exportación y carga de archivos extremo a extremo.

## Instalación y pruebas (PowerShell)
Desde `Asistente-Jurisprudencia-main`:
```
npm install
npx playwright install chromium
npm run probar:anonimizacion
npm run probar:metadatos
npm run probar:oficial
npm start
```
Coloca tu `.env` anterior en la carpeta del proyecto; nunca lo compartas. La prueba oficial y la consulta en vivo requieren conexión al portal. El proyecto no incluye credenciales ni `node_modules`.
