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
