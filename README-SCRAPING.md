# Prueba inicial de automatización de la Rama Judicial

Esta versión **no realiza todavía búsquedas automáticas completas**. Incluye un explorador Playwright que abre el portal oficial e identifica campos y botones. El objetivo es descubrir los selectores reales antes de programar el envío y la extracción.

## Ejecutar en Windows / terminal

```bash
npm install
npx playwright install chromium
npm run probar:oficial
```

La salida JSON mostrará `estado`, `campos`, `botones` y `candidatos`. Si el portal no abre, mostrará un error; no simula resultados. Envíame la salida (sin datos personales) para completar los selectores de búsqueda y extracción de providencias.

**Pendiente:** automatizar envío del formulario, paginación, recuperación y verificación de documentos, integración con `/api/analyze`, pruebas en Render y revisión de las condiciones del portal. Las 43 sentencias siguen siendo la fuente del análisis actual hasta completar y validar esas etapas.

En `public/index.html` se corrigió el enlace de consulta oficial.
