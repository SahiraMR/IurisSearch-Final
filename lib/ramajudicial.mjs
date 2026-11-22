// Explorador de búsqueda oficial. No inventa sentencias ni recurre al corpus.
export const PORTAL_CSJ = 'https://consultajurisprudencial.ramajudicial.gov.co/WebRelatoria/csj/index.xhtml';

export async function probarBusquedaOficial(termino, { visible = false } = {}) {
  if (typeof termino !== 'string' || !termino.trim() || termino.length > 120) {
    throw new Error('Indica un término de búsqueda de 1 a 120 caracteres.');
  }
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('Falta Playwright. Ejecuta: npm install && npx playwright install chromium'); }
  const browser = await chromium.launch({ headless: !visible });
  try {
    const page = await browser.newPage({ acceptDownloads: false, locale: 'es-CO' });
    await page.goto(PORTAL_CSJ, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Diagnóstico: el portal JSF puede usar componentes dinámicos y campos ocultos.
    const campos = await page.locator('input:not([type=hidden]), textarea, select').evaluateAll(els =>
      els.map(el => ({ tag: el.tagName, type: el.type || '', id: el.id, name: el.name,
        placeholder: el.getAttribute('placeholder') || '', label: el.labels?.[0]?.innerText?.trim() || '' })));
    const botones = await page.locator('button, input[type=submit], a[role=button]').evaluateAll(els =>
      els.map(el => ({ text: (el.innerText || el.value || '').trim().slice(0, 90), id: el.id })).filter(x => x.text));
    const candidatos = campos.filter(c => /texto completo|palabra|t[eé]rmino|buscar|consulta|tema|delito/i.test(
      [c.id, c.name, c.placeholder, c.label].join(' ')) && !/date|fecha/i.test([c.id,c.name].join(' ')));
    if (!candidatos.length) return { estado: 'requiere_configuracion', portal: PORTAL_CSJ,
      mensaje: 'Se abrió el portal, pero no se identificó con seguridad el campo de consulta. No se ha ejecutado una búsqueda.', campos, botones };
    // No enviar el formulario a ciegas: evita resultados inventados y consultas erróneas.
    return { estado: 'campo_identificado', portal: PORTAL_CSJ,
      mensaje: 'Se identificaron campos posibles. Falta verificar el botón y la estructura de resultados antes de automatizar la búsqueda.',
      candidatos, botones, campos };
  } finally { await browser.close(); }
}


// Segunda prueba: interacción real con los componentes PrimeFaces del portal.
export async function diagnosticarConsultaOficial(termino, { visible = false } = {}) {
  if (typeof termino !== 'string' || !termino.trim() || termino.length > 120) {
    throw new Error('Indica un término de 1 a 120 caracteres.');
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !visible });
  try {
    const page = await browser.newPage({ locale: 'es-CO', acceptDownloads: false });
    await page.goto(PORTAL_CSJ, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // El diagnóstico confirmó que el fieldset «Buscar en:» comienza plegado.
    const seccion = page.locator('[id="searchForm:set-fulltxt"]');
    if (await seccion.count() !== 1) {
      return { estado: 'estructura_cambiada', mensaje: 'No se encontró la sección Buscar en:' };
    }
    const campo = page.locator('[id="searchForm:fulltxtInput"]');
    if (!(await campo.isVisible())) {
      await seccion.locator('legend').click({ timeout: 12000 });
      await campo.waitFor({ state: 'visible', timeout: 12000 });
    }

    // Texto completo ya estaba seleccionado en el diagnóstico previo.
    // Si cambia el valor predeterminado, pulsar el componente visual.
    const radio = page.locator('[id="searchForm:options1:0"]');
    if (!(await radio.isChecked())) {
      await page.locator('label[for="searchForm:options1:0"]').click({ timeout: 10000 });
    }
    if (!(await radio.isChecked())) throw new Error('No se activó Texto completo.');

    // El filtro Penal es un menú desplegable (ui-selectcheckboxmenu),
    // no un checkbox visible. Abrir el menú y usar su etiqueta visual.
    const penal = page.locator('[id="searchForm:spenal:2"]');
    let filtroPenal = 'no_aplicado';
    if (await penal.count() === 1) {
      if (!(await penal.isChecked())) {
        const menu = page.locator('[id="searchForm:spenal"]');
        await menu.locator('.ui-selectcheckboxmenu-trigger').click({ timeout: 10000 });
        // PrimeFaces crea el panel flotante fuera del formulario.
        const panel = page.locator('[id="searchForm:spenal_panel"]');
        const opcion = panel.locator('label').filter({ hasText: /^Sala de Casación Penal$/ });
        if (await opcion.count() === 1 && await opcion.isVisible()) {
          await opcion.click({ timeout: 10000 });
        } else {
          // Diagnóstico honesto: no modificar el checkbox oculto.
          return { estado: 'filtro_penal_pendiente', mensaje: 'Se abrió Buscar en:, pero no se encontró la opción visible Sala de Casación Penal en el menú.',
            panelVisible: await panel.isVisible().catch(() => false),
            textoPanel: await panel.innerText().catch(() => '') };
        }
      }
      filtroPenal = (await penal.isChecked()) ? 'seleccionado' : 'no_confirmado';
      if (filtroPenal !== 'seleccionado') {
        return { estado: 'filtro_penal_pendiente', mensaje: 'El menú Penal no confirmó la selección.' };
      }
    }

    await campo.fill(termino);
    const boton = page.locator('[id="searchForm:searchButton"]');
    await boton.click({ timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const diagnostico = await page.evaluate(() => {
      const tabla = document.querySelector('[id="resultForm:jurisTable"]');
      const zona = tabla || document.querySelector('[id^="resultForm:"]');
      const filas = tabla ? [...tabla.querySelectorAll('tbody tr')].slice(0, 10) : [];
      const enlaces = zona ? [...zona.querySelectorAll('a[href]')].slice(0, 25).map(a => ({
        texto: (a.textContent || '').trim().slice(0, 150), href: a.getAttribute('href') || ''
      })) : [];
      const mensajes = [...document.querySelectorAll('[class*="message"], [class*="empty"], [class*="error"]')]
        .map(e => (e.textContent || '').trim().slice(0, 180)).filter(Boolean).slice(0, 12);
      return { titulo: document.title, tablaEncontrada: !!tabla, cantidadFilasVisibles: filas.length,
        filas: filas.map(f => (f.innerText || '').trim().slice(0, 700)), enlaces, mensajes,
        textoZonaResultados: (zona?.innerText || '').trim().slice(0, 1800) };
    });
    diagnostico.filas = [...new Set(diagnostico.filas.filter(Boolean))];
    diagnostico.cantidadFilasUnicas = diagnostico.filas.length;
    return { estado: 'consulta_enviada_pendiente_validacion', portal: PORTAL_CSJ,
      termino, filtroPenal, textoCompleto: await radio.isChecked(), ...diagnostico,
      aviso: 'Resultados de diagnóstico sin validar; no se incorporan todavía a Gemini.' };
  } finally {
    await browser.close();
  }
}
