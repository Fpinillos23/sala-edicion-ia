"""Mesa de revelado de Brock: estilos sobrios, recortes que respetan rostros, logo y protección de identidad.

Todo trabaja sobre la foto real (ajustes de píxel). No se agrega, quita ni mueve nada de la escena.
"""
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import fotos_comun as fc
import retoque

_FRONTAL = fc.detector("haarcascade_frontalface_default.xml")
_PERFIL = fc.detector("haarcascade_profileface.xml")
_CANDADO = threading.Lock()
LOGO = Path(__file__).resolve().parent.parent / "marca" / "logo.png"
RAZONES = {"4:5": 4 / 5, "1:1": 1.0, "16:9": 16 / 9, "9:16": 9 / 16, "3:2": 3 / 2}


def _mezclar_gris(rgb, cuanto):
    """Baja la saturación una fracción (0 = igual, 1 = gris), sobre la luminosidad Lab."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    lab[..., 1:] *= (1 - cuanto)
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), 0, 1)


def _virado(rgb, sombras_ab, luces_ab, fuerza):
    """Virado partido: tiñe un poco las sombras y las luces (en Lab), sin tocar la luminosidad."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    L = lab[..., 0:1] / 100.0
    ws, wl = (1 - L) ** 2, L ** 2
    lab[..., 1:] += fuerza * (ws * np.array(sombras_ab, np.float32) + wl * np.array(luces_ab, np.float32))
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), 0, 1)


def aplicar_estilo(rgb, estilo, intensidad="suave"):
    k = 1.5 if intensidad == "media" else 1.0
    if estilo == "calido":
        return retoque._revelar(rgb, 0, 0.035 * k, 0)
    if estilo == "frio":
        return retoque._revelar(rgb, 0, -0.035 * k, 0)
    if estilo == "contraste":
        return retoque._tono(rgb, contraste=0.14 * k)
    if estilo == "vivo":
        return retoque._tono(rgb, vibrance=0.18 * k, contraste=0.04 * k)
    if estilo == "editorial":
        return _mezclar_gris(retoque._tono(rgb, sombras=0.05, contraste=0.08 * k), 0.08 * k)
    if estilo == "blanco_negro":
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
        L = lab[..., 0] / 100.0
        gris = np.repeat(L[..., None], 3, axis=2).astype(np.float32)
        return retoque._tono(np.clip(gris, 0, 1), contraste=0.10 * k)
    if estilo == "cine":
        base = _mezclar_gris(retoque._tono(rgb, contraste=0.06 * k), 0.06)
        return _virado(base, (-3.0, -5.0), (3.0, 6.0), 0.8 * k)
    if estilo == "mate":
        x = _mezclar_gris(rgb, 0.06 * k)
        return np.clip(0.055 * k + x * (1 - 0.085 * k), 0, 1)
    return rgb  # natural


def rostros(rgb_uint8):
    """Cajas de rostros (x, y, w, h) en coordenadas de la foto, buscadas en una copia reducida."""
    h, w = rgb_uint8.shape[:2]
    f = min(1.0, 1400 / max(h, w))
    g = cv2.cvtColor(cv2.resize(rgb_uint8, None, fx=f, fy=f, interpolation=cv2.INTER_AREA) if f < 1 else rgb_uint8, cv2.COLOR_RGB2GRAY)
    with _CANDADO:
        return _rostros(g, f)


def _rostros(g, f):
    lado = max(24, int(min(g.shape) / 28))
    cajas = list(_FRONTAL.detectMultiScale(g, 1.12, 6, minSize=(lado, lado))) if _FRONTAL else []
    if _PERFIL:
        cajas += list(_PERFIL.detectMultiScale(g, 1.12, 7, minSize=(lado, lado)))
        cajas += [(g.shape[1] - x - cw, y, cw, ch) for (x, y, cw, ch) in _PERFIL.detectMultiScale(cv2.flip(g, 1), 1.12, 7, minSize=(lado, lado))]
    salida = []
    for (x, y, cw, ch) in cajas:
        c = (int(x / f), int(y / f), int(cw / f), int(ch / f))
        if not any(_solapa(c, o) > 0.4 for o in salida):
            salida.append(c)
    return salida


