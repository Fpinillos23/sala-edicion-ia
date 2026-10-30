"""Armado de notas con varios clips: entrada, entrevistas, voz en off, apoyos y salida.

El plan de armado (lo arma Jason y lo aprueba el mando) es un JSON validado aquí:
{
  "formato": "vertical" | "vertical_recorte" | "cuadrado" | "original",
  "bloques": [{"clip": n, "inicio": s, "fin": s}],      # la nota en orden; un clip de off pone su audio
  "tapas":   [{"apoyo": n, "desde": s, "en": s, "dura": s}],   # apoyos encima, con la voz debajo
  ... y todo lo del plan de edición libre (textos, subtítulos, intro, cierre, música, color, fundido, logo).
}
Los números de clip empiezan en 1, en el orden en que llegaron. "en" es el segundo de la nota final.
Lo que falte de imagen en los bloques de off se rellena solo con los apoyos, en orden.
"""
import shutil
from pathlib import Path

from editor import _ffmpeg, info_video
from plan import _filtro_formato, _num, renderizar_plan

HABLADOS = ("entrada", "entrevista", "salida", "off", "sin_etiqueta")


def _validar(plan, clips, duraciones):
    """Corrige o descarta lo imposible: clips que no existen, tiempos fuera del clip, tapas sin apoyo."""
    n = len(clips)
    bloques = []
    for b in plan.get("bloques") or []:
        c = int(_num(b.get("clip"), 0))
        if not 1 <= c <= n or clips[c - 1]["tipo"] == "apoyo":
            continue
        d = duraciones[c - 1]
        a = _num(b.get("inicio"), 0.0, 0, d)
        f = _num(b.get("fin"), d, 0, d)
        if f - a >= 0.5:
            bloques.append({"clip": c, "inicio": round(a, 2), "fin": round(f, 2)})
    if not bloques:  # sin plan válido: todos los clips hablados completos, en el orden en que llegaron
        bloques = [{"clip": i + 1, "inicio": 0.0, "fin": round(duraciones[i], 2)}
                   for i, c in enumerate(clips) if c["tipo"] != "apoyo" and duraciones[i] > 0.5]
    total = sum(b["fin"] - b["inicio"] for b in bloques)
    tapas = []
    for t in plan.get("tapas") or []:
        c = int(_num(t.get("apoyo"), 0))
        if not 1 <= c <= n or clips[c - 1]["tipo"] != "apoyo":
            continue
        d = duraciones[c - 1]
        desde = _num(t.get("desde"), 0.0, 0, max(0.0, d - 0.5))
        en = _num(t.get("en"), None, 0, total)
        dura = _num(t.get("dura"), None, 0.5, 30)
        if en is None or dura is None:
            continue
        dura = min(dura, d - desde, total - en)
        if dura >= 0.5:
            tapas.append({"apoyo": c, "desde": round(desde, 2), "en": round(en, 2), "dura": round(dura, 2)})
    return bloques, tapas, total


def _rellenar_off(bloques, tapas, clips, duraciones):
    """Los bloques de off no tienen imagen propia: lo que no cubra una tapa se cubre con apoyos, en orden."""
    apoyos = [i + 1 for i, c in enumerate(clips) if c["tipo"] == "apoyo" and duraciones[i] > 0.5 and c.get("usable", True)]
    if not apoyos:  # si todos los apoyos salieron malos, igual se usan antes que dejar el off en negro
        apoyos = [i + 1 for i, c in enumerate(clips) if c["tipo"] == "apoyo" and duraciones[i] > 0.5]
    if not apoyos:
        return tapas, False
    usado = {a: 0.0 for a in apoyos}
    for t in tapas:
        usado[t["apoyo"]] = max(usado[t["apoyo"]], t["desde"] + t["dura"])
    nuevas, k, pos = list(tapas), 0, 0.0
    for b in bloques:
        largo = b["fin"] - b["inicio"]
        if clips[b["clip"] - 1]["tipo"] == "off":
            cubiertos = sorted((t["en"], t["en"] + t["dura"]) for t in nuevas if t["en"] < pos + largo and t["en"] + t["dura"] > pos)
            hueco_ini, huecos = pos, []
            for a, f in cubiertos:
                if a > hueco_ini + 0.05:
                    huecos.append((hueco_ini, min(a, pos + largo)))
                hueco_ini = max(hueco_ini, f)
            if hueco_ini < pos + largo - 0.05:
                huecos.append((hueco_ini, pos + largo))
            for h0, h1 in huecos:
                t0 = h0
                while t0 < h1 - 0.05:
                    ap = apoyos[k % len(apoyos)]
                    d = duraciones[ap - 1]
                    if usado[ap] >= d - 0.5:
                        usado[ap] = 0.0  # se acabó ese apoyo: vuelve a empezar
                    trozo = min(h1 - t0, d - usado[ap], 5.0)
                    nuevas.append({"apoyo": ap, "desde": round(usado[ap], 2), "en": round(t0, 2), "dura": round(trozo, 2)})
                    usado[ap] += trozo
                    t0 += trozo
                    k += 1
        pos += largo
    return nuevas, True


