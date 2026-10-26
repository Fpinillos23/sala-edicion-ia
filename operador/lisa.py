"""LISA DAVIS — Inteligencia. Descarga el video y lo transcribe con Whisper (Groq)."""
import os
import sys
import tempfile
from pathlib import Path

from groq import Groq

import comun
from transcriptor import transcribir, duracion


def main(mision_id):
    trabajo = comun.pedir_trabajo(mision_id)
    comun.reportar(mision_id, "progreso", agente="lisa", texto="Descargando el material")
    carpeta = Path(tempfile.mkdtemp(prefix="lisa_"))
    video = comun.descargar_drive(trabajo["video_id"], carpeta / "video")

    comun.reportar(mision_id, "progreso", agente="lisa", texto="Escuchando y transcribiendo")
    cliente = Groq(api_key=os.environ["GROQ_API_KEY"])
    modelo = os.environ.get("MODELO_TRANSCRIPCION") or "whisper-large-v3-turbo"
    segmentos = transcribir(cliente, video, carpeta, modelo)
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