def _solapa(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix, iy = max(0, min(ax + aw, bx + bw) - max(ax, bx)), max(0, min(ay + ah, by + bh) - max(ay, by))
    return ix * iy / float(min(aw * ah, bw * bh) or 1)


def _interes(rgb_uint8):
    """Centro de interés cuando no hay rostros: centroide de los bordes (donde está el detalle)."""
    h, w = rgb_uint8.shape[:2]
    f = 256 / max(h, w)
    g = cv2.cvtColor(cv2.resize(rgb_uint8, None, fx=f, fy=f, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32)
    e = cv2.GaussianBlur(np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)), (0, 0), 8)
    total = e.sum() or 1.0
    ys, xs = np.indices(e.shape)
    cx, cy = (e * xs).sum() / total / f, (e * ys).sum() / total / f
    # Se acerca al centro: el centroide solo orienta, no manda
    return 0.5 * cx + 0.5 * w / 2, 0.5 * cy + 0.5 * h / 2


def recorte(shape, razon, caras, rgb_uint8):
    """Caja (x0, y0, x1, y1) del recorte más grande con esa proporción, ubicada para no cortar rostros.
    Devuelve también si quedó algún rostro cortado (para que Eric lo reporte)."""
    h, w = shape[:2]
    if razon is None:
        return (0, 0, w, h), False
    if w / h > razon:
        cw, ch = int(round(h * razon)), h
    else:
        cw, ch = w, int(round(w / razon))
    # El encuadre se ancla en los rostros PRINCIPALES (tamaño comparable al mayor): así una detección falsa
    # pequeña o una persona lejana no arrastran el recorte. (Para difuminar se usan todos.)
    principales = [c for c in caras if c[2] >= 0.45 * max(x[2] for x in caras)] if caras else []
    if principales:
        alto_cara = max(c[3] for c in principales)
        x0 = min(c[0] for c in principales); x1 = max(c[0] + c[2] for c in principales)
        y0 = min(c[1] for c in principales) - 0.6 * alto_cara      # aire sobre la cabeza (pelo, frente)
        cy_cara = (min(c[1] for c in principales) + max(c[1] + c[3] for c in principales)) / 2
        cx = (x0 + x1) / 2
        top = min(cy_cara - ch / 3, y0)                              # rostros en el tercio superior, sin cortar la cabeza
    else:
        cx, cy = _interes(rgb_uint8)
        top = cy - ch / 2
    left = int(np.clip(cx - cw / 2, 0, w - cw))
    top = int(np.clip(top, 0, h - ch))
    caja = (left, top, left + cw, top + ch)
    cortado = any(_fuera(c, caja) > 0.15 for c in principales)
    return caja, cortado


def _fuera(c, caja):
    x, y, cw, ch = c
    ix = max(0, min(x + cw, caja[2]) - max(x, caja[0]))
    iy = max(0, min(y + ch, caja[3]) - max(y, caja[1]))
    dentro = ix * iy / float(cw * ch or 1)
    return 0.0 if dentro == 0 else 1 - dentro  # rostros totalmente fuera no cuentan (no aparecen)


def difuminar(im, caras):
    """Protección de identidad: mosaico grueso + desenfoque sobre cada rostro (no se puede revertir)."""
    a = np.asarray(im).copy()
    h, w = a.shape[:2]
    for (x, y, cw, ch) in caras:
        m = int(0.25 * max(cw, ch))
        x0, y0, x1, y1 = max(0, x - m), max(0, y - m), min(w, x + cw + m), min(h, y + ch + m)
        zona = a[y0:y1, x0:x1]
        if zona.size == 0:
            continue
        b = max(6, (x1 - x0) // 9)
        peq = cv2.resize(zona, (max(1, (x1 - x0) // b), max(1, (y1 - y0) // b)), interpolation=cv2.INTER_AREA)
        zona = cv2.resize(peq, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
        a[y0:y1, x0:x1] = cv2.GaussianBlur(zona, (0, 0), b / 2)
    return Image.fromarray(a)


def poner_logo(im):
    if not LOGO.exists():
        return im, False
    logo = Image.open(LOGO).convert("RGBA")
    ancho = max(80, int(im.width * 0.12))
    logo = logo.resize((ancho, max(1, int(logo.height * ancho / logo.width))), Image.LANCZOS)
    alfa = logo.getchannel("A").point(lambda v: int(v * 0.9))
    logo.putalpha(alfa)
    margen = int(min(im.size) * 0.03)
    base = im.convert("RGBA")
    base.alpha_composite(logo, (im.width - logo.width - margen, im.height - logo.height - margen))
    return base.convert("RGB"), True
