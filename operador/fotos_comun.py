"""Utilidades de la Sala de Fotografía (Clay, Brock y Eric) en GitHub Actions.

IMPORTANTE: el repositorio y sus registros son públicos. Aquí nunca se imprime el contenido de una misión,
ni nombres de archivos, ni URLs, ni claves: solo mensajes genéricos y números.
"""
import base64
import io
import json
import os
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageCms, ImageOps

import comun

TELEGRAM_FOTOS = os.environ.get("TELEGRAM_TOKEN_FOTOS", "")
GEMINI = os.environ.get("GEMINI_API_KEY", "")
MODELO = os.environ.get("MODELO_GEMINI") or "gemini-3.8-flash"
EXT_RAW = {".dng", ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".raf", ".orf", ".rw2", ".pef", ".srw", ".x3f", ".3fr", ".iiq", ".rwl"}

try:  # fotos de iPhone (HEIC/HEIF)
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

_SRGB = ImageCms.createProfile("sRGB")


def detector(nombre):
    """Detector de rostros de OpenCV, o None si esta instalación no los trae (en ese caso se trabaja sin rostros)."""
    import cv2
    carpeta = getattr(getattr(cv2, "data", None), "haarcascades", "")
    c = cv2.CascadeClassifier(str(Path(carpeta) / nombre)) if carpeta else None
    if c is None or c.empty():
        print("   (Sin detector de rostros en esta instalación de OpenCV)")
        return None
    return c


# ───────────── Comunicación con el Apps Script ─────────────

def pedir_trabajo(mision_id):
    r = requests.get(comun.API, params={"accion": "trabajo_fotos", "id": mision_id, "k": comun.CLAVE}, timeout=60)
    r.raise_for_status()
    datos = r.json()
    if not datos.get("ok"):
        raise RuntimeError("El Apps Script no entregó la misión de fotografía (¿cambió o se canceló?).")
    return datos["trabajo"]


def reportar(mision_id, tipo, **datos):
    cuerpo = {"origen": "fotos", "k": comun.CLAVE, "mision_id": mision_id, "tipo": tipo, **datos}
    intentos = 6 if tipo in ("seleccion", "listo", "error") else 2
    for intento in range(intentos):
        try:
            r = requests.post(comun.API, data=json.dumps(cuerpo, ensure_ascii=False).encode("utf-8"),
                              headers={"Content-Type": "application/json"}, timeout=180)
            if r.status_code < 400 and r.json().get("ok"):
                return True
        except (requests.RequestException, ValueError):
            pass
        time.sleep(10 * (intento + 1))
    print(f"   (No se pudo reportar '{tipo}'; la misión sigue)")
    return False


def descargar_foto(mision_id, foto, carpeta):
    """Descarga un original. Si la carpeta compartida no alcanza, pide que se comparta esa foto sola y reintenta."""
    ext = Path(foto.get("nombre") or "").suffix.lower() or ".jpg"
    destino = Path(carpeta) / f"{int(foto['n']):03d}{ext}"
    try:
        return comun.descargar_drive(foto["id"], destino, intentos=2)
    except RuntimeError:
        try:
            requests.get(comun.API, params={"accion": "compartir_foto", "id": mision_id, "k": comun.CLAVE, "foto": foto["id"]}, timeout=60)
        except requests.RequestException:
            pass
        return comun.descargar_drive(foto["id"], destino, intentos=3)


def subir_a_drive(mision_id, ruta, nombre):
    """Pide al Apps Script una sesión de subida de un solo uso (a la carpeta "editadas" de la misión) y sube el archivo."""
    try:
        r = requests.get(comun.API, params={"accion": "subida_foto", "id": mision_id, "k": comun.CLAVE, "nombre": nombre}, timeout=60)
        url = r.json().get("url") if r.status_code == 200 else None
        if not url:
            return None
        with open(ruta, "rb") as f:
            s = requests.put(url, data=f, timeout=600, headers={"Content-Type": "image/jpeg", "Content-Length": str(Path(ruta).stat().st_size)})
        if s.status_code in (200, 201):
            return s.json().get("id")
    except (requests.RequestException, ValueError):
        pass
    print("   Drive no aceptó una foto editada.")
    return None


# ───────────── Telegram (bot de fotografía) ─────────────

def enviar_foto(chat_id, ruta, leyenda=""):
    if not TELEGRAM_FOTOS:
        return False
    with open(ruta, "rb") as f:
        r = requests.post(f"https://api.telegram.org/bot{TELEGRAM_FOTOS}/sendPhoto",
                          data={"chat_id": chat_id, "caption": leyenda[:1000], "parse_mode": "HTML"},
                          files={"photo": ("hoja.jpg", f, "image/jpeg")}, timeout=300)
    return r.status_code < 400


