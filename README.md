# Centro de Operaciones Bravo — Torre Informativa

Dos departamentos de agentes en el mismo ecosistema, cada uno con su bot de Telegram:

- **Edición (video):** **Jason Hayes** coordina, **Lisa Davis** transcribe, **Mandy Ellis** escribe el guion, **Sonny Quinn** edita y **Ray Perry** revisa.
- **Fotografía:** **Trent Sawyer** planifica, **Clay Spenser** selecciona, **Brock Reynolds** edita y **Eric Blackburn** revisa la calidad.

- `apps-script/` — el cerebro (bot de Telegram, misión, guion con Groq).
- `operador/` — Lisa y Sonny; corren en GitHub Actions con FFmpeg.
- `.github/workflows/operacion.yml` — despierta a Lisa y Sonny; `fotografia.yml` despierta a Clay y a Brock (con Eric).
- `apps-script/Fotografia.gs` — el departamento de fotografía (va en el mismo proyecto de Apps Script).
- `sala/` — sala virtual en vivo (Vercel).
- `marca/` — pon aquí `logo.png` si quieres logo en los reels.

Instalación paso a paso: [INSTALACION.md](INSTALACION.md) (edición) y [INSTALACION-FOTOGRAFIA.md](INSTALACION-FOTOGRAFIA.md) (fotografía).
