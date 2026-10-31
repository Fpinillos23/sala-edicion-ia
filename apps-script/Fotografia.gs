/**
 * ═══════════════════════════════════════════════════════════════
 *  SALA DE FOTOGRAFÍA IA — Departamento de Fotografía (Google Apps Script)
 * ═══════════════════════════════════════════════════════════════
 *  Vive en el MISMO proyecto de Apps Script que la Sala de Edición (mismo /exec, misma clave, mismo Gemini),
 *  pero habla por un bot de Telegram propio (TELEGRAM_TOKEN_FOTOS) y guarda su propia misión.
 *
 *  Trent Sawyer (Bravo 4) ...... planifica la sesión y convierte tu orden en un plan   ─ aquí, con Gemini
 *  Clay Spenser (Bravo 6) ...... selecciona las mejores fotos                         ─┐ GitHub Actions
 *  Brock Reynolds (Bravo 5) .... edita y retoca (natural, sin regenerar la imagen)     │
 *  Eric Blackburn (Bravo Actual) revisa la calidad antes de mostrártelas               ─┘
 *  Tú (Mando) .................. das el sí final
 */

const AGENTES_FOTO = {
  trent: { nombre: 'Trent Sawyer', alias: 'Bravo 4', rol: 'Planifica la sesión y arma el plan' },
  clay:  { nombre: 'Clay Spenser', alias: 'Bravo 6', rol: 'Selecciona las mejores fotos' },
  brock: { nombre: 'Brock Reynolds', alias: 'Bravo 5', rol: 'Edita y retoca las fotos' },
  eric:  { nombre: 'Eric Blackburn', alias: 'Bravo Actual', rol: 'Control de calidad de las fotos' },
};
const ETAPAS_FOTO = ['Sin misión', 'Planificación', 'Recepción', 'Plan', 'Selección', 'Edición', 'Control', 'Aprobación', 'Entregado'];
const NOMBRES_FOTO = ['Obturador', 'Diafragma', 'Enfoque', 'Contraluz', 'Encuadre', 'Revelado', 'Prisma', 'Iris', 'Silueta', 'Penumbra', 'Horizonte', 'Mochila'];
const LIBRES_FOTO = ['lista', 'cancelada', 'cerrada'];
const OCUPADOS_FOTO = ['seleccionando', 'editando'];
const MAX_FOTOS = 200;              // por misión
const MAX_SELECCION = 30;           // fotos que Brock edita como máximo
const EXT_RAW = /\.(dng|cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|rwl)$/i;
const ESTILOS_FOTO = {
  natural: 'Natural (solo luz y color corregidos)', editorial: 'Editorial (sobrio, algo de contraste, color contenido)',
  calido: 'Cálido', frio: 'Frío', blanco_negro: 'Blanco y negro', contraste: 'Más contraste', vivo: 'Color vivo',
  cine: 'Cine (sombras frías, luces cálidas, suave)', mate: 'Mate (negros levantados, suave)',
};
const FORMATOS_FOTO = {
  original: 'Proporción original', '4:5': 'Vertical 4:5 (feed de Instagram)', '1:1': 'Cuadrado 1:1',
  '16:9': 'Horizontal 16:9 (web, portada)', '9:16': 'Vertical 9:16 (historias)', '3:2': 'Horizontal 3:2 (clásico)',
};

// ───────────────────────── Configuración ─────────────────────────

/** Ejecútala UNA vez después de agregar TELEGRAM_TOKEN_FOTOS en las Propiedades del script. */
function configurarFotos() {
  if (!prop_('TELEGRAM_TOKEN_FOTOS')) throw new Error('Falta la propiedad TELEGRAM_TOKEN_FOTOS (el token del bot nuevo).');
  if (!prop_('CLAVE_SALA') || !prop_('URL_WEBAPP')) throw new Error('Primero debe estar instalada la Sala de Edición (ejecuta configurar).');
  if (prop_('TELEGRAM_TOKEN_FOTOS') === prop_('TELEGRAM_TOKEN')) throw new Error('TELEGRAM_TOKEN_FOTOS debe ser el token de un bot DISTINTO al de la sala de edición.');
  const c = carpetasFoto_();
  const w = tgF_('deleteWebhook', { drop_pending_updates: true });
  P_().deleteProperty('FOTO_TG_OFFSET');
  tgF_('setMyCommands', { commands: [
    { command: 'sesion', description: 'Planificar una sesión de fotos' },
    { command: 'drive', description: 'Usar las fotos de la carpeta entrada de Drive' },
    { command: 'listo', description: 'Ya envié todas las fotos' },
    { command: 'estado', description: 'Cómo va la misión' },
    { command: 'reintentar', description: 'Relanzar a Clay o a Brock si se quedaron atascados' },
    { command: 'cancelar', description: 'Cancelar la misión actual' },
    { command: 'ayuda', description: 'Cómo funciona la sala de fotografía' },
  ] });
  // El activador de la sala de edición (revisarTelegram) también recoge los mensajes de este bot.
  const activadores = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'revisarTelegram').length;
  if (!activadores) ScriptApp.newTrigger('revisarTelegram').timeBased().everyMinutes(1).create();
  if (!prop_('SALA_FOTOS')) salaEventoF_('trent', 'espera', 'Departamento de fotografía instalado.', { mision: null });
  const yo = tgF_('getMe', {});
  Logger.log('Bot de fotografía: ' + (yo.ok ? '@' + yo.result.username + ' ✅' : 'ERROR — revisa TELEGRAM_TOKEN_FOTOS'));
  Logger.log('Recogida de mensajes: ' + (w && w.ok ? 'activa cada minuto (junto con la sala de edición) ✅' : 'ERROR ' + JSON.stringify(w)));
  Logger.log('Trent (Gemini): ' + probarIA_());
  Logger.log('Carpeta de Drive: https://drive.google.com/drive/folders/' + c.base);
  Logger.log('En GitHub agrega el secreto TELEGRAM_TOKEN_FOTOS con el mismo token. Luego envía /start a tu bot nuevo.');
}

function carpetasFoto_() {
  let base = null;
  try { base = prop_('FOTO_CARPETA_ID') ? DriveApp.getFolderById(prop_('FOTO_CARPETA_ID')) : null; } catch (e) { base = null; }
  if (!base) { base = DriveApp.createFolder('Sala de Fotografía IA'); P_().setProperty('FOTO_CARPETA_ID', base.getId()); }
  const sub = { base: base.getId() };
  ['entrada', 'sesiones'].forEach(n => {
    const key = 'FOTO_CARPETA_' + n.toUpperCase();
    let f = null;
    try { f = prop_(key) ? DriveApp.getFolderById(prop_(key)) : null; } catch (e) { f = null; }
    if (!f) { f = base.createFolder(n); P_().setProperty(key, f.getId()); }
    sub[n] = f.getId();
  });
  return sub;
}

function carpetaFoto_(n) {
  const id = prop_('FOTO_CARPETA_' + n.toUpperCase());
  try { if (id) return DriveApp.getFolderById(id); } catch (e) { /* se recrea abajo */ }
  return DriveApp.getFolderById(carpetasFoto_()[n]);
}

// ───────────────────────── Telegram (bot de fotografía) ─────────────────────────

function tgF_(metodo, datos) {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_TOKEN_FOTOS') + '/' + metodo, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(datos || {}), muteHttpExceptions: true,
  });
  let res;
  try { res = JSON.parse(r.getContentText()); } catch (e) { res = { ok: false, description: 'respuesta no válida' }; }
  if (!res.ok) console.error('Telegram (fotos) ' + metodo + ' falló: ' + JSON.stringify(res).slice(0, 300));
  return res;
}

function enviarF_(chat, texto, botones) {
  const partes = [];
  let resto = String(texto);
  while (resto.length > 3900) {
    let corte = resto.lastIndexOf('\n', 3900);
    if (corte < 1000) corte = 3900;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }
  partes.push(resto);
  let r;
  partes.forEach((t, i) => {
    const datos = { chat_id: chat, text: t, parse_mode: 'HTML', disable_web_page_preview: true };
    if (botones && i === partes.length - 1) datos.reply_markup = { inline_keyboard: botones };
    r = tgF_('sendMessage', datos);
    if (r && !r.ok) { delete datos.parse_mode; datos.text = t.replace(/<[^>]+>/g, ''); r = tgF_('sendMessage', datos); }
  });
  return r;
}

function descargarTgF_(fileId) {
  const f = tgF_('getFile', { file_id: fileId });
  if (!f.ok) return null;
  const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN_FOTOS') + '/' + f.result.file_path).getBlob();
  return { blob: blob, ruta: String(f.result.file_path) };
}

