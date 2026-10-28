"""SONNY QUINN — Bravo 3. Ejecuta la guía de cortes y entrega el reel por Telegram."""
import html
import os
import sys
import tempfile
from pathlib import Path

import comun
from editor import info_video, renderizar, renderizar_visual
from plan import renderizar_plan
from nota import renderizar_nota

BASE = Path(__file__).resolve().parent.parent


def main(mision_id):
    t = comun.pedir_trabajo(mision_id)
    comun.reportar(mision_id, "progreso", agente="sonny", texto="Descargando el material")
    carpeta = Path(tempfile.mkdtemp(prefix="sonny_"))
    if t.get("modo") == "nota":
        return editar_nota(mision_id, t, carpeta)
    video = comun.descargar_drive(t["video_id"], carpeta / "video")

    conf = dict(t.get("conf") or {})
    conf.setdefault("fuente", "Liberation Sans")
    conf.setdefault("color", "#E30613")
    conf["segundos_titulo"] = float(conf.get("segundos_titulo") or 0)
    logo = BASE / "marca" / "logo.png"
    conf["logo"] = str(logo) if logo.exists() else ""

    def avisar(texto):
        print(f"   {texto}")
        comun.reportar(mision_id, "progreso", agente="sonny", texto=texto)

    destino = carpeta / "reel.mp4"
    if "modo" not in t:
        raise RuntimeError("La implementación de Apps Script está desactualizada (no envía el plan). "
                           "En Apps Script: Implementar → Administrar implementaciones → ✏️ → Nueva versión → Implementar. "
                           "Luego pulsa Reintentar.")
    if t.get("modo") not in ("plan", "visual") and not t.get("cortes"):
        raise RuntimeError("La misión no trae guía de cortes ni plan de edición. Pulsa Reintentar o vuelve a dar la instrucción.")
    if t.get("modo") in ("plan", "visual"):
        imagenes = []
        for i, img_id in enumerate(t.get("imagenes") or [], 1):
            avisar(f"Descargando imagen {i} de {len(t['imagenes'])}")
            imagenes.append(comun.descargar_drive(img_id, carpeta / f"imagen_{i:02d}"))
        musica = comun.descargar_drive(t["musica"], carpeta / "musica") if t.get("musica") else None
        if t.get("modo") == "visual":
            total = renderizar_visual(video, imagenes, t.get("formato", "vertical"), carpeta, destino, conf,
                                      audio=t.get("audio", "silencio"), titulo=t.get("titulo", ""), avisar=avisar)
        else:
            total = renderizar_plan(video, t.get("plan") or {}, imagenes, musica, t.get("segmentos") or [],
                                    carpeta, destino, conf, avisar=avisar)
    else:
        total = renderizar(video, t["cortes"], t["segmentos"], t.get("titulo", ""), t.get("formato", "vertical"),
                           carpeta, destino, conf, avisar=avisar)

    extra = {}
    if t.get("maestra_url"):
        avisar("Guardando la copia maestra en Drive")
        mid = comun.subir_maestra(t["maestra_url"], destino)
        if mid:
            extra = {"maestra_id": mid, "maestra_mb": round(destino.stat().st_size / 1_048_576, 1)}
        else:
            extra = {"maestra_error": True}

    avisar("Enviando el video a Telegram")
    final = comun.ajustar_peso(destino, total)
    info = info_video(final)
    leyenda = f"🎬 <b>{html.escape(t.get('titulo') or 'Video listo')}</b>\nSonny Quinn: misión cumplida ({total:.0f} s)."
    comun.enviar_video(t["chat_id"], final, leyenda, info["ancho"], info["alto"], total)
    comun.reportar(mision_id, "listo", agente="sonny", duracion=round(total, 1),
                   peso_mb=round(final.stat().st_size / 1_048_576, 1), **extra)


def _conf(t):
    conf = dict(t.get("conf") or {})
    conf.setdefault("fuente", "Liberation Sans")
    conf.setdefault("color", "#E30613")
    conf["segundos_titulo"] = float(conf.get("segundos_titulo") or 0)
    logo = BASE / "marca" / "logo.png"
    conf["logo"] = str(logo) if logo.exists() else ""
    return conf


def editar_nota(mision_id, t, carpeta):
    """Nota con varios clips: entrada, entrevistas, voz en off, apoyos y salida."""
    def avisar(texto):
        print(f"   {texto}")
        comun.reportar(mision_id, "progreso", agente="sonny", texto=texto)

    clips = t.get("clips") or []
    rutas = []
    for i, c in enumerate(clips, 1):
        avisar(f"Descargando clip {i} de {len(clips)}")
        rutas.append(comun.descargar_drive(c["id"], carpeta / f"clip_{i:02d}"))
    imagenes = [comun.descargar_drive(x, carpeta / f"imagen_{i:02d}") for i, x in enumerate(t.get("imagenes") or [], 1)]
    musica = comun.descargar_drive(t["musica"], carpeta / "musica") if t.get("musica") else None
    destino = carpeta / "nota.mp4"
    total = renderizar_nota(rutas, clips, t.get("plan") or {}, imagenes, musica, t.get("segmentos_por_clip") or {},
                            carpeta, destino, _conf(t), avisar=avisar)
    extra = {}
    if t.get("maestra_url"):
        avisar("Guardando la copia maestra en Drive")
        mid = comun.subir_maestra(t["maestra_url"], destino)
        extra = {"maestra_id": mid, "maestra_mb": round(destino.stat().st_size / 1_048_576, 1)} if mid else {"maestra_error": True}
    avisar("Enviando la nota a Telegram")
    final = comun.ajustar_peso(destino, total)
    info = info_video(final)
    leyenda = f"🎬 <b>{html.escape(t.get('titulo') or 'Nota lista')}</b>\nSonny Quinn: nota armada ({total:.0f} s, {len(clips)} clips)."
    comun.enviar_video(t["chat_id"], final, leyenda, info["ancho"], info["alto"], total)
    comun.reportar(mision_id, "listo", agente="sonny", duracion=round(total, 1),
                   peso_mb=round(final.stat().st_size / 1_048_576, 1), **extra)


if __name__ == "__main__":
    mid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MISION_ID", "")
    try:
        main(mid)
    except Exception as e:
        print("   Sonny no pudo completar la edición.")
        comun.reportar(mid, "error", agente="sonny", texto=str(e)[:400])
        sys.exit(1)
