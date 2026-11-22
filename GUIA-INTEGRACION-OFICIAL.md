# Integración oficial (versión experimental)

1. En esta carpeta ejecuta `npm install` y `npx playwright install chromium`.
2. Conserva tu `.env` original en la raíz del proyecto (no viene incluido en el ZIP).
3. Ejecuta `npm start`, inicia sesión y abre **Buscar y analizar jurisprudencia oficial en vivo**.
4. Busca `hurto`. Se intentarán descargar y verificar hasta tres PDF de la primera página.
5. Pulsa **Ver texto anonimizado** o **Analizar con Gemini y citas**.

## Límites importantes
- La búsqueda en vivo es una sección independiente de la búsqueda local existente. La búsqueda principal aún usa el corpus local; no se mezclan silenciosamente resultados.
- La extracción requiere PDFs con texto digital (sin OCR). No se guardan PDFs descargados en Turso; se conservan temporalmente en memoria durante 30 minutos.
- La anonimización es parcial, no exhaustiva. No debe publicarse ni enviarse información personal sensible sin revisión. El PDF oficial conserva el original.
- Las citas incluyen página y fragmento extraído, pero su relación con las afirmaciones generadas por Gemini no está validada automáticamente de forma semántica.
- La descarga depende de identificadores JSF/PrimeFaces que pueden cambiar. El sitio puede tener errores o tiempos de espera.
- No se ha ejecutado una prueba integral real con el portal, Gemini y Turso en este entorno.