/** Una pasada de recogida de mensajes del bot de fotografía. La llama revisarTelegram (ya con el candado tomado). */
function sondearFotos_(espera) {
  if (!prop_('TELEGRAM_TOKEN_FOTOS')) return 0;
  const offset = parseInt(prop_('FOTO_TG_OFFSET', '0'), 10);
  const datos = { timeout: espera || 0, allowed_updates: ['message', 'callback_query'] };
  if (offset) datos.offset = offset;
  const r = tgF_('getUpdates', datos);
  if (!r.ok) return 0;
  const lista = r.result || [];
  lista.forEach(u => {
    P_().setProperty('FOTO_TG_OFFSET', String(u.update_id + 1));
    try { telegramFotos_(u); } catch (err) { avisarErrorF_(err); }
  });
  return lista.length;
}

function avisarErrorF_(err) {
  console.error('Error en la sala de fotografía: ' + (err && err.stack || err));
  const m = misionF_();
  const chat = (m && m.chat) || prop_('FOTO_CHAT_DUENO');
  if (chat) enviarF_(chat, '⚠️ <b>Trent Sawyer</b>: tuvimos un problema.\n<code>' + esc_(String(err.message || err)).slice(0, 600) + '</code>');
}

function telegramFotos_(u) {
  if (u.callback_query) return botonF_(u.callback_query);
  const msg = u.message;
  if (!msg || !msg.chat) return;
  const chat = String(msg.chat.id);
  const texto = String(msg.text || msg.caption || '').trim();
  const dueno = prop_('FOTO_CHAT_DUENO');
  if (!dueno) {
    if (/^\/start/.test(texto)) { P_().setProperty('FOTO_CHAT_DUENO', chat); bienvenidaF_(chat); }
    return;
  }
  if (chat !== dueno) { enviarF_(chat, 'Esta sala de fotografía es privada.'); return; }

  if (/^\/(start|ayuda)/.test(texto)) return bienvenidaF_(chat);
  if (/^\/estado/.test(texto)) return estadoF_(chat);
  if (/^\/cancelar/.test(texto)) return cancelarF_(chat);
  if (/^\/sesion/i.test(texto)) return abrirSesionF_(chat, texto.replace(/^\/sesion\S*\s*/i, ''));
  if (/^\/drive/.test(texto)) return importarDriveF_(chat);
  if (/^\/listo/.test(texto)) { const ml = misionF_(); return recibiendoF_(ml) ? fotosListasF_(chat, ml) : enviarF_(chat, 'No estoy recibiendo fotos ahora mismo.'); }
  if (/^\/reintentar/.test(texto)) return reintentarF_(chat);

  if (msg.voice) return notaDeVozF_(chat, msg.voice);
  const archivo = archivoFotoDe_(msg);
  if (archivo) return recibirFotoF_(chat, msg, archivo, texto);
  if (msg.video || (msg.document && /^video\//.test(msg.document.mime_type || ''))) {
    return enviarF_(chat, '🎬 <b>Trent Sawyer</b>: los videos van a la Sala de Edición (tu otro bot). Aquí trabajamos fotos.');
  }
  if (msg.document) return enviarF_(chat, '⚠️ Ese archivo no parece una foto. Acepto JPG, PNG, HEIC, WEBP, TIFF y RAW (DNG, CR2, NEF, ARW…).');
  return textoLibreF_(chat, texto);
}

/** Devuelve el archivo de foto de un mensaje: foto comprimida de Telegram o documento (mejor calidad). */
function archivoFotoDe_(msg) {
  if (msg.photo && msg.photo.length) return Object.assign({ comprimida: true }, msg.photo[msg.photo.length - 1]);
  const d = msg.document;
  if (d && (/^image\//.test(d.mime_type || '') || EXT_RAW.test(d.file_name || ''))) return Object.assign({ comprimida: false }, d);
  return null;
}

function bienvenidaF_(chat) {
  enviarF_(chat, '📷 <b>Sala de Fotografía IA</b> — ' + esc_(prop_('NOMBRE_MEDIO', 'Torre Informativa')) + '\n\n' +
    '<b>Trent Sawyer</b> (Bravo 4) planifica la sesión y arma el plan.\n' +
    '<b>Clay Spenser</b> (Bravo 6) selecciona las mejores fotos.\n' +
    '<b>Brock Reynolds</b> (Bravo 5) las edita, con retoque natural.\n' +
    '<b>Eric Blackburn</b> (Bravo Actual) revisa la calidad.\n' +
    '<b>Tú</b> das el sí final.\n\n' +
    '<b>Cómo se usa</b>\n' +
    '1. (Opcional) <code>/sesion</code> y cuéntame qué vas a fotografiar: Trent te arma la lista de tomas.\n' +
    '2. Envíame las fotos <b>como archivo</b> (📎 → Archivo) para no perder calidad. Si son más de 20 MB o RAW, súbelas a <b>Sala de Fotografía IA › entrada</b> en Drive y escribe <code>/drive</code>.\n' +
    '3. Pulsa <b>✅ Ya envié todas</b> y dime, con tus palabras o en nota de voz 🎙, para qué son y qué quieres.\n' +
    '4. Apruebas el plan, revisas la selección de Clay y, al final, apruebas las fotos editadas.\n\n' +
    'Comandos: /sesion /drive /listo /estado /reintentar /cancelar /ayuda');
}

function estadoF_(chat) {
  const m = misionF_();
  if (!m || LIBRES_FOTO.indexOf(m.estado) >= 0) return enviarF_(chat, '📷 Sin misión activa. Envíame fotos o escribe /sesion.');
  enviarF_(chat, '📷 <b>' + esc_(m.codigo) + '</b> · ' + (m.n || 0) + ' fotos · estado: <b>' + esc_(textoEstadoF_(m.estado)) + '</b>');
}

function textoEstadoF_(e) {
  return ({ brief: 'Trent espera los detalles de la sesión', esperando_fotos: 'esperando las fotos', recibiendo: 'recibiendo fotos',
    instruccion: 'esperando tu instrucción', plan: 'esperando tu aprobación del plan', seleccionando: 'Clay está seleccionando',
    seleccion: 'esperando tu revisión de la selección', editando: 'Brock está editando y Eric revisa', aprobacion: 'esperando tu aprobación final',
    error: 'con un error', lista: 'entregada', cancelada: 'cancelada', cerrada: 'cerrada' })[e] || e;
}

function cancelarF_(chat) {
  const m = misionF_();
  if (!m || LIBRES_FOTO.indexOf(m.estado) >= 0) return enviarF_(chat, 'No hay misión activa.');
  m.estado = 'cancelada'; guardarMisionF_(m);
  cerrarAccesoF_(m);
  salaEventoF_('trent', 'espera', 'Misión cancelada por el mando.', { mision: resumenSalaF_(m, 0) });
  enviarF_(chat, '❌ Misión <b>' + esc_(m.codigo) + '</b> cancelada. Las fotos siguen en Drive, en su carpeta de sesión.');
}

// ───────────────────────── Misión ─────────────────────────

function nuevaMisionF_(chat) {
  const anterior = misionF_();
  if (anterior && LIBRES_FOTO.indexOf(anterior.estado) < 0 && anterior.estado !== 'error') return null;
  const num = parseInt(prop_('FOTO_CONTADOR', '0'), 10) + 1;
  P_().setProperty('FOTO_CONTADOR', String(num));
  const codigo = 'Operación ' + NOMBRES_FOTO[(num - 1) % NOMBRES_FOTO.length] + '-' + ('0' + num).slice(-2);
  const fecha = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd');
  const carpeta = carpetaFoto_('sesiones').createFolder(fecha + ' · ' + codigo);
  const m = {
    id: Utilities.getUuid().slice(0, 8), codigo: codigo, chat: chat, estado: 'recibiendo', creada: Date.now(),
    carpeta: carpeta.getId(), originales: carpeta.createFolder('originales').getId(), editadas: carpeta.createFolder('editadas').getId(),
    instruccion: '', n: 0, comprimidas: 0, compartidas: [],
  };
  guardarMisionF_(m);
  guardarDatosF_({ fotos: [] });
  return m;
}

function fotos_(n) { return n + (n === 1 ? ' foto' : ' fotos'); }

function misionF_() { try { return JSON.parse(prop_('FOTO_MISION', 'null')); } catch (e) { return null; } }
function guardarMisionF_(m) { P_().setProperty('FOTO_MISION', JSON.stringify(m)); }

/* Datos grandes (lista de fotos, plan, ranking): en trozos de 8 KB, porque una propiedad solo guarda 9 KB. */
function leerDatosF_() {
  const props = P_().getProperties();
  const n = parseInt(props.FOTO_DATOS_N || '0', 10);
  let txt = '';
  for (let i = 0; i < n; i++) txt += props['FOTO_DATOS_' + i] || '';
  try { return JSON.parse(txt || '{}'); } catch (e) { console.error('Datos de fotografía dañados: ' + e); return {}; }
}

function guardarDatosF_(datos) {
  const txt = JSON.stringify(datos || {});
  const anterior = parseInt(prop_('FOTO_DATOS_N', '0'), 10);
  const nuevas = {};
  let n = 0;
  for (let i = 0; i < txt.length; i += 8000) nuevas['FOTO_DATOS_' + (n++)] = txt.slice(i, i + 8000);
  nuevas.FOTO_DATOS_N = String(n);
  P_().setProperties(nuevas);
  for (let i = n; i < anterior; i++) P_().deleteProperty('FOTO_DATOS_' + i);
}

function agregarInstruccionF_(m, texto) {
  texto = String(texto || '').trim();
  if (!texto) return;
  m.instruccion = (m.instruccion ? m.instruccion + '\n' : '') + texto.slice(0, 1200);
  if (m.instruccion.length > 3000) m.instruccion = m.instruccion.slice(-3000);
}

// ───────────────────────── Trent Sawyer: plan de la sesión ─────────────────────────

const _FS = { type: 'string' }, _FN = { type: 'number' }, _FB = { type: 'boolean' };
const _FLISTA = { type: 'array', items: _FS };

const ESQUEMA_SESION = {
  type: 'object',
  properties: {
    titulo: _FS,
    tipo: { type: 'string', enum: ['cobertura', 'estudio', 'redes', 'artistica'] },
    objetivo: _FS,
    tomas: { type: 'array', items: { type: 'object', properties: { toma: _FS, detalle: _FS, obligatoria: _FB }, required: ['toma', 'detalle', 'obligatoria'] } },
    luz: _FLISTA, equipo: _FLISTA, ritmo: _FLISTA, cuidados: _FLISTA,
    entrega: { type: 'object', properties: { cantidad: _FN, formatos: _FLISTA, estilo: _FS }, required: ['cantidad', 'formatos', 'estilo'] },
    pendientes: _FLISTA,
  },
  required: ['titulo', 'tipo', 'objetivo', 'tomas', 'luz', 'equipo', 'ritmo', 'cuidados', 'entrega', 'pendientes'],
};

function sistemaTrent_() {
  return 'Eres TRENT SAWYER (Bravo 4), jefe del departamento de fotografía de ' + prop_('NOMBRE_MEDIO', 'Torre Informativa') +
    ', un medio periodístico de Valledupar (Colombia). Planificas sesiones de fotos y conviertes las instrucciones del fotógrafo en planes ejecutables.\n' +
    'Trabajas cuatro tipos de encargo: cobertura periodística, sesión de estudio (retrato, producto), redes sociales y fotografía artística.\n' +
    'Reglas:\n' +
    '1. Usa solo lo que el fotógrafo te dice. No inventes nombres, cargos, lugares, horarios ni datos del evento; si algo falta y es importante, anótalo en "pendientes" o "pregunta".\n' +
    '2. Ética fotoperiodística: en una COBERTURA la edición se limita a luz, color, contraste, recorte y blanco y negro. Nunca se agregan, quitan ni mueven elementos de la escena. Si el fotógrafo pide un estilo fuerte para una cobertura, propón el natural o editorial y explica por qué.\n' +
    '3. Retoque de personas: se preserva la identidad, la anatomía y la textura de la piel. Nada de suavizar piel, adelgazar, cambiar rasgos ni regenerar la imagen.\n' +
    '4. Cuidados: recuerda pedir consentimiento a quien se retrata cuando aplique, con especial cuidado con niños, niñas y adolescentes; no des asesoría legal específica.\n' +
    '5. Escribe en español de Colombia, claro y breve. Responde solo en JSON válido.';
}

function abrirSesionF_(chat, detalle) {
  let m = misionF_();
  if (m && LIBRES_FOTO.indexOf(m.estado) < 0 && m.estado !== 'error') {
    if (m.estado !== 'recibiendo' && m.estado !== 'esperando_fotos' && m.estado !== 'brief') {
      return enviarF_(chat, '📷 Hay una misión en curso (<b>' + esc_(m.codigo) + '</b>). Termínala o escribe /cancelar antes de planificar otra.');
    }
  } else {
    m = nuevaMisionF_(chat);
  }
  m.estado = 'brief'; guardarMisionF_(m);
  salaEventoF_('trent', 'trabajando', 'Recibiendo el encargo de una sesión.', { mision: resumenSalaF_(m, 1) });
  if (detalle) return planSesionF_(chat, m, detalle);
  enviarF_(chat, '🗺 <b>Trent Sawyer</b>: cuéntame la sesión, por escrito o en nota de voz 🎙:\n' +
    '• ¿Qué es? (evento, retrato, producto, publicación para redes, proyecto artístico)\n' +
    '• ¿Dónde y cuándo? ¿Interior o exterior?\n' +
    '• ¿Para qué se van a usar las fotos y cuántas necesitas?\n' +
    '• ¿Con qué equipo cuentas?');
}

function planSesionF_(chat, m, texto) {
  agregarInstruccionF_(m, texto);
  guardarMisionF_(m);
  tgF_('sendChatAction', { chat_id: chat, action: 'typing' });
  salaEventoF_('trent', 'trabajando', 'Armando la lista de tomas.', { mision: resumenSalaF_(m, 1) });
  const p = gemini_(sistemaTrent_(), 'Arma el plan de esta sesión de fotos a partir de lo que dice el fotógrafo.\n' +
    'Incluye entre 6 y 14 tomas concretas (encuadre, momento o detalle), marcando cuáles son imprescindibles.\n' +
    'En "luz", "equipo", "ritmo" y "cuidados" da indicaciones prácticas y breves (máximo 5 cada una). ' +
    'En "entrega" propone cuántas fotos finales, formatos (original, 4:5, 1:1, 16:9, 9:16, 3:2) y estilo (' + Object.keys(ESTILOS_FOTO).join(', ') + ').\n\n' +
    'Lo que dice el fotógrafo:\n«' + m.instruccion + '»', { rapido: true, esquema: ESQUEMA_SESION });
  const d = leerDatosF_(); d.plan_sesion = p; guardarDatosF_(d);
  m.estado = 'esperando_fotos'; m.plan_sesion = true; guardarMisionF_(m);
  salaEventoF_('trent', 'listo', 'Plan de sesión entregado: ' + (p.tomas || []).length + ' tomas.', { mision: resumenSalaF_(m, 1) });
  const lista = (titulo, xs) => xs && xs.length ? '\n<b>' + titulo + '</b>\n' + xs.map(x => '• ' + esc_(x)).join('\n') : '';
  enviarF_(chat, '🗺 <b>Trent Sawyer</b> · Plan de sesión: <b>' + esc_(p.titulo || 'Sesión') + '</b>\n' +
    '<i>' + esc_(p.objetivo || '') + '</i>\n\n<b>Lista de tomas</b>\n' +
    (p.tomas || []).map((t, i) => (i + 1) + '. ' + (t.obligatoria ? '⭐ ' : '') + '<b>' + esc_(t.toma) + '</b> — ' + esc_(t.detalle)).join('\n') +
    lista('Luz', p.luz) + lista('Equipo', p.equipo) + lista('Ritmo de trabajo', p.ritmo) + lista('Cuidados', p.cuidados) +
    '\n<b>Entrega propuesta</b>\n• ' + (p.entrega ? (p.entrega.cantidad || '?') + ' fotos · ' + esc_((p.entrega.formatos || []).join(', ')) + ' · estilo ' + esc_(p.entrega.estilo || 'natural') : '') +
    lista('Me falta saber', p.pendientes) +
    '\n\n⭐ = imprescindible. Cuando tengas las fotos, envíamelas aquí (como archivo) o súbelas a Drive y escribe /drive. Clay usará esta lista para seleccionar.');
}

// ───────────────────────── Recepción de fotos ─────────────────────────

function recibirFotoF_(chat, msg, archivo, texto) {
  if ((archivo.file_size || 0) > LIMITE_TELEGRAM) {
    return enviarF_(chat, '📦 <b>Trent Sawyer</b>: esa foto pasa de 20 MB, el máximo que un bot puede descargar. Súbela a <b>Sala de Fotografía IA › entrada</b> en Drive y escribe /drive.');
  }
  let m = misionF_();
  if (!m || LIBRES_FOTO.indexOf(m.estado) >= 0 || m.estado === 'error') m = nuevaMisionF_(chat);
  if (!m) return enviarF_(chat, '📷 Hay una misión en curso. Escribe /cancelar si quieres empezar otra.');
  if (['brief', 'esperando_fotos', 'recibiendo', 'instruccion'].indexOf(m.estado) < 0) {
    return enviarF_(chat, '📷 La misión <b>' + esc_(m.codigo) + '</b> ya está ' + esc_(textoEstadoF_(m.estado)) + '. Escribe /cancelar si quieres empezar otra.');
  }
  if ((m.n || 0) >= MAX_FOTOS) return enviarF_(chat, '📦 Ya tengo ' + MAX_FOTOS + ' fotos, el máximo por misión. Pulsa /listo para seguir.');
  const d = descargarTgF_(archivo.file_id);
  if (!d) return enviarF_(chat, '⚠️ No pude recibir esa foto de Telegram. Envíala de nuevo, por favor.');
  const ext = (d.ruta.match(/\.(\w{3,4})$/) || [0, 'jpg'])[1];
  const n = (m.n || 0) + 1;
  const nombre = archivo.file_name || ('foto_' + ('00' + n).slice(-3) + '.' + ext);
  const guardada = DriveApp.getFolderById(m.originales).createFile(d.blob.setName(('00' + n).slice(-3) + '_' + nombre));
  const datos = leerDatosF_();
  datos.fotos = (datos.fotos || []).concat([{ n: n, id: guardada.getId(), nombre: nombre.slice(0, 60), comprimida: !!archivo.comprimida }]);
  guardarDatosF_(datos);
  m.n = n; if (archivo.comprimida) m.comprimidas = (m.comprimidas || 0) + 1;
  if (m.estado !== 'recibiendo') { m.estado_previo = m.estado; m.estado = 'recibiendo'; }
  if (texto) agregarInstruccionF_(m, texto);
  guardarMisionF_(m);
  salaEventoF_('trent', 'trabajando', 'Recibiendo material: ' + fotos_(n) + '.', { mision: resumenSalaF_(m, 2) });
  avisarRecepcionF_(chat, m, msg.media_group_id, !!archivo.comprimida);
}

/** Responde una sola vez por álbum, y como máximo una vez cada 25 s si llegan fotos sueltas. */
function avisarRecepcionF_(chat, m, grupo, comprimida) {
  const cache = CacheService.getScriptCache();
  const llave = grupo ? 'falbum_' + grupo : 'faviso';
  if (cache.get(llave)) return;
  cache.put(llave, '1', grupo ? 600 : 25);
  const aviso = comprimida && !cache.get('faviso_comp') ? (cache.put('faviso_comp', '1', 3600), '\n💡 Llegaron como <b>foto</b> y Telegram las comprime. Para la máxima calidad, envíalas como <b>archivo</b> (📎 → Archivo).') : '';
  enviarF_(chat, '📥 <b>Trent Sawyer</b>: recibiendo (' + fotos_(m.n) + ' en <b>' + esc_(m.codigo) + '</b>). Cuando termines, pulsa el botón.' + aviso,
    [[{ text: '✅ Ya envié todas', callback_data: 'f:listo' }]]);
}

/** /drive: trae a la misión las fotos que estén en la carpeta "entrada", en orden de nombre (el de la cámara). */
function importarDriveF_(chat) {
  let m = misionF_();
  if (!m || LIBRES_FOTO.indexOf(m.estado) >= 0 || m.estado === 'error') m = nuevaMisionF_(chat);
  if (!m || ['brief', 'esperando_fotos', 'recibiendo', 'instruccion'].indexOf(m.estado) < 0) {
    return enviarF_(chat, '📷 Hay una misión en otra etapa. Escribe /cancelar si quieres empezar otra.');
  }
  const it = carpetaFoto_('entrada').getFiles();
  const lista = [];
  while (it.hasNext()) {
    const f = it.next();
    if (/^image\//.test(f.getMimeType()) || EXT_RAW.test(f.getName())) lista.push(f);
  }
  if (!lista.length) {
    return enviarF_(chat, '📂 La carpeta <b>Sala de Fotografía IA › entrada</b> está vacía. Sube ahí las fotos (JPG, HEIC, PNG o RAW) y vuelve a escribir /drive.\n' +
      'https://drive.google.com/drive/folders/' + carpetasFoto_().entrada);
  }
  lista.sort((a, b) => a.getName().localeCompare(b.getName(), 'es', { numeric: true }));
  const destino = DriveApp.getFolderById(m.originales);
  const datos = leerDatosF_();
  datos.fotos = datos.fotos || [];
  let n = m.n || 0, movidas = 0;
  for (let i = 0; i < lista.length && n < MAX_FOTOS; i++) {
    n++; movidas++;
    lista[i].moveTo(destino);
    datos.fotos.push({ n: n, id: lista[i].getId(), nombre: lista[i].getName().slice(0, 60), comprimida: false });
  }
  guardarDatosF_(datos);
  m.n = n; if (m.estado !== 'recibiendo') { m.estado_previo = m.estado; m.estado = 'recibiendo'; }
  guardarMisionF_(m);
  salaEventoF_('trent', 'trabajando', 'Material de Drive recibido: ' + n + ' fotos.', { mision: resumenSalaF_(m, 2) });
  enviarF_(chat, '📂 <b>Trent Sawyer</b>: traje ' + movidas + ' fotos de Drive a la misión <b>' + esc_(m.codigo) + '</b> (' + n + ' en total).' +
    (lista.length > movidas ? '\n⚠️ Quedaron ' + (lista.length - movidas) + ' en entrada: el máximo por misión es ' + MAX_FOTOS + '.' : ''),
    [[{ text: '✅ Son todas', callback_data: 'f:listo' }]]);
}

function recibiendoF_(m) { return !!m && (m.estado === 'recibiendo' || (m.estado === 'esperando_fotos' && m.n > 0)); }

function fotosListasF_(chat, m) {
  if (!m.n) return enviarF_(chat, '📷 Todavía no tengo fotos en esta misión.');
  if (m.instruccion && (m.plan_sesion || m.instruccion.length > 8)) return planificarF_(chat, m);
  m.estado = 'instruccion'; guardarMisionF_(m);
  salaEventoF_('trent', 'espera', 'Esperando la orden del mando.', { mision: resumenSalaF_(m, 3) });
  enviarF_(chat, '🗺 <b>Trent Sawyer</b>: tengo ' + m.n + ' fotos. ¿Para qué son y qué quieres? Dímelo con tus palabras o en nota de voz 🎙. Por ejemplo:\n' +
    '• <i>«Cobertura de la rueda de prensa del alcalde, elige las 8 mejores para la nota web, horizontales.»</i>\n' +
    '• <i>«Sesión de retrato de la cantante, 5 fotos para Instagram en 4:5, estilo editorial, con el logo.»</i>\n' +
    '• <i>«Serie artística en blanco y negro, escoge 6 y déjalas en su proporción original.»</i>');
}

function notaDeVozF_(chat, voz) {
  if (!prop_('GEMINI_API_KEY')) return enviarF_(chat, '🎙 Para entender notas de voz necesito la clave de Gemini. Por ahora, escríbemelo.');
  if ((voz.file_size || 0) > LIMITE_TELEGRAM) return enviarF_(chat, '🎙 Esa nota de voz es muy larga. ¿Me la escribes?');
  let texto = '';
  try {
    const d = descargarTgF_(voz.file_id);
    tgF_('sendChatAction', { chat_id: chat, action: 'typing' });
    const r = gemini_('Transcribes notas de voz en español de Colombia, palabra por palabra, sin resumir ni agregar nada.', [
      { inline_data: { mime_type: voz.mime_type || 'audio/ogg', data: Utilities.base64Encode(d.blob.getBytes()) } },
      { text: 'Transcribe esta nota de voz. Devuelve JSON: {"texto": "lo que dice"}' }]);
    texto = String((r && r.texto) || '').trim();
  } catch (e) { console.error('Nota de voz (fotos): ' + (e.message || e)); }
  if (!texto) return enviarF_(chat, '🎙 No logré entender la nota de voz. ¿Me la repites o me la escribes?');
  enviarF_(chat, '🎙 Entendí: <i>«' + esc_(texto.slice(0, 600)) + '»</i>');
  textoLibreF_(chat, texto);
}

function textoLibreF_(chat, texto) {
  if (!texto) return;
  const m = misionF_();
  if (!m || LIBRES_FOTO.indexOf(m.estado) >= 0) {
    return enviarF_(chat, '📷 Envíame las fotos (mejor como archivo) o escribe /sesion para planificar una sesión. /ayuda para más.');
  }
  switch (m.estado) {
    case 'brief': return planSesionF_(chat, m, texto);
    case 'esperando_fotos':
      agregarInstruccionF_(m, texto); guardarMisionF_(m);
      return enviarF_(chat, '📝 Anotado para el plan. Ahora envíame las fotos.');
    case 'recibiendo':
      agregarInstruccionF_(m, texto); guardarMisionF_(m);
      return enviarF_(chat, '📝 Anotado. ¿Ya enviaste todas las fotos?', [[{ text: '✅ Ya envié todas', callback_data: 'f:listo' }]]);
    case 'instruccion':
      agregarInstruccionF_(m, texto); guardarMisionF_(m);
      return planificarF_(chat, m);
    case 'plan':
      return planificarF_(chat, m, texto);
    case 'seleccion':
      return cambiarSeleccionF_(chat, m, texto);
    case 'aprobacion':
      return pedirCambiosF_(chat, m, texto);
    case 'error':
      return enviarF_(chat, '⚠️ La misión quedó con un error. Escribe /reintentar o /cancelar.');
    default:
      return enviarF_(chat, '⏳ El equipo está trabajando (' + esc_(textoEstadoF_(m.estado)) + '). Te aviso apenas termine.');
  }
}

// ───────────────────────── Trent Sawyer: plan de selección y edición ─────────────────────────

const ESQUEMA_PLAN_FOTO = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['cobertura', 'estudio', 'redes', 'artistica'] },
    resumen: _FS,
    cantidad: _FN,
    tomas: { type: 'array', items: { type: 'object', properties: { descripcion: _FS, obligatoria: _FB }, required: ['descripcion', 'obligatoria'] } },
    criterios: _FLISTA,
    estilo: { type: 'string', enum: Object.keys(ESTILOS_FOTO) },
    intensidad: { type: 'string', enum: ['suave', 'media'] },
    formatos: { type: 'array', items: { type: 'string', enum: Object.keys(FORMATOS_FOTO) } },
    lado_max: _FN,
    logo: _FB,
    difuminar_rostros: _FB,
    sin_retoque: _FB,
    por_foto: { type: 'array', items: { type: 'object', properties: {
      n: _FN, estilo: { type: ['string', 'null'], enum: Object.keys(ESTILOS_FOTO).concat([null]) },
      formatos: { type: ['array', 'null'], items: { type: 'string', enum: Object.keys(FORMATOS_FOTO) } },
      exposicion: { type: ['number', 'null'] }, temperatura: { type: ['number', 'null'] }, nota: { type: ['string', 'null'] } }, required: ['n'] } },
    no_puede: _FLISTA,
    pregunta: { type: ['string', 'null'] },
  },
  required: ['tipo', 'resumen', 'cantidad', 'tomas', 'criterios', 'estilo', 'intensidad', 'formatos', 'lado_max', 'logo', 'difuminar_rostros', 'sin_retoque', 'por_foto', 'no_puede', 'pregunta'],
};

const CAPACIDADES_FOTO =
  'Lo que el equipo SÍ sabe hacer:\n' +
  '- Clay: descartar fotos movidas, desenfocadas, quemadas o con ojos cerrados; agrupar ráfagas y repetidas y quedarse con la mejor; ' +
  'puntuar composición, momento, expresión y relevancia; cubrir la lista de tomas; elegir N fotos.\n' +
  '- Brock: revelado natural medido en cada foto (exposición, balance de blancos, sombras, luces, contraste, vibrance, nitidez suave), ' +
  'estilos (' + Object.keys(ESTILOS_FOTO).join(', ') + '), intensidad suave o media, recortes inteligentes que respetan rostros ' +
  '(original, 4:5, 1:1, 16:9, 9:16, 3:2), tamaño máximo en píxeles (0 = original), logo del medio, difuminar rostros (protección de identidad), ' +
  'quitar la ubicación GPS (siempre), ajustes por foto (más clara, más cálida, otro estilo, otro formato).\n' +
  '- Eric: revisa cada foto antes de mostrártela (luces quemadas, color de piel, recortes que corten cabezas, que no se haya alterado el contenido).\n' +
  'Lo que NO sabe hacer: quitar o agregar objetos o personas, cambiar fondos, suavizar piel, adelgazar o cambiar rasgos, generar imágenes, enderezar perspectiva compleja, unir panorámicas o HDR.';

function planificarF_(chat, m, cambio, directo) {
  const d = leerDatosF_();
  const fotos = d.fotos || [];
  tgF_('sendChatAction', { chat_id: chat, action: 'typing' });
  salaEventoF_('trent', 'trabajando', 'Convirtiendo la orden del mando en un plan.', { mision: resumenSalaF_(m, 3) });
  const usuario = 'Arma el plan para seleccionar y editar estas fotos.\n\n' + CAPACIDADES_FOTO + '\n\n' +
    'Material: ' + fotos.length + ' fotos' + (m.comprimidas ? ' (' + m.comprimidas + ' llegaron comprimidas por Telegram)' : '') + '.\n' +
    (d.plan_sesion ? 'Plan de sesión que hiciste antes (usa su lista de tomas y su entrega propuesta):\n' + JSON.stringify(d.plan_sesion) + '\n\n' : '') +
    'Instrucciones del fotógrafo:\n«' + (m.instruccion || '(sin instrucciones: usa tu criterio y el plan de sesión)') + '»\n' +
    (d.plan && cambio ? '\nPlan actual:\n' + JSON.stringify(d.plan) + '\nCambio que pide ahora el fotógrafo: «' + cambio + '». Devuelve el plan completo ya corregido.\n' : '') +
    '\nGuía:\n' +
    '- "cantidad": cuántas fotos finales (entre 1 y ' + Math.min(MAX_SELECCION, fotos.length) + '). Si no lo dice: cobertura 6-10, estudio 5-8, redes 3-6 (máximo 10 para un carrusel), artística 4-8.\n' +
    '- "tomas": lo que la selección debe cubrir (de la instrucción o del plan de sesión). Vacío si no aplica.\n' +
    '- "formatos": los que pida; si no dice nada: cobertura [16:9] y original, redes [4:5], estudio y artística [original].\n' +
    '- "lado_max": 2048 para redes, 0 (resolución original) en lo demás, salvo que pida otra cosa.\n' +
    '- "estilo": el que pida; si no, cobertura natural, estudio editorial, redes natural o vivo, artística el que mejor sirva. En cobertura solo natural, editorial o blanco_negro.\n' +
    '- "por_foto": ajustes para fotos concretas que mencione por número ("la 3 más clara" → exposicion 0.2; "más cálida" → temperatura 0.03). Vacío si no hay.\n' +
    '- "sin_retoque": true solo si pide entregar sin retocar.\n' +
    '- "no_puede": lo que pidió y el equipo no sabe hacer (ver arriba). Vacío si todo se puede.\n' +
    '- "pregunta": solo si falta algo imprescindible para trabajar; si no, null.';
  const p = gemini_(sistemaTrent_(), usuario, { rapido: true, esquema: ESQUEMA_PLAN_FOTO });
  p.cantidad = Math.max(1, Math.min(MAX_SELECCION, Math.round(Number(p.cantidad) || 6), fotos.length));
  p.formatos = (p.formatos || []).filter(f => FORMATOS_FOTO[f]).slice(0, 3);
  if (!p.formatos.length) p.formatos = ['original'];
  if (!ESTILOS_FOTO[p.estilo]) p.estilo = 'natural';
  if (p.tipo === 'cobertura' && ['natural', 'editorial', 'blanco_negro'].indexOf(p.estilo) < 0) p.estilo = 'editorial';
  p.lado_max = Math.max(0, Math.min(8000, Math.round(Number(p.lado_max) || 0)));
  d.plan = p; guardarDatosF_(d);

  if (p.pregunta) {
    if (!directo) { m.estado = 'instruccion'; guardarMisionF_(m); } // si venía de la aprobación, sigue ahí para recibir la respuesta
    salaEventoF_('trent', 'espera', 'Consultando al mando.', { mision: resumenSalaF_(m, 3) });
    return enviarF_(chat, '🗺 <b>Trent Sawyer</b>: antes de mover al equipo, una pregunta:\n' + esc_(p.pregunta));
  }
  if (directo) {
    enviarF_(chat, '🗺 <b>Trent Sawyer</b>: ajusté el plan con tus cambios.' +
      ((p.por_foto || []).length ? '\n' + p.por_foto.map(x => '• Foto ' + x.n + ': ' + esc_(x.nota || [x.estilo, (x.formatos || []).join(', ')].filter(Boolean).join(' · ') || 'ajuste')).join('\n') : '') +
      '\n• Estilo general: ' + esc_(ESTILOS_FOTO[p.estilo] || p.estilo) + ' · formatos: ' + esc_(p.formatos.join(', ')) +
      ((p.no_puede || []).length ? '\n⚠️ No sabemos hacer: ' + esc_(p.no_puede.join('; ')) : ''));
    m.estado = 'seleccion'; guardarMisionF_(m);
    return editarF_(chat, m);
  }
  m.estado = 'plan'; guardarMisionF_(m);
  salaEventoF_('trent', 'listo', 'Plan listo. Esperando luz verde.', { mision: resumenSalaF_(m, 3) });
  salaEventoF_('mando', 'trabajando', 'Revisando el plan de fotografía.', {});
  enviarF_(chat, describirPlanF_(p, fotos.length), [
    [{ text: '▶️ Adelante: que Clay seleccione', callback_data: 'f:seleccionar' }],
    [{ text: '✏️ Cambiar el plan', callback_data: 'f:cambiar_plan' }, { text: '❌ Cancelar', callback_data: 'f:cancelar' }]]);
}

function describirPlanF_(p, total) {
  const tipos = { cobertura: 'Cobertura periodística', estudio: 'Sesión de estudio', redes: 'Redes sociales', artistica: 'Fotografía artística' };
  let t = '🗺 <b>Trent Sawyer</b> · Plan de la misión\n<i>' + esc_(p.resumen || '') + '</i>\n\n' +
    '• Tipo: <b>' + (tipos[p.tipo] || p.tipo) + '</b>\n' +
    '• Clay elige <b>' + p.cantidad + '</b> de ' + total + ' fotos\n' +
    '• Estilo: <b>' + esc_(ESTILOS_FOTO[p.estilo] || p.estilo) + '</b>' + (p.sin_retoque ? ' · <b>sin retoque</b>' : ' · intensidad ' + (p.intensidad || 'suave')) + '\n' +
    '• Formatos: ' + p.formatos.map(f => esc_(FORMATOS_FOTO[f] || f)).join(' · ') + '\n' +
    '• Tamaño: ' + (p.lado_max ? 'lado mayor de ' + p.lado_max + ' px' : 'resolución original') + '\n' +
    (p.logo ? '• Con el logo del medio\n' : '') +
    (p.difuminar_rostros ? '• Rostros difuminados (protección de identidad)\n' : '') +
    '• Ubicación GPS: se quita de todas las fotos\n';
  if ((p.tomas || []).length) t += '\n<b>Tomas que debe cubrir</b>\n' + p.tomas.map(x => '• ' + (x.obligatoria ? '⭐ ' : '') + esc_(x.descripcion)).join('\n') + '\n';
  if ((p.criterios || []).length) t += '\n<b>Criterios de selección</b>\n' + p.criterios.slice(0, 6).map(x => '• ' + esc_(x)).join('\n') + '\n';
  if ((p.por_foto || []).length) t += '\n<b>Ajustes por foto</b>\n' + p.por_foto.map(x => '• Foto ' + x.n + ': ' + esc_(x.nota || [x.estilo, (x.formatos || []).join(', ')].filter(Boolean).join(' · ') || 'ajuste')).join('\n') + '\n';
  if ((p.no_puede || []).length) t += '\n⚠️ <b>Esto no lo sabemos hacer</b>\n' + p.no_puede.map(x => '• ' + esc_(x)).join('\n') + '\n';
  return t + '\nSi quieres cambiar algo, escríbemelo o mándame una nota de voz.';
}

// ───────────────────────── Despachos a GitHub (Clay y Brock) ─────────────────────────

function despacharFotos_(tipo, m) {
  const r = UrlFetchApp.fetch('https://api.github.com/repos/' + prop_('GITHUB_REPO') + '/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('GITHUB_TOKEN'), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ event_type: tipo, client_payload: { mision_id: m.id } }),
  });
  if (r.getResponseCode() !== 204) throw new Error('GitHub no aceptó la orden (' + r.getResponseCode() + '). Revisa GITHUB_TOKEN y GITHUB_REPO.');
}

