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
