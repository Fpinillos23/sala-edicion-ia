"""Retoque fotográfico natural para las imágenes que Sonny pone sobre el video.

Sigue las reglas de la skill de retoque: se trabaja sobre una COPIA, los ajustes de luz van sobre la luminosidad,
la máscara de sombras/luces se calcula en baja resolución, no hay desenfoque sobre la piel ni deformaciones,
y no se regenera la imagen. Es un revelado sobrio: exposición, balance de color, sombras/luces, algo de contraste,
vibrance (que protege la piel) y nitidez suave. Los valores salen de medir la foto, y se quedan en la parte baja.
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

LADO_MAX = 2200  # las imágenes van en un recuadro sobre el video: no hace falta más resolución


def _cargar(ruta):
    im = ImageOps.exif_transpose(Image.open(ruta)).convert("RGB")
    if max(im.size) > LADO_MAX:
        im.thumbnail((LADO_MAX, LADO_MAX), Image.LANCZOS)
    return np.asarray(im, np.float32) / 255.0


def _revelar(rgb, exposicion=0.0, temperatura=0.0, tinte=0.0):
    lin = np.power(rgb, 2.2)
    lin *= np.array([1 + temperatura, 1 - tinte, 1 - temperatura], np.float32) * 2.0 ** exposicion
    return np.power(np.clip(lin, 0, 1), 1 / 2.2)


def _tono(rgb, sombras=0.0, luces=0.0, contraste=0.0, vibrance=0.0, nitidez=0.0):
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    L = lab[..., 0] / 100.0
    h, w = L.shape
    f = 400 / max(h, w)
    Lb = cv2.resize(cv2.GaussianBlur(cv2.resize(L, None, fx=f, fy=f, interpolation=cv2.INTER_AREA), (0, 0), 10), (w, h))
    L = L + sombras * (1 - Lb) ** 3 * (1 - L) * L * 4 - luces * Lb ** 3 * L * (1 - L) * 4
    if contraste:
        L = L + contraste * (L - 0.5) * (1 - np.abs(2 * L - 1))
    if nitidez:
        L = L + nitidez * (L - cv2.GaussianBlur(L, (0, 0), 1.2))
    if vibrance:
        croma = np.hypot(lab[..., 1], lab[..., 2]) / 80.0
        lab[..., 1:] *= (1 + vibrance * np.clip(1 - croma, 0, 1))[..., None]
    lab[..., 0] = np.clip(L, 0, 1) * 100
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), 0, 1)


def diagnosticar(rgb):
    """Mide la foto en vez de suponer: luminosidad media, recortes y dominante de color en los medios tonos."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    L = lab[..., 0] / 100.0
    medios = (L > 0.25) & (L < 0.8)
    a = float(lab[..., 1][medios].mean()) if medios.any() else 0.0
    b = float(lab[..., 2][medios].mean()) if medios.any() else 0.0
    media = float(L.mean())
    oscuros = float((L < 0.12).mean())
    claros = float((L > 0.94).mean())
    ajustes = {
        # exposición: solo si la foto está claramente oscura o clara (±0.1 a ±0.4 EV)
        "exposicion": float(np.clip((0.50 - media) * 1.2, -0.3, 0.4)) if abs(media - 0.50) > 0.08 else 0.0,
        # balance: corrige solo una parte de la dominante, para no matar la luz cálida o fría del lugar
        "temperatura": float(np.clip(-b / 300.0, -0.05, 0.05)) if abs(b) > 6 else 0.0,
        "tinte": float(np.clip(-a / 300.0, -0.04, 0.04)) if abs(a) > 5 else 0.0,
        "sombras": 0.22 if oscuros > 0.08 else 0.1,
        "luces": 0.18 if claros > 0.04 else 0.06,
        "contraste": 0.06,
        "vibrance": 0.10,
        "nitidez": 0.15,
    }
    return {"luminosidad_media": round(media, 3), "dominante_a": round(a, 2), "dominante_b": round(b, 2),
            "sombras_empastadas": round(oscuros, 3), "luces_quemadas": round(claros, 3)}, ajustes


def mejorar(origen, destino):
    """Devuelve la ruta de la copia retocada (PNG sin pérdida) y los ajustes aplicados."""
    rgb = _cargar(origen)
    medidas, a = diagnosticar(rgb)
    out = _revelar(rgb, a["exposicion"], a["temperatura"], a["tinte"])
    out = _tono(out, a["sombras"], a["luces"], a["contraste"], a["vibrance"], a["nitidez"])
    destino = Path(destino).with_suffix(".png")
    Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)).save(destino)
    return destino, medidas, a