def _retimar_segmentos(bloques, segmentos_por_clip):
    """Lleva las frases transcritas de cada clip a la línea de tiempo de la nota (para subtítulos)."""
    salida, pos = [], 0.0
    for b in bloques:
        for s in segmentos_por_clip.get(str(b["clip"]), []) or []:
            a, f = max(s["inicio"], b["inicio"]), min(s["fin"], b["fin"])
            if f - a > 0.2:
                salida.append({"inicio": round(pos + a - b["inicio"], 2), "fin": round(pos + f - b["inicio"], 2), "texto": s["texto"]})
        pos += b["fin"] - b["inicio"]
    return salida


def _rotulos_automaticos(plan, bloques, clips):
    """Primera aparición de cada entrevistado con nombre: rótulo con nombre y cargo, si el plan no trae uno ahí."""
    textos = list(plan.get("textos") or [])
    vistos, pos = set(), 0.0
    for b in bloques:
        c = clips[b["clip"] - 1]
        if c["tipo"] == "entrevista" and c.get("nombre") and b["clip"] not in vistos:
            vistos.add(b["clip"])
            hay = any(str(x.get("estilo")) == "rotulo" and abs(float(x.get("inicio") or 0) - pos) < 3 for x in textos)
            if not hay:
                textos.append({"texto": c["nombre"], "subtexto": c.get("cargo", ""), "estilo": "rotulo", "posicion": "abajo",
                               "inicio": round(pos + 0.5, 2), "fin": round(pos + min(5.0, b["fin"] - b["inicio"]), 2)})
        pos += b["fin"] - b["inicio"]
    return textos


