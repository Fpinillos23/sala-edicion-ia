"""BROCK REYNOLDS (Bravo 5) — edita las fotos seleccionadas. Luego ERIC BLACKBURN las revisa.

Por cada foto:
1. Revelado natural medido en la foto (exposición, balance, sombras, luces, contraste, vibrance, nitidez suave),
   con las reglas de la skill de retoque: copia, ajustes sobre la luminosidad, nada de suavizar piel ni deformar.
2. El estilo del plan (o el de esa foto, si el mando pidió algo puntual).
3. Recortes por formato que respetan los rostros, tamaño, logo y protección de identidad si se pidió.
4. JPEG de alta calidad en sRGB, con autor y derechos, SIN ubicación GPS. Se sube a Drive (carpeta de la misión).
"""
import re
import sys
import unicodedata
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

import eric
import estilos
import fotos_comun as fc
import retoque

LADO_DIAGNOSTICO = 1600
ETIQUETA = {"original": "orig", "4:5": "4x5", "1:1": "1x1", "16:9": "16x9", "9:16": "9x16", "3:2": "3x2"}
SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def revelar(rgb, intensidad, extra):
    """Revelado natural: los valores salen de medir una copia reducida y se aplican a la foto completa."""
    f = LADO_DIAGNOSTICO / max(rgb.shape[:2])
    import cv2
    chica = cv2.resize(rgb, None, fx=f, fy=f, interpolation=cv2.INTER_AREA) if f < 1 else rgb
    medidas, a = retoque.diagnosticar(chica)
    k = 1.35 if intensidad == "media" else 1.0
    for clave in ("sombras", "luces", "contraste", "vibrance"):
        a[clave] *= k
    a["exposicion"] += float(extra.get("exposicion") or 0)
    a["temperatura"] += float(extra.get("temperatura") or 0)
    a["exposicion"] = float(np.clip(a["exposicion"], -0.7, 0.7))
    a["temperatura"] = float(np.clip(a["temperatura"], -0.10, 0.10))
    out = retoque._revelar(rgb, a["exposicion"], a["temperatura"], a["tinte"])
    out = retoque._tono(out, a["sombras"], a["luces"], a["contraste"], a["vibrance"], a["nitidez"])
    return out, a


def _ascii(t):
    """Los campos de texto del EXIF solo admiten ASCII: "Fabián" → "Fabian", "©" → "(c)"."""
    return unicodedata.normalize("NFKD", str(t)).encode("ascii", "ignore").decode()


def exif_limpio(conf, fecha):
    """EXIF nuevo: autor, derechos y programa. La ubicación GPS y los datos del dispositivo no pasan."""
    ex = Image.Exif()
    medio = conf.get("medio") or "Torre Informativa"
    ex[0x013B] = _ascii(conf.get("autor") or medio)          # Artist
    ex[0x8298] = _ascii(f"Copyright (c) {medio}")             # Copyright
    ex[0x0131] = "Sala de Fotografia IA"                      # Software
    if fecha and re.match(r"^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$", str(fecha)):
        ex[0x0132] = str(fecha)                               # fecha de la toma
    return ex


def guardar(im, ruta, conf, fecha):
    im.save(ruta, "JPEG", quality=92, subsampling=0, optimize=True, progressive=True,
            exif=exif_limpio(conf, fecha).tobytes(), icc_profile=SRGB_ICC)


