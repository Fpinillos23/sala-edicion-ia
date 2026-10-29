"""LISA DAVIS — Inteligencia. Descarga el video y lo transcribe (Gemini, o Whisper en Groq si hay clave)."""
import os
import sys
import tempfile
from pathlib import Path

import comun
from transcriptor import transcribir, transcribir_gemini, duracion


def _transcribir(video, carpeta):
    if os.environ.get("GROQ_API_KEY"):
        from groq import Groq  # Whisper: marcas de tiempo más finas
        cliente = Groq(api_key=os.environ["GROQ_API_KEY"])
        modelo = os.environ.get("MODELO_TRANSCRIPCION") or "whisper-large-v3-turbo"
        return transcribir(cliente, video, carpeta, modelo)
    if os.environ.get("GEMINI_API_KEY"):
        modelo = os.environ.get("MODELO_GEMINI") or "gemini-3.8-flash"
        return transcribir_gemini(os.environ["GEMINI_API_KEY"], video, carpeta, modelo)
    raise RuntimeError("Falta GEMINI_API_KEY (o GROQ_API_KEY) en los secretos de GitHub.")


def nota(mision_id, trabajo):
    """Varios clips: transcribe los hablados (3 a la vez) y mide la duración de todos (también los apoyos)."""
    from concurrent.futures import ThreadPoolExecutor
    clips = trabajo.get("clips") or []
    total = len(clips)

    def uno(par):
        i, c = par
        hablado = c.get("tipo") in ("entrada", "entrevista", "salida", "off", "sin_etiqueta")
        for intento in range(2):  # si un clip falla, se reintenta una vez completo
            try:
                carpeta = Path(tempfile.mkdtemp(prefix=f"lisa_{i}_"))
                ruta = comun.descargar_drive(c["id"], carpeta / "clip")
                dur = round(duracion(ruta), 2)
                if not hablado:
                    return i, dur, None, True
                comun.reportar(mision_id, "progreso", agente="lisa", texto=f"Clip {i} de {total}: transcribiendo")
                segs = _transcribir(ruta, carpeta)
                comun.reportar(mision_id, "progreso", agente="lisa", texto=f"Clip {i} de {total}: listo ({len(segs)} frases)")
                return i, dur, segs, True
            except Exception as e:  # noqa: BLE001
                print(f"   Clip {i}: falló ({type(e).__name__}), intento {intento + 1}.")
        return i, 0.0, [] if hablado else None, False

    with ThreadPoolExecutor(max_workers=3) as ex:
        resultados = list(ex.map(uno, list(enumerate(clips, 1))))
    segmentos, duraciones, fallidos = {}, {}, []
    for i, dur, segs, ok in resultados:
        duraciones[str(i)] = dur
        if segs is not None:
            segmentos[str(i)] = segs
        if not ok:
            fallidos.append(i)
    hablados = [i for i, c in enumerate(clips, 1) if c.get("tipo") != "apoyo"]
    if hablados and all(i in fallidos for i in hablados):
        raise RuntimeError(f"No pude transcribir ningún clip con voz (clips {', '.join(map(str, fallidos))}). Reintenta en unos minutos.")
    print(f"   Nota transcrita: {total} clips, {len(fallidos)} con problemas.")
    comun.reportar(mision_id, "transcripcion", agente="lisa", segmentos_por_clip=segmentos, duraciones=duraciones,
                   segmentos=[s for v in segmentos.values() for s in v], duracion=sum(duraciones.values()), fallidos=fallidos)


def main(mision_id):
    trabajo = comun.pedir_trabajo(mision_id)
    if trabajo.get("modo") == "nota":
        return nota(mision_id, trabajo)
    comun.reportar(mision_id, "progreso", agente="lisa", texto="Descargando el material")
    carpeta = Path(tempfile.mkdtemp(prefix="lisa_"))
    video = comun.descargar_drive(trabajo["video_id"], carpeta / "video")

    comun.reportar(mision_id, "progreso", agente="lisa", texto="Escuchando y transcribiendo")
    segmentos = _transcribir(video, carpeta)
    total = duracion(video)
    print(f"   Transcripción lista: {len(segmentos)} frases.")
    comun.reportar(mision_id, "transcripcion", agente="lisa", segmentos=segmentos, duracion=total)


if __name__ == "__main__":
    mid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MISION_ID", "")
    try:
        main(mid)
    except Exception as e:
        print("   Lisa no pudo completar la transcripción.")
        comun.reportar(mid, "error", agente="lisa", texto=str(e)[:400])
        sys.exit(1)