def enviar_album(chat_id, rutas_y_leyendas):
    """Envía vistas previas en álbumes de hasta 10 (Telegram las comprime: solo son para mirar)."""
    if not TELEGRAM_FOTOS or not rutas_y_leyendas:
        return False
    ok = True
    for i in range(0, len(rutas_y_leyendas), 10):
        grupo = rutas_y_leyendas[i:i + 10]
        if len(grupo) == 1:
            ok = enviar_foto(chat_id, grupo[0][0], grupo[0][1]) and ok
            continue
        archivos, medios = {}, []
        for k, (ruta, leyenda) in enumerate(grupo):
            archivos[f"f{k}"] = (f"f{k}.jpg", open(ruta, "rb"), "image/jpeg")
            medios.append({"type": "photo", "media": f"attach://f{k}", "caption": leyenda[:1000]})
        try:
            r = requests.post(f"https://api.telegram.org/bot{TELEGRAM_FOTOS}/sendMediaGroup",
                              data={"chat_id": chat_id, "media": json.dumps(medios)}, files=archivos, timeout=600)
            ok = ok and r.status_code < 400
        finally:
            for _, f, _ in archivos.values():
                f.close()
    return ok


# ───────────── Abrir cualquier foto ─────────────

def abrir(ruta, lado_max=0):
    """Abre JPG/PNG/HEIC/WEBP/TIFF/RAW, endereza según EXIF, pasa a sRGB y devuelve (PIL RGB, datos EXIF útiles)."""
    ruta = Path(ruta)
    info = {}
    if ruta.suffix.lower() in EXT_RAW:
        import rawpy
        with rawpy.imread(str(ruta)) as raw:
            rgb = raw.postprocess(use_camera_wb=True, no_auto_bright=False, output_bps=8, output_color=rawpy.ColorSpace.sRGB)
        im = Image.fromarray(rgb)
    else:
        im = Image.open(ruta)
        try:
            exif = im.getexif()
            sub = exif.get_ifd(0x8769)
            info = {"fecha": sub.get(0x9003) or exif.get(0x0132), "camara": " ".join(str(x) for x in (exif.get(0x010F), exif.get(0x0110)) if x)}
        except Exception:  # noqa: BLE001
            info = {}
        icc = im.info.get("icc_profile")
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "RGBA", "L"):
            im = im.convert("RGB")
        if icc:
            try:  # perfiles de color de cámaras y teléfonos (Display P3, Adobe RGB) → sRGB, para que el color no cambie
                im = ImageCms.profileToProfile(im.convert("RGB"), ImageCms.ImageCmsProfile(io.BytesIO(icc)), _SRGB, outputMode="RGB")
            except Exception:  # noqa: BLE001
                pass
        im = im.convert("RGB")
    if lado_max and max(im.size) > lado_max:
        im.thumbnail((lado_max, lado_max), Image.LANCZOS)
    return im, info


def a_float(im):
    return np.asarray(im, np.float32) / 255.0


def a_jpeg_bytes(im, lado=1024, calidad=82):
    copia = im.copy()
    copia.thumbnail((lado, lado), Image.LANCZOS)
    b = io.BytesIO()
    copia.save(b, "JPEG", quality=calidad)
    return b.getvalue()


# ───────────── Gemini (visión) ─────────────

def gemini_json(prompt, imagenes, esquema=None, temperatura=0.2):
    """Pide a Gemini un JSON mirando varias imágenes (bytes JPEG). Devuelve None si no hay clave o no responde."""
    if not GEMINI:
        return None
    partes = []
    for x in imagenes:  # cada imagen puede llevar un rótulo antes ("Foto 12"), para que Gemini sepa de cuál habla
        rotulo, datos = x if isinstance(x, tuple) else (None, x)
        if rotulo:
            partes.append({"text": rotulo})
        partes.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(datos).decode()}})
    config = {"responseMimeType": "application/json", "temperature": temperatura}
    if esquema:
        config["responseJsonSchema"] = esquema
    cuerpo = {"contents": [{"role": "user", "parts": partes + [{"text": prompt}]}], "generationConfig": config}
    for m in list(dict.fromkeys([MODELO, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"])):
        for intento in range(3):
            try:
                r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent",
                                  headers={"x-goog-api-key": GEMINI}, json=cuerpo, timeout=(30, 180))
            except requests.RequestException:
                time.sleep(5)
                continue
            if r.status_code == 200:
                try:
                    texto = "".join(p.get("text", "") for p in r.json()["candidates"][0]["content"]["parts"])
                    return json.loads(texto)
                except (ValueError, KeyError, IndexError):
                    break
            if r.status_code == 400 and "responseJsonSchema" in config:
                config.pop("responseJsonSchema")  # el modelo no acepta esquema: se pide sin él
                continue
            if r.status_code == 404:
                break
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(15 * (intento + 1))  # topes del plan gratuito: se espera y se reintenta
                continue
            break
    return None