/** Comparte la carpeta de originales por enlace SOLO mientras Clay o Brock trabajan. */
function abrirAccesoF_(m) {
  try { DriveApp.getFolderById(m.originales).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (e) { compartirApi_(m.originales, true); }
}

function cerrarAccesoF_(m) {
  try { DriveApp.getFolderById(m.originales).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); }
  catch (e) { try { compartirApi_(m.originales, false); } catch (e2) { console.error('No se pudo cerrar la carpeta: ' + (e2.message || e2)); } }
  (m.compartidas || []).forEach(id => { try { compartir_(id, false); } catch (e) { /* sigue */ } });
  m.compartidas = []; guardarMisionF_(m);
}

function seleccionarF_(chat, m) {
  if (!implementacionAlDiaF_(chat)) return;
  m.estado = 'seleccionando'; guardarMisionF_(m);
  abrirAccesoF_(m);
  despacharFotos_('seleccionar_fotos', m);
  salaEventoF_('mando', 'listo', 'Plan de fotografía aprobado.', {});
  salaEventoF_('clay', 'trabajando', 'En posición. Preparando la selección.', { mision: resumenSalaF_(m, 4) });
  enviarF_(chat, '🎯 <b>Clay Spenser</b>: entendido. Reviso las ' + m.n + ' fotos (nitidez, exposición, ojos, repetidas, composición y momento) y te muestro la selección. ' +
    'Tardo uno o dos minutos en arrancar.');
}

