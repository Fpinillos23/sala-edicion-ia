"""Motor de edición libre: Sonny ejecuta el PLAN que Jason y Mandy armaron con la instrucción del mando.

El plan es un JSON validado aquí (nunca se ejecutan comandos escritos por la IA):
{
  "formato": "vertical" | "vertical_recorte" | "cuadrado" | "original",
  "tramos": [{"inicio": s, "fin": s}],            # partes del video a conservar, en orden; vacío = todo
  "velocidad": 1.0,                                 # 0.25 a 4
  "color": {"filtro": "ninguno|blanco_negro|calido|frio|contraste|vivo", "brillo": 0.0},
  "audio": {"modo": "original|silencio|solo_voz", "volumen": 1.0,
            "musica": false, "volumen_musica": 0.35},
  "subtitulos": false,
  "textos": [{"texto": "", "subtexto": "", "inicio": s, "fin": s, "posicion": "arriba|centro|abajo",
              "estilo": "titular|rotulo|simple", "animado": true}],   # animado = gráfico de Remotion
  "intro": {"texto": "", "subtexto": "", "segundos": 3} | null,       # tarjeta animada al inicio (Remotion)
  "cierre": {"texto": "", "subtexto": "", "segundos": 3} | null,      # tarjeta con la firma del medio al final
  "imagenes": {"usar": [1, 2], "estilo": "recuadro_flotante|pantalla_completa|esquina",
               "posicion": "arriba|centro|abajo|izquierda|derecha", "tamano": 0.7,
               "tiempos": [{"imagen": 1, "inicio": s, "fin": s}],      # sin tiempos = repartidas parejo
               "retoque": true},                                          # retoque fotográfico natural
  "fundido": {"entrada": 0.0, "salida": 0.0},
  "logo": true
}
Los tiempos de "textos" e "imagenes.tiempos" están en la línea de tiempo del video FINAL.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from editor import _color_ass, _ffmpeg, _filtro, _limpio, _t, _tam_imagen, frases_subtitulo, info_video

FILTROS_COLOR = {
    "blanco_negro": "hue=s=0",
    "calido": "colorbalance=rs=.08:gs=.02:bs=-.08",
    "frio": "colorbalance=rs=-.06:bs=.08",
    "contraste": "eq=contrast=1.18:saturation=1.1",
    "vivo": "eq=saturation=1.35:contrast=1.05",
}


def _num(x, defecto, minimo=None, maximo=None):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return defecto
    if minimo is not None:
        v = max(minimo, v)
    if maximo is not None:
        v = min(maximo, v)
    return v


def validar(plan, duracion, n_imagenes, hay_musica):
    """Normaliza el plan: valores fuera de rango se corrigen, lo imposible se descarta."""
    p = dict(plan or {})
    p["formato"] = p.get("formato") if p.get("formato") in ("vertical", "vertical_recorte", "cuadrado", "original") else "vertical"
    tramos = []
    for t in p.get("tramos") or []:
        a, b = _num(t.get("inicio"), None, 0, duracion), _num(t.get("fin"), None, 0, duracion)
        if a is not None and b is not None and b - a >= 0.5:
            tramos.append({"inicio": round(a, 2), "fin": round(b, 2)})
    p["tramos"] = tramos or [{"inicio": 0.0, "fin": round(duracion, 2)}]
    p["velocidad"] = _num(p.get("velocidad"), 1.0, 0.25, 4.0)
    color = p.get("color") or {}
    p["color"] = {"filtro": color.get("filtro") if color.get("filtro") in FILTROS_COLOR else "ninguno",
                  "brillo": _num(color.get("brillo"), 0.0, -0.3, 0.3)}
    audio = p.get("audio") or {}
    p["audio"] = {"modo": audio.get("modo") if audio.get("modo") in ("original", "silencio", "solo_voz") else "original",
                  "volumen": _num(audio.get("volumen"), 1.0, 0.0, 3.0),
                  "musica": bool(audio.get("musica")) and hay_musica,
                  "volumen_musica": _num(audio.get("volumen_musica"), 0.35, 0.0, 2.0)}
    p["subtitulos"] = bool(p.get("subtitulos"))
    total = sum(t["fin"] - t["inicio"] for t in p["tramos"]) / p["velocidad"]
    textos = []
    for x in p.get("textos") or []:
        texto = str(x.get("texto") or "").strip()
        if not texto:
            continue
        a = _num(x.get("inicio"), 0.0, 0, total)
        b = _num(x.get("fin"), total, 0, total)
        if b - a < 0.3:
            a, b = 0.0, total
        textos.append({"texto": texto[:160], "subtexto": str(x.get("subtexto") or "").strip()[:120], "inicio": a, "fin": b,
                       "animado": x.get("animado") is not False,
                       "posicion": x.get("posicion") if x.get("posicion") in ("arriba", "centro", "abajo") else "arriba",
                       "estilo": x.get("estilo") if x.get("estilo") in ("titular", "rotulo", "simple") else "titular"})
    p["textos"] = textos[:12]
    im = p.get("imagenes") or {}
    usar = [int(i) for i in (im.get("usar") or range(1, n_imagenes + 1)) if str(i).isdigit() and 1 <= int(i) <= n_imagenes]
    tiempos = []
    for x in im.get("tiempos") or []:
        i = int(_num(x.get("imagen"), 0))
        a, b = _num(x.get("inicio"), None, 0, total), _num(x.get("fin"), None, 0, total)
        if 1 <= i <= n_imagenes and a is not None and b is not None and b - a >= 0.5:
            tiempos.append({"imagen": i, "inicio": a, "fin": b})
    p["imagenes"] = {"usar": usar if n_imagenes else [],
                     "estilo": im.get("estilo") if im.get("estilo") in ("recuadro_flotante", "pantalla_completa", "esquina") else "recuadro_flotante",
                     "posicion": im.get("posicion") if im.get("posicion") in ("arriba", "centro", "abajo", "izquierda", "derecha") else "",
                     "tamano": _num(im.get("tamano"), 0.0, 0.15, 1.0),
                     "tiempos": tiempos if n_imagenes else [],
                     "retoque": im.get("retoque") is not False}
    f = p.get("fundido") or {}
    p["fundido"] = {"entrada": _num(f.get("entrada"), 0.0, 0, min(3, total / 3)),
                    "salida": _num(f.get("salida"), 0.0, 0, min(3, total / 3))}
    p["logo"] = p.get("logo") is not False
    for k in ("intro", "cierre"):
        t = p.get(k)
        if isinstance(t, dict) and (k == "cierre" or str(t.get("texto") or "").strip()):
            p[k] = {"texto": str(t.get("texto") or "").strip()[:120], "subtexto": str(t.get("subtexto") or "").strip()[:120],
                    "segundos": _num(t.get("segundos"), 3.0, 1.5, 6.0)}
        else:
            p[k] = None
    p["total"] = round(total, 2)
    return p


def _atempo(v):
    """atempo solo acepta 0.5–2.0 por paso: se encadena."""
    pasos = []
    while v > 2.0:
        pasos.append("atempo=2.0")
        v /= 2.0
    while v < 0.5:
        pasos.append("atempo=0.5")
        v /= 0.5
    pasos.append(f"atempo={v:.4f}")
    return ",".join(pasos)


def _filtro_formato(formato, info):
    if formato == "cuadrado":
        return ("split[a][b];"
                "[a]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,boxblur=25:2,eq=brightness=-0.08[fondo];"
                "[b]scale=1080:1080:force_original_aspect_ratio=decrease[frente];"
                "[fondo][frente]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30"), (1080, 1080)
    return _filtro(formato, info)


def _tiempos_imagenes(p, total):
    im = p["imagenes"]
    if im["tiempos"]:
        return [(x["imagen"], x["inicio"], x["fin"] - x["inicio"]) for x in im["tiempos"]]
    usar = im["usar"]
    if not usar:
        return []
    tramo = total / len(usar)
    dura = max(1.5, min(tramo * 0.8, 7.0, tramo))
    return [(i, k * tramo + (tramo - dura) / 2, dura) for k, i in enumerate(usar)]


def _caja_imagen(estilo, posicion, tamano, W, H, hay_titulo_arriba, hay_subs=False):
    """Tamaño máximo de la caja y expresiones de posición (x, y) para overlay."""
    vertical = H > W
    if estilo == "pantalla_completa":
        return W, H, "0", "0", 0, False
    if estilo == "esquina":
        k = tamano or 0.32
        bw, bh = round(W * k), round(H * k * (0.6 if vertical else 1.0))
        pos = posicion or "derecha"
        m = round(min(W, H) * 0.04)
        x = f"W-w-{m}" if pos != "izquierda" else str(m)
        y = f"H-h-{round(H * (0.24 if hay_subs else 0.12))}" if pos in ("abajo", "derecha", "izquierda", "") else str(round(H * 0.12))
        return bw - bw % 2, bh - bh % 2, x, y, max(3, round(min(W, H) * 0.006)), False
    # recuadro flotante
    k = tamano or (0.70 if vertical else 0.42)
    bw, bh = round(W * k), round(H * (k * 0.46 if vertical else min(0.9, k * 1.48)))
    vaiven = f"+{round(H * 0.008)}*sin(2*PI*t/3.5)"
    pos = posicion or ("abajo" if (vertical and hay_titulo_arriba) else ("arriba" if vertical else "derecha"))
    if pos == "arriba":
        x, y = "(W-w)/2", f"{round(H * 0.11)}{vaiven}"
    elif pos == "abajo":
        x, y = "(W-w)/2", f"H-h-{round(H * 0.09)}{vaiven}"
    elif pos == "centro":
        x, y = "(W-w)/2", f"(H-h)/2{vaiven}"
    elif pos == "izquierda":
        x, y = str(round(W * 0.05)), f"(H-h)/2{vaiven}"
    else:
        x, y = f"W-w-{round(W * 0.05)}", f"(H-h)/2{vaiven}"
    return bw - bw % 2, bh - bh % 2, x, y, max(4, round(min(W, H) * 0.008)), True


def _escribir_ass(ruta, p, frases, tam, conf, hay_subs=False):
    w, h = tam
    k = min(w, h) / 1080
    fuente, marca = conf["fuente"], _color_ass(conf["color"])
    vertical = h > w
    alin = {"arriba": 8, "centro": 5, "abajo": 2}
    abajo = (300 if vertical else 70) + (150 if hay_subs else 0)  # sobre los subtítulos, no encima de ellos
    margen = {"arriba": round((230 if vertical else 50) * k), "centro": 0, "abajo": round(abajo * k)}
    lineas = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Sub,{fuente},{round(66 * k)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,{max(3, round(5 * k))},1,2,{round(70 * k)},{round(70 * k)},{round((300 if vertical else 70) * k)},1",
        f"Style: titular,{fuente},{round(70 * k)},&H00FFFFFF,&H00FFFFFF,{marca},{marca},-1,0,0,0,100,100,0,0,3,{round(14 * k)},0,8,{round(80 * k)},{round(80 * k)},0,1",
        f"Style: rotulo,{fuente},{round(54 * k)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,{round(12 * k)},0,2,{round(60 * k)},{round(60 * k)},0,1",
        f"Style: simple,{fuente},{round(62 * k)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,{max(3, round(5 * k))},1,8,{round(70 * k)},{round(70 * k)},0,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for x in p["textos"]:
        texto = _limpio(x["texto"])
        if x["estilo"] == "titular":
            texto = texto.upper()
        lineas.append(f"Dialogue: 1,{_t(x['inicio'])},{_t(x['fin'])},{x['estilo']},,0,0,{margen[x['posicion']]},,"
                      f"{{\\an{alin[x['posicion']]}}}{texto}")
    for ini, fin, texto in frases:
        lineas.append(f"Dialogue: 0,{_t(ini)},{_t(fin)},Sub,,0,0,0,,{_limpio(texto)}")
    Path(ruta).write_text("\n".join(lineas) + "\n", encoding="utf-8")


def _solo_voz(audio_wav, carpeta, avisar):
    """Separa la voz de la música con Demucs (modelo abierto, corre en la nube de GitHub)."""
    avisar("Instalando el separador de voz (tarda unos minutos la primera vez)")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "torch", "torchaudio",
                    "--index-url", "https://download.pytorch.org/whl/cpu"], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "demucs", "soundfile"], check=True)
    avisar("Separando la voz de la música")
    salida = Path(carpeta) / "separado"
    r = subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(salida), str(audio_wav)],
                       capture_output=True, text=True)
    voz = salida / "htdemucs" / Path(audio_wav).stem / "vocals.wav"
    if r.returncode != 0 or not voz.exists():
        raise RuntimeError("No pude separar la voz de la música (Demucs). " + (r.stderr or "")[-300:])
    return voz


GRAFICOS = Path(__file__).resolve().parent / "graficos"
_remotion = {"listo": None}


def _remotion_listo(avisar):
    """Instala una sola vez el proyecto de gráficos de Remotion. Si falla, la edición sigue con texto fijo."""
    if _remotion["listo"] is not None:
        return _remotion["listo"]
    try:
        if not (GRAFICOS / "node_modules" / "remotion").exists():
            avisar("Preparando los gráficos animados (Remotion)")
            subprocess.run(["npm", "ci", "--no-audit", "--no-fund", "--loglevel=error"], cwd=GRAFICOS, check=True, timeout=600)
        _remotion["listo"] = True
    except Exception as e:  # noqa: BLE001
        print(f"   Remotion no disponible ({type(e).__name__}); uso texto fijo.")
        _remotion["listo"] = False
    return _remotion["listo"]


def _render_grafico(composicion, props, salida, transparente):
    args = ["npx", "remotion", "render", "src/index.ts", composicion, str(salida), "--props=" + json.dumps(props, ensure_ascii=False),
            "--log=error"]
    if transparente:  # guía oficial "transparent-videos": ProRes 4444 con canal alfa
        args += ["--codec=prores", "--prores-profile=4444", "--pixel-format=yuva444p10le", "--image-format=png"]
    else:
        args += ["--codec=h264", "--crf=18"]
    if os.environ.get("REMOTION_NAVEGADOR"):  # solo para pruebas fuera de GitHub
        args.append("--browser-executable=" + os.environ["REMOTION_NAVEGADOR"])
    r = subprocess.run(args, cwd=GRAFICOS, capture_output=True, text=True, timeout=900)
    if r.returncode != 0 or not Path(salida).exists():
        raise RuntimeError("Remotion: " + (r.stderr or r.stdout)[-400:])
    return Path(salida)


def _props(texto, subtexto, posicion, W, H, segundos, conf):
    return {"texto": texto, "subtexto": subtexto, "color": conf.get("color") or "#E30613",
            "medio": conf.get("medio") or "Torre Informativa", "posicion": posicion,
            "ancho": W, "alto": H, "segundos": round(segundos, 2)}


def renderizar_plan(video, plan, imagenes, musica, segmentos, carpeta_trabajo, destino, conf, avisar=print):
    video, destino = Path(video).resolve(), Path(destino).resolve()
    trabajo = Path(carpeta_trabajo).resolve() / "render_plan"
    if trabajo.exists():
        shutil.rmtree(trabajo)
    trabajo.mkdir(parents=True)
    info = info_video(video)
    if info["duracion"] <= 0:
        raise RuntimeError("No pude leer la duración del video.")
    p = validar(plan, info["duracion"], len(imagenes), bool(musica))
    filtro, (W, H) = _filtro_formato(p["formato"], info)
    vel = p["velocidad"]
    color = [FILTROS_COLOR[p["color"]["filtro"]]] if p["color"]["filtro"] in FILTROS_COLOR else []
    if p["color"]["brillo"]:
        color.append(f"eq=brightness={p['color']['brillo']:.2f}")
    cadena_v = filtro + ("," + ",".join(color) if color else "") + (f",setpts=PTS/{vel:.4f}" if vel != 1 else "")
    usa_original = p["audio"]["modo"] != "silencio" and info["tiene_audio"]
    codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]

    # 1. Tramos: cortar, dar formato, color y velocidad
    lista = []
    for i, t in enumerate(p["tramos"], 1):
        if len(p["tramos"]) > 1:
            avisar(f"Preparando tramo {i} de {len(p['tramos'])}")
        nombre = f"tramo_{i:02d}.mp4"
        entrada = ["-ss", f"{t['inicio']:.2f}", "-t", f"{t['fin'] - t['inicio']:.2f}", "-i", str(video)]
        if usa_original:
            fa = "aresample=48000" + ("," + _atempo(vel) if vel != 1 else "")
            mapa = ["-filter_complex", f"[0:v]{cadena_v}[v];[0:a:0]{fa}[a]", "-map", "[v]", "-map", "[a]"]
        else:
            entrada += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            mapa = ["-filter_complex", f"[0:v]{cadena_v}[v]", "-map", "[v]", "-map", "1:a", "-shortest"]
        _ffmpeg(entrada + mapa + codec + [nombre], cwd=str(trabajo))
        lista.append(f"file '{nombre}'")
    (trabajo / "lista.txt").write_text("\n".join(lista) + "\n", encoding="utf-8")
    _ffmpeg(["-f", "concat", "-safe", "0", "-i", "lista.txt", "-c", "copy", "unido.mp4"], cwd=str(trabajo))
    total = info_video(trabajo / "unido.mp4")["duracion"] or p["total"]

    # 2. Audio de voz separado (si se pidió quitar la música y dejar la voz)
    entradas = ["-i", "unido.mp4"]
    audio_base = "[0:a]"
    if p["audio"]["modo"] == "solo_voz" and usa_original:
        _ffmpeg(["-i", "unido.mp4", "-vn", "-ac", "2", "-ar", "44100", "audio.wav"], cwd=str(trabajo))
        voz = _solo_voz(trabajo / "audio.wav", trabajo, avisar)
        entradas += ["-i", str(voz)]
        audio_base = "[1:a]"

    # 3. Imágenes, textos, subtítulos, logo, fundidos y música
    frases = []
    if p["subtitulos"] and segmentos:
        frases, _ = frases_subtitulo(p["tramos"], segmentos)
        frases = [(a / vel, b / vel, x) for a, b, x in frases]
    # Textos animados (Remotion). Si Remotion no está disponible o falla, esos textos salen fijos con ASS.
    animados = []
    if any(x["animado"] for x in p["textos"]) and _remotion_listo(avisar):
        avisar("Animando titulares y rótulos (Remotion)")
        comp = {"titular": "Titular", "rotulo": "Rotulo", "simple": "Simple"}
        for i, x in enumerate([x for x in p["textos"] if x["animado"]], 1):
            try:
                ruta = _render_grafico(comp[x["estilo"]], _props(x["texto"], x["subtexto"], x["posicion"], W, H,
                                       min(x["fin"], total) - x["inicio"], conf), trabajo / f"grafico_{i:02d}.mov", True)
                animados.append((ruta, x["inicio"], min(x["fin"], total)))
                x["hecho"] = True
            except Exception as e:  # noqa: BLE001
                print(f"   Gráfico {i} sin animación ({str(e)[:120]}).")
    hay_titulo_arriba = any(x["posicion"] == "arriba" for x in p["textos"])  # antes de separar los animados
    p["textos"] = [x for x in p["textos"] if not x.get("hecho")]
    partes, ultimo = [], "0:v"
    im = p["imagenes"]
    bw, bh, px, py, borde, zoom = _caja_imagen(im["estilo"], im["posicion"], im["tamano"], W, H, hay_titulo_arriba, bool(frases))
    tiempos = _tiempos_imagenes(p, total)
    if tiempos and im["retoque"]:
        avisar("Retocando las imágenes (luz y color naturales)")
        from retoque import mejorar
        retocadas = list(imagenes)
        for n in sorted({n for n, _, _ in tiempos}):
            try:
                retocadas[n - 1], _, _ = mejorar(imagenes[n - 1], trabajo / f"retocada_{n:02d}")
            except Exception as e:  # noqa: BLE001  una foto rara no detiene la edición
                print(f"   No se pudo retocar la imagen {n} ({type(e).__name__}); va sin retoque.")
        imagenes = retocadas
    if tiempos:
        avisar(f"Animando {len(tiempos)} imágenes")
    for k, (n, ini, dura) in enumerate(tiempos, 1):
        idx = entradas.count("-i")
        entradas += ["-i", str(Path(imagenes[n - 1]).resolve())]
        cuadros = max(1, round(dura * 30))
        f = min(0.45, dura / 4)
        if im["estilo"] == "pantalla_completa":
            ajuste = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,"
            zp = f"zoompan=z='min(1+0.12*on/{cuadros},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={cuadros}:s={W}x{H}:fps=30,"
            marco = ""
        else:
            ajuste = (f"scale={bw - 2 * borde}:{bh - 2 * borde}:force_original_aspect_ratio=decrease,"
                      f"scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,")
            tam = _tam_imagen(imagenes[n - 1], bw - 2 * borde, bh - 2 * borde)
            z = f"min(1+0.10*on/{cuadros},1.10)" if zoom else "1"
            zp = f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={cuadros}:s={tam}:fps=30,"
            marco = f"pad=iw+{2 * borde}:ih+{2 * borde}:{borde}:{borde}:white,"
        partes.append(f"[{idx}:v]{ajuste}{zp}{marco}format=rgba,"
                      f"fade=t=in:st=0:d={f:.2f}:alpha=1,fade=t=out:st={max(0.0, dura - f):.2f}:d={f:.2f}:alpha=1,"
                      f"setpts=PTS-STARTPTS+{ini:.2f}/TB[img{k}]")
        partes.append(f"[{ultimo}][img{k}]overlay=x='{px}':y='{py}':eof_action=pass:"
                      f"enable='between(t,{ini:.2f},{ini + dura:.2f})'[v{k}]")
        ultimo = f"v{k}"

    for k, (ruta, ini, fin) in enumerate(animados, 1):
        idx = entradas.count("-i")
        entradas += ["-i", str(ruta)]
        partes.append(f"[{idx}:v]format=yuva444p,setpts=PTS-STARTPTS+{ini:.2f}/TB[g{k}]")
        partes.append(f"[{ultimo}][g{k}]overlay=0:0:eof_action=pass:enable='between(t,{ini:.2f},{fin:.2f})'[vg{k}]")
        ultimo = f"vg{k}"
    if p["textos"] or frases:
        _escribir_ass(trabajo / "textos.ass", p, frases, (W, H), conf, hay_subs=bool(frases))
        partes.append(f"[{ultimo}]ass=textos.ass[vt]")
        ultimo = "vt"

    logo = Path(conf["logo"]).resolve() if conf.get("logo") and p["logo"] else None
    if logo and logo.exists():
        idx = entradas.count("-i")
        entradas += ["-i", str(logo)]
        ancho_logo = round(min(W, H) * 0.17)
        partes.append(f"[{idx}:v]scale={ancho_logo}:-1[logo]")
        partes.append(f"[{ultimo}][logo]overlay=W-w-{round(ancho_logo * 0.25)}:{round(ancho_logo * 0.25)}[vl]")
        ultimo = "vl"

    fe, fs = p["fundido"]["entrada"], p["fundido"]["salida"]
    fv = []
    if fe:
        fv.append(f"fade=t=in:st=0:d={fe:.2f}")
    if fs:
        fv.append(f"fade=t=out:st={max(0.0, total - fs):.2f}:d={fs:.2f}")
    partes.append(f"[{ultimo}]{','.join(fv) if fv else 'null'}[vfin]")

    vol = p["audio"]["volumen"] if p["audio"]["modo"] != "silencio" else 0.0
    partes.append(f"{audio_base}volume={vol:.2f}[voz]")
    pista = "voz"
    if p["audio"]["musica"]:
        idx = entradas.count("-i")
        entradas += ["-stream_loop", "-1", "-i", str(Path(musica).resolve())]
        fin_m = max(0.0, total - 1.5)
        partes.append(f"[{idx}:a]aresample=48000,volume={p['audio']['volumen_musica']:.2f},atrim=0:{total:.2f},"
                      f"afade=t=out:st={fin_m:.2f}:d=1.5[mus]")
        partes.append("[voz][mus]amix=inputs=2:duration=first:normalize=0[mix]")
        pista = "mix"
    fa = []
    if fe:
        fa.append(f"afade=t=in:st=0:d={fe:.2f}")
    if fs:
        fa.append(f"afade=t=out:st={max(0.0, total - fs):.2f}:d={fs:.2f}")
    partes.append(f"[{pista}]{','.join(fa) if fa else 'anull'}[afin]")

    (trabajo / "filtro.txt").write_text(";\n".join(partes), encoding="utf-8")
    avisar("Montando la versión final")
    _ffmpeg(entradas + ["-filter_complex_script", "filtro.txt", "-map", "[vfin]", "-map", "[afin]", "-t", f"{total:.2f}",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "final.mp4"],
            cwd=str(trabajo))
    final = trabajo / "final.mp4"
    if (p["intro"] or p["cierre"]) and _remotion_listo(avisar):
        try:
            final, total = _tarjetas(final, total, p, W, H, conf, trabajo, avisar)
        except Exception as e:  # noqa: BLE001  sin tarjetas, pero con el video completo
            print(f"   Intro/cierre no disponibles ({str(e)[:160]}).")
    Path(destino).parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(final), str(destino))
    return total


def _tarjetas(final, total, p, W, H, conf, trabajo, avisar):
    """Intro y cierre animados con Remotion, unidos al video con audio en silencio durante las tarjetas."""
    avisar("Animando la intro y el cierre (Remotion)")
    piezas = []
    if p["intro"]:
        i = p["intro"]
        piezas.append(_render_grafico("Tarjeta", _props(i["texto"], i["subtexto"], "centro", W, H, i["segundos"], conf), trabajo / "intro.mp4", False))
    piezas.append(final)
    if p["cierre"]:
        c = p["cierre"]
        piezas.append(_render_grafico("Tarjeta", _props(c["texto"], c["subtexto"], "centro", W, H, c["segundos"], conf), trabajo / "cierre.mp4", False))
    entradas, cadena = [], ""
    for k, pieza in enumerate(piezas):
        entradas += ["-i", str(pieza)]
        if pieza == final:
            cadena += f"[{k}:v]fps=30,format=yuv420p,setsar=1[v{k}];[{k}:a]aresample=48000[a{k}];"
        else:
            dur = info_video(pieza)["duracion"]
            cadena += (f"[{k}:v]scale={W}:{H},fps=30,format=yuv420p,setsar=1[v{k}];"
                       f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.2f}[a{k}];")
    cadena += "".join(f"[v{k}][a{k}]" for k in range(len(piezas))) + f"concat=n={len(piezas)}:v=1:a=1[v][a]"
    salida = trabajo / "con_tarjetas.mp4"
    _ffmpeg(entradas + ["-filter_complex", cadena, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(salida)],
            cwd=str(trabajo))
    return salida, info_video(salida)["duracion"]
