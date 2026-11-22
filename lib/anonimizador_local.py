"""Detector LOCAL de nombres para segunda pasada de IurisSearch.
Entrada JSON por stdin: {"paginas": [str, ...]}; salida: {"ok":bool,"nombres":[...]}
No envía datos a servicios externos ni escribe texto original en disco.
"""
import json
import re
import sys

MAX_PAGINAS = 150
MAX_CARACTERES = 1_500_000


def ejecutar():
    entrada = json.load(sys.stdin)
    paginas = entrada.get('paginas')
    if not isinstance(paginas, list) or not paginas or len(paginas) > MAX_PAGINAS:
        raise ValueError('Número de páginas inválido')
    if any(not isinstance(p, str) for p in paginas) or sum(map(len, paginas)) > MAX_CARACTERES:
        raise ValueError('Texto inválido o demasiado grande')

    # spaCy: modelo español descargado e instalado localmente.
    import spacy
    nlp = spacy.load('es_core_news_sm', disable=['parser', 'tagger', 'lemmatizer'])
    nombres = set()
    for pagina in paginas:
        # El límite por bloque reduce memoria y evita textos enormes por llamada.
        for inicio in range(0, len(pagina), 60000):
            doc = nlp(pagina[inicio:inicio + 60000])
            for entidad in doc.ents:
                if entidad.label_ not in ('PER', 'PERSON'):
                    continue
                nombre = re.sub(r'\s+', ' ', entidad.text).strip(' ,.;:()[]')
                palabras = nombre.split()
                if 2 <= len(palabras) <= 6 and 5 <= len(nombre) <= 100 and all(re.search(r'[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]', w) for w in palabras):
                    nombres.add(nombre)

    # Presidio se usa como segundo detector cuando está instalado.
    # Se limita a PERSON: números, emails y teléfonos ya tienen controles propios
    # en el anonimizado principal de IurisSearch.
    try:
        from presidio_analyzer import AnalyzerEngine, PatternRecognizer
        from presidio_analyzer.nlp_engine import NlpEngineProvider
        config = {'nlp_engine_name': 'spacy', 'models': [{'lang_code': 'es', 'model_name': 'es_core_news_sm'}]}
        engine = NlpEngineProvider(nlp_configuration=config).create_engine()
        analyzer = AnalyzerEngine(nlp_engine=engine, supported_languages=['es'])
        for pagina in paginas:
            for inicio in range(0, len(pagina), 60000):
                bloque = pagina[inicio:inicio + 60000]
                for r in analyzer.analyze(text=bloque, language='es', entities=['PERSON'], score_threshold=0.55):
                    nombre = re.sub(r'\s+', ' ', bloque[r.start:r.end]).strip(' ,.;:()[]')
                    if 2 <= len(nombre.split()) <= 6 and 5 <= len(nombre) <= 100:
                        nombres.add(nombre)
    except (ImportError, ValueError, RuntimeError):
        pass  # spaCy sigue siendo obligatorio; Presidio es detector complementario.

    print(json.dumps({'ok': True, 'nombres': sorted(nombres, key=len, reverse=True)[:300]}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        ejecutar()
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': type(exc).__name__}))
        sys.exit(1)