function editarF_(chat, m) {
  if (!implementacionAlDiaF_(chat)) return;
  // Las versiones anteriores de esta misión se van a la papelera, para que no se mezclen con las nuevas
  const it = DriveApp.getFolderById(m.editadas).getFiles();
  while (it.hasNext()) { try { it.next().setTrashed(true); } catch (e) { /* sigue */ } }
  m.estado = 'editando'; m.versiones = (m.versiones || 0) + 1; guardarMisionF_(m);
  abrirAccesoF_(m);
  despacharFotos_('editar_fotos', m);
  const sel = (leerDatosF_().seleccion || []).length;
  salaEventoF_('mando', 'listo', 'Selección aprobada.', {});
  salaEventoF_('brock', 'trabajando', 'En posición. Preparando la mesa de revelado.', { mision: resumenSalaF_(m, 5) });
  enviarF_(chat, '🎨 <b>Brock Reynolds</b>: recibido. Edito las ' + sel + ' fotos' + (m.versiones > 1 ? ' con tus cambios' : '') +
    ' y Eric las revisa antes de mostrártelas. Te aviso al terminar.');
}

function reintentarF_(chat) {
  const m = misionF_();
  if (!m || ['seleccionando', 'editando', 'error'].indexOf(m.estado) < 0) return enviarF_(chat, 'No hay ningún trabajo de Clay o Brock pendiente para relanzar.');
  const editar = m.estado === 'editando' || (m.estado === 'error' && m.error_de !== 'clay');
  return editar ? editarF_(chat, m) : seleccionarF_(chat, m);
}

