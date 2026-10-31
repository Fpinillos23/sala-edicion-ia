"""CLAY SPENSER (Bravo 6) — selecciona las mejores fotos de la misión.

1. Medidas técnicas de cada foto: nitidez (también por zonas, para no castigar el fondo desenfocado),
   exposición (luces quemadas y sombras empastadas), rostros y huella visual para encontrar repetidas y ráfagas.
2. Gemini mira las candidatas (miniaturas) y puntúa composición, momento, expresión, ojos cerrados y
   relevancia frente al plan de Trent y su lista de tomas.
3. Agrupa repetidas, se queda con la mejor de cada grupo, cubre primero las tomas imprescindibles y completa por puntaje.
4. Envía a Telegram la hoja de contactos numerada (seleccionadas en verde) y reporta al Apps Script.
"""
import math
import sys
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import fotos_comun as fc

LADO_ANALISIS = 1600
FUENTE = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
_CARAS = fc.detector("haarcascade_frontalface_default.xml")
_CANDADO = threading.Lock()  # el detector de OpenCV no se puede usar desde varios hilos a la vez

ESQUEMA_IA = {
    "type": "object",
    "properties": {"fotos": {"type": "array", "items": {"type": "object", "properties": {
        "n": {"type": "number"}, "composicion": {"type": "number"}, "momento": {"type": "number"},
        "expresion": {"type": ["number", "null"]}, "ojos_cerrados": {"type": "boolean"}, "relevancia": {"type": "number"},
        "toma": {"type": "number"}, "motivo": {"type": "string"}},
        "required": ["n", "composicion", "momento", "expresion", "ojos_cerrados", "relevancia", "toma", "motivo"]}}},
    "required": ["fotos"],
}


# ───────────── Medidas técnicas ─────────────

