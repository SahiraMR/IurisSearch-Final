# IurisSearch — entrega consolidada de pruebas

## Inicio en Windows (PowerShell)

```powershell
cd .\Asistente-Jurisprudencia-main
npm install
npx playwright install chromium
npm run probar:pdf
npm start
```

Abrir http://localhost:3000. Colocar el archivo `.env` propio en la raíz del proyecto; **no se distribuye en este ZIP**. No compartir claves de Gemini ni Turso.

## Funciones incluidas

- Corpus local, interfaz, historial y exportación existentes.
- Sección independiente de búsqueda oficial en vivo, con descarga automática PDF, validación de número de providencia/radicado, extracción de texto por página y análisis con Gemini bajo petición.
- Prueba offline con providencia AHP147-2026 y bloqueo de análisis si falla la detección del nombre del accionante.
- Citas por fragmento/página como ayuda a la revisión humana, **no** validación semántica automática de cada afirmación.

## Limitaciones verificables

- No se ha probado extremo a extremo con credenciales reales de Gemini y Turso en esta entrega.
- La anonimización es automática **parcial** y puede no identificar a todas las personas; para documentos oficiales se bloquea el análisis si no se identifica el accionante en el encabezado, pero eso no garantiza anonimización exhaustiva.
- La consulta oficial continúa separada de la búsqueda local principal.
- La automatización depende de los identificadores actuales del portal PrimeFaces; pueden cambiar.
- El análisis con Gemini puede contener errores. Verificar siempre cada fragmento con el PDF oficial.