function implementacionAlDiaF_(chat) {
  const cache = CacheService.getScriptCache();
  if (cache.get('impl_ok_' + VERSION)) return true;
  let publicada = '';
  try {
    const r = UrlFetchApp.fetch(prop_('URL_WEBAPP') + '?accion=version', { muteHttpExceptions: true, followRedirects: true });
    try { publicada = String((JSON.parse(r.getContentText()) || {}).version || ''); } catch (e) { publicada = 'anterior'; }
  } catch (e) { return true; }
  if (publicada === VERSION) { cache.put('impl_ok_' + VERSION, '1', 21600); return true; }
  enviarF_(chat, '🛠 <b>Trent Sawyer</b>: falta un paso en Apps Script. El código guardado es la versión <b>' + VERSION + '</b>, pero la implementación publicada es ' +
    (publicada ? 'la <b>' + esc_(publicada) + '</b>' : 'una anterior') + '.\n<b>Implementar → Administrar implementaciones → ✏️ → Versión: Nueva versión → Implementar</b>.\n' +
    'Luego pulsa de nuevo el botón. Tu misión sigue guardada.');
  return false;
}

// ───────────────────────── Botones ─────────────────────────

function botonF_(q) {
  tgF_('answerCallbackQuery', { callback_query_id: q.id });
  const chat = String(q.message.chat.id);
  if (chat !== prop_('FOTO_CHAT_DUENO')) return;
  const d = String(q.data || '');
  const m = misionF_();
  if (!m) return enviarF_(chat, 'No hay misión activa.');
  if (d === 'f:cancelar') return cancelarF_(chat);
  if (d === 'f:listo' && recibiendoF_(m)) return fotosListasF_(chat, m);
  if (d === 'f:seleccionar' && m.estado === 'plan') return seleccionarF_(chat, m);
  if (d === 'f:cambiar_plan' && m.estado === 'plan') return enviarF_(chat, '✏️ Dime qué cambio en el plan (por escrito o nota de voz).');
  if (d === 'f:editar' && m.estado === 'seleccion') return editarF_(chat, m);
  if (d === 'f:cambiar_sel' && m.estado === 'seleccion') {
    return enviarF_(chat, '✏️ Dime qué cambio, con los números de la hoja de contactos. Por ejemplo: <i>«quita la 4 y la 9, agrega la 15»</i> o <i>«quiero 12 en vez de 8»</i>.');
  }
  if (d === 'f:aprobar' && m.estado === 'aprobacion') return aprobarF_(chat, m);
  if (d === 'f:cambios' && m.estado === 'aprobacion') {
    return enviarF_(chat, '✏️ Dime qué cambio. Por ejemplo: <i>«la 2 más clara, la 5 en blanco y negro, todas también en cuadrado»</i>.');
  }
  if (d === 'f:completas' && m.estado === 'lista') return enviarCompletasF_(chat, m);
  if (d === 'f:cerrar' && m.estado === 'lista') {
    m.estado = 'cerrada'; guardarMisionF_(m);
    salaEventoF_('trent', 'espera', 'Misión cerrada. En posición.', {});
    return enviarF_(chat, '✅ Misión <b>' + esc_(m.codigo) + '</b> cerrada. Envíame fotos cuando quieras.');
  }
  if (d === 'f:reintentar') return reintentarF_(chat);
  enviarF_(chat, 'Ese botón ya no aplica a la etapa actual (' + esc_(textoEstadoF_(m.estado)) + ').');
}

