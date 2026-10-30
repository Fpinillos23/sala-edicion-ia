"""RAY PERRY — Bravo 2, control de calidad. Revisa el video final antes de entregarlo.

Todo se mide con FFmpeg (nada se adivina):
- tramos en negro dentro del video (fuera del primer y último segundo, donde hay fundidos y tarjetas),
- silencios largos cuando el video debería tener sonido,
- volumen integrado (LUFS) frente al estándar de redes (-14),
- duración frente a la que se aprobó,
- que el archivo tenga imagen y sonido y el tamaño esperado.
"""
import re
import subprocess

from editor import info_video


def _ffmpeg_salida(args):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats"] + args + ["-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stderr


def _mmss(t):
    t = max(0.0, float(t))
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def revisar(ruta, duracion_esperada=0.0, con_sonido=True, ancho_alto=None):
    """Devuelve {"ok": bool, "hallazgos": [texto], "lufs": float|None, "duracion": float}."""
    info = info_video(ruta)
    total = info["duracion"]
    hallazgos = []

    if not info.get("tiene_video"):
        hallazgos.append("El archivo no tiene imagen.")
    if ancho_alto and (info["ancho"], info["alto"]) != tuple(ancho_alto):
        hallazgos.append(f"Tamaño {info['ancho']}×{info['alto']}, se esperaba {ancho_alto[0]}×{ancho_alto[1]}.")

    if duracion_esperada and total > 0:
        dif = abs(total - duracion_esperada) / duracion_esperada
        if dif > 0.15:
            hallazgos.append(f"Dura {_mmss(total)} y el plan aprobado decía {_mmss(duracion_esperada)}.")

    # Negros: solo cuentan los que están dentro del video, no los fundidos del principio y del final
    salida = _ffmpeg_salida(["-i", str(ruta), "-vf", "blackdetect=d=0.4:pix_th=0.08", "-an"])
    for ini, fin in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", salida):
        ini, fin = float(ini), float(fin)
        if ini > 1.2 and fin < total - 1.2:
            hallazgos.append(f"Pantalla en negro de {_mmss(ini)} a {_mmss(fin)} ({fin - ini:.1f} s).")

    lufs = None
    if con_sonido:
        if not info["tiene_audio"]:
            hallazgos.append("El video no tiene pista de sonido.")
        else:
            salida = _ffmpeg_salida(["-i", str(ruta), "-vn", "-af", "silencedetect=n=-50dB:d=2.5,ebur128"])
            for ini, fin in re.findall(r"silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)", salida):
                ini, fin = float(ini), float(fin)
                if ini > 1.0 and fin < total - 1.0:
                    hallazgos.append(f"Silencio de {_mmss(ini)} a {_mmss(fin)} ({fin - ini:.1f} s).")
            m = re.findall(r"I:\s+(-?[\d.]+) LUFS", salida)
            if m:
                lufs = float(m[-1])
                if lufs < -20 or lufs > -10:
                    hallazgos.append(f"Volumen fuera de lo normal: {lufs:.1f} LUFS (lo ideal para redes es -14).")

    return {"ok": not hallazgos, "hallazgos": hallazgos[:8], "lufs": lufs, "duracion": round(total, 1)}
