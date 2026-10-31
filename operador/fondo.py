"""Mesa de fondos de Brock: recortar al sujeto, limpiar el fondo, borrar objetos y cambiar el fondo.

Herramientas (todas gratuitas y en CPU):
- Recorte del sujeto: rembg — u2net_human_seg para personas (sólido y rápido), isnet-general-use para objetos.
  El borde se afina con un filtro guiado sobre la propia foto (cabello, bordes de ropa).
- Borrado de objetos: LaMa (big-lama, TorchScript). Si no está disponible, OpenCV Telea (solo para cosas pequeñas).
- Ubicación de lo que hay que borrar: Gemini devuelve las cajas; dentro de cada caja se recorta el objeto con isnet.

Reglas de la casa (World Press Photo y la skill de retoque):
- El sujeto nunca se repinta: toda máscara de borrado excluye a la persona o sujeto principal.
- Nada de esto se usa en coberturas periodísticas (Trent lo bloquea en el plan y Brock lo vuelve a revisar).
"""
import os
import subprocess
import sys
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import fotos_comun as fc

MODELOS = Path(os.environ.get("MODELOS_DIR", Path.home() / ".cache" / "sala-fotos"))
os.environ.setdefault("U2NET_HOME", str(MODELOS))
LAMA_URL = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"
_CANDADO = threading.RLock()  # reentrante: _sesion() se llama con el candado ya tomado
_SESIONES, _LAMA = {}, {"modelo": None, "probado": False}


# ───────────── Máscaras ─────────────

def _sesion(nombre):
    from rembg import new_session
    with _CANDADO:
        if nombre not in _SESIONES:
            _SESIONES[nombre] = new_session(nombre)
        return _SESIONES[nombre]


def _guiado(guia, p, r=8, eps=1e-3):
    """Filtro guiado (He et al.): ajusta el borde de la máscara a los bordes reales de la foto."""
    I = guia.astype(np.float32)
    caja = lambda x: cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1))
    mI, mp = caja(I), caja(p)
    a = (caja(I * p) - mI * mp) / (caja(I * I) - mI * mI + eps)
    b = mp - a * mI
    return np.clip(caja(a) * I + caja(b), 0, 1)


def hay_personas(im):
    """¿Hay personas en la foto? Detector de personas de PhotoS (YOLOv8n-seg, clase «person»)."""
    try:
        from photo_s import segmask
        chica = im.copy()
        chica.thumbnail((640, 640))
        return float((segmask.segment(chica, "object", "person") > 0.5).mean()) > 0.03
    except Exception:  # noqa: BLE001 — sin el modelo, se decide por rostros (lo hace quien llama)
        return None


