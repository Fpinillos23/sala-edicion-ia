"""Editor: ejecuta la guía de cortes con FFmpeg (formato vertical, subtítulos, título y logo)."""
import json
import shutil
import subprocess
from pathlib import Path

FORMATOS = {
    "1": ("vertical", "Vertical 9:16 con fondo desenfocado (no recorta a nadie)"),
    "2": ("vertical_recorte", "Vertical 9:16 recortando el centro de la imagen"),
    "3": ("original", "Mismo formato del video original"),
}


def _ffmpeg(args, cwd=None):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + args
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("FFmpeg falló:\n" + r.stderr[-1500:])


def info_video(ruta):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(ruta)],
                       capture_output=True, text=True, encoding="utf-8")
    d = json.loads(r.stdout or "{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
    w, h = int(v.get("width", 1920)), int(v.get("height", 1080))
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = abs(int(float(sd["rotation"])))
    if rot in (90, 270):  # videos de celular grabados en vertical
        w, h = h, w
    return {
        "ancho": w, "alto": h,
        "duracion": float(d.get("format", {}).get("duration", 0) or 0),
        "tiene_audio": any(s.get("codec_type") == "audio" for s in d.get("streams", [])),
    }


def _filtro(formato, info):
    if formato == "vertical":
        return ("split[a][b];"
                "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:2,eq=brightness=-0.08[fondo];"
                "[b]scale=1080:1920:force_original_aspect_ratio=decrease[frente];"
                "[fondo][frente]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30"), (1080, 1920)
    if formato == "vertical_recorte":
        return ("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30"), (1080, 1920)
    w, h = info["ancho"] - info["ancho"] % 2, info["alto"] - info["alto"] % 2
    return f"scale={w}:{h},setsar=1,fps=30", (w, h)


# ---------- Subtítulos (formato ASS para controlar tamaño y estilo) ----------

def _color_ass(hexa):
    hexa = (hexa or "#E30613").lstrip("#")
    if len(hexa) != 6:
        hexa = "E30613"
    r, g, b = hexa[0:2], hexa[2:4], hexa[4:6]
    return f"&H00{b}{g}{r}".upper()


def _t(seg):
    seg = max(0.0, seg)
    h, m = int(seg // 3600), int(seg % 3600 // 60)
    return f"{h}:{m:02d}:{seg % 60:05.2f}"


def _limpio(texto):
    return texto.replace("{", "(").replace("}", ")").replace("\n", " ").strip()


def frases_subtitulo(cortes, segmentos, palabras_max=7):
    """Reparte el texto de cada segmento en trozos cortos, re-ubicados en la línea de tiempo del reel."""
    salida, posicion = [], 0.0
    for c in cortes:
        a, b = c["inicio"], c["fin"]
        for s in segmentos:
            if s["fin"] <= a or s["inicio"] >= b:
                continue
            palabras = s["texto"].split()
            if not palabras:
                continue
            paso = (s["fin"] - s["inicio"]) / len(palabras)
            visibles = [(s["inicio"] + paso * (i + 0.5), p) for i, p in enumerate(palabras)]
            visibles = [(t, p) for t, p in visibles if a <= t <= b]
            for i in range(0, len(visibles), palabras_max):
                grupo = visibles[i:i + palabras_max]
                ini = max(a, grupo[0][0] - paso / 2)
                fin = min(b, grupo[-1][0] + paso / 2)
                salida.append((posicion + ini - a, posicion + fin - a, " ".join(p for _, p in grupo)))
        posicion += b - a
    return salida, posicion


def escribir_ass(ruta, frases, titulo, total, tam, fuente, color_marca, segundos_titulo):
    w, h = tam
    k = min(w, h) / 1080
    sub, tit = round(66 * k), round(70 * k)
    margen_sub = round((300 if h > w else 70) * k)
    margen_tit = round((230 if h > w else 50) * k)
    fin_titulo = total if not segundos_titulo else min(total, segundos_titulo)
    lineas = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Sub,{fuente},{sub},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,{max(3, round(5 * k))},1,2,{round(70 * k)},{round(70 * k)},{margen_sub},1",
        f"Style: Titulo,{fuente},{tit},&H00FFFFFF,&H00FFFFFF,{color_marca},{color_marca},-1,0,0,0,100,100,0,0,3,{round(14 * k)},0,8,{round(80 * k)},{round(80 * k)},{margen_tit},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if titulo:
        lineas.append(f"Dialogue: 1,{_t(0)},{_t(fin_titulo)},Titulo,,0,0,0,,{_limpio(titulo).upper()}")
    for ini, fin, texto in frases:
        lineas.append(f"Dialogue: 0,{_t(ini)},{_t(fin)},Sub,,0,0,0,,{_limpio(texto)}")
    Path(ruta).write_text("\n".join(lineas) + "\n", encoding="utf-8")


# ---------- Render ----------

def renderizar(video, cortes, segmentos, titulo, formato, carpeta_trabajo, destino, conf, avisar=print):
    video, destino = Path(video).resolve(), Path(destino).resolve()
    trabajo = Path(carpeta_trabajo).resolve() / "render"
    if trabajo.exists():
        shutil.rmtree(trabajo)
    trabajo.mkdir(parents=True)
    info = info_video(video)
    filtro, tam = _filtro(formato, info)
    codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]

    lista = []
    for i, c in enumerate(cortes, 1):
        avisar(f"Cortando fragmento {i} de {len(cortes)}")
        nombre = f"clip_{i:02d}.mp4"
        entrada = ["-ss", f"{c['inicio']:.2f}", "-i", str(video)]
        if info["tiene_audio"]:
            mapa = ["-filter_complex", f"[0:v]{filtro}[v]", "-map", "[v]", "-map", "0:a:0"]
        else:
            entrada += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            mapa = ["-filter_complex", f"[0:v]{filtro}[v]", "-map", "[v]", "-map", "1:a"]
        _ffmpeg(entrada + ["-t", f"{c['fin'] - c['inicio']:.2f}"] + mapa + codec + [nombre], cwd=str(trabajo))
        lista.append(f"file '{nombre}'")

    (trabajo / "lista.txt").write_text("\n".join(lista) + "\n", encoding="utf-8")
    avisar("Uniendo fragmentos")
    _ffmpeg(["-f", "concat", "-safe", "0", "-i", "lista.txt", "-c", "copy", "unido.mp4"], cwd=str(trabajo))

    avisar("Poniendo subtítulos y titular")
    frases, total = frases_subtitulo(cortes, segmentos)
    escribir_ass(trabajo / "subs.ass", frases, titulo, total, tam,
                 conf["fuente"], _color_ass(conf["color"]), conf["segundos_titulo"])

    logo = Path(conf["logo"]).resolve() if conf.get("logo") else None
    if logo and logo.exists():
        ancho_logo = round(min(tam) * 0.17)
        shutil.copy(logo, trabajo / ("logo" + logo.suffix))
        args = ["-i", "unido.mp4", "-i", "logo" + logo.suffix, "-filter_complex",
                f"[0:v]ass=subs.ass[v];[1:v]scale={ancho_logo}:-1[l];[v][l]overlay=W-w-{round(ancho_logo * 0.25)}:{round(ancho_logo * 0.25)}[o]",
                "-map", "[o]", "-map", "0:a"]
    else:
        args = ["-i", "unido.mp4", "-vf", "ass=subs.ass", "-map", "0:v", "-map", "0:a"]
    _ffmpeg(args + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                    "-c:a", "copy", "-movflags", "+faststart", "final.mp4"], cwd=str(trabajo))

    Path(destino).parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(trabajo / "final.mp4"), str(destino))
    return total


