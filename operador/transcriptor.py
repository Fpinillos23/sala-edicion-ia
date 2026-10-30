"""Transcriptor: extrae el audio del video y lo transcribe con Whisper (Groq, gratis)."""
import json
import os
import subprocess
from pathlib import Path

LIMITE_MB = 19  # Groq gratis acepta archivos de hasta ~25 MB; dejamos margen


def _ffmpeg(args, cwd=None):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + args
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("FFmpeg falló:\n" + r.stderr[-1500:])


def duracion(ruta):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(ruta)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def _a_dict(resp):
    for metodo in ("model_dump", "to_dict", "dict"):
        if hasattr(resp, metodo):
            try:
                return getattr(resp, metodo)()
            except Exception:
                pass
    return dict(resp) if isinstance(resp, dict) else {"text": getattr(resp, "text", ""), "segments": getattr(resp, "segments", [])}


def transcribir(cliente, video, carpeta_trabajo, modelo, idioma="es"):
    """Devuelve una lista de segmentos [{inicio, fin, texto}] con tiempos en segundos."""
    carpeta_trabajo = Path(carpeta_trabajo)
    cache = carpeta_trabajo / "transcripcion.json"
    if cache.exists():
        print("   (Usando la transcripción ya guardada de este video)")
        return json.loads(cache.read_text(encoding="utf-8"))

    audio = carpeta_trabajo / "audio.mp3"
    print("   Extrayendo audio...")
    _ffmpeg(["-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(audio)])

    # Si el audio es muy pesado, se divide en trozos de 10 minutos
    piezas = [audio]
    if audio.stat().st_size > LIMITE_MB * 1024 * 1024:
        print("   El audio es largo; lo divido en partes de 10 minutos...")
        _ffmpeg(["-i", "audio.mp3", "-f", "segment", "-segment_time", "600", "-c", "copy", "parte_%03d.mp3"],
                cwd=str(carpeta_trabajo))
        piezas = sorted(carpeta_trabajo.glob("parte_*.mp3"))

    segmentos, desfase = [], 0.0
    for i, pieza in enumerate(piezas, 1):
        print(f"   Transcribiendo parte {i} de {len(piezas)}...")
        with open(pieza, "rb") as f:
            resp = cliente.audio.transcriptions.create(
                file=(pieza.name, f.read()),
                model=modelo,
                response_format="verbose_json",
                language=idioma,
                temperature=0.0,
            )
        datos = _a_dict(resp)
        for s in datos.get("segments") or []:
            s = s if isinstance(s, dict) else _a_dict(s)
            texto = (s.get("text") or "").strip()
            if texto:
                segmentos.append({
                    "inicio": round(float(s["start"]) + desfase, 2),
                    "fin": round(float(s["end"]) + desfase, 2),
                    "texto": texto,
                })
        desfase += duracion(pieza)

    for p in piezas:
        if p != audio:
            os.remove(p)
    cache.write_text(json.dumps(segmentos, ensure_ascii=False, indent=1), encoding="utf-8")
    return segmentos


def como_texto(segmentos):
    """Formato que lee el Guionista: [inicio-fin] texto"""
    return "\n".join(f"[{s['inicio']:.1f}-{s['fin']:.1f}] {s['texto']}" for s in segmentos)


# ───────────── Alternativa gratuita: Gemini (cuando no hay clave de Groq) ─────────────

PROMPT_GEMINI = (
    "Transcribe este audio en español, palabra por palabra, sin resumir ni corregir el sentido. "
    "Divide la transcripción en frases cortas (de 3 a 12 segundos cada una). "
    "Devuelve SOLO un arreglo JSON con este formato: "
    '[{"inicio": "MM:SS", "fin": "MM:SS", "texto": "lo que se dice"}]. '
    "Los tiempos son relativos al inicio de este audio. Si un tramo no tiene voz, omítelo. "
    "No inventes palabras que no se escuchen."
)


def _a_segundos(t):
    try:
        partes = [float(x) for x in str(t).strip().split(":")]
    except ValueError:
        return None
    s = 0.0
    for p in partes:
        s = s * 60 + p
    return s


def _pedir_gemini(clave, modelo, audio_bytes):
    """Prueba el modelo preferido y, si está saturado, otros modelos gratuitos de Gemini."""
    import base64
    import time
    import requests
    cuerpo = {
        "contents": [{"role": "user", "parts": [
            {"inline_data": {"mime_type": "audio/mp3", "data": base64.b64encode(audio_bytes).decode()}},
            {"text": PROMPT_GEMINI},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.0},
    }
    modelos = list(dict.fromkeys([modelo, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]))
    ultimo = ""
    for m in modelos:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent"
        for intento in range(3):
            try:
                r = requests.post(url, headers={"x-goog-api-key": clave}, json=cuerpo, timeout=(30, 300))
            except requests.RequestException as e:  # conexión cortada o sin respuesta: se reintenta
                ultimo = f"{type(e).__name__} en {m}"
                print(f"   Se cortó la conexión con {m}; reintento en 20 segundos...")
                time.sleep(20)
                continue
            if r.status_code == 200:
                texto = r.json()["candidates"][0]["content"]["parts"][0]["text"]
                datos = json.loads(texto)
                return datos if isinstance(datos, list) else datos.get("segmentos", [])
            if r.status_code in (400, 401, 403):
                raise RuntimeError(f"Gemini rechazó la petición ({r.status_code}). Revisa GEMINI_API_KEY.")
            ultimo = f"{r.status_code} en {m}"
            if r.status_code == 404:
                break
            if r.status_code == 429 or r.status_code >= 500:
                print(f"   {m} está ocupado; reintento en 20 segundos...")
                time.sleep(20)
                continue
            raise RuntimeError(f"Gemini respondió {r.status_code} al transcribir.")
        print(f"   Paso a otro modelo de Gemini ({ultimo}).")
    raise RuntimeError(f"Gemini está saturado en este momento ({ultimo}). Reintenta en unos minutos.")


TROZO_GEMINI = 120  # segundos por petición: trozos cortos responden rápido y Google no corta la conexión


def transcribir_gemini(clave, video, carpeta_trabajo, modelo="gemini-3.8-flash"):
    """Transcribe con Gemini en trozos de 2 minutos. Las marcas de tiempo llegan al segundo."""
    carpeta_trabajo = Path(carpeta_trabajo)
    audio = carpeta_trabajo / "audio.mp3"
    print("   Extrayendo audio...")
    _ffmpeg(["-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(audio)])
    _ffmpeg(["-i", "audio.mp3", "-f", "segment", "-segment_time", str(TROZO_GEMINI), "-c", "copy", "parte_%03d.mp3"],
            cwd=str(carpeta_trabajo))
    piezas = sorted(carpeta_trabajo.glob("parte_*.mp3")) or [audio]

    segmentos, desfase = [], 0.0
    for i, pieza in enumerate(piezas, 1):
        print(f"   Transcribiendo parte {i} de {len(piezas)} con Gemini...")
        largo = duracion(pieza)
        for s in _pedir_gemini(clave, modelo, pieza.read_bytes()):
            ini, fin = _a_segundos(s.get("inicio")), _a_segundos(s.get("fin"))
            texto = str(s.get("texto") or "").strip()
            if ini is None or fin is None or not texto:
                continue
            if ini < 0 or ini >= largo - 0.2:
                continue  # tiempo fuera de este trozo de audio: se descarta, no se inventa
            fin = min(fin, largo)
            if fin <= ini:
                fin = min(ini + 2.0, largo)
            segmentos.append({"inicio": round(ini + desfase, 2), "fin": round(fin + desfase, 2), "texto": texto})
        desfase += largo
    segmentos.sort(key=lambda s: s["inicio"])
    return segmentos


# ───────────── Ver las tomas de apoyo (para que Jason elija con criterio visual) ─────────────

PROMPT_APOYO = (
    "Estas son tres imágenes tomadas al principio, a la mitad y al final de una toma de video de apoyo para una nota periodística "
    "de Valledupar (Colombia). Descríbela para un editor. Devuelve SOLO este JSON: "
    '{"descripcion": "qué se ve en una frase concreta: lugar, personas, objetos y acción, sin suponer nombres", '
    '"calidad": "buena | movida | oscura | desenfocada | sobreexpuesta", "plano": "general | medio | detalle", '
    '"usable": true}. "usable" es false solo si la toma está tan movida, oscura o borrosa que no sirve al aire.'
)


def describir_apoyo(clave, modelo, video, carpeta):
    """Tres fotogramas pequeños de la toma y su brillo medido; Gemini dice qué se ve y si la toma sirve."""
    import base64
    import requests
    carpeta = Path(carpeta)
    d = duracion(video)
    fotos, brillos = [], []
    for k, frac in enumerate((0.15, 0.5, 0.85)):
        foto = carpeta / f"cuadro_{k}.jpg"
        _ffmpeg(["-ss", f"{max(0.0, d * frac):.2f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "5", str(foto)])
        if foto.exists():
            fotos.append(foto.read_bytes())
        r = subprocess.run(["ffmpeg", "-hide_banner", "-ss", f"{max(0.0, d * frac):.2f}", "-i", str(video), "-frames:v", "1",
                            "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"],
                           capture_output=True, text=True)
        m = [float(x) for x in __import__("re").findall(r"YAVG=([\d.]+)", r.stderr)]
        if m:
            brillos.append(m[0])
    brillo = round(sum(brillos) / len(brillos)) if brillos else None
    salida = {"descripcion": "", "calidad": "oscura" if brillo is not None and brillo < 35 else "", "plano": "", "usable": True, "brillo": brillo}
    if not clave or not fotos:
        return salida
    partes = [{"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(f).decode()}} for f in fotos]
    cuerpo = {"contents": [{"role": "user", "parts": partes + [{"text": PROMPT_APOYO}]}],
              "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}}
    for m in list(dict.fromkeys([modelo, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"])):
        try:
            r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent",
                              headers={"x-goog-api-key": clave}, json=cuerpo, timeout=(30, 120))
            if r.status_code == 200:
                datos = json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
                salida.update({k: datos.get(k, salida[k]) for k in ("descripcion", "calidad", "plano", "usable")})
                salida["descripcion"] = str(salida["descripcion"])[:200]
                return salida
        except (requests.RequestException, ValueError, KeyError, IndexError):
            continue
    return salida