// ───────────────────────── Selección: cambios del mando ─────────────────────────

const ESQUEMA_CAMBIO_SEL = {
  type: 'object',
  properties: { quitar: { type: 'array', items: _FN }, agregar: { type: 'array', items: _FN }, cantidad: { type: ['number', 'null'] },
    criterio: { type: ['string', 'null'] }, aprobar: _FB },
  required: ['quitar', 'agregar', 'cantidad', 'criterio', 'aprobar'],
};

function cambiarSeleccionF_(chat, m, texto) {
  const d = leerDatosF_();
  const total = (d.fotos || []).length;
  let c;
  try {
    c = gemini_(sistemaTrent_(), 'El fotógrafo revisa la selección de Clay (fotos numeradas del 1 al ' + total + '). Selección actual: ' + JSON.stringify(d.seleccion || []) + '.\n' +
      'Mensaje del fotógrafo: «' + texto + '».\nDevuelve qué números quitar, cuáles agregar, si cambia la cantidad total ("cantidad", o null), ' +
      'si pide otro criterio para que Clay vuelva a seleccionar ("criterio", o null) y si con esto ya aprueba seguir a la edición ("aprobar").', { rapido: true, esquema: ESQUEMA_CAMBIO_SEL });
  } catch (e) { return enviarF_(chat, '⚠️ No pude procesar el cambio: ' + esc_(String(e.message || e)).slice(0, 200)); }
  const valido = x => Number.isInteger(Number(x)) && Number(x) >= 1 && Number(x) <= total;
  if (c.criterio || (c.cantidad && !c.agregar.length && !c.quitar.length)) {
    // Otro criterio o más/menos fotos: Clay vuelve a seleccionar con el plan corregido
    if (c.cantidad) d.plan.cantidad = Math.max(1, Math.min(MAX_SELECCION, Math.round(c.cantidad), total));
    if (c.criterio) d.plan.criterios = [String(c.criterio)].concat(d.plan.criterios || []).slice(0, 8);
    guardarDatosF_(d);
    enviarF_(chat, '🎯 <b>Clay Spenser</b>: entendido, vuelvo a seleccionar' + (c.cantidad ? ' ' + d.plan.cantidad + ' fotos' : '') + (c.criterio ? ' con ese criterio' : '') + '.');
    return seleccionarF_(chat, m);
  }
  let sel = (d.seleccion || []).filter(n => (c.quitar || []).map(Number).indexOf(n) < 0);
  (c.agregar || []).map(Number).filter(valido).forEach(n => { if (sel.indexOf(n) < 0) sel.push(n); });
  sel = sel.slice(0, MAX_SELECCION);
  if (!sel.length) return enviarF_(chat, '⚠️ La selección quedaría vacía. Dime qué fotos dejo.');
  d.seleccion = sel; guardarDatosF_(d);
  const botones = [[{ text: '🎨 Editar estas ' + sel.length, callback_data: 'f:editar' }], [{ text: '✏️ Otro cambio', callback_data: 'f:cambiar_sel' }]];
  if (c.aprobar) return editarF_(chat, m);
  enviarF_(chat, '🎯 <b>Clay Spenser</b>: selección actualizada: <b>' + sel.join(', ') + '</b> (' + sel.length + ' fotos).', botones);
}

