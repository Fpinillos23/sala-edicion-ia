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
    """Varios clips: transcribe los hablados y mide la duración de todos (también los apoyos)."""
    clips = trabajo.get("clips") or []
    segmentos, duraciones, fallidos = {}, {}, []
    for i, c in enumerate(clips, 1):
        hablado = c.get("tipo") in ("entrada", "entrevista", "salida", "off", "sin_etiqueta")
        for intento in range(2):  # si un clip falla, se reintenta una vez completo antes de seguir con los demás
            try:
                comun.reportar(mision_id, "progreso", agente="lisa", texto=f"Clip {i} de {len(clips)}: descargando")
                carpeta = Path(tempfile.mkdtemp(prefix=f"lisa_{i}_"))
                ruta = comun.descargar_drive(c["id"], carpeta / "clip")
                duraciones[str(i)] = round(duracion(ruta), 2)
                if hablado:
                    comun.reportar(mision_id, "progreso", agente="lisa", texto=f"Clip {i} de {len(clips)}: transcribiendo")
                    segmentos[str(i)] = _transcribir(ruta, carpeta)
                break
            except Exception as e:  # noqa: BLE001
                print(f"   Clip {i}: falló ({type(e).__name__}).")
                if intento == 1:
                    fallidos.append(i)
                    segmentos.setdefault(str(i), [])
    if fallidos and len(fallidos) == len([c for c in clips if c.get("tipo") != "apoyo"]):
        raise RuntimeError(f"No pude transcribir ningún clip con voz (clips {', '.join(map(str, fallidos))}). Reintenta en unos minutos.")
    print(f"   Nota transcrita: {len(clips)} clips, {len(fallidos)} con problemas.")
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