def mascara_sujeto(im, hay_personas=None, lado=1024):
    """Alfa 0-1 del sujeto principal, del tamaño de la foto.
    Personas: u2net_human_seg (sólido), más todo lo que la persona lleva o sostiene según isnet (flores, casco, objetos).
    Objetos y productos: isnet, quedándose con la pieza principal (sin restos de la mesa)."""
    from rembg import remove
    chica = im.copy()
    chica.thumbnail((lado, lado), Image.LANCZOS)
    with _CANDADO:
        a_obj = np.asarray(remove(chica, session=_sesion("isnet-general-use"), only_mask=True, post_process_mask=False), np.float32) / 255.0
    if hay_personas:
        with _CANDADO:
            a = np.asarray(remove(chica, session=_sesion("u2net_human_seg"), only_mask=True, post_process_mask=False), np.float32) / 255.0
        # Las piezas de isnet que tocan a la persona se suman completas (lo que sostiene o lleva puesto)
        n, et = cv2.connectedComponents((a_obj > 0.5).astype(np.uint8))
        toca = cv2.dilate((a > 0.5).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        for k in range(1, n):
            pieza = et == k
            if (pieza & toca).any():
                a = np.maximum(a, np.where(cv2.dilate(pieza.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0, a_obj, 0))
    else:
        a = a_obj
        n, et, st, _ = cv2.connectedComponentsWithStats((a > 0.5).astype(np.uint8))
        if n > 2:  # solo la pieza principal y las que sean al menos un 15 % de ella
            mayor = st[1:, cv2.CC_STAT_AREA].max()
            fuera = np.isin(et, [k for k in range(1, n) if st[k, cv2.CC_STAT_AREA] < 0.15 * mayor])
            a = np.where(cv2.dilate(fuera.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0, 0, a)
    gris = cv2.cvtColor(np.asarray(chica), cv2.COLOR_RGB2GRAY) / 255.0
    a = _guiado(gris, a, r=max(2, lado // 256), eps=2e-3)
    return cv2.resize(a, im.size, interpolation=cv2.INTER_CUBIC).clip(0, 1)


def mascara_objeto(im, caja):
    """Silueta del objeto dentro de una caja [ymin, xmin, ymax, xmax] en 0-1000 (formato de Gemini)."""
    w, h = im.size
    y0, x0, y1, x1 = [int(v) for v in caja]
    y0, y1 = sorted((max(0, y0), min(1000, y1)))
    x0, x1 = sorted((max(0, x0), min(1000, x1)))
    X0, Y0, X1, Y1 = int(x0 * w / 1000), int(y0 * h / 1000), int(x1 * w / 1000), int(y1 * h / 1000)
    if X1 - X0 < 4 or Y1 - Y0 < 4:
        return None
    m = np.zeros((h, w), np.float32)
    # Dentro de la caja, el objeto se recorta con isnet; si no lo distingue, se usa la caja completa
    rec = im.crop((X0, Y0, X1, Y1))
    try:
        from rembg import remove
        with _CANDADO:
            s = np.asarray(remove(rec, session=_sesion("isnet-general-use"), only_mask=True), np.float32) / 255.0
        cubre = (s > 0.5).mean()
        local = (s > 0.35).astype(np.float32) if 0.05 < cubre < 0.95 else np.ones_like(s)
    except Exception:  # noqa: BLE001
        local = np.ones((Y1 - Y0, X1 - X0), np.float32)
    m[Y0:Y1, X0:X1] = local
    return m


# ───────────── Borrado (LaMa) ─────────────

def _lama():
    if _LAMA["probado"]:
        return _LAMA["modelo"]
    _LAMA["probado"] = True
    try:
        try:
            import torch
        except ImportError:  # se instala solo cuando hace falta borrar algo (versión CPU, liviana)
            print("   Instalando el motor de borrado (LaMa)...")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "torch", "--index-url", "https://download.pytorch.org/whl/cpu"], check=True)
            import torch
        ruta = MODELOS / "big-lama.pt"
        if not ruta.exists():
            MODELOS.mkdir(parents=True, exist_ok=True)
            import requests
            with requests.get(LAMA_URL, stream=True, timeout=(30, 600)) as r:
                r.raise_for_status()
                with open(ruta, "wb") as f:
                    for t in r.iter_content(1 << 20):
                        f.write(t)
        torch.set_num_threads(max(1, os.cpu_count() or 2))
        modelo = torch.jit.load(str(ruta), map_location="cpu")
        modelo.eval()
        _LAMA["modelo"] = modelo
    except Exception as e:  # noqa: BLE001
        print(f"   LaMa no disponible ({type(e).__name__}); uso OpenCV para borrar.")
    return _LAMA["modelo"]


def _lama_parche(rgb8, mask, lado=768):
    """Borra con LaMa dentro de un recorte alrededor de la máscara (con contexto), a lo sumo `lado` px."""
    import torch
    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    my, mx = max(48, (y1 - y0)), max(48, (x1 - x0))
    Y0, Y1, X0, X1 = max(0, y0 - my), min(h, y1 + my), max(0, x0 - mx), min(w, x1 + mx)
    parche, mp = rgb8[Y0:Y1, X0:X1], mask[Y0:Y1, X0:X1]
    ph, pw = mp.shape
    f = min(1.0, lado / max(ph, pw))
    if f < 1:
        parche_r = cv2.resize(parche, (max(8, int(pw * f)), max(8, int(ph * f))), interpolation=cv2.INTER_AREA)
        mp_r = cv2.resize(mp, (parche_r.shape[1], parche_r.shape[0]), interpolation=cv2.INTER_NEAREST)
    else:
        parche_r, mp_r = parche, mp
    rh, rw = mp_r.shape
    H, W = rh + (-rh) % 8, rw + (-rw) % 8
    img = np.pad(parche_r, ((0, H - rh), (0, W - rw), (0, 0)), mode="reflect")
    mk = np.pad(mp_r, ((0, H - rh), (0, W - rw)))
    ti = torch.from_numpy(img).permute(2, 0, 1)[None].float() / 255
    tm = torch.from_numpy((mk > 0).astype(np.float32))[None, None]
    with torch.inference_mode():
        out = _LAMA["modelo"](ti, tm)[0].permute(1, 2, 0).numpy()[:rh, :rw]
    out = (out * 255).clip(0, 255).astype(np.uint8)
    if f < 1:
        out = cv2.resize(out, (pw, ph), interpolation=cv2.INTER_CUBIC)
        # el relleno ampliado pierde grano: se le devuelve el grano de la foto para que no parezca una mancha lisa
        ruido = parche.astype(np.float32) - cv2.GaussianBlur(parche, (0, 0), 1.2).astype(np.float32)
        out = np.clip(out.astype(np.float32) + np.roll(ruido, (37, 53), (0, 1)) * 0.8, 0, 255).astype(np.uint8)
    return (Y0, Y1, X0, X1), out


def borrar(rgb8, mask_borrar, sujeto=None):
    """Borra lo marcado y rellena con el entorno. Nunca toca al sujeto. Devuelve (imagen, motor)."""
    m = (mask_borrar > 0.5).astype(np.uint8)
    if sujeto is not None:  # protección: el sujeto (con un margen) no se repinta jamás
        m[cv2.dilate((sujeto > 0.5).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0] = 0
    if m.sum() < 20:
        return rgb8, None
    m = cv2.dilate(m, np.ones((7, 7), np.uint8))  # un borde de seguridad para no dejar contornos
    salida = rgb8.copy()
    if _lama() is not None:
        n, etiquetas = cv2.connectedComponents(m)
        for k in range(1, n):
            parte = (etiquetas == k).astype(np.uint8)
            (Y0, Y1, X0, X1), relleno = _lama_parche(salida, parte)
            suave = cv2.GaussianBlur(parte[Y0:Y1, X0:X1].astype(np.float32), (0, 0), 2)[..., None]
            suave = np.maximum(suave, parte[Y0:Y1, X0:X1, None])
            salida[Y0:Y1, X0:X1] = (salida[Y0:Y1, X0:X1] * (1 - suave) + relleno * suave).astype(np.uint8)
        return salida, "LaMa"
    return cv2.inpaint(salida, m, 5, cv2.INPAINT_TELEA), "OpenCV"


# ───────────── Limpieza de fondo de estudio ─────────────

def limpiar_estudio(rgb, sujeto, fuerza=1.0):
    """Fondo de estudio parejo: quita motas y polvo, suaviza arrugas y manchas del telón sin tocar al sujeto.
    Se trabaja en dos frecuencias: el tono (baja) se empareja, el grano (alta) se conserva para que no parezca plástico."""
    h, w = sujeto.shape
    fondo = 1 - cv2.GaussianBlur(cv2.dilate((sujeto > 0.3).astype(np.float32), np.ones((15, 15), np.uint8)), (0, 0), 6)
    if fondo.max() < 0.1:
        return rgb, 0
    rgb8 = (rgb * 255).astype(np.uint8)
    # 1) Motas y polvo: puntos pequeños que se separan del tono local (solo en el fondo)
    g = cv2.cvtColor(rgb8, cv2.COLOR_RGB2GRAY).astype(np.float32)
    dif = np.abs(g - cv2.medianBlur(g.astype(np.uint8), 21).astype(np.float32))
    motas = ((dif > 18) & (fondo > 0.9)).astype(np.uint8)
    n, et, st, _ = cv2.connectedComponentsWithStats(motas)
    lado = max(h, w)
    chicas = np.zeros_like(motas)
    for k in range(1, n):
        if st[k, cv2.CC_STAT_AREA] < (lado / 220) ** 2:
            chicas[et == k] = 1
    cuenta = int(chicas.max() and cv2.connectedComponents(chicas)[0] - 1)
    if chicas.any():
        rgb8 = cv2.inpaint(rgb8, cv2.dilate(chicas, np.ones((3, 3), np.uint8)), 3, cv2.INPAINT_TELEA)
    x = rgb8.astype(np.float32) / 255
    # 2) Arrugas y manchas: se suaviza solo la baja frecuencia del fondo
    s = lado / 60
    baja = cv2.GaussianBlur(x, (0, 0), s / 4)
    alta = x - baja
    pareja = cv2.GaussianBlur(x, (0, 0), s)
    nueva = np.clip(baja * (1 - 0.75 * fuerza) + pareja * 0.75 * fuerza + alta, 0, 1)
    f = (fondo * fuerza)[..., None]
    return x * (1 - f) + nueva * f, cuenta


# ───────────── Cambio de fondo ─────────────

def fondo_estudio(w, h, color=(46, 52, 44), semilla=7):
    """Telón pintado de estudio (como los de lienzo pintado a mano): manchas suaves de tono y un centro más claro.
    Se genera con ruido por capas: no es una imagen inventada por IA."""
    rng = np.random.default_rng(semilla)
    base = np.zeros((h, w), np.float32)
    for esc, peso in ((4, 0.5), (9, 0.3), (22, 0.15), (60, 0.05)):
        r = rng.random((esc, max(2, int(esc * w / h)))).astype(np.float32)
        base += cv2.resize(r, (w, h), interpolation=cv2.INTER_CUBIC) * peso
    base = (base - base.min()) / (np.ptp(base) + 1e-6)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    luz = np.exp(-(((xx - w * 0.5) / (w * 0.55)) ** 2 + ((yy - h * 0.42) / (h * 0.6)) ** 2))
    c = np.array(color, np.float32) / 255
    lum = 0.55 + 0.35 * base + 0.45 * luz
    tinte = (base - 0.5)[..., None] * np.array([0.04, 0.02, -0.03], np.float32)
    return np.clip(c[None, None] * lum[..., None] * 1.15 + tinte, 0, 1)


def fondo_desenfocado(rgb, sujeto):
    """Modo retrato: el fondo original, sin el sujeto (rellenado) y desenfocado como con un lente abierto."""
    h, w = sujeto.shape
    f = 640 / max(h, w)
    chica = cv2.resize((rgb * 255).astype(np.uint8), (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
    ms = cv2.resize(cv2.dilate((sujeto > 0.2).astype(np.uint8), np.ones((15, 15), np.uint8)), (chica.shape[1], chica.shape[0]))
    relleno = cv2.inpaint(chica, ms, 9, cv2.INPAINT_TELEA)
    relleno = cv2.GaussianBlur(relleno, (0, 0), 6)
    return cv2.resize(relleno, (w, h), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255


def fondo_color(w, h, color=(240, 240, 240), degradado=True):
    c = np.array(color, np.float32) / 255
    if not degradado:
        return np.ones((h, w, 3), np.float32) * c
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w / 2) / w) ** 2 + ((yy - h * 0.45) / h) ** 2)
    return np.clip(c * (1.06 - 0.35 * d[..., None]), 0, 1)


def fondo_imagen(im_fondo, w, h, desenfoque=0.0):
    """Ajusta la imagen de fondo al tamaño (cubre sin deformar) y la desenfoca un poco si se pide."""
    f = max(w / im_fondo.width, h / im_fondo.height)
    r = im_fondo.convert("RGB").resize((int(im_fondo.width * f + 0.5), int(im_fondo.height * f + 0.5)), Image.LANCZOS)
    x0, y0 = (r.width - w) // 2, (r.height - h) // 2
    a = np.asarray(r.crop((x0, y0, x0 + w, y0 + h)), np.float32) / 255
    if desenfoque:
        a = cv2.GaussianBlur(a, (0, 0), desenfoque * max(w, h) / 400)
    return a


def componer(rgb, sujeto, fondo, armonizar=0.25):
    """Pone al sujeto sobre el fondo nuevo como lo haría un retocador:
    - descontamina el borde (quita el color del fondo viejo en el cabello y los bordes);
    - armoniza el color del sujeto hacia la luz del fondo nuevo (poco: no cambia la piel);
    - envuelve el borde con un poco de luz del fondo (light wrap), para que no parezca recortado."""
    a = np.clip(sujeto, 0, 1)[..., None]
    # Descontaminación: color del sujeto estimado con desenfoque premultiplicado
    k = max(3, int(max(sujeto.shape) / 300)) | 1
    a_nucleo = (a[..., 0] > 0.9).astype(np.float32)[..., None]  # solo píxeles seguros del sujeto
    num = cv2.GaussianBlur((rgb * a_nucleo).astype(np.float32), (0, 0), k)
    den = cv2.GaussianBlur(a_nucleo[..., 0], (0, 0), k)[..., None]
    estimado = np.where(den > 1e-3, num / np.maximum(den, 1e-3), rgb)
    borde = ((a > 0.02) & (a < 0.98)).astype(np.float32)
    borde = cv2.GaussianBlur(borde[..., 0], (0, 0), 1.5)[..., None]
    sujeto_rgb = rgb * (1 - borde) + estimado * borde
    # Armonización en Lab: medias del sujeto se acercan un poco a las del fondo
    lab_s = cv2.cvtColor(sujeto_rgb.astype(np.float32), cv2.COLOR_RGB2LAB)
    lab_f = cv2.cvtColor(fondo.astype(np.float32), cv2.COLOR_RGB2LAB)
    peso = a[..., 0] > 0.5
    if peso.any():
        dm = lab_f.reshape(-1, 3).mean(0) - lab_s[peso].mean(0)
        lab_s[..., 1:] += dm[1:] * armonizar
        lab_s[..., 0] += np.clip(dm[0] * armonizar * 0.5, -6, 6)
    sujeto_rgb = np.clip(cv2.cvtColor(lab_s, cv2.COLOR_LAB2RGB), 0, 1)
    # Light wrap
    envoltura = cv2.GaussianBlur(fondo, (0, 0), k * 2)
    franja = np.clip(cv2.GaussianBlur((1 - a[..., 0]), (0, 0), k * 2)[..., None] * a, 0, 1) * 0.35
    sujeto_rgb = sujeto_rgb * (1 - franja) + envoltura * franja
    return np.clip(sujeto_rgb * a + fondo * (1 - a), 0, 1)


COLORES = {
    "negro": (14, 14, 16), "gris": (92, 94, 96), "gris oscuro": (44, 46, 48), "blanco": (244, 244, 242),
    "verde": (48, 62, 46), "verde oscuro": (30, 40, 32), "azul": (40, 58, 86), "azul oscuro": (24, 32, 52),
    "rojo": (110, 30, 32), "vino": (74, 22, 30), "marron": (78, 56, 40), "marrón": (78, 56, 40), "beige": (196, 178, 150),
    "crema": (226, 214, 190), "dorado": (160, 120, 60), "turquesa": (40, 96, 98), "morado": (66, 40, 80), "rosa": (196, 140, 150),
}


def color_de(texto, defecto=(46, 52, 44)):
    t = str(texto or "").strip().lower()
    if t.startswith("#") and len(t) == 7:
        try:
            return tuple(int(t[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            return defecto
    for nombre in sorted(COLORES, key=len, reverse=True):
        if nombre in t:
            return COLORES[nombre]
    return defecto


# ───────────── Gemini: qué borrar ─────────────

ESQUEMA_CAJAS = {"type": "object", "properties": {"objetos": {"type": "array", "items": {"type": "object", "properties": {
    "que": {"type": "string"}, "box_2d": {"type": "array", "items": {"type": "number"}}}, "required": ["que", "box_2d"]}}},
    "required": ["objetos"]}


def localizar(im, pedidos=None, general=False):
    """Pide a Gemini las cajas de lo que hay que borrar. `pedidos`: lo que nombró el mando ("el poste", "el cable").
    `general`: distracciones evidentes del FONDO (nunca la persona principal ni lo que sostiene)."""
    if not fc.GEMINI or (not pedidos and not general):
        return []
    instr = ("Ubica en esta foto estos elementos para borrarlos: " + "; ".join(pedidos) + ". ") if pedidos else ""
    if general:
        instr += ("Ubica también las distracciones evidentes del FONDO: basura, cables, cinta, soportes de luz, letreros, manchas, "
                  "objetos cortados en el borde, personas ajenas al fondo. ")
    prompt = (instr + "NUNCA incluyas a la persona o sujeto principal, ni su ropa, ni lo que sostiene. "
              "Devuelve cada elemento con box_2d = [ymin, xmin, ymax, xmax] normalizado de 0 a 1000, ajustado al elemento. "
              "Si no hay nada que borrar, devuelve una lista vacía. Máximo 8 elementos.")
    r = fc.gemini_json(prompt, [fc.a_jpeg_bytes(im, 1280, 85)], ESQUEMA_CAJAS, temperatura=0.1) or {}
    salida = []
    for o in r.get("objetos", [])[:8]:
        b = o.get("box_2d") or []
        if len(b) == 4 and all(isinstance(v, (int, float)) for v in b):
            salida.append({"que": str(o.get("que", ""))[:60], "caja": b})
    return salida