# ---------- Modo visual: video sin voz + imágenes animadas en un recuadro flotante ----------

def _reparto(total, n, maximo=7.0):
    """Reparte n imágenes a lo largo de 'total' segundos, cada una centrada en su tramo."""
    if n <= 0 or total <= 0:
        return []
    tramo = total / n
    dura = max(1.5, min(tramo * 0.8, maximo, tramo))
    return [(i * tramo + (tramo - dura) / 2, dura) for i in range(n)]


def renderizar_visual(video, imagenes, formato, carpeta_trabajo, destino, conf, audio="silencio", titulo="", avisar=print):
    """Quita el audio del video y pone encima las imágenes, una a la vez, en un recuadro que flota.
    Cada imagen entra con un fundido, se acerca despacio (efecto Ken Burns) y sale con otro fundido."""
    video, destino = Path(video).resolve(), Path(destino).resolve()
    trabajo = Path(carpeta_trabajo).resolve() / "render_visual"
    if trabajo.exists():
        shutil.rmtree(trabajo)
    trabajo.mkdir(parents=True)
    info = info_video(video)
    total = info["duracion"]
    if total <= 0:
        raise RuntimeError("No pude leer la duración del video.")
    filtro, (W, H) = _filtro(formato, info)
    vertical = H > W

    # Tamaño máximo del recuadro y posición: arriba al centro en vertical, a la derecha en horizontal.
    bw, bh = (round(W * 0.70), round(H * 0.32)) if vertical else (round(W * 0.42), round(H * 0.62))
    bw, bh = bw - bw % 2, bh - bh % 2
    borde = max(4, round(min(W, H) * 0.008))
    if vertical and titulo:  # con titular arriba, el recuadro flota en la parte de abajo
        pos_x, pos_y = "(W-w)/2", f"H-h-{round(H * 0.09)}+{round(H * 0.008)}*sin(2*PI*t/3.5)"
    elif vertical:
        pos_x, pos_y = "(W-w)/2", f"{round(H * 0.11)}+{round(H * 0.008)}*sin(2*PI*t/3.5)"
    else:
        pos_x, pos_y = f"W-w-{round(W * 0.05)}", f"(H-h)/2+{round(H * 0.012)}*sin(2*PI*t/3.5)"

    entradas = ["-i", str(video)]
    partes = [f"[0:v]{filtro}[base]"]
    reparto = _reparto(total, len(imagenes))
    ultimo = "base"
    for k, (img, (ini, dura)) in enumerate(zip(imagenes, reparto), 1):
        entradas += ["-i", str(Path(img).resolve())]
        cuadros = max(1, round(dura * 30))
        f = 0.45
        partes.append(
            f"[{k}:v]scale={bw - 2 * borde}:{bh - 2 * borde}:force_original_aspect_ratio=decrease,"
            f"scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,"
            f"zoompan=z='min(1+0.10*on/{cuadros},1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={cuadros}:s=WIDTHxHEIGHT:fps=30,"
            f"pad=iw+{2 * borde}:ih+{2 * borde}:{borde}:{borde}:white,format=rgba,"
            f"fade=t=in:st=0:d={f}:alpha=1,fade=t=out:st={max(0.0, dura - f):.2f}:d={f}:alpha=1,"
            f"setpts=PTS-STARTPTS+{ini:.2f}/TB[img{k}]"
        )
        # zoompan necesita el tamaño final explícito: se calcula después de leer la imagen
        partes[-1] = partes[-1].replace("WIDTHxHEIGHT", _tam_imagen(img, bw - 2 * borde, bh - 2 * borde))
        partes.append(f"[{ultimo}][img{k}]overlay=x='{pos_x}':y='{pos_y}':eof_action=pass:"
                      f"enable='between(t,{ini:.2f},{ini + dura:.2f})'[v{k}]")
        ultimo = f"v{k}"

    logo = Path(conf["logo"]).resolve() if conf.get("logo") else None
    if logo and logo.exists():
        entradas += ["-i", str(logo)]
        n = len(imagenes) + 1
        ancho_logo = round(min(W, H) * 0.17)
        partes.append(f"[{n}:v]scale={ancho_logo}:-1[logo]")
        partes.append(f"[{ultimo}][logo]overlay=W-w-{round(ancho_logo * 0.25)}:{round(ancho_logo * 0.25)}[vl]")
        ultimo = "vl"

    if titulo:
        escribir_ass(trabajo / "titulo.ass", [], titulo, total, (W, H), conf["fuente"],
                     _color_ass(conf["color"]), conf.get("segundos_titulo") or 0)
        partes.append(f"[{ultimo}]ass=titulo.ass[vt]")
        ultimo = "vt"

    # Audio: "silencio" = pista muda (Silencio total). "original" conserva el sonido del video.
    if audio == "original" and info["tiene_audio"]:
        mapa_audio = ["-map", "0:a:0"]
    else:
        entradas += ["-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=r=48000:cl=stereo"]
        mapa_audio = ["-map", f"{_indice_ultima(entradas)}:a"]

    (trabajo / "filtro.txt").write_text(";".join(partes), encoding="utf-8")
    avisar(f"Animando {len(imagenes)} imágenes sobre el video" if imagenes else "Quitando el audio del video")
    _ffmpeg(entradas + ["-filter_complex_script", "filtro.txt", "-map", f"[{ultimo}]"] + mapa_audio +
            ["-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "final.mp4"],
            cwd=str(trabajo))
    Path(destino).parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(trabajo / "final.mp4"), str(destino))
    return total


def _indice_ultima(entradas):
    return entradas.count("-i") - 1


def _tam_imagen(img, maxw, maxh):
    """Tamaño (par) que tendrá la imagen al encajarla en el recuadro sin deformarla."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", str(img)], capture_output=True, text=True)
    try:
        w, h = [int(x) for x in r.stdout.strip().split(",")[:2]]
    except ValueError:
        raise RuntimeError("Una de las imágenes no se pudo leer (¿está dañada o no es una imagen?).")
    k = min(maxw / w, maxh / h)
    w2, h2 = int(w * k) // 2 * 2, int(h * k) // 2 * 2
    return f"{max(2, w2)}x{max(2, h2)}"
