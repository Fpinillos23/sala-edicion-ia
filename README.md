# Sala de Edición IA — Torre Informativa

Equipo de agentes que convierte videos en reels desde Telegram:
**Jason Hayes** coordina, **Lisa Davis** transcribe, **Mandy Ellis** escribe el guion y **Sonny Quinn** edita.

- `apps-script/` — el cerebro (bot de Telegram, misión, guion con Groq).
- `operador/` — Lisa y Sonny; corren en GitHub Actions con FFmpeg.
- `.github/workflows/operacion.yml` — despierta a los operadores.
- `sala/` — sala virtual en vivo (Vercel).
- `marca/` — pon aquí `logo.png` si quieres logo en los reels.

Instalación paso a paso: [INSTALACION.md](INSTALACION.md)
