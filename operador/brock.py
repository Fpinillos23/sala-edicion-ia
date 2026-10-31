"""BROCK REYNOLDS (Bravo 5) — edita las fotos seleccionadas. Luego ERIC BLACKBURN las revisa.

Por cada foto (orden de trabajo de los retocadores de alto nivel: limpiar → piel → luz → fondo → color):
1. Reducción de ruido (PhotoS) si la foto tiene grano: noche, interiores, ISO alto.
2. Revelado natural medido en la foto, con las reglas de la skill de retoque (copia, luminosidad, nada de piel plástica).
3. Solo si el mando lo pidió y NO es cobertura periodística:
   limpieza del fondo de estudio, borrado de objetos (LaMa), retoque detallado (piel, ojos, luz del rostro), fondo nuevo.
4. El estilo: los de siempre, o los de autor (fine art inspirado en Rebeca Saray, dramático) solo cuando se piden.
5. Recortes por formato que respetan los rostros, tamaño, logo y protección de identidad si se pidió.
6. JPEG de alta calidad en sRGB, con autor y derechos, SIN ubicación GPS. Se sube a Drive (carpeta de la misión).
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
import fondo
import fotos_comun as fc
import retoque
import retoque_detalle as rd

LADO_DIAGNOSTICO = 1600
ETIQUETA = {"original": "orig", "4:5": "4x5", "1:1": "1x1", "16:9": "16x9", "9:16": "9x16", "3:2": "3x2"}
ESTILOS_COBERTURA = ("natural", "editorial", "blanco_negro")  # World Press Photo: nada que cambie el contenido
SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def revelar(rgb, intensidad, extra, clave_baja=False):
    """Revelado natural: los valores salen de medir una copia reducida y se aplican a la foto completa.
    `clave_baja` (fine art): no se aclara una foto oscura, porque la penumbra es parte del estilo."""
    f = LADO_DIAGNOSTICO / max(rgb.shape[:2])
    import cv2
    chica = cv2.resize(rgb, None, fx=f, fy=f, interpolation=cv2.INTER_AREA) if f < 1 else rgb
    medidas, a = retoque.diagnosticar(chica)
    k = 1.35 if intensidad == "media" else 1.0
    for clave in ("sombras", "luces", "contraste", "vibrance"):
        a[clave] *= k
    if clave_baja:
        a["exposicion"] = min(a["exposicion"], 0.0)
        a["sombras"] *= 0.4
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

    fondos = {int(f["n"]): f for f in (t.get("fondos") or []) if isinstance(f, dict) and f.get("id")}
    imagenes_fondo, intenciones = {}, {}

    def imagen_fondo(numero):
        if numero not in imagenes_fondo:
            f = fondos.get(int(numero)) if numero else None
            if not f:
                imagenes_fondo[numero] = None
            else:
                ruta_f = fc.descargar_foto(mision_id, {"n": 900 + int(numero), "id": f["id"], "nombre": f.get("nombre", "fondo.jpg")}, carpeta)
                imagenes_fondo[numero] = fc.abrir(ruta_f, 4000)[0]
        return imagenes_fondo[numero]

    for i, n in enumerate(seleccion, 1):
        try:
            fc.reportar(mision_id, "progreso", agente="brock", texto=f"Revelando la foto {i} de {total}")
            ruta = fc.descargar_foto(mision_id, fotos[n], carpeta)
            im, info = fc.abrir(ruta)
            propio = por_foto.get(n, {})
            cobertura = plan.get("tipo") == "cobertura"
            estilo = propio.get("estilo") or plan.get("estilo") or "natural"
            detalle = propio.get("detalle") or plan.get("detalle") or "estandar"
            cfg_fondo = propio.get("fondo") or plan.get("fondo") or {}
            limpieza = propio.get("limpieza") or plan.get("limpieza") or {}
            if cobertura:  # segunda barrera (Trent ya lo filtra): en periodismo no se toca el contenido
                estilo = estilo if estilo in ESTILOS_COBERTURA else "editorial"
                detalle, cfg_fondo, limpieza = "estandar", {}, {}
            tipo_fondo = (cfg_fondo or {}).get("tipo") or "ninguno"
            quitar = [str(q)[:80] for q in (limpieza.get("quitar") or []) if str(q).strip()][:6]
            formatos = [f for f in (propio.get("formatos") or plan.get("formatos") or ["original"]) if f == "original" or f in estilos.RAZONES][:3] or ["original"]
            hecho = []

            im, sigma = rd.reducir_ruido(im, plan.get("ruido") or "auto")
            if sigma >= 2.6 and plan.get("ruido") != "no":
                hecho.append("ruido reducido")
            rgb = fc.a_float(im)
            if plan.get("sin_retoque"):
                editada = rgb
            else:
                editada, _ = revelar(rgb, plan.get("intensidad") or "suave", propio, clave_baja=estilo == "fineart")
            del rgb
            base_uint8 = np.asarray(im)
            caras = estilos.rostros(base_uint8)

            necesita_sujeto = (tipo_fondo != "ninguno" or limpieza.get("estudio") or limpieza.get("general") or quitar
                               or detalle == "alto" or estilo in ("fineart", "dramatico"))
            sujeto = None
            if necesita_sujeto:
                fc.reportar(mision_id, "progreso", agente="brock", texto=f"Foto {i} de {total}: separando al sujeto del fondo")
                personas = fondo.hay_personas(im)
                sujeto = fondo.mascara_sujeto(im, hay_personas=bool(len(caras)) if personas is None else personas)

            contenido = []
            if limpieza.get("estudio"):
                editada, motas = fondo.limpiar_estudio(editada, sujeto)
                contenido.append("fondo de estudio limpiado" + (f" ({motas} motas)" if motas else ""))
            if limpieza.get("general") or quitar:
                fc.reportar(mision_id, "progreso", agente="brock", texto=f"Foto {i} de {total}: borrando distracciones del fondo")
                vista_pil = Image.fromarray((np.clip(editada, 0, 1) * 255).astype(np.uint8))
                objetos = fondo.localizar(vista_pil, quitar, bool(limpieza.get("general")))
                marca = np.zeros(sujeto.shape, np.float32)
                for o in objetos:
                    m = fondo.mascara_objeto(vista_pil, o["caja"])
                    if m is not None:
                        marca = np.maximum(marca, m)
                u8, motor = fondo.borrar((np.clip(editada, 0, 1) * 255).astype(np.uint8), marca, sujeto)
                if motor:
                    editada = u8.astype(np.float32) / 255
                    contenido.append("borré: " + ", ".join(o["que"] for o in objetos)[:120])
                elif quitar:
                    notas.append(f"Foto {n}: no encontré lo que pediste borrar ({'; '.join(quitar)[:80]}).")
            if detalle == "alto" or estilo == "fineart":
                fc.reportar(mision_id, "progreso", agente="brock", texto=f"Foto {i} de {total}: retoque detallado (piel, ojos, luz)")
                editada = rd.detalle_alto(editada, caras, sujeto, 0.5)
                hecho.append("retoque detallado")
            if tipo_fondo != "ninguno":
                fc.reportar(mision_id, "progreso", agente="brock", texto=f"Foto {i} de {total}: poniendo el fondo nuevo")
                h_, w_ = sujeto.shape
                if tipo_fondo == "imagen" and imagen_fondo(cfg_fondo.get("fondo_n")) is not None:
                    nuevo = fondo.fondo_imagen(imagen_fondo(cfg_fondo.get("fondo_n")), w_, h_, desenfoque=0.6)
                    texto_fondo = f"fondo {cfg_fondo.get('fondo_n')} que enviaste"
                elif tipo_fondo == "desenfocado":
                    nuevo, texto_fondo = fondo.fondo_desenfocado(editada, sujeto), "fondo desenfocado"
                elif tipo_fondo == "color":
                    nuevo = fondo.fondo_color(w_, h_, fondo.color_de(cfg_fondo.get("color"), (240, 240, 240)))
                    texto_fondo = f"fondo de color {cfg_fondo.get('color') or 'claro'}"
                else:
                    if tipo_fondo == "imagen":
                        notas.append(f"Foto {n}: no encontré el fondo {cfg_fondo.get('fondo_n')}; usé un telón pintado.")
                    nuevo = fondo.fondo_estudio(w_, h_, fondo.color_de(cfg_fondo.get("color")), semilla=n)
                    texto_fondo = f"telón pintado {cfg_fondo.get('color') or 'verde oscuro'}"
                editada = fondo.componer(editada, sujeto, nuevo)
                contenido.append(texto_fondo)

            if estilo == "fineart":
                variante = propio.get("variante") or plan.get("variante") or "oscuro"
                editada = rd.fineart(editada, sujeto, caras, "dorado" if variante == "dorado" else "oscuro", plan.get("intensidad") or "media")
            elif estilo == "dramatico":
                editada = rd.dramatico(editada, sujeto, caras, plan.get("intensidad") or "media")
            else:
                editada = estilos.aplicar_estilo(editada, estilo, plan.get("intensidad") or "suave")
            final = Image.fromarray((np.clip(editada, 0, 1) * 255 + 0.5).astype(np.uint8))
            del editada
            if contenido:
                intenciones[n] = "; ".join(contenido)
            if contenido or hecho:
                notas.append(f"Foto {n}: " + "; ".join(hecho + contenido) + ".")
            estilo_fuerte = estilo in ("fineart", "dramatico")

            for formato in formatos:
                razon = estilos.RAZONES.get(formato)
                caja, cortado = estilos.recorte(base_uint8.shape, razon, caras, base_uint8)
                pieza = final.crop(caja)
                original_recorte = im.crop(caja)
                sujeto_rec = sujeto[caja[1]:caja[3], caja[0]:caja[2]] if (sujeto is not None and contenido) else None
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
                                                  estilo == "blanco_negro", bool(plan.get("difuminar_rostros")),
                                                  sujeto=sujeto_rec, estilo_fuerte=estilo_fuerte)
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
            del final, base_uint8, sujeto
        except Exception as e:  # noqa: BLE001
            print(f"   Foto {i} de {total}: falló ({type(e).__name__}).")  # sin detalles: los registros son públicos
            fallidas.append(n)

    if not archivos:
        raise RuntimeError("No se pudo entregar ninguna foto editada.")
    fc.reportar(mision_id, "progreso", agente="eric", texto="Revisión visual de antes y después")
    hallazgos += eric.revisar_visual(pares, intenciones)
    if intenciones:
        notas.append("Fotomontaje o retoque de contenido en las fotos " + ", ".join(str(k) for k in sorted(intenciones)) +
                     ": sirven para redes, arte o estudio; no las publiques como foto periodística sin aclararlo.")
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
            "contraste": "contraste", "vivo": "vivo", "cine": "cine", "mate": "mate",
            "fineart": "fine art (inspirado en Rebeca Saray)", "dramatico": "dramático"}.get(e, e)


if __name__ == "__main__":
    mid = sys.argv[1]
    try:
        principal(mid)
    except Exception as e:  # noqa: BLE001
        print(f"Brock falló: {type(e).__name__}")
        fc.reportar(mid, "error", agente="brock", texto=str(e)[:300])
        sys.exit(1)