def huella(gris):
    """dHash de 64 bits: dos fotos casi iguales (ráfaga, repetida) tienen huellas parecidas."""
    p = cv2.resize(gris, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (p[:, 1:] > p[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def medir(ruta):
    im, info = fc.abrir(ruta, LADO_ANALISIS)
    rgb = np.asarray(im)
    gris = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    g = cv2.resize(gris, None, fx=1024 / max(gris.shape), fy=1024 / max(gris.shape), interpolation=cv2.INTER_AREA) if max(gris.shape) > 1024 else gris
    lap = cv2.Laplacian(g, cv2.CV_64F)
    h, w = g.shape
    # Nitidez por zonas (4×4): cuenta la zona MÁS nítida, porque un retrato con fondo desenfocado está bien enfocado
    zonas = [lap[i * h // 4:(i + 1) * h // 4, j * w // 4:(j + 1) * w // 4].var() for i in range(4) for j in range(4)]
    L = g.astype(np.float32) / 255.0
    caras = []
    if _CARAS:
        with _CANDADO:
            caras = _CARAS.detectMultiScale(g, scaleFactor=1.15, minNeighbors=6, minSize=(max(24, w // 30), max(24, w // 30)))
    return {
        "nitidez": float(np.percentile(zonas, 90)), "nitidez_global": float(lap.var()),
        "luz": float(L.mean()), "quemadas": float((L > 0.98).mean()), "empastadas": float((L < 0.02).mean()),
        "rostros": int(len(caras)), "huella": huella(g), "fecha": str(info.get("fecha") or ""),
        "miniatura": fc.a_jpeg_bytes(im, 768, 80), "contacto": fc.a_jpeg_bytes(im, 360, 78),
    }


def puntaje_tecnico(x, ref_nitidez):
    """0 a 100. La nitidez se compara con la mediana de la misma sesión (misma cámara, misma luz)."""
    nit = min(1.0, x["nitidez"] / max(ref_nitidez, 1e-6))
    exp = 1.0 - min(1.0, abs(x["luz"] - 0.47) * 1.6)
    recorte = 1.0 - min(1.0, x["quemadas"] * 6 + x["empastadas"] * 4)
    return round(100 * (0.55 * nit + 0.25 * exp + 0.20 * recorte), 1)


def falla_tecnica(x, ref_nitidez):
    if x["nitidez"] < 0.25 * ref_nitidez and x["nitidez"] < 120:
        return "movida o fuera de foco"
    if x["quemadas"] > 0.25:
        return "luces muy quemadas"
    if x["empastadas"] > 0.45:
        return "demasiado oscura"
    return ""


def agrupar(fotos, umbral=10):
    """Une las fotos casi idénticas (distancia de huella ≤ umbral) en grupos."""
    padre = {f["n"]: f["n"] for f in fotos}

    def raiz(a):
        while padre[a] != a:
            padre[a] = padre[padre[a]]
            a = padre[a]
        return a
    for i, a in enumerate(fotos):
        for b in fotos[i + 1:]:
            if bin(a["huella"] ^ b["huella"]).count("1") <= umbral:
                padre[raiz(a["n"])] = raiz(b["n"])
    return {f["n"]: raiz(f["n"]) for f in fotos}


# ───────────── Juicio visual (Gemini) ─────────────

def juzgar(lote, plan):
    tomas = plan.get("tomas") or []
    lista_tomas = "\n".join(f"{i}. {t.get('descripcion', '')}" for i, t in enumerate(tomas)) or "(no hay lista de tomas)"
    prompt = (
        "Eres CLAY SPENSER, editor de fotografía de un medio periodístico colombiano. Evalúa cada foto rotulada.\n"
        f"Encargo: {plan.get('tipo', 'cobertura')}. {plan.get('resumen', '')}\n"
        f"Criterios del fotógrafo: {'; '.join(plan.get('criterios') or []) or 'los de un buen editor de fotografía'}\n"
        f"Lista de tomas (índice. descripción):\n{lista_tomas}\n\n"
        "Para cada foto, de 0 a 10: composicion (encuadre, orden, horizonte, aire), momento (acción, gesto, emoción, lo que cuenta), "
        "expresion (de las personas; null si no hay personas), relevancia (qué tanto sirve para el encargo). "
        "ojos_cerrados: true si la persona principal parpadea o tiene los ojos cerrados sin intención. "
        "toma: el índice de la lista de tomas que mejor cubre, o -1. "
        "motivo: máximo 12 palabras, concreto (qué tiene de bueno o de malo). No describas a las personas por su apariencia física.\n"
        "Sé exigente: un 9 o 10 es una foto publicable de portada."
    )
    r = fc.gemini_json(prompt, [(f"Foto {f['n']}:", f["miniatura"]) for f in lote], ESQUEMA_IA)
    return {int(x["n"]): x for x in (r or {}).get("fotos", []) if isinstance(x, dict) and "n" in x}


# ───────────── Hoja de contactos ─────────────

def hoja_contactos(fotos, seleccion, descartes, carpeta, codigo):
    """Hojas de 6×8 miniaturas numeradas: seleccionadas con marco verde, descartadas atenuadas."""
    try:
        fuente = ImageFont.truetype(FUENTE, 26)
        chica = ImageFont.truetype(FUENTE, 18)
    except OSError:
        fuente = chica = ImageFont.load_default()
    cols, filas, celda = 6, 8, 240
    hojas = []
    por_hoja = cols * filas
    for k in range(0, len(fotos), por_hoja):
        grupo = fotos[k:k + por_hoja]
        alto = math.ceil(len(grupo) / cols) * celda + 50
        hoja = Image.new("RGB", (cols * celda, alto), (24, 26, 22))
        d = ImageDraw.Draw(hoja)
        d.text((12, 12), f"{codigo} · hoja {k // por_hoja + 1} · verde = seleccionada", fill=(220, 220, 210), font=chica)
        for i, f in enumerate(grupo):
            x, y = (i % cols) * celda, 50 + (i // cols) * celda
            try:
                mini = Image.open(__import__("io").BytesIO(f["contacto"])).convert("RGB")
            except Exception:  # noqa: BLE001
                continue
            mini.thumbnail((celda - 16, celda - 16))
            if f["n"] in descartes:
                mini = Image.blend(mini, Image.new("RGB", mini.size, (24, 26, 22)), 0.55)
            ox, oy = x + (celda - mini.width) // 2, y + (celda - mini.height) // 2
            hoja.paste(mini, (ox, oy))
            if f["n"] in seleccion:
                d.rectangle([ox - 5, oy - 5, ox + mini.width + 4, oy + mini.height + 4], outline=(60, 200, 90), width=6)
            d.rectangle([x + 8, y + 8, x + 62, y + 40], fill=(60, 200, 90) if f["n"] in seleccion else (0, 0, 0))
            d.text((x + 13, y + 10), str(f["n"]), fill=(255, 255, 255), font=fuente)
        ruta = Path(carpeta) / f"hoja_{k // por_hoja + 1}.jpg"
        hoja.save(ruta, "JPEG", quality=85)
        hojas.append(ruta)
    return hojas


# ───────────── Misión ─────────────

def principal(mision_id):
    t = fc.pedir_trabajo(mision_id)
    plan = t.get("plan") or {}
    fotos_mision = t.get("fotos") or []
    cantidad = max(1, min(int(plan.get("cantidad") or 6), len(fotos_mision), 30))
    carpeta = Path(tempfile.mkdtemp(prefix="clay_"))
    total = len(fotos_mision)
    fc.reportar(mision_id, "progreso", agente="clay", texto=f"Descargando {total} fotos")

    def una(f):
        try:
            ruta = fc.descargar_foto(mision_id, f, carpeta)
            return {**f, **medir(ruta)}
        except Exception as e:  # noqa: BLE001
            print(f"   Una foto no se pudo abrir ({type(e).__name__}).")
            return {**f, "error": True}

    with ThreadPoolExecutor(max_workers=6) as ex:
        medidas = list(ex.map(una, fotos_mision))
    fallidas = [f["n"] for f in medidas if f.get("error")]
    fotos = [f for f in medidas if not f.get("error")]
    if not fotos:
        raise RuntimeError("No pude abrir ninguna foto. ¿La carpeta de la misión está compartida por enlace?")
    fc.reportar(mision_id, "progreso", agente="clay", texto=f"Medí {len(fotos)} fotos: nitidez, luz, rostros y repetidas")

    ref = float(np.median([f["nitidez"] for f in fotos])) or 1.0
    descartes = {}
    for f in fotos:
        f["tecnico"] = puntaje_tecnico(f, ref)
        motivo = falla_tecnica(f, ref)
        if motivo:
            descartes[f["n"]] = motivo
    grupos = agrupar(fotos)
    # Representante por grupo: la mejor técnicamente. Las demás del grupo quedan como repetidas.
    mejores = {}
    for f in fotos:
        g = grupos[f["n"]]
        if f["n"] in descartes:
            continue
        if g not in mejores or f["tecnico"] > mejores[g]["tecnico"]:
            mejores[g] = f
    repetidas = sum(1 for f in fotos if f["n"] not in descartes and mejores.get(grupos[f["n"]], {}).get("n") != f["n"])
    candidatas = sorted(mejores.values(), key=lambda f: -f["tecnico"])
    if not candidatas:  # todas con fallas: se toman las menos malas
        candidatas = sorted(fotos, key=lambda f: -f["tecnico"])[:max(cantidad * 3, 12)]
    candidatas = candidatas[:120]

    # Juicio visual por lotes de 8
    juicios, sin_ia = {}, not fc.GEMINI
    if fc.GEMINI:
        lotes = [candidatas[i:i + 8] for i in range(0, len(candidatas), 8)]
        for i, lote in enumerate(lotes, 1):
            fc.reportar(mision_id, "progreso", agente="clay", texto=f"Mirando composición y momento: lote {i} de {len(lotes)}")
            juicios.update(juzgar(lote, plan))
        sin_ia = not juicios

    tomas = plan.get("tomas") or []
    for f in candidatas:
        j = juicios.get(f["n"])
        if j:
            arte = (j["composicion"] * 0.3 + j["momento"] * 0.35 + j["relevancia"] * 0.35)
            if j.get("expresion") is not None:
                arte = arte * 0.85 + j["expresion"] * 0.15
            f["puntaje"] = round(0.35 * f["tecnico"] + 6.5 * arte, 1)
            if j.get("ojos_cerrados"):
                f["puntaje"] -= 35
            f["motivo"] = str(j.get("motivo") or "")[:90]
            f["toma"] = int(j.get("toma", -1)) if str(j.get("toma", -1)).lstrip("-").isdigit() else -1
        else:
            f["puntaje"] = f["tecnico"]
            f["motivo"] = "buena nitidez y exposición" if f["tecnico"] > 70 else "técnicamente aceptable"
            f["toma"] = -1

    # Primero cubre las tomas imprescindibles (y luego las demás), una foto por toma; después completa por puntaje
    seleccion, cubiertas = [], {}
    orden_tomas = sorted(range(len(tomas)), key=lambda i: not tomas[i].get("obligatoria"))
    for i in orden_tomas:
        opciones = sorted([f for f in candidatas if f.get("toma") == i and f["n"] not in seleccion], key=lambda f: -f["puntaje"])
        if opciones and len(seleccion) < cantidad and opciones[0]["puntaje"] > 35:
            seleccion.append(opciones[0]["n"])
            cubiertas[i] = opciones[0]["n"]
    for f in sorted(candidatas, key=lambda f: -f["puntaje"]):
        if len(seleccion) >= cantidad:
            break
        if f["n"] not in seleccion:
            seleccion.append(f["n"])
    seleccion.sort()

    ranking = [{"n": f["n"], "p": f.get("puntaje", f["tecnico"]), "m": f.get("motivo") or descartes.get(f["n"], "repetida")}
               for f in sorted(fotos, key=lambda f: -f.get("puntaje", f["tecnico"] - 50))]
    elegida_del_grupo = {grupos[f["n"]]: f["n"] for f in mejores.values()}
    evaluadas = {f["n"] for f in candidatas}
    for r in ranking:
        if r["n"] in descartes:
            r["m"] = "descartada: " + descartes[r["n"]]
        elif r["n"] not in evaluadas:
            otra = elegida_del_grupo.get(grupos[r["n"]])
            r["m"] = f"repetida de la {otra}" if otra and otra != r["n"] else "no alcanzó el corte"

    fc.reportar(mision_id, "progreso", agente="clay", texto="Armando la hoja de contactos")
    hojas = hoja_contactos(sorted(fotos, key=lambda f: f["n"]), set(seleccion), set(descartes), carpeta, t.get("codigo", ""))
    enviada = all(fc.enviar_foto(t["chat_id"], h, f"🎯 <b>Clay Spenser</b> · hoja de contactos {i + 1} de {len(hojas)}", mision_id)
                  for i, h in enumerate(hojas))

    fc.reportar(mision_id, "seleccion", agente="clay", seleccion=seleccion, ranking=ranking[:200], fallidas=fallidas, hoja_enviada=enviada,
                resumen={"descartadas_tecnicas": len(descartes), "repetidas": repetidas, "sin_ia": bool(sin_ia),
                         "pedidas": cantidad, "distintas": len(candidatas)},
                tomas=[{"descripcion": x.get("descripcion", ""), "obligatoria": bool(x.get("obligatoria")), "n": cubiertas.get(i)}
                       for i, x in enumerate(tomas)])
    print(f"Clay: {len(seleccion)} seleccionadas de {len(fotos)}.")


if __name__ == "__main__":
    mid = sys.argv[1]
    try:
        principal(mid)
    except Exception as e:  # noqa: BLE001
        print(f"Clay falló: {type(e).__name__}")
        fc.reportar(mid, "error", agente="clay", texto=str(e)[:300])
        sys.exit(1)
