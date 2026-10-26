# Sala de Edición IA en línea — Instalación

Tu sala de edición funciona igual que la sala de redacción: hablas con un bot de Telegram y el equipo trabaja en la nube, gratis.

| Agente | Función | Dónde trabaja |
|---|---|---|
| **Jason Hayes** (Bravo 1) | Coordina la misión y te reporta | Apps Script |
| **Lisa Davis** (Inteligencia) | Transcribe el video | GitHub Actions |
| **Mandy Ellis** (Enlace) | Te pregunta lo que falta y escribe el guion con la guía de cortes | Apps Script + Gemini |
| **Sonny Quinn** (Bravo 3) | Corta, subtitula y te entrega el reel | GitHub Actions |
| **Tú** (Mando) | Apruebas cada guion antes de editar | Telegram |

La instalación toma unos 30 minutos y se hace una sola vez. Sigue el orden: cada paso entrega un dato que necesita el siguiente.

---

## 1. Crear el bot nuevo en Telegram

1. En Telegram abre **@BotFather** y envía `/newbot`.
2. Ponle un nombre (por ejemplo, *Sala de Edición TI*) y un usuario que termine en `bot`.
3. Copia el **token** que te entrega. Lo llamaremos `TELEGRAM_TOKEN`.

## 2. Clave de Gemini

