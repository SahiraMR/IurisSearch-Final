# Prueba de anonimización

Ejecuta `npm install`, `npm run probar:anonimizacion` y `npm run probar:oficial`. Para abrir la web, `npm start`.

La API `/api/documento/:id` ahora devuelve el texto transformado, no el original. El original se consulta exclusivamente en el portal oficial mediante su enlace.

**Limitación importante:** las reglas no detectan todos los nombres, apodos, cédulas ni variantes. Requiere revisión humana antes de exponer sentencias con datos sensibles. Los nombres sin contexto de rol pueden quedar visibles; no se debe afirmar anonimización completa. La consulta oficial por Playwright sigue en fase de prueba.
