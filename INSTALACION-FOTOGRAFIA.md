# Sala de Fotografía IA — Instalación

El Departamento de Fotografía vive en el **mismo ecosistema** que la Sala de Edición: el mismo proyecto de Apps Script, el mismo repositorio de GitHub, la misma clave de Gemini y la misma sala virtual en Vercel. Solo tiene **su propio bot de Telegram**, para que fotos y videos no se mezclen.

| Agente | Función | Dónde trabaja |
|---|---|---|
| **Trent Sawyer** (Bravo 4) | Planifica la sesión (lista de tomas, luz, equipo, cuidados) y convierte tu orden en un plan | Apps Script + Gemini |
| **Clay Spenser** (Bravo 6) | Selecciona las mejores fotos: descarta movidas, quemadas y repetidas; juzga composición, momento y expresión | GitHub Actions + Gemini |
| **Brock Reynolds** (Bravo 5) | Edita: revelado natural, estilo, recortes por formato, logo, protección de identidad | GitHub Actions |
| **Eric Blackburn** (Bravo Actual) | Control de calidad de cada foto antes de que tú la veas | GitHub Actions + Gemini |
| **Tú** (Mando) | Apruebas el plan, la selección y las fotos finales | Telegram |

Requisito: la Sala de Edición ya instalada y funcionando. La instalación toma unos 10 minutos.

---

## 1. Crear el bot de fotografía

1. En Telegram abre **@BotFather** → `/newbot`.
2. Nombre, por ejemplo, *Sala de Fotografía TI*; usuario terminado en `bot`.
3. Copia el **token**. Lo llamaremos `TELEGRAM_TOKEN_FOTOS`. Debe ser un bot distinto al de edición.

## 2. Apps Script (mismo proyecto de la Sala de Edición)

1. Abre tu proyecto *Sala de Edición IA* en https://script.google.com.
2. Reemplaza todo el contenido de **Codigo.gs** por el nuevo `apps-script/Codigo.gs` (trae los enganches del nuevo departamento; versión `2026-10-30.4`).
3. Junto a "Archivos", pulsa **+ → Secuencia de comandos**, llámala **Fotografia** y pega `apps-script/Fotografia.gs`. Guarda.
4. **Configuración del proyecto** → **Propiedades del script** → agrega `TELEGRAM_TOKEN_FOTOS` con el token del paso 1.
5. Elige la función **configurarFotos** y pulsa **Ejecutar**. En el registro debe salir `@tu_bot ✅` y la dirección de la carpeta **Sala de Fotografía IA** en tu Drive.
6. **Implementar → Administrar implementaciones → ✏️ → Versión: Nueva versión → Implementar.** (Sin este paso, Trent te avisará que la versión publicada es vieja.)

No hace falta otro activador: la misma revisión de cada minuto atiende los dos bots.

## 3. GitHub

1. Sube al repositorio los archivos nuevos y modificados (o pídemelo y los subo yo).
2. **Settings → Secrets and variables → Actions → New repository secret**: crea `TELEGRAM_TOKEN_FOTOS` con el mismo token.
   Los demás secretos (`SALA_API`, `SALA_CLAVE`, `GEMINI_API_KEY`) ya están y se comparten.

## 4. Sala virtual (Vercel)

Si Vercel está conectado al repositorio, se actualiza sola al subir los cambios. Verás los dos departamentos: **Edición** (ámbar) y **Fotografía** (azul cianotipo), con el Mando arriba y una sola radio para ambos.

## 5. Primera misión

Abre el bot de fotografía y envía `/start`. El primer chat que lo haga queda como dueño.

---

## Uso diario

1. **Planificar (opcional):** `/sesion` y cuéntale a Trent qué vas a fotografiar, dónde, para qué y con qué equipo. Te devuelve la lista de tomas (⭐ = imprescindibles), luz, equipo, ritmo y cuidados. Clay usará esa lista para seleccionar.
2. **Enviar las fotos:**
   - Como **archivo** (📎 → Archivo) para no perder calidad. Si las mandas como foto, Telegram las comprime y Trent te lo advierte.
   - Más de 20 MB o **RAW** (DNG, CR2, NEF, ARW…): súbelas a **Sala de Fotografía IA › entrada** en Drive y escribe `/drive`. Se ordenan por nombre de archivo, como las numeró la cámara.
   - Hasta 200 fotos por misión. Acepta JPG, PNG, HEIC (iPhone), WEBP, TIFF y RAW.
