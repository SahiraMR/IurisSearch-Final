
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const URL =
  'https://consultajurisprudencial.ramajudicial.gov.co/WebRelatoria/csj/index.xhtml';

const termino = process.argv[2] || 'hurto';
const ID_PROVIDENCIA = '988480';

const carpeta = path.resolve('diagnostico-oficial');

await fs.mkdir(carpeta, { recursive: true });

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  acceptDownloads: true,
  locale: 'es-CO',
  viewport: {
    width: 1440,
    height: 900
  }
});

const page = await context.newPage();
const eventos = [];
const descargas = [];
const ventanas = [];
const respuestasDocumento = [];

function registrar(tipo, dato) {
  if (eventos.length < 100) {
    eventos.push({
      tipo,
      dato: String(dato).slice(0, 500)
    });
  }
}

context.on('page', ventana => {
  if (ventana !== page) {
    ventanas.push(ventana);
    registrar('VENTANA_NUEVA', ventana.url());
  }
});

page.on('download', descarga => {
  descargas.push(descarga);
  registrar('DESCARGA', descarga.suggestedFilename());
});

page.on('pageerror', error => {
  registrar('ERROR_PAGINA', error.message);
});

page.on('response', respuesta => {
  const headers = respuesta.headers();

  const tipo = headers['content-type'] || '';
  const disposicion =
    headers['content-disposition'] || '';

  if (
    /pdf|octet-stream|msword|officedocument|attachment/i.test(
      tipo + ' ' + disposicion
    )
  ) {
    const informacion = {
      estado: respuesta.status(),
      url: respuesta.url().split('?')[0],
      tipo,
      disposicion
    };

    respuestasDocumento.push(informacion);

    registrar(
      'RESPUESTA_DOCUMENTO',
      JSON.stringify(informacion)
    );
  }
});

async function guardarEvidencias(nombre) {
  await page.screenshot({
    path: path.join(carpeta, `${nombre}.png`),
    fullPage: true
  }).catch(() => {});

  await fs.writeFile(
    path.join(carpeta, `${nombre}.html`),
    await page.content(),
    'utf8'
  ).catch(() => {});
}

async function obtenerFilas() {
  return page.evaluate(() => {
    const tabla = document.getElementById(
      'resultForm:jurisTable'
    );

    if (!tabla) return [];

    return [...tabla.querySelectorAll('tbody tr[data-rk]')]
      .map(fila => ({
        id: fila.getAttribute('data-rk'),
        texto: (fila.innerText || '').trim()
      }))
      .filter(fila => fila.id && fila.texto);
  });
}

async function esperarResultados() {
  await page.waitForFunction(
    () => {
      const tabla = document.getElementById(
        'resultForm:jurisTable'
      );

      return Boolean(
        tabla?.querySelector('tbody tr[data-rk]')
      );
    },
    null,
    {
      timeout: 45000
    }
  );
}