def renderizar_nota(rutas, clips, plan, imagenes, musica, segmentos_por_clip, carpeta_trabajo, destino, conf, avisar=print, borrador=None):
    trabajo = Path(carpeta_trabajo).resolve() / "render_nota"
    if trabajo.exists():
        shutil.rmtree(trabajo)
    trabajo.mkdir(parents=True)
    infos = [info_video(r) for r in rutas]
    duraciones = [i["duracion"] for i in infos]
    plan = dict(plan or {})
    bloques, tapas, total = _validar(plan, clips, duraciones)
    if not bloques:
        raise RuntimeError("La nota no tiene ningún clip hablado (entrada, entrevista, off o salida).")
    tapas, _ = _rellenar_off(bloques, tapas, clips, duraciones)

    # El formato se toma del primer clip con imagen (sirve de referencia para vertical u original).
    ref = next((i for i, c in zip(infos, clips) if c["tipo"] != "off" and i.get("tiene_video")), {"ancho": 1080, "alto": 1920})
    _, (W, H) = _filtro_formato(plan.get("formato") if plan.get("formato") in ("vertical", "vertical_recorte", "cuadrado", "original") else "vertical", ref)
    formato = plan.get("formato") if plan.get("formato") in ("vertical", "vertical_recorte", "cuadrado", "original") else "vertical"
    codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]

    # 1. Bloques en orden, todos al mismo tamaño, cuadros por segundo y audio
    lista = []
    for i, b in enumerate(bloques, 1):
        avisar(f"Armando bloque {i} de {len(bloques)}")
        c, info, ruta = clips[b["clip"] - 1], infos[b["clip"] - 1], rutas[b["clip"] - 1]
        dur = b["fin"] - b["inicio"]
        nombre = f"bloque_{i:02d}.mp4"
        if c["tipo"] == "off" or not info.get("tiene_video"):
            # Voz en off: la imagen la ponen las tapas; mientras tanto, fondo negro.
            args = ["-f", "lavfi", "-t", f"{dur:.2f}", "-i", f"color=c=black:s={W}x{H}:r=30",
                    "-ss", f"{b['inicio']:.2f}", "-t", f"{dur:.2f}", "-i", str(ruta),
                    "-map", "0:v", "-map", "1:a:0", "-af", "aresample=48000", "-shortest"]
        else:
            filtro, _ = _filtro_formato(formato, info)
            filtro += f",scale={W}:{H},setsar=1"
            args = ["-ss", f"{b['inicio']:.2f}", "-t", f"{dur:.2f}", "-i", str(ruta)]
            if info["tiene_audio"]:
                args += ["-filter_complex", f"[0:v]{filtro}[v];[0:a:0]aresample=48000[a]", "-map", "[v]", "-map", "[a]"]
            else:
                args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex", f"[0:v]{filtro}[v]",
                         "-map", "[v]", "-map", "1:a", "-shortest"]
        _ffmpeg(args + codec + [nombre], cwd=str(trabajo))
        lista.append(f"file '{nombre}'")
    (trabajo / "lista.txt").write_text("\n".join(lista) + "\n", encoding="utf-8")
    _ffmpeg(["-f", "concat", "-safe", "0", "-i", "lista.txt", "-c", "copy", "unido.mp4"], cwd=str(trabajo))
    base = trabajo / "unido.mp4"

    # 2. Apoyos encima (la voz sigue debajo)
    if tapas:
        avisar(f"Poniendo {len(tapas)} tomas de apoyo")
        entradas, partes, ultimo = ["-i", "unido.mp4"], [], "0:v"
        for k, t in enumerate(sorted(tapas, key=lambda x: x["en"]), 1):
            info = infos[t["apoyo"] - 1]
            filtro, _ = _filtro_formato(formato, info)
            entradas += ["-ss", f"{t['desde']:.2f}", "-t", f"{t['dura'] + 0.2:.2f}", "-i", str(rutas[t["apoyo"] - 1])]
            partes.append(f"[{k}:v]{filtro},scale={W}:{H},setsar=1,setpts=PTS-STARTPTS+{t['en']:.2f}/TB[t{k}]")
            partes.append(f"[{ultimo}][t{k}]overlay=0:0:eof_action=repeat:enable='between(t,{t['en']:.2f},{t['en'] + t['dura'] + 0.05:.2f})'[v{k}]")
            ultimo = f"v{k}"
        (trabajo / "tapas.txt").write_text(";\n".join(partes), encoding="utf-8")
        _ffmpeg(entradas + ["-filter_complex_script", "tapas.txt", "-map", f"[{ultimo}]", "-map", "0:a",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy",
                            "con_apoyos.mp4"], cwd=str(trabajo))
        base = trabajo / "con_apoyos.mp4"

    # Borrador liviano: el mando ve la nota armada mientras Sonny termina los gráficos
    if borrador:
        try:
            avisar("Enviando un borrador liviano")
            _ffmpeg(["-i", str(base), "-vf", "scale=-2:'min(854,ih)'", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
                     "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "borrador.mp4"], cwd=str(trabajo))
            borrador(trabajo / "borrador.mp4", info_video(trabajo / "borrador.mp4")["duracion"])
        except Exception as e:  # noqa: BLE001  el borrador es una ayuda: si falla, la nota sigue
            print(f"   No se pudo enviar el borrador ({type(e).__name__}).")

    # 3. Textos, rótulos, subtítulos, música, intro y cierre: el motor de edición libre sobre la nota ya armada
    plan2 = {k: v for k, v in plan.items() if k not in ("bloques", "tapas", "tramos", "velocidad")}
    plan2["formato"] = "original"
    plan2["textos"] = _rotulos_automaticos(plan, bloques, clips)
    im = plan.get("imagenes") or {}
    if not im.get("usar") and not im.get("tiempos"):
        imagenes = []  # en una nota, las fotos sueltas solo salen si el armado las pide
    return renderizar_plan(base, plan2, imagenes, musica, _retimar_segmentos(bloques, segmentos_por_clip),
                           trabajo, destino, conf, avisar=avisar)
