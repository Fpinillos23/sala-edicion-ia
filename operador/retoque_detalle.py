"""Edición detallada de Brock: retoque de alto nivel y estilos de autor, siempre sobre la foto real.

Referentes (cómo trabajan los grandes retocadores, llevado a código):
- Pratik Naik / Natalia Taffarel (retoque de alto nivel): primero limpiar, luego emparejar el TONO de la piel en la
  baja frecuencia sin tocar la textura (separación de frecuencias), luego esculpir la luz (dodge & burn) y al final el color.
- Skill «retoque fotográfico natural y de estudio» de Fabian: nada de desenfoque sobre la piel, poros y pecas intactos,
  escleróticas y dientes nunca en blanco puro, sin deformar ni regenerar el rostro.
- Rebeca Saray (fine art, SOLO cuando el mando lo pide): calibrado con sus antes/después — exposición más baja,
  color contenido salvo los rojos, luces frías, el rostro como foco de luz, viñeta, resplandor suave y neblina en el fondo;
  o su variante dorada (contraluz cálido y neblina). La textura de la piel se conserva.
- Joel Grimes (dramático): contraste local alto, color desaturado, fondo oscurecido.
- PhotoS: reducción de ruido NLM, recuperación de luces y claridad.
"""
import cv2
import numpy as np
from PIL import Image

import fotos_comun as fc

try:
    from photo_s import denoise as _ps_denoise, grade as _ps_grade
except ImportError:  # pragma: no cover
    _ps_denoise = _ps_grade = None

_OJOS = fc.detector("haarcascade_eye.xml")


# ───────────── utilidades ─────────────

def _lab(x):
    return cv2.cvtColor(np.clip(x, 0, 1).astype(np.float32), cv2.COLOR_RGB2LAB)


def _rgb(lab):
    return np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2RGB), 0, 1)


def _pil(x):
    return Image.fromarray((np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8))


def _float(im):
    return np.asarray(im.convert("RGB"), np.float32) / 255


def _caja_mascara(shape, cajas, escala=1.0, sigma=0.35):
    """Mancha gaussiana suave sobre cada rostro (x, y, w, h)."""
    h, w = shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    m = np.zeros((h, w), np.float32)
    for (x, y, cw, ch) in cajas:
        cx, cy = x + cw / 2, y + ch * 0.55
        rx, ry = cw * escala, ch * escala * 1.15
        m = np.maximum(m, np.exp(-(((xx - cx) / (rx * sigma * 2)) ** 2 + ((yy - cy) / (ry * sigma * 2)) ** 2)))
    return m


# ───────────── ruido (PhotoS) ─────────────

def ruido(rgb8):
    """Sigma del ruido (0-255) por el método de Immerkær: mide el grano en las zonas planas."""
    g = cv2.cvtColor(rgb8, cv2.COLOR_RGB2GRAY).astype(np.float32)
    if max(g.shape) > 1600:
        f = 1600 / max(g.shape)
        g = cv2.resize(g, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    k = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], np.float32)
    conv = np.abs(cv2.filter2D(g, -1, k))
    bordes = cv2.Canny(g.astype(np.uint8), 40, 120) > 0
    plano = conv[~cv2.dilate(bordes.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)]
    if plano.size < 100:
        return 0.0
    return float(np.sqrt(np.pi / 2) * plano.mean() / 6)


def reducir_ruido(im, modo="auto"):
    """Reducción de ruido NLM de PhotoS cuando la foto tiene grano visible (noche, ISO alto). Permitido en coberturas."""
    if modo == "no" or _ps_denoise is None:
        return im, 0.0
    s = ruido(np.asarray(im))
    if modo != "fuerte" and s < 2.6:
        return im, round(s, 1)
    fuerza = float(np.clip(s * 2.2, 4, 14)) * (1.3 if modo == "fuerte" else 1.0)
    try:
        return _ps_denoise.apply_denoise(im, strength=fuerza), round(s, 1)
    except Exception:  # noqa: BLE001
        return im, round(s, 1)


def recuperar_luces(rgb, cantidad=0.5):
    if _ps_grade is None:
        return rgb
    return _float(_ps_grade.apply_highlight_recovery(_pil(rgb), amount=cantidad))


# ───────────── piel, ojos y luz del rostro ─────────────