3. Pulsa **✅ Ya envié todas** y dile a Trent, con tus palabras o en nota de voz 🎙, para qué son. Ejemplos:
   - *«Cobertura de la rueda de prensa del alcalde, las 8 mejores para la nota web, horizontales.»*
   - *«Retratos de la cantante, 5 para Instagram en 4:5, estilo editorial, con el logo.»*
   - *«Serie artística en blanco y negro, escoge 6, proporción original.»*
4. **Apruebas el plan** (▶️ Adelante) o le pides cambios.
5. **Clay** te envía la **hoja de contactos** numerada (seleccionadas en verde, descartadas atenuadas) y explica por qué eligió cada una. Puedes ajustar: *«quita la 4 y la 9, agrega la 15»* o *«quiero 12»*.
6. **Brock** edita, **Eric** revisa, y recibes las vistas previas con el informe de calidad. Apruebas o pides cambios: *«la 2 más clara, la 5 en blanco y negro»* (van directo a Brock, sin repetir la selección).
7. Al aprobar, las fotos quedan en Drive en **sesiones › (fecha · operación) › aprobadas**; los originales siguen intactos en **originales**. Con **📦** te las envía al chat en calidad completa (hasta 20 por vez).

Comandos: `/sesion`, `/drive`, `/listo`, `/estado`, `/reintentar`, `/cancelar`, `/ayuda`.

## Lo que sabe hacer cada uno

- **Clay:** nitidez (por zonas, para no castigar el fondo desenfocado de un retrato), exposición, rostros, repetidas y ráfagas (se queda con la mejor de cada grupo y no rellena con repetidas), y con Gemini: composición, momento, expresión, ojos cerrados y relevancia frente a la lista de tomas.
- **Brock:** revelado natural medido en cada foto (exposición, balance, sombras, luces, contraste, vibrance, nitidez suave) con las reglas de tu skill de retoque; estilos *natural, editorial, cálido, frío, blanco y negro, contraste, vivo, cine, mate*; formatos *original, 4:5, 1:1, 16:9, 9:16, 3:2* con recortes que dejan aire sobre la cabeza; tamaño máximo; logo (`marca/logo.png`); rostros difuminados con mosaico; JPEG de alta calidad en sRGB con autor y derechos.
- **Eric:** proporción correcta, luces quemadas o sombras empastadas por el revelado, que la estructura sea la misma foto (nada regenerado), color de piel (magenta ≤ amarillo), recortes que corten rostros, ausencia de GPS; y con Gemini, una revisión visual de antes y después.

**No sabe hacer:** quitar o agregar objetos o personas, cambiar fondos, suavizar piel, adelgazar o cambiar rasgos, generar imágenes, panorámicas ni HDR.

## Reglas de la casa

- **Ética fotoperiodística:** en una *cobertura* la edición se limita a luz, color, contraste, recorte y blanco y negro. Si pides un estilo fuerte (cine, mate, vivo) para una cobertura, Trent lo cambia a editorial y te lo muestra en el plan.
- **Privacidad:** todas las fotos entregadas salen **sin ubicación GPS** ni datos del teléfono. La carpeta de originales se comparte por enlace solo mientras Clay o Brock trabajan y se cierra al terminar. La sala virtual solo muestra códigos y estados.
- **Rostros difuminados:** la detección automática puede no ver rostros pequeños o muy de perfil, y a veces marca algo que no es un rostro. Revisa siempre las fotos antes de publicarlas cuando la protección de identidad importe (menores, fuentes, víctimas).
- **Gemini gratuito:** en el plan gratuito, Google puede usar lo que envías para mejorar sus productos. No pases por la sala material de fuentes que no deba salir de la redacción. Si Gemini no responde, Clay selecciona solo con medidas técnicas y te lo advierte.
- **Tiempos:** cada operador tarda uno o dos minutos en arrancar en GitHub. Clay le hace a Gemini una consulta por cada 8 fotos candidatas; con muchas fotos, el plan gratuito puede imponer pausas y Clay espera solo. Brock tarda más con RAW de alta resolución.
