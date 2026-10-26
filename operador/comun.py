"""Utilidades compartidas por los operadores que corren en GitHub Actions.

IMPORTANTE: este repositorio es público y sus registros (logs) también.
Aquí nunca se imprime el contenido de una misión, ni URLs, ni claves: solo mensajes genéricos.
"""
import json
import os
import subprocess
import time
from pathlib import Path

import requests

API = os.environ.get("SALA_API", "")          # URL /exec del Apps Script (secreto)
CLAVE = os.environ.get("SALA_CLAVE", "")      # clave compartida con el Apps Script (secreto)
TELEGRAM = os.environ.get("TELEGRAM_TOKEN", "")
LIMITE_TELEGRAM = 48 * 1024 * 1024           # los bots envían videos de hasta 50 MB


def pedir_trabajo(mision_id):
    r = requests.get(API, params={"accion": "trabajo", "id": mision_id, "k": CLAVE}, timeout=60)
    r.raise_for_status()
    datos = r.json()
    if not datos.get("ok"):
        raise RuntimeError("El Apps Script no entregó la misión (¿cambió o se canceló?).")
    return datos["trabajo"]


def reportar(mision_id, tipo, **datos):
    """Avisa al Apps Script (y por él, a Telegram y a la sala virtual). Nunca detiene la misión si falla."""
    cuerpo = {"origen": "operador", "k": CLAVE, "mision_id": mision_id, "tipo": tipo, **datos}
    intentos = 6 if tipo in ("transcripcion", "listo", "error") else 2
    for intento in range(intentos):
        try:
            r = requests.post(API, data=json.dumps(cuerpo, ensure_ascii=False).encode("utf-8"),
                              headers={"Content-Type": "application/json"}, timeout=180)
            if r.status_code < 400 and r.json().get("ok"):
                return True
        except (requests.RequestException, ValueError):
            pass
        time.sleep(10 * (intento + 1))
    print(f"   (No se pudo reportar '{tipo}' al Apps Script; la misión sigue)")
    return False


def descargar_drive(file_id, destino):
    """Descarga un archivo de Drive compartido temporalmente por enlace."""
    destino = Path(destino)
    url = "https://drive.usercontent.google.com/download"
    with requests.get(url, params={"id": file_id, "export": "download", "confirm": "t"},
                      stream=True, timeout=600) as r:
        tipo = r.headers.get("Content-Type", "")
        if r.status_code == 200 and "text/html" not in tipo:
            with open(destino, "wb") as f:
                for trozo in r.iter_content(1024 * 1024):
                    f.write(trozo)
            if destino.stat().st_size > 0:
                return destino
    # Respaldo: gdown resuelve los avisos de "archivo grande" de Drive
    subprocess.run(["gdown", "--quiet", "--id", file_id, "-O", str(destino)], check=False)
    if not destino.exists() or destino.stat().st_size == 0:
        raise RuntimeError("No pude descargar el video de Drive. ¿Está compartido por enlace?")
    return destino


def ajustar_peso(ruta, duracion):
    """Si el reel pasa el límite de Telegram, lo recomprime con la tasa justa para que quepa."""
    ruta = Path(ruta)
    if ruta.stat().st_size <= LIMITE_TELEGRAM or duracion <= 0:
        return ruta
    kbps = int((LIMITE_TELEGRAM * 8 / 1000) / duracion * 0.92) - 160
    salida = ruta.with_name(ruta.stem + "_liviano.mp4")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(ruta),
                    "-c:v", "libx264", "-preset", "veryfast", "-b:v", f"{max(kbps, 400)}k",
                    "-maxrate", f"{max(kbps, 400)}k", "-bufsize", f"{max(kbps, 400) * 2}k",
                    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(salida)], check=True)
    return salida


def enviar_video(chat_id, ruta, leyenda, ancho, alto, duracion):
    with open(ruta, "rb") as f:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM}/sendVideo",
            data={"chat_id": chat_id, "caption": leyenda[:1000], "parse_mode": "HTML",
                  "supports_streaming": "true", "width": ancho, "height": alto, "duration": int(duracion)},
            files={"video": (Path(ruta).name, f, "video/mp4")}, timeout=600)
    if r.status_code >= 400:
        raise RuntimeError(f"Telegram no aceptó el video (código {r.status_code}).")
    return r.json().get("result", {}).get("message_id")


def subir_maestra(url_sesion, ruta):
    """Sube el reel original a Drive usando la sesión de un solo uso que preparó el Apps Script.
    Devuelve el id del archivo en Drive, o None si falla (sin imprimir la dirección de la sesión)."""
    ruta = Path(ruta)
    try:
        with open(ruta, "rb") as f:
            r = requests.put(url_sesion, data=f, timeout=1800, headers={
                "Content-Type": "video/mp4", "Content-Length": str(ruta.stat().st_size)})
        if r.status_code in (200, 201):
            return r.json().get("id")
        print(f"   Drive no aceptó la copia maestra (código {r.status_code}).")
    except (requests.RequestException, ValueError):
        print("   No se pudo subir la copia maestra a Drive.")
    return None
