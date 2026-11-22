# IurisSearch - búsqueda oficial integrada

1. Extrae este ZIP en una carpeta NUEVA, no encima de una instalación anterior.
2. Abre `Asistente-Jurisprudencia-main` en VS Code; verifica `dir package.json`.
3. Copia tu `.env` local a esa carpeta (no lo compartas).
4. Ejecuta `npm install`, `npx playwright install chromium` y `npm start`.
5. En `http://localhost:3000`, abre **Buscar y analizar jurisprudencia oficial en vivo**, busca `hurto` y pulsa **Consultar portal**.
6. Los resultados deben indicar documentos descargados y verificados. Si no hay resultados, revisa los avisos o errores que muestra la página.

**Limitaciones:** no se verificó de extremo a extremo la conexión a servicios externos desde este entorno. La anonimización es parcial y exige revisión humana. Las citas de Gemini apuntan a fragmentos reales, pero su pertinencia no está comprobada automáticamente. El análisis principal de casos todavía usa el corpus local; la búsqueda oficial está en una sección independiente.