def principal(mision_id):
    t = fc.pedir_trabajo(mision_id)
    plan = t.get("plan") or {}
    conf = t.get("conf") or {}
    por_foto = {int(x["n"]): x for x in (plan.get("por_foto") or []) if isinstance(x, dict) and x.get("n") is not None}
    fotos = {int(f["n"]): f for f in (t.get("fotos") or [])}
    seleccion = [n for n in (t.get("seleccion") or []) if n in fotos]
    if not seleccion:
        raise RuntimeError("No hay fotos seleccionadas para editar.")
    carpeta = Path(tempfile.mkdtemp(prefix="brock_"))
    codigo = re.sub(r"[^a-z0-9]+", "-", _ascii(t.get("codigo") or "mision").lower()).strip("-")
    archivos, hallazgos, fallidas, vistas, pares, notas = [], [], [], [], [], []
    logo_ok = None
    total = len(seleccion)

    for i, n in enumerate(seleccion, 1):
        try:
            fc.reportar(mision_id, "progreso", agente="brock", texto=f"Revelando la foto {i} de {total}")
            ruta = fc.descargar_foto(mision_id, fotos[n], carpeta)
            im, info = fc.abrir(ruta)
            propio = por_foto.get(n, {})
            estilo = propio.get("estilo") or plan.get("estilo") or "natural"
            formatos = [f for f in (propio.get("formatos") or plan.get("formatos") or ["original"]) if f == "original" or f in estilos.RAZONES][:3] or ["original"]
            rgb = fc.a_float(im)
            if plan.get("sin_retoque"):
                editada = rgb
            else:
                editada, _ = revelar(rgb, plan.get("intensidad") or "suave", propio)
            editada = estilos.aplicar_estilo(editada, estilo, plan.get("intensidad") or "suave")
            final = Image.fromarray((np.clip(editada, 0, 1) * 255 + 0.5).astype(np.uint8))
            del rgb, editada
            base_uint8 = np.asarray(im)
            caras = estilos.rostros(base_uint8)

            for formato in formatos:
                razon = estilos.RAZONES.get(formato)
                caja, cortado = estilos.recorte(base_uint8.shape, razon, caras, base_uint8)
                pieza = final.crop(caja)
                original_recorte = im.crop(caja)
                caras_rec = [(x - caja[0], y - caja[1], w, h) for (x, y, w, h) in caras
                             if x + w > caja[0] and x < caja[2] and y + h > caja[1] and y < caja[3]]
                lado = int(plan.get("lado_max") or 0)
                if lado and max(pieza.size) > lado:
                    escala = lado / max(pieza.size)
                    pieza = pieza.resize((round(pieza.width * escala), round(pieza.height * escala)), Image.LANCZOS)
                if plan.get("difuminar_rostros") and caras_rec:
                    esc = pieza.width / original_recorte.width
                    pieza = estilos.difuminar(pieza, [(int(x * esc), int(y * esc), int(w * esc), int(h * esc)) for (x, y, w, h) in caras_rec])
                if plan.get("logo"):
                    pieza, logo_ok = estilos.poner_logo(pieza)
                nombre = f"{codigo}_{n:03d}_{ETIQUETA.get(formato, 'orig')}.jpg"
                salida = carpeta / nombre
                guardar(pieza, salida, conf, info.get("fecha"))
                hallazgos += eric.revisar_archivo(n, formato, original_recorte, salida, razon, caras_rec, cortado,
                                                  estilo == "blanco_negro", bool(plan.get("difuminar_rostros")))
                fc.reportar(mision_id, "progreso", agente="eric", texto=f"Revisando la foto {i} de {total} ({formato})")
                drive_id = fc.subir_a_drive(mision_id, salida, nombre)
                if drive_id:
                    archivos.append({"n": n, "formato": formato, "id": drive_id, "mb": round(salida.stat().st_size / 1048576, 1)})
                else:
                    hallazgos.append(f"Foto {n} ({formato}): no se pudo guardar en Drive")
                if formato == formatos[0]:
                    vista = carpeta / f"vista_{n:03d}.jpg"
                    copia = pieza.copy()
                    copia.thumbnail((1600, 1600), Image.LANCZOS)
                    copia.save(vista, "JPEG", quality=85)
                    rotulo = f"{n} · {estilos_nombre(estilo)}" + (f" · {', '.join(formatos)}" if formatos != ["original"] else "")
                    vistas.append((vista, rotulo))
                    pares.append((n, fc.a_jpeg_bytes(original_recorte, 640, 80), fc.a_jpeg_bytes(pieza, 640, 80)))
            del final, base_uint8
        except Exception as e:  # noqa: BLE001
            print(f"   Foto {i} de {total}: falló ({type(e).__name__}).")
            fallidas.append(n)

    if not archivos:
        raise RuntimeError("No se pudo entregar ninguna foto editada.")
    fc.reportar(mision_id, "progreso", agente="eric", texto="Revisión visual de antes y después")
    hallazgos += eric.revisar_visual(pares)
    if plan.get("logo") and logo_ok is False:
        notas.append("Pediste el logo, pero no hay marca/logo.png en el repositorio; las fotos van sin logo.")
    if plan.get("difuminar_rostros"):
        notas.append("Rostros difuminados con mosaico. Revisa que no quede ninguno sin cubrir: la detección automática puede fallar con rostros de perfil o pequeños.")
    vista_ok = fc.enviar_album(t["chat_id"], [(r, f"Foto {txt}") for r, txt in vistas], mision_id)
    fc.reportar(mision_id, "listo", agente="brock", archivos=archivos, fallidas=fallidas, vista_enviada=vista_ok, notas=notas,
                revision={"ok": not hallazgos, "hallazgos": hallazgos[:20]})
    print(f"Brock: {len(archivos)} archivos entregados; Eric: {len(hallazgos)} observaciones.")


def estilos_nombre(e):
    return {"natural": "natural", "editorial": "editorial", "calido": "cálido", "frio": "frío", "blanco_negro": "blanco y negro",
            "contraste": "contraste", "vivo": "vivo", "cine": "cine", "mate": "mate"}.get(e, e)


if __name__ == "__main__":
    mid = sys.argv[1]
    try:
        principal(mid)
    except Exception as e:  # noqa: BLE001
        print(f"Brock falló: {type(e).__name__}")
        fc.reportar(mid, "error", agente="brock", texto=str(e)[:300])
        sys.exit(1)