try {
  console.log('Abriendo portal oficial...');

  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  const campo = page.locator(
    '[id="searchForm:fulltxtInput"]'
  );

  const seccion = page.locator(
    '[id="searchForm:set-fulltxt"]'
  );

  if (!(await campo.isVisible())) {
    console.log('Abriendo búsqueda por texto completo...');

    await seccion.locator('legend').click();

    await campo.waitFor({
      state: 'visible',
      timeout: 15000
    });
  }

  const radio = page.locator(
    '[id="searchForm:options1:0"]'
  );

  if (
    await radio.count() &&
    !(await radio.isChecked())
  ) {
    const etiqueta = page.locator(
      'label[for="searchForm:options1:0"]'
    );

    if (await etiqueta.isVisible()) {
      await etiqueta.click();
    }
  }

  const penal = page.locator(
    '[id="searchForm:spenal:2"]'
  );

  if (
    await penal.count() &&
    !(await penal.isChecked())
  ) {
    console.log('Seleccionando Sala de Casación Penal...');

    await page.locator(
      '[id="searchForm:spenal"] .ui-selectcheckboxmenu-trigger'
    ).click();

    await page.locator(
      '[id="searchForm:spenal_panel"] label'
    ).filter({
      hasText: /^Sala de Casación Penal$/
    }).click({
      timeout: 15000
    });
  }

  console.log(`Buscando: ${termino}`);

  await campo.fill(termino);

  await page.locator(
    '[id="searchForm:searchButton"]'
  ).click();

  console.log('Esperando resultados oficiales...');

  await esperarResultados();

  await page.waitForTimeout(1200);

  const filas = await obtenerFilas();

  console.log('\nPROVIDENCIAS ENCONTRADAS:');

  console.log(JSON.stringify(
    filas.map(fila => ({
      id: fila.id,
      texto: fila.texto.slice(0, 450)
    })),
    null,
    2
  ));

  const filaOficial = page.locator(
    `[id="resultForm:jurisTable"] tr[data-rk="${ID_PROVIDENCIA}"]`
  );

  if (!(await filaOficial.count())) {
    throw new Error(
      `No apareció la providencia con ID ${ID_PROVIDENCIA}.`
    );
  }

  console.log('\nSeleccionando providencia...');

  await filaOficial.locator(
    '.ui-chkbox-box'
  ).click({
    timeout: 15000
  });

  await page.waitForTimeout(1000);

  const seleccion = await filaOficial.evaluate(fila => ({
    id: fila.getAttribute('data-rk'),
    seleccionada: fila.getAttribute('aria-selected'),
    checkbox: fila.querySelector(
      'input[type="checkbox"]'
    )?.checked ?? null
  }));

  console.log('\nESTADO DE SELECCIÓN:');
  console.log(JSON.stringify(seleccion, null, 2));

  if (
    seleccion.seleccionada !== 'true' &&
    seleccion.checkbox !== true
  ) {
    throw new Error(
      'La providencia no quedó seleccionada.'
    );
  }

  console.log('\nAbriendo menú de descarga...');

  const botonMenu = page.locator(
    '[id="resultForm:j_idt234_menuButton"]'
  );

  await botonMenu.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await botonMenu.click();

  const opcionPDF = page.locator(
    '[id="resultForm:j_idt237"]'
  );

  await opcionPDF.waitFor({
    state: 'visible',
    timeout: 15000
  });

  console.log('\nSolicitando PDF oficial...');

  const inicio = Date.now();

  await opcionPDF.click({
    timeout: 15000
  });

  // El portal puede generar una descarga mediante AJAX.
  // Esperamos hasta 15 segundos para observar el resultado.
  while (
    Date.now() - inicio < 15000 &&
    descargas.length === 0 &&
    ventanas.length === 0 &&
    respuestasDocumento.length === 0
  ) {
    await page.waitForTimeout(500);
  }

  await page.waitForTimeout(1500);

  let archivoDescargado = null;

  if (descargas.length > 0) {
    console.log('\nSe detectó una descarga.');

    const descarga = descargas[0];

    const nombreOriginal = descarga.suggestedFilename();

    const extension = path.extname(nombreOriginal)
      .toLowerCase();

    const nombreSeguro = extension === '.pdf'
      ? `providencia_${ID_PROVIDENCIA}.pdf`
      : `providencia_${ID_PROVIDENCIA}_descarga${extension || '.bin'}`;

    const destino = path.join(
      carpeta,
      nombreSeguro
    );

    await descarga.saveAs(destino);

    const contenido = await fs.readFile(destino);
    const esPDF = contenido.subarray(0, 5)
      .toString('ascii') === '%PDF-';

    archivoDescargado = {
      ruta: destino,
      nombreOriginal,
      bytes: contenido.length,
      esPDF
    };

    console.log('\nARCHIVO DESCARGADO:');
    console.log(JSON.stringify(
      archivoDescargado,
      null,
      2
    ));

    if (!esPDF) {
      console.log(
        'ADVERTENCIA: El archivo no tiene la firma de un PDF.'
      );
    }

  } else if (ventanas.length > 0) {
    console.log('\nSe abrió una ventana nueva.');

    for (const ventana of ventanas) {
      await ventana.waitForLoadState(
        'domcontentloaded',
        { timeout: 10000 }
      ).catch(() => {});

      console.log('URL:', ventana.url());
    }

  } else if (respuestasDocumento.length > 0) {
    console.log(
      '\nEl servidor respondió con contenido de documento.'
    );

    console.log(JSON.stringify(
      respuestasDocumento,
      null,
      2
    ));

    console.log(
      'Todavía no se guardó un archivo. Debemos revisar cómo entrega el contenido el portal.'
    );

  } else {
    console.log(
      '\nNo se detectó descarga, ventana nueva ni respuesta de documento.'
    );
  }

  const resultado = {
    termino,
    providencia: ID_PROVIDENCIA,
    filasEncontradas: filas.length,
    seleccion,
    archivoDescargado,
    ventanas: ventanas.map(v => v.url()),
    respuestasDocumento,
    eventos
  };

  await fs.writeFile(
    path.join(
      carpeta,
      'resultado-descarga-real.json'
    ),
    JSON.stringify(resultado, null, 2),
    'utf8'
  );

  await guardarEvidencias('despues-descarga');

  console.log('\n===== RESULTADO FINAL =====');

  console.log(JSON.stringify(
    resultado,
    null,
    2
  ));

  console.log('\nArchivos guardados en:');
  console.log(carpeta);

  console.log('\nPrueba terminada.');

} catch (error) {
  console.error('\nERROR:', error.message);

  await guardarEvidencias('error-descarga');

  process.exitCode = 1;

} finally {
  await browser.close();
}
