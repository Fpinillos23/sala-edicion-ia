"""ERIC BLACKBURN (Bravo Actual) — control de calidad de las fotos editadas, antes de que el mando las vea.

Revisión medida (en cada archivo):
- la proporción pedida, sin estirar;
- que el revelado no haya quemado luces ni empastado sombras;
- que el contenido sea la misma foto (estructura igual a la del original: nada regenerado ni movido);
- color de piel en los rostros (regla "color by the numbers": en CMY, el magenta no supera al amarillo);
- que el recorte no corte rostros;
- que no quede la ubicación GPS en el archivo.
Revisión visual (Gemini, si hay clave): piel plástica, color irreal, halos, recortes incómodos.
"""
import cv2
import numpy as np
from PIL import Image

import fotos_comun as fc

ESQUEMA_VISUAL = {
    "type": "object",
    "properties": {"fotos": {"type": "array", "items": {"type": "object", "properties": {
        "n": {"type": "number"}, "problema": {"type": ["string", "null"]}}, "required": ["n", "problema"]}}},
    "required": ["fotos"],
}


def _gris(a, lado=256):
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY) if a.ndim == 3 else a
    f = lado / max(g.shape)
    return cv2.resize(g, (max(8, int(g.shape[1] * f)), max(8, int(g.shape[0] * f))), interpolation=cv2.INTER_AREA).astype(np.float32)


def _estructura(a, b):
    """Correlación de los bordes de dos imágenes (0 a 1). Una foto revelada conserva ~0.9 o más."""
    ga, gb = _gris(a), _gris(b)
    gb = cv2.resize(gb, (ga.shape[1], ga.shape[0]))
    ea = np.hypot(cv2.Sobel(ga, cv2.CV_32F, 1, 0), cv2.Sobel(ga, cv2.CV_32F, 0, 1)).ravel()
    eb = np.hypot(cv2.Sobel(gb, cv2.CV_32F, 1, 0), cv2.Sobel(gb, cv2.CV_32F, 0, 1)).ravel()
    ea, eb = ea - ea.mean(), eb - eb.mean()
    return float((ea @ eb) / (np.linalg.norm(ea) * np.linalg.norm(eb) + 1e-9))