// ───────────────────────── Aprobación: cambios y entrega ─────────────────────────

function pedirCambiosF_(chat, m, texto) {
  agregarInstruccionF_(m, 'Cambios tras ver las fotos editadas: ' + texto);
  guardarMisionF_(m);
  // Los cambios de edición no piden nueva selección ni nueva aprobación del plan: van directo a Brock
  planificarF_(chat, m, texto, true);
}

function aprobarF_(chat, m) {
  const carpeta = DriveApp.getFolderById(m.editadas);
  try { carpeta.setName('aprobadas'); } catch (e) { /* el nombre es solo orden */ }
  cerrarAccesoF_(m);
  m.estado = 'lista'; m.entregada = Date.now(); guardarMisionF_(m);
  const s = salaLeerF_(); s.stats = s.stats || { fotos: 0, misiones: 0 };
  const n = (leerDatosF_().entregas || []).length;
  s.stats.fotos = (s.stats.fotos || 0) + n; s.stats.misiones = (s.stats.misiones || 0) + 1;
  if (m.creada) s.stats.minutos = (s.stats.minutos || []).concat(Math.round((Date.now() - m.creada) / 60000)).slice(-20);
  salaGuardarF_(s);
  salaEventoF_('mando', 'listo', 'Fotos aprobadas.', {});
  salaEventoF_('trent', 'listo', 'Fotos entregadas. Misión cumplida.', { mision: resumenSalaF_(m, 8) });
  enviarF_(chat, '🎖 <b>Trent Sawyer</b>: misión cumplida, comandante. ' + (n === 1 ? 'La foto aprobada quedó' : 'Las ' + n + ' fotos aprobadas quedaron') + ' en Drive:\n' +
    'https://drive.google.com/drive/folders/' + m.editadas + '\n' +
    'Los originales siguen en la carpeta de la sesión, sin tocar.', [
    [{ text: '📦 Enviármelas aquí en calidad completa', callback_data: 'f:completas' }],
    [{ text: '✅ Cerrar misión', callback_data: 'f:cerrar' }]]);
}

/** Envía las fotos aprobadas como documento (sin compresión de Telegram). Hasta 20 por vez. */
function enviarCompletasF_(chat, m) {
  const entregas = (leerDatosF_().entregas || []).slice(0, 20);
  let enviadas = 0;
  entregas.forEach(e => {
    try {
      const f = DriveApp.getFileById(e.id);
      if (f.getSize() > 48 * 1024 * 1024) return;
      const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_TOKEN_FOTOS') + '/sendDocument', {
        method: 'post', muteHttpExceptions: true, payload: { chat_id: chat, document: f.getBlob(), caption: 'Foto ' + e.n + (e.formato !== 'original' ? ' · ' + e.formato : '') },
      });
      if (r.getResponseCode() === 200) enviadas++;
    } catch (err) { console.error('Envío de foto completa: ' + (err.message || err)); }
  });
  enviarF_(chat, '📦 Envié ' + enviadas + ' de ' + entregas.length + ' archivos.' + ((leerDatosF_().entregas || []).length > 20 ? ' El resto está en la carpeta de Drive.' : ''),
    [[{ text: '✅ Cerrar misión', callback_data: 'f:cerrar' }]]);
}

// ───────────────────────── Puente con los operadores (GitHub Actions) ─────────────────────────

/** doGet: Clay y Brock piden el trabajo, una sesión de subida o que se comparta una foto suelta. */
function doGetFotos_(p) {
  if (!p.k || p.k !== prop_('CLAVE_SALA')) return json_({ ok: false });
  const m = misionF_();
  if (!m || m.id !== p.id) return json_({ ok: false });
  if (p.accion === 'trabajo_fotos') return json_({ ok: true, trabajo: trabajoFotos_(m) });
  if (p.accion === 'subida_foto') {
    try { return json_({ ok: true, url: sesionSubidaFoto_(m, String(p.nombre || 'foto.jpg')) }); }
    catch (e) { return json_({ ok: false, error: String(e.message || e).slice(0, 150) }); }
  }
  if (p.accion === 'compartir_foto') {
    const d = leerDatosF_();
    const foto = (d.fotos || []).filter(f => f.id === p.foto)[0];
    if (!foto) return json_({ ok: false });
    const ok = compartir_(foto.id, true);
    if (ok) { const m2 = misionF_(); m2.compartidas = (m2.compartidas || []).concat([foto.id]); guardarMisionF_(m2); }
    return json_({ ok: ok });
  }
  return json_({ ok: false });
}

function trabajoFotos_(m) {
  const d = leerDatosF_();
  return {
    codigo: m.codigo, chat_id: m.chat, fotos: d.fotos || [], plan: d.plan || {}, seleccion: d.seleccion || [],
    plan_sesion: d.plan_sesion || null, version: m.versiones || 1,
    conf: { medio: prop_('NOMBRE_MEDIO', 'Torre Informativa'), color: prop_('COLOR_MARCA', '#E30613'), autor: prop_('AUTOR_FOTOS', '') },
  };
}

function sesionSubidaFoto_(m, nombre) {
  nombre = nombre.replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 120);
  const r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': 'image/jpeg' },
    payload: JSON.stringify({ name: nombre, parents: [m.editadas], mimeType: 'image/jpeg' }),
  });
  const h = r.getAllHeaders();
  const url = h.Location || h.location;
  if (r.getResponseCode() !== 200 || !url) throw new Error('Drive respondió ' + r.getResponseCode());
  return url;
}