def mascara_piel(rgb, sujeto=None, caras=()):
    """Piel probable: rango de piel en YCrCb dentro del sujeto, sin labios (muy rojos) ni zonas muy oscuras."""
    u8 = (rgb * 255).astype(np.uint8)
    ycc = cv2.cvtColor(u8, cv2.COLOR_RGB2YCrCb).astype(np.float32)
    Y, Cr, Cb = ycc[..., 0], ycc[..., 1], ycc[..., 2]
    piel = ((Cr > 135) & (Cr < 172) & (Cb > 78) & (Cb < 128) & (Y > 50)).astype(np.float32)
    lab = _lab(rgb)
    piel[lab[..., 1] > 32] = 0  # labios y maquillaje rojo intenso
    if sujeto is not None:
        piel *= (sujeto > 0.5)
    lado = max(rgb.shape[:2])
    piel = cv2.morphologyEx(piel, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return cv2.GaussianBlur(piel, (0, 0), lado / 500)


def igualar_piel(rgb, piel, caras, fuerza=0.5):
    """Separación de frecuencias: empareja manchas y rojeces en la BAJA frecuencia; la alta (poros, pecas) queda intacta."""
    if piel.max() < 0.05:
        return rgb
    tam = np.median([c[2] for c in caras]) if len(caras) else max(rgb.shape[:2]) / 6
    s = max(1.5, tam / 45)
    lab = _lab(rgb)
    baja = cv2.GaussianBlur(lab, (0, 0), s)
    alta = lab - baja
    pareja = cv2.GaussianBlur(baja, (0, 0), s * 3.5)
    f = (piel * fuerza)[..., None] * np.array([0.55, 0.7, 0.7], np.float32)
    nueva_baja = baja + (pareja - baja) * f
    return _rgb(nueva_baja + alta)


def luz_rostro(rgb, caras, fuerza=0.5, sujeto=None):
    """Dodge & burn macro: más luz en el centro del rostro (en luminosidad, sin tocar el color).
    Si no se detecta el rostro (perfil, mano encima), la luz va a la zona de piel más grande del sujeto."""
    if len(caras):
        m = _caja_mascara(rgb.shape, caras, 0.9)
    else:
        piel = mascara_piel(rgb, sujeto)
        if piel.max() < 0.1:
            return rgb
        m = cv2.GaussianBlur(piel, (0, 0), max(rgb.shape[:2]) / 25)
        m = m / (m.max() + 1e-6)
    if sujeto is not None:
        m *= np.clip(sujeto * 1.5, 0, 1)
    lab = _lab(rgb)
    L = lab[..., 0] / 100
    lab[..., 0] = np.clip(L + 0.10 * fuerza * m * (1 - L) * 1.6, 0, 1) * 100
    return _rgb(lab)


def ojos(rgb, caras, fuerza=0.5):
    """Ojos con vida: un poco de contraste local y luz en el iris. La esclerótica nunca llega al blanco puro."""
    if _OJOS is None or not len(caras):
        return rgb
    salida = rgb.copy()
    u8 = (rgb * 255).astype(np.uint8)
    for (x, y, w, h) in caras:
        zona = cv2.cvtColor(u8[y:y + h // 2 + h // 8, x:x + w], cv2.COLOR_RGB2GRAY)
        if zona.size == 0:
            continue
        for (ex, ey, ew, eh) in _OJOS.detectMultiScale(zona, 1.1, 6, minSize=(max(8, w // 10), max(8, w // 10)))[:2]:
            X0, Y0, X1, Y1 = x + ex, y + ey, x + ex + ew, y + ey + eh
            parche = salida[Y0:Y1, X0:X1]
            lab = _lab(parche)
            L = lab[..., 0] / 100
            det = L - cv2.GaussianBlur(L, (0, 0), max(1, ew / 12))
            m = _caja_mascara(parche.shape, [(0, 0, ew, eh)], 0.5)
            L = L + m * (0.5 * fuerza * det + 0.03 * fuerza)
            lab[..., 0] = np.minimum(L, 0.93) * 100   # nunca blanco puro
            salida[Y0:Y1, X0:X1] = _rgb(lab)
    return salida


def brillo_suave(rgb, cantidad=0.15, color=(1.0, 1.0, 1.0)):
    """Resplandor (efecto Orton) solo en las luces: piel luminosa sin borrar textura."""
    L = _lab(rgb)[..., 0] / 100
    luces = np.clip((L - 0.55) / 0.4, 0, 1)[..., None]
    halo = cv2.GaussianBlur(rgb * luces, (0, 0), max(rgb.shape[:2]) / 90) * np.array(color, np.float32)
    return np.clip(1 - (1 - rgb) * (1 - halo * cantidad), 0, 1)


def viñeta(rgb, cantidad=0.35, centro=(0.5, 0.45), sujeto=None):
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx / w - centro[0]) / 0.75) ** 2 + ((yy / h - centro[1]) / 0.85) ** 2)
    m = np.clip((d - 0.35) / 0.6, 0, 1) ** 1.6
    if sujeto is not None:
        m *= 1 - 0.6 * np.clip(sujeto, 0, 1)
    return rgb * (1 - cantidad * m)[..., None]


def detalle_alto(rgb, caras, sujeto=None, fuerza=0.5):
    """Retoque de alto nivel natural (orden de Pratik Naik): tono de piel → luz del rostro → ojos."""
    piel = mascara_piel(rgb, sujeto, caras)
    x = igualar_piel(rgb, piel, caras, fuerza)
    x = luz_rostro(x, caras, fuerza * 0.6, sujeto)
    return ojos(x, caras, fuerza)


# ───────────── estilos de autor ─────────────

def _matiz_croma(lab):
    return np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360, np.hypot(lab[..., 1], lab[..., 2])


def fineart(rgb, sujeto, caras, variante="oscuro", intensidad="media"):
    """Fine art pictórico (inspirado en Rebeca Saray). `sujeto` es el alfa 0-1 de la persona (o None)."""
    k = 1.0 if intensidad == "media" else 0.7
    h, w = rgb.shape[:2]
    suj = np.zeros((h, w), np.float32) if sujeto is None else np.clip(sujeto, 0, 1)
    fon = 1 - suj
    detalle_original = _lab(rgb)[..., 0] - cv2.GaussianBlur(_lab(rgb)[..., 0], (0, 0), 1.2)

    lab = _lab(rgb)
    L, a, b = lab[..., 0] / 100, lab[..., 1], lab[..., 2]
    matiz, croma = _matiz_croma(lab)
    rojos = np.clip(1 - np.minimum(np.abs(matiz - 32), 360 - np.abs(matiz - 32)) / 42, 0, 1) * np.clip(croma / 25, 0, 1)
    verdes = np.clip(1 - np.abs(matiz - 135) / 50, 0, 1) * np.clip(croma / 10, 0, 1)

    if variante == "dorado":
        L = L * (1 - 0.05 * k * fon) + 0.035 * k                                 # negros levantados (mate)
        sat = 1 - 0.10 * k - 0.25 * k * verdes
        a, b = a * sat, b * sat
        b = b + (8 * L ** 2 - 2 * (1 - L) ** 2) * k                               # luces doradas, sombras oliva
        a = a + (2.5 * L ** 2 + 1.0 * (1 - L) ** 2) * k
    else:  # oscuro
        # labios, telas rojas, cabello cobrizo: rojos con color propio que NO son piel (la piel no se satura)
        saturados = rojos * np.clip((croma - 8) / 12, 0, 1) * (1 - mascara_piel(rgb, sujeto))
        sat = 1 - 0.20 * k * fon - 0.12 * k * suj - 0.40 * k * verdes + 0.75 * k * saturados
        a, b = a * sat, b * sat
        # Clave baja: si la foto es clara, una curva (gamma) la lleva a una media cercana a 0.30 sin quemar ni empastar;
        # si ya es oscura, se deja. Es lo que muestran sus antes/después (la media baja de 39 a 28 en Lab).
        media = float(L.mean())
        if media > 0.30:
            g = float(np.clip(np.log(0.29) / np.log(max(media, 0.31)), 1.0, 1.6))
            L = L ** g
        L = 0.012 * k + L * (1 - 0.012 * k)                                       # negros apenas levantados
        # Sujeto: contraste en los medios tonos (esculpido); fondo: plano y retirado
        Ls = np.clip(0.45 + (L - 0.45) * (1 + 0.22 * k), 0, 1)
        Lf = L * (1 - 0.10 * k)
        L = Ls * suj + Lf * fon
        L = L - 0.04 * k * saturados * L                                          # rojos más profundos
        L = np.where(L > 0.62, 0.62 + (L - 0.62) * (1 - 0.35 * k), L)             # luces contenidas (sin blancos que griten)
        luz = np.clip((L - 0.55) / 0.45, 0, 1)
        neutros = np.clip(1 - croma / 18, 0, 1)
        a = a - (1.5 + 2.5 * neutros) * k * luz                                   # luces frías; los blancos van a cian
        b = b - (4.5 + 8.0 * neutros) * k * luz
        a = a + 1.5 * k * (1 - L) ** 3                                            # sombras cálidas (marrón)
        b = b + 3.0 * k * (1 - L) ** 3
    lab = np.stack([L * 100, a, b], -1)
    x = _rgb(lab)

    # El rostro como foco de luz y el fondo que se retira
    x = luz_rostro(x, caras, (1.4 if len(caras) else 0.7) * k, sujeto)
    if variante == "dorado":
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        contraluz = np.exp(-(((xx - w * 0.5) / (w * 0.7)) ** 2 + ((yy + h * 0.05) / (h * 0.55)) ** 2))[..., None]
        neblina = cv2.GaussianBlur(x, (0, 0), max(h, w) / 60) * 0.45 + np.array([1.0, 0.84, 0.55], np.float32) * 0.55
        velo = 0.62 * k * contraluz * (0.35 + 0.65 * fon[..., None])  # el contraluz también envuelve un poco al sujeto
        x = x * (1 - velo) + neblina * velo
        x = brillo_suave(x, 0.22 * k, (1.0, 0.92, 0.75))
        x = viñeta(x, 0.22 * k, sujeto=sujeto)
    else:
        # Neblina pictórica en el fondo: menos contraste y un velo gris verdoso, más denso arriba
        neblina = cv2.GaussianBlur(x, (0, 0), max(h, w) / 45)
        Lmed = float(np.median(_lab(x)[..., 0])) / 100
        tono = np.array([0.36, 0.42, 0.39], np.float32) * (0.6 + Lmed)  # gris verdoso de los telones pintados
        yy = np.linspace(1.0, 0.55, h, dtype=np.float32)[:, None]
        velo = (0.34 * k * fon * yy)[..., None]
        x = x * (1 - velo) + (neblina * 0.55 + tono * 0.45) * velo
        if _ps_grade is not None:  # claridad (PhotoS) solo en el sujeto: el esculpido de luz que se ve en sus retratos
            cl = _float(_ps_grade.apply_clarity(_pil(x), amount=0.25 * k))
            x = x * (1 - suj[..., None]) + cl * suj[..., None]
        x = brillo_suave(x, 0.20 * k, (0.95, 0.98, 1.0))
        x = viñeta(x, 0.42 * k, centro=(0.5, 0.40), sujeto=sujeto)

    # La textura vuelve intacta (poros, pecas, cabello): el estilo no la ablanda
    lab = _lab(x)
    det_actual = lab[..., 0] - cv2.GaussianBlur(lab[..., 0], (0, 0), 1.2)
    lab[..., 0] += (detalle_original - det_actual) * (0.6 + 0.4 * suj)
    return _rgb(lab)


def dramatico(rgb, sujeto, caras, intensidad="media"):
    """Dramático (referente: Joel Grimes): contraste local alto, color desaturado, fondo oscurecido."""
    k = 1.0 if intensidad == "media" else 0.7
    x = rgb
    if _ps_grade is not None:
        x = _float(_ps_grade.apply_clarity(_pil(x), amount=0.45 * k))
    lab = _lab(x)
    piel = mascara_piel(rgb, sujeto)[..., None]
    lab[..., 1:] *= 1 - 0.38 * k * (1 - 0.55 * piel)   # la piel conserva color: dramática, no enferma
    L = lab[..., 0] / 100
    L = np.clip(0.5 + (L - 0.5) * (1 + 0.18 * k), 0, 1)
    lab[..., 0] = L * 100
    lab[..., 2] -= 3 * k * (1 - L) ** 2
    x = _rgb(lab)
    x = luz_rostro(x, caras, 0.5 * k, sujeto)
    return viñeta(x, 0.4 * k, sujeto=sujeto)