Usa tu clave gratuita de Gemini (se crea en https://aistudio.google.com/apikey). La llamaremos `GEMINI_API_KEY`.

> **Opcional:** si además agregas una clave de Groq como `GROQ_API_KEY` (en GitHub), Lisa transcribirá con Whisper, que da marcas de tiempo más finas que Gemini (Gemini marca al segundo).

## 3. Repositorio en GitHub

1. Crea un repositorio **público** llamado `sala-edicion-ia` (en GitHub: *New repository*).
2. Sube todos los archivos de esta carpeta, incluida la carpeta oculta `.github`. *(Si me das el nombre del repositorio, yo los subo por ti).*
3. Crea la llave para que Apps Script pueda despertar a Lisa y a Sonny:
   - GitHub → tu foto → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
   - *Repository access*: **Only select repositories** → `sala-edicion-ia`.
   - *Permissions* → *Repository permissions* → **Contents: Read and write**.
   - Copia el token. Lo llamaremos `GITHUB_TOKEN`.

## 4. Apps Script (el cerebro)

1. Entra a https://script.google.com y crea un **proyecto nuevo** llamado *Sala de Edición IA*.
2. Borra lo que trae el editor y pega todo el contenido de `apps-script/Codigo.gs`. Guarda.
3. **Implementar** → **Nueva implementación** → tipo **Aplicación web**:
   - *Ejecutar como*: **Yo**
   - *Quién tiene acceso*: **Cualquier persona**
   - Autoriza los permisos que pide Google (Drive y conexiones externas).
   - Copia la **URL de la aplicación web** (termina en `/exec`).
4. **Configuración del proyecto** (engranaje) → **Propiedades del script** → agrega:

   | Propiedad | Valor |
   |---|---|
   | `TELEGRAM_TOKEN` | token del paso 1 |
   | `GEMINI_API_KEY` | clave del paso 2 |
   | `GITHUB_TOKEN` | token del paso 3 |
   | `GITHUB_REPO` | `tu-usuario/sala-edicion-ia` |
   | `URL_WEBAPP` | la URL `/exec` del punto 3 |

5. En el editor, elige la función **configurar** y pulsa **Ejecutar**. En el registro aparecen dos valores: `SALA_CLAVE` y `SALA_API`. Cópialos.

> **Importante:** si algún día cambias el código, actualiza la implementación existente (**Implementar → Administrar implementaciones → editar → Nueva versión**). Así la URL no cambia y no tienes que repetir los pasos 5 y 6.

## 5. Secretos en GitHub

En el repositorio: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Crea estos cuatro:

| Secreto | Valor |
|---|---|
| `TELEGRAM_TOKEN` | token del paso 1 |
| `GEMINI_API_KEY` | clave del paso 2 |
| `SALA_API` | valor que imprimió `configurar` |
| `SALA_CLAVE` | valor que imprimió `configurar` |

GitHub oculta los secretos en los registros públicos.

## 6. Sala virtual en Vercel

1. En el repositorio, edita `sala/config.js` y pega la URL `/exec`:
   ```js
   window.SALA_API = "https://script.google.com/macros/s/.../exec";
   ```
2. En Vercel: **Add New → Project** → importa `sala-edicion-ia`.
3. En *Root Directory* elige **sala**. *Framework Preset*: **Other**. Pulsa **Deploy**.

Si dejas `config.js` vacío, la sala se muestra en modo demostración.

## 7. Primera misión

1. Abre tu bot nuevo y envía `/start`. El primer chat que lo haga queda como dueño de la sala; nadie más podrá usarla.
2. Envía un video corto. Jason abre la misión y Lisa empieza a transcribir.

---

## Uso diario

- **Videos de hasta 20 MB**: envíalos directo al bot.
- **Videos más pesados**: súbelos a la carpeta **Sala de Edición IA › entrada** de tu Drive y escribe `/drive`, o pega el enlace de Drive en el chat.
- **Jason siempre te pide la instrucción, y la instrucción es libre.** Respóndele con tus palabras, por escrito o con una **nota de voz** 🎙, o escríbela en el pie de foto del video. Ejemplos:
  - *"Quítale la música y pon encima las fotos que te mandé."*
  - *"Déjale la voz, quítale la música y ponle subtítulos."*
  - *"Del segundo 10 al 40, en blanco y negro, al doble de rápido, con el titular Festival Vallenato."*
  - *"Pon esta canción de fondo, suave, y un rótulo abajo que diga Fuente: Alcaldía."*
  - *"Haz un reel de 45 segundos con lo que dice el alcalde"* (este va al flujo de Mandy, con preguntas y guion).
- **Material extra**: envía fotos (sueltas o en álbum) y audios de música de fondo antes o después del video.
- Jason convierte tu orden en un **plan de edición** y te lo muestra antes de tocar nada. Si falta algo, pregunta; si pides algo que la sala no sabe hacer, te lo dice. Para corregir, escríbele o mándale una nota de voz con el cambio.
- **Lo que Sonny sabe hacer**: elegir partes del video, cambiar velocidad, formato (vertical, cuadrado, original), color (blanco y negro, cálido, frío, contraste, vivo, brillo), quitar todo el sonido o bajarle el volumen, separar la voz de la música, música de fondo, subtítulos, titulares, rótulos y textos, imágenes (recuadro flotante, pantalla completa o esquina, repartidas o en momentos exactos), fundidos y logo.
- **Lo que todavía no sabe hacer**: unir varios videos, generar imágenes o voces, traducir, ni quitar objetos de la imagen.
- **Separar la voz de la música** usa Demucs, un modelo abierto que corre en GitHub; la primera vez tarda varios minutos más en instalarse.
- En el modo reel, responde las preguntas de Mandy. Si no sabes algo, `/saltar`: quedará como *vacío de información*, nunca se inventa.
- Elige duración y formato, revisa el guion y pulsa **Aprobar y editar** o **Pedir cambios**.
- Sonny te envía el reel al chat. El guion queda en **Sala de Edición IA › salida**.
- **Copia maestra en Drive** (el reel original, sin recomprimir): pídela con el botón **💾 Aprobar + copia maestra en Drive**. En reels de más de 1 minuto se guarda sola. Jason te envía el enlace al terminar. Sonny solo recibe un permiso de subida de un solo uso para ese archivo, nunca acceso a tu Drive.
- Comandos: `/estado`, `/drive`, `/saltar`, `/cancelar`, `/ayuda`.

## Personalizar (Propiedades del script, opcionales)

| Propiedad | Qué hace | Por defecto |
|---|---|---|
| `COLOR_MARCA` | Color del recuadro del titular (#RRGGBB) | `#E30613` |
| `NOMBRE_MEDIO` | Medio que firma los guiones | Torre Informativa |
| `NOMBRE_MANDO` | Tu nombre en la sala virtual | Mando |
| `SEGUNDOS_TITULO` | Cuánto dura el titular (0 = todo el reel) | 0 |
| `MODELO_GEMINI` | Modelo de Gemini para Mandy | `gemini-3.8-flash` |

**Logo**: sube un PNG con fondo transparente al repositorio como `marca/logo.png` y Sonny lo pondrá arriba a la derecha.

## Lo que conviene saber

- **Una misión a la vez**, como en la sala de redacción.
- **Privacidad**: el video se comparte por enlace solo mientras Lisa o Sonny lo procesan, y vuelve a ser privado al terminar o cancelar. La sala virtual solo muestra el código de la operación y el estado de cada agente; nunca titulares, transcripciones ni nombres de archivos. Los registros de GitHub son públicos, por eso los operadores nunca imprimen el contenido de una misión.
- **Tiempos**: cada operador tarda uno o dos minutos en arrancar (prepara FFmpeg en la nube) antes de trabajar.
- **Límites gratuitos**: Telegram deja a los bots descargar archivos de hasta 20 MB y enviar videos de hasta 50 MB (si el reel pesa más, Sonny lo recomprime). Gemini gratuito tiene topes por minuto y por día (los ves en Google AI Studio); si aparece una pausa, la sala espera sola. Las Actions son gratuitas en repositorios públicos.
- **Privacidad de Gemini gratuito**: en el plan gratuito, Google puede usar lo que envías para mejorar sus productos, y personas pueden revisarlo. No pases por la sala material confidencial de fuentes que no deba salir de la redacción.
- **Revisa nombres y cifras en los subtítulos**: Whisper puede escuchar mal algunas palabras.
- Mandy trabaja con lo que **se dice** en el video; no ve la imagen. Para material sin voz (solo música o imágenes), usa el modo visual.
- Las imágenes se guardan en **Sala de Edición IA › imagenes** y, como el video, solo se comparten por enlace mientras Sonny trabaja.