/** doPost con origen "fotos": reportes de Clay, Brock y Eric. */
function operadorFotos_(b) {
  const m = misionF_();
  if (!m || m.id !== b.mision_id || LIBRES_FOTO.indexOf(m.estado) >= 0) return;
  const agente = AGENTES_FOTO[b.agente] ? b.agente : 'clay';
  const etapa = { clay: 4, brock: 5, eric: 6 }[agente] || 4;

  if (b.tipo === 'progreso') return salaEventoF_(agente, 'trabajando', b.texto || 'Trabajando', { mision: resumenSalaF_(m, etapa) });

  if (b.tipo === 'error') {
    m.estado = 'error'; m.error_de = agente; guardarMisionF_(m);
    cerrarAccesoF_(m);
    salaEventoF_(agente, 'alerta', 'Operación con fallas. Esperando órdenes.', { mision: resumenSalaF_(m, etapa) });
    return enviarF_(m.chat, '⚠️ <b>' + AGENTES_FOTO[agente].nombre + '</b> reporta un problema:\n<code>' + esc_(b.texto || 'sin detalle') + '</code>',
      [[{ text: '🔁 Reintentar', callback_data: 'f:reintentar' }, { text: '❌ Cancelar', callback_data: 'f:cancelar' }]]);
  }

  if (b.tipo === 'seleccion' && m.estado === 'seleccionando') {
    const d = leerDatosF_();
    d.seleccion = (b.seleccion || []).map(Number).slice(0, MAX_SELECCION);
    d.ranking = (b.ranking || []).slice(0, MAX_FOTOS);
    guardarDatosF_(d);
    m.estado = 'seleccion'; guardarMisionF_(m);
    cerrarAccesoF_(m);
    salaEventoF_('clay', 'listo', 'Selección entregada: ' + d.seleccion.length + ' de ' + m.n + '.', { mision: resumenSalaF_(m, 4) });
    salaEventoF_('mando', 'trabajando', 'Revisando la selección.', {});
    const r = b.resumen || {};
    const motivos = {};
    d.ranking.forEach(x => { motivos[x.n] = x.m; });
    let t = '🎯 <b>Clay Spenser</b>: de ' + m.n + ' fotos elegí <b>' + d.seleccion.length + '</b>' +
      (b.hoja_enviada ? ' (marcadas en verde en la hoja de contactos de arriba).' : '.') + '\n' +
      '<b>Selección:</b> ' + d.seleccion.join(', ') + '\n';
    if (r.descartadas_tecnicas) t += '• Descarté ' + r.descartadas_tecnicas + ' por fallas técnicas (movidas, fuera de foco, quemadas u ojos cerrados).\n';
    if (r.repetidas) t += '• Agrupé ' + r.repetidas + ' repetidas o de ráfaga y me quedé con la mejor de cada grupo.\n';
    if (r.pedidas && d.seleccion.length < r.pedidas) t += '• Pediste ' + r.pedidas + ', pero solo hay ' + (r.distintas || d.seleccion.length) + ' escenas distintas sin fallas: no relleno con repetidas. Si quieres alguna repetida, agrégala por número.\n';
    if (r.sin_ia) t += '• ⚠️ Gemini no respondió: seleccioné solo con medidas técnicas, sin juzgar composición ni momento.\n';
    const cubiertas = (b.tomas || []).filter(x => x.n), faltan = (b.tomas || []).filter(x => !x.n && x.obligatoria);
    if (cubiertas.length) t += '\n<b>Tomas cubiertas</b>\n' + cubiertas.map(x => '✅ ' + esc_(x.descripcion) + ' → foto ' + x.n).join('\n') + '\n';
    if (faltan.length) t += '\n<b>No encontré</b>\n' + faltan.map(x => '⚠️ ' + esc_(x.descripcion)).join('\n') + '\n';
    t += '\n<b>Por qué</b>\n' + d.seleccion.slice(0, 12).map(n => '• ' + n + ': ' + esc_(motivos[n] || '—')).join('\n');
    if (b.fallidas && b.fallidas.length) t += '\n\n⚠️ No pude abrir las fotos ' + b.fallidas.join(', ') + '.';
    return enviarF_(m.chat, t + '\n\nRevísala: puedes pedirme cambios con los números, o seguir.', [
      [{ text: '🎨 Editar estas ' + d.seleccion.length, callback_data: 'f:editar' }],
      [{ text: '✏️ Cambiar selección', callback_data: 'f:cambiar_sel' }, { text: '❌ Cancelar', callback_data: 'f:cancelar' }]]);
  }

  if (b.tipo === 'listo' && m.estado === 'editando') {
    const d = leerDatosF_();
    d.entregas = (b.archivos || []).slice(0, 120);
    d.revision = b.revision || {};
    guardarDatosF_(d);
    m.estado = 'aprobacion'; guardarMisionF_(m);
    cerrarAccesoF_(m);
    const rv = b.revision || {};
    salaEventoF_('brock', 'listo', 'Revelado terminado: ' + d.entregas.length + ' archivos.', { mision: resumenSalaF_(m, 6) });
    salaEventoF_('eric', rv.ok === false ? 'alerta' : 'listo', rv.ok === false ? 'Revisión con ' + (rv.hallazgos || []).length + ' observaciones.' : 'Control de calidad sin problemas.', { mision: resumenSalaF_(m, 7) });
    salaEventoF_('mando', 'trabajando', 'Revisando las fotos editadas.', {});
    let t = '🎨 <b>Brock Reynolds</b>: ' + (d.entregas.length === 1 ? 'lista 1 foto editada' : 'listas ' + d.entregas.length + ' fotos editadas') + (b.vista_enviada ? ' (te las mostré arriba).' : '.') + '\n';
    if ((b.notas || []).length) t += b.notas.slice(0, 6).map(x => '• ' + esc_(x)).join('\n') + '\n';
    if (rv.ok === true) t += '\n🔎 <b>Eric Blackburn</b> (control de calidad): todo en orden. Luz y color naturales, sin recortes problemáticos, contenido intacto y sin ubicación GPS.';
    else if (rv.ok === false) t += '\n🔎 <b>Eric Blackburn</b> (control de calidad) encontró esto:\n' + (rv.hallazgos || []).slice(0, 12).map(x => '• ' + esc_(x)).join('\n');
    if (b.fallidas && b.fallidas.length) t += '\n\n⚠️ No pude editar las fotos ' + b.fallidas.join(', ') + '.';
    return enviarF_(m.chat, t + '\n\n¿Las apruebas?', [
      [{ text: '✅ Aprobar y entregar', callback_data: 'f:aprobar' }],
      [{ text: '✏️ Pedir cambios', callback_data: 'f:cambios' }, { text: '❌ Cancelar', callback_data: 'f:cancelar' }]]);
  }
}

// ───────────────────────── Sala virtual (estado público del departamento) ─────────────────────────

function salaLeerF_() { try { return JSON.parse(prop_('SALA_FOTOS', '{}')); } catch (e) { return {}; } }
function salaGuardarF_(s) { s.actualizado = Date.now(); P_().setProperty('SALA_FOTOS', JSON.stringify(s)); }

function salaEventoF_(agente, estado, linea, extra) {
  const s = salaLeerF_();
  s.agentes = s.agentes || {};
  s.agentes[agente] = { estado: estado, linea: String(linea || '').slice(0, 140), t: Date.now() };
  s.bitacora = s.bitacora || [];
  s.bitacora.unshift({ t: Date.now(), a: agente, x: String(linea || '').slice(0, 160) });
  s.bitacora = s.bitacora.slice(0, 25);
  if (extra) Object.keys(extra).forEach(k => { s[k] = extra[k]; });
  salaGuardarF_(s);
}

function resumenSalaF_(m, etapa) {
  return { codigo: m.codigo, etapa: etapa, etapaNombre: ETAPAS_FOTO[etapa] || '', inicio: m.creada, fin: etapa >= ETAPAS_FOTO.length - 1 ? Date.now() : null };
}

function estadoSalaFotos_() {
  const s = salaLeerF_();
  const agentes = {};
  Object.keys(AGENTES_FOTO).forEach(k => {
    agentes[k] = Object.assign({}, AGENTES_FOTO[k], (s.agentes || {})[k] || { estado: 'espera', linea: 'En posición.' });
  });
  return {
    instalado: !!prop_('TELEGRAM_TOKEN_FOTOS'), agentes: agentes, mando: (s.agentes || {}).mando || null,
    mision: s.mision || null, etapas: ETAPAS_FOTO, bitacora: s.bitacora || [],
    stats: s.stats || { fotos: 0, misiones: 0 }, actualizado: s.actualizado || null,
  };
}