def revisar_archivo(n, formato, original_recorte, ruta_salida, razon, caras, cortado, blanco_negro, difuminado,
                    sujeto=None, estilo_fuerte=False):
    """Devuelve la lista de hallazgos (vacía si todo está bien) para un archivo entregado.
    `sujeto`: alfa del sujeto (recortado al formato) cuando se cambió o limpió el fondo; entonces la estructura
    se compara SOLO dentro del sujeto, porque el fondo cambió a propósito. `estilo_fuerte`: fine art o dramático
    (cambian el tono a propósito: no se avisa por luces o sombras)."""
    hallazgos = []
    im = Image.open(ruta_salida)
    if 0x8825 in im.getexif():
        hallazgos.append(f"Foto {n} ({formato}): quedó la ubicación GPS en el archivo")
    sal = np.asarray(im.convert("RGB"))
    h, w = sal.shape[:2]
    if razon and abs(w / h - razon) > 0.012:
        hallazgos.append(f"Foto {n} ({formato}): la proporción no es la pedida")
    org = np.asarray(original_recorte.convert("RGB"))
    lo = cv2.cvtColor(org, cv2.COLOR_RGB2GRAY) / 255.0
    ls = cv2.cvtColor(sal, cv2.COLOR_RGB2GRAY) / 255.0
    if (ls > 0.985).mean() - (lo > 0.985).mean() > 0.02:
        hallazgos.append(f"Foto {n} ({formato}): el revelado quemó algunas luces")
    if not estilo_fuerte and (ls < 0.015).mean() - (lo < 0.015).mean() > 0.03:
        hallazgos.append(f"Foto {n} ({formato}): el revelado empastó algunas sombras")
    if not difuminado:
        if sujeto is not None:
            # Solo el sujeto: la persona tiene que seguir siendo exactamente la misma (nada regenerado ni deformado)
            nucleo = cv2.resize((sujeto > 0.95).astype(np.uint8), (org.shape[1], org.shape[0]), interpolation=cv2.INTER_NEAREST)
            nucleo = cv2.erode(nucleo, np.ones((9, 9), np.uint8)).astype(bool)
            if nucleo.sum() > 400:
                ys, xs = np.nonzero(nucleo)
                y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
                sal_r = cv2.resize(sal, (org.shape[1], org.shape[0]))
                e = _estructura(org[y0:y1, x0:x1] * nucleo[y0:y1, x0:x1, None], sal_r[y0:y1, x0:x1] * nucleo[y0:y1, x0:x1, None])
                if e < 0.85:
                    hallazgos.append(f"Foto {n} ({formato}): la persona cambió más de lo esperado al tocar el fondo (similitud {e:.2f}); revisa los bordes")
        else:
            e = _estructura(org, sal)
            if e < (0.70 if estilo_fuerte else 0.80):
                hallazgos.append(f"Foto {n} ({formato}): la estructura cambió más de lo esperado (similitud {e:.2f}); revísala a fondo")
    if cortado:
        hallazgos.append(f"Foto {n} ({formato}): el recorte corta un rostro; quizá convenga otra proporción")
    if caras and not blanco_negro and not difuminado:
        fx, fy = w / org.shape[1], h / org.shape[0]
        for (x, y, cw, ch) in caras[:3]:
            x0, y0 = int((x + cw * 0.3) * fx), int((y + ch * 0.35) * fy)
            x1, y1 = int((x + cw * 0.7) * fx), int((y + ch * 0.75) * fy)
            zona = sal[max(0, y0):max(0, y1), max(0, x0):max(0, x1)].reshape(-1, 3) / 255.0
            if len(zona) < 50:
                continue
            r, g, b = zona.mean(axis=0)
            m_, y_ = 1 - g, 1 - b
            if m_ > y_ * 1.08 + 0.01:
                hallazgos.append(f"Foto {n} ({formato}): la piel tira a magenta (M > Y); conviene revisar el balance")
                break
    return hallazgos


def revisar_visual(pares, intenciones=None):
    """pares: [(n, bytes_original, bytes_editada)]. Devuelve hallazgos visuales de Gemini (solo problemas claros).
    `intenciones`: {n: "lo que se pidió"} — cambios hechos a propósito (fondo nuevo, objetos borrados, estilo), que no son errores."""
    if not fc.GEMINI or not pares:
        return []
    hallazgos = []
    for i in range(0, len(pares), 6):
        lote = pares[i:i + 6]
        imagenes = []
        pedidos = []
        for n, a, b in lote:
            imagenes += [(f"Foto {n} — ANTES:", a), (f"Foto {n} — DESPUÉS:", b)]
            if (intenciones or {}).get(n):
                pedidos.append(f"Foto {n}: {intenciones[n]}")
        r = fc.gemini_json(
            "Eres ERIC BLACKBURN, control de calidad de fotografía de un medio periodístico. Compara cada par ANTES/DESPUÉS. "
            "El DESPUÉS debe ser la misma foto, con la PERSONA intacta (mismos rasgos, misma textura de piel). "
            + ("Cambios pedidos a propósito, que NO son errores: " + "; ".join(pedidos) + ". En esas fotos revisa la CALIDAD del cambio: "
               "bordes recortados o con halo alrededor del cabello, restos o manchas donde se borró algo, luz del sujeto que no "
               "coincide con el fondo nuevo, cabello cortado. " if pedidos else "En las demás, solo se corrigió luz y color. ")
            + "Reporta SOLO problemas claros y visibles: piel plástica o sin textura, color de piel antinatural, halos, ruido excesivo, "
            "elementos agregados o quitados SIN haberse pedido, o un recorte que corte una cabeza o una mano de forma incómoda. "
            "Si una foto está bien, \"problema\" es null. Escribe el problema en máximo 14 palabras, en español.",
            imagenes, ESQUEMA_VISUAL)
        for x in (r or {}).get("fotos", []):
            if isinstance(x, dict) and x.get("problema"):
                hallazgos.append(f"Foto {int(x.get('n', 0))}: {str(x['problema'])[:120]}")
    return hallazgos
