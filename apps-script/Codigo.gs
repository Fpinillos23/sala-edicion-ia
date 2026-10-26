/**
 * ═══════════════════════════════════════════════════════════════
 *  SALA DE EDICIÓN IA — Centro de operaciones (Google Apps Script)
 * ═══════════════════════════════════════════════════════════════
 *  Jason Hayes (Bravo 1) ... coordina la misión y te reporta por Telegram
 *  Lisa Davis (Inteligencia) transcribe el video  ─┐ trabajan en
 *  Sonny Quinn (Bravo 3) ... corta y entrega el reel ┘ GitHub Actions
 *  Mandy Ellis (Enlace) .... te interroga y escribe el guion (aquí, con Gemini)
 *
 *  Todo gratis: Apps Script + Telegram + Gemini (o Groq) + GitHub Actions (repo público).
 *  Instalación: ver INSTALACION.md
 */

const AGENTES = {
  jason: { nombre: 'Jason Hayes', alias: 'Bravo 1', rol: 'Coordina la misión' },
  lisa:  { nombre: 'Lisa Davis',  alias: 'Inteligencia', rol: 'Transcribe el material' },
  mandy: { nombre: 'Mandy Ellis', alias: 'Enlace', rol: 'Interroga y escribe el guion' },
  sonny: { nombre: 'Sonny Quinn', alias: 'Bravo 3', rol: 'Corta y entrega el reel' },
};

const FORMATOS = {
  '1': ['vertical', 'Vertical con fondo desenfocado'],
  '2': ['vertical_recorte', 'Vertical recortado al centro'],
  '3': ['original', 'Formato original'],
};

const ETAPAS = ['Sin misión', 'Recepción', 'Inteligencia', 'Interrogatorio', 'Guion', 'Aprobación', 'Edición', 'Entregado'];
const NOMBRES_OPERACION = ['Guatapurí', 'Tridente', 'Centinela', 'Halcón', 'Sierra', 'Relámpago', 'Ceiba', 'Acordeón', 'Cacique', 'Faro', 'Brújula', 'Cóndor'];
const LIBRES = ['lista', 'cancelada', 'cerrada'];
const LIMITE_TELEGRAM = 20 * 1024 * 1024; // un bot solo descarga archivos de hasta 20 MB

// ───────────────────────── Configuración ─────────────────────────

function P_() { return PropertiesService.getScriptProperties(); }
function prop_(k, def) { const v = P_().getProperty(k); return (v === null || v === '') ? def : v; }

/** Ejecútala UNA vez después de implementar la aplicación web y llenar las propiedades. */
function configurar() {
  const faltan = ['TELEGRAM_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO', 'URL_WEBAPP'].filter(k => !prop_(k));
  if (!prop_('GEMINI_API_KEY') && !prop_('GROQ_API_KEY')) faltan.push('GEMINI_API_KEY');
  if (faltan.length) throw new Error('Faltan estas propiedades del script: ' + faltan.join(', '));
  if (!/\/exec$/.test(prop_('URL_WEBAPP'))) throw new Error('URL_WEBAPP debe terminar en /exec (la URL de la implementación).');
  if (!prop_('CLAVE_SALA')) P_().setProperty('CLAVE_SALA', Utilities.getUuid().replace(/-/g, ''));
  const c = carpetas_();

  const w = tg_('setWebhook', {
    url: prop_('URL_WEBAPP') + '?k=' + prop_('CLAVE_SALA'),
    drop_pending_updates: true,
    allowed_updates: ['message', 'callback_query'],
  });
  tg_('setMyCommands', { commands: [
    { command: 'estado', description: 'Cómo va la misión' },
    { command: 'drive', description: 'Usar un video de la carpeta de Drive' },
    { command: 'saltar', description: 'Saltar una pregunta de Mandy' },
    { command: 'cancelar', description: 'Cancelar la misión actual' },
    { command: 'ayuda', description: 'Cómo funciona la sala' },
  ] });
  if (!prop_('SALA')) salaEvento_('jason', 'espera', 'Sala instalada. Esperando material.', { mision: null });

  Logger.log('Webhook de Telegram: ' + (w && w.ok ? 'activo ✅' : 'ERROR ' + JSON.stringify(w)));
  Logger.log('Mandy (' + (prop_('GEMINI_API_KEY') ? 'Gemini' : 'Groq') + '): ' + probarIA_());
  const gh = UrlFetchApp.fetch('https://api.github.com/repos/' + prop_('GITHUB_REPO'), {
    muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + prop_('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' } });
  Logger.log('GitHub: ' + (gh.getResponseCode() === 200 ? 'acceso al repositorio ✅' : 'ERROR ' + gh.getResponseCode() + ' (revisa GITHUB_TOKEN y GITHUB_REPO)'));
  Logger.log('Carpeta de Drive: https://drive.google.com/drive/folders/' + c.base);
  Logger.log('────────── Copia estos dos valores en GitHub → Settings → Secrets → Actions ──────────');
  Logger.log('SALA_CLAVE = ' + prop_('CLAVE_SALA'));
  Logger.log('SALA_API   = ' + prop_('URL_WEBAPP'));
  Logger.log('────────── Para la sala virtual (Vercel), en sala/config.js ──────────');
  Logger.log('window.SALA_API = "' + prop_('URL_WEBAPP') + '";');
  Logger.log('Ahora abre tu bot en Telegram y envíale /start');
}

/** Diagnóstico: muestra cómo ve Telegram al bot y al webhook (sin mostrar claves). */
function diagnosticar() {
  const yo = tg_('getMe', {});
  Logger.log('Bot: ' + (yo.ok ? '@' + yo.result.username + ' ✅' : 'ERROR — revisa TELEGRAM_TOKEN: ' + JSON.stringify(yo)));
  const w = tg_('getWebhookInfo', {});
  if (!w.ok) return Logger.log('No pude leer el webhook: ' + JSON.stringify(w));
  const r = w.result || {};
  const url = String(r.url || '');
  Logger.log('Webhook apunta a esta app: ' + (url.indexOf(prop_('URL_WEBAPP')) === 0 ? 'sí ✅' : 'NO ❌ (' + url.split('?')[0] + ')'));
  Logger.log('Mensajes en espera: ' + (r.pending_update_count || 0));
  Logger.log('Último error de entrega: ' + (r.last_error_message ? r.last_error_message + ' (' + new Date(r.last_error_date * 1000) + ')' : 'ninguno ✅'));
  Logger.log('Dueño registrado: ' + (prop_('CHAT_DUENO') ? 'sí ✅' : 'todavía no (falta el primer /start)'));
  if (prop_('CHAT_DUENO')) {
    const r = tg_('sendMessage', { chat_id: prop_('CHAT_DUENO'), text: '🎖 Jason Hayes: prueba de comunicación desde el diagnóstico.' });
    Logger.log('Envío de prueba a tu chat: ' + (r.ok ? 'entregado ✅' : 'ERROR — ' + JSON.stringify(r).slice(0, 300)));
  }
  try { sesionSubidaDrive_({ nombre: 'prueba.mp4' }); Logger.log('Copia maestra en Drive: permiso de subida ✅ (la prueba no crea archivos)'); }
  catch (e) { Logger.log('Copia maestra en Drive: ERROR — ' + (e.message || e)); }
}

function carpetas_() {
  let base = prop_('CARPETA_ID');
  let carpeta;
  try { carpeta = base ? DriveApp.getFolderById(base) : null; } catch (e) { carpeta = null; }
  if (!carpeta) {
    carpeta = DriveApp.createFolder('Sala de Edición IA');
    P_().setProperty('CARPETA_ID', carpeta.getId());
  }
  const sub = {};
  ['entrada', 'trabajo', 'salida'].forEach(n => {
    const key = 'CARPETA_' + n.toUpperCase();
    let f = null;
    try { f = prop_(key) ? DriveApp.getFolderById(prop_(key)) : null; } catch (e) { f = null; }
    if (!f) { f = carpeta.createFolder(n); P_().setProperty(key, f.getId()); }
    sub[n] = f.getId();
  });
  sub.base = carpeta.getId();
  return sub;
}

function carpeta_(n) {
  const id = prop_('CARPETA_' + n.toUpperCase());
  return id ? DriveApp.getFolderById(id) : DriveApp.getFolderById(carpetas_()[n]);
}

// ───────────────────────── Entradas web ─────────────────────────

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.accion === 'sala') return json_(estadoSala_());
  if (p.accion === 'trabajo') {
    if (!p.k || p.k !== prop_('CLAVE_SALA')) return json_({ ok: false });
    const m = mision_();
    if (!m || m.id !== p.id) return json_({ ok: false });
    return json_({ ok: true, trabajo: trabajoParaOperador_(m) });
  }
  return ContentService.createTextOutput('Sala de Edición IA en línea.');
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false }); }
  const clave = prop_('CLAVE_SALA');
  const k = (e.parameter && e.parameter.k) || body.k;
  if (!clave || k !== clave) return json_({ ok: false });

  // Telegram reintenta si tardamos: ignoramos los mensajes repetidos
  if (body.update_id !== undefined) {
    const cache = CacheService.getScriptCache();
    const llave = 'u' + body.update_id;
    if (cache.get(llave)) return json_({ ok: true });
    cache.put(llave, '1', 21600);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(28000)) {
    const chatOcupado = body.message && body.message.chat ? String(body.message.chat.id) :
      (body.callback_query ? String(body.callback_query.message.chat.id) : null);
    if (chatOcupado && chatOcupado === prop_('CHAT_DUENO')) {
      enviar_(chatOcupado, '⏳ <b>Jason Hayes</b>: el equipo está ocupado en este instante. Repíteme eso en un minuto, por favor.');
    }
    return json_({ ok: false, ocupado: true });
  }
  try {
    if (body.origen === 'operador') operador_(body);
    else telegram_(body);
    return json_({ ok: true });
  } catch (err) {
    console.error('Error en doPost: ' + (err && err.stack || err));
    const m = mision_();
    const chat = (m && m.chat) || prop_('CHAT_DUENO');
    if (chat) enviar_(chat, '⚠️ <b>Jason Hayes</b>: tuvimos un problema.\n<code>' + esc_(String(err.message || err)).slice(0, 600) + '</code>');
    salaEvento_('jason', 'alerta', 'Incidente en la misión. Revisando.');
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── Telegram ─────────────────────────

function tg_(metodo, datos) {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop_('TELEGRAM_TOKEN') + '/' + metodo, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(datos || {}), muteHttpExceptions: true,
  });
  let res;
  try { res = JSON.parse(r.getContentText()); } catch (e) { res = { ok: false, description: 'respuesta no válida' }; }
  if (!res.ok) console.error('Telegram ' + metodo + ' falló: ' + JSON.stringify(res).slice(0, 300));
  return res;
}

function enviar_(chat, texto, botones) {
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
    r = tg_('sendMessage', datos);
    if (r && !r.ok) { // si el HTML falla, se envía como texto plano
      delete datos.parse_mode;
      datos.text = t.replace(/<[^>]+>/g, '');
      r = tg_('sendMessage', datos);
    }
  });
  return r;
}

function esc_(t) { return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function telegram_(u) {
  if (u.callback_query) return boton_(u.callback_query);
  const msg = u.message;
  if (!msg || !msg.chat) return;
  const chat = String(msg.chat.id);
  const texto = String(msg.text || msg.caption || '').trim();
  const dueno = prop_('CHAT_DUENO');

  if (!dueno) {
    if (/^\/start/.test(texto)) { P_().setProperty('CHAT_DUENO', chat); bienvenida_(chat); }
    return;
  }
  if (chat !== dueno) { enviar_(chat, 'Esta sala de edición es privada.'); return; }

  if (/^\/(start|ayuda)/.test(texto)) return bienvenida_(chat);
  if (/^\/estado/.test(texto)) return estado_(chat);
  if (/^\/cancelar/.test(texto)) return cancelar_(chat);
  if (/^\/drive/.test(texto)) return listarDrive_(chat);

  const doc = msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null;
  const archivo = msg.video || doc;
  if (archivo) return recibirVideoTelegram_(chat, archivo);

  const idDrive = idDrive_(texto);
  if (idDrive) return iniciarConDrive_(chat, idDrive);

  const m = mision_();
  if (m && m.estado === 'preguntando') return responder_(chat, m, texto);
  if (m && m.estado === 'ajuste') return ajustar_(chat, m, texto);
  if (m && m.estado === 'duracion' && /^\d{1,3}$/.test(texto)) return fijarDuracion_(chat, m, parseInt(texto, 10));
  if (m && ['transcribiendo', 'escribiendo', 'editando'].indexOf(m.estado) >= 0) {
    const quien = { transcribiendo: 'Lisa está transcribiendo', escribiendo: 'Mandy está escribiendo el guion', editando: 'Sonny está editando' }[m.estado];
    return enviar_(chat, '⏳ <b>Jason Hayes</b>: ' + quien + '. Te aviso apenas termine.');
  }
  enviar_(chat, '🎖 <b>Jason Hayes</b>: envíame un video (hasta 20 MB) o un enlace de Google Drive para abrir una misión. Escribe /ayuda si lo necesitas.');
}

function boton_(q) {
  const chat = String(q.message.chat.id);
  const d = q.data || '';
  tg_('answerCallbackQuery', { callback_query_id: q.id });
  if (chat !== prop_('CHAT_DUENO')) return;
  tg_('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });

  if (d.indexOf('usar:') === 0) return iniciarConDrive_(chat, d.slice(5));
  const m = mision_();
  if (!m) return enviar_(chat, 'No hay ninguna misión activa.');
  if (d === 'cancelar') return cancelar_(chat);
  if (d.indexOf('dur:') === 0 && m.estado === 'duracion') return fijarDuracion_(chat, m, parseInt(d.slice(4), 10));
  if (d.indexOf('fmt:') === 0 && m.estado === 'formato') {
    m.formato = (FORMATOS[d.slice(4)] || FORMATOS['1'])[0];
    m.ajustes = '';
    guardarMision_(m);
    return escribirGuion_(chat, m);
  }
  if ((d === 'aprobar' || d === 'aprobar_maestra') && m.estado === 'revision') return aprobar_(chat, m, d === 'aprobar_maestra');
  if (d === 'cambiar' && m.estado === 'revision') {
    m.estado = 'ajuste'; guardarMision_(m);
    salaEvento_('mando', 'trabajando', 'Mando pidió ajustes al guion.', { mision: resumenSala_(m, 4) });
    return enviar_(chat, '✏️ <b>Mandy Ellis</b>: dime qué cambio quieres (por ejemplo: "empieza con la cifra", "más corto", "quita el segundo corte").');
  }
  if (d === 'otro' && m.estado === 'lista') {
    m.ajustes = ''; m.estado = 'duracion'; guardarMision_(m);
    return pedirDuracion_(chat, m);
  }
  if (d === 'cerrar' && m.estado === 'lista') {
    m.estado = 'cerrada'; guardarMision_(m);
    salaEvento_('jason', 'espera', 'Misión cerrada. Esperando nuevo material.', { mision: null });
    return enviar_(chat, '🎖 <b>Jason Hayes</b>: misión cerrada. Buen trabajo, comandante. Envíame el próximo video cuando quieras.');
  }
  if (d.indexOf('reintentar:') === 0 && m.estado === 'error') {
    const tipo = d.slice(11);
    m.estado = tipo === 'editar' ? 'editando' : 'transcribiendo'; guardarMision_(m);
    compartir_(m.video_id, true);
    despachar_(tipo, m);
    salaEvento_(tipo === 'editar' ? 'sonny' : 'lisa', 'trabajando', 'Reintentando la operación.',
      { mision: resumenSala_(m, tipo === 'editar' ? 6 : 2) });
    return enviar_(chat, '🔁 <b>Jason Hayes</b>: reintentando. Te aviso.');
  }
}

function bienvenida_(chat) {
  enviar_(chat, [
    '🎖 <b>Jason Hayes, Bravo 1</b>. Sala de edición lista, comandante.',
    '',
    '<b>Cómo trabajamos:</b>',
    '1. Me envías un video (hasta 20 MB). Si pesa más, súbelo a la carpeta <b>entrada</b> de Drive y escribe /drive.',
    '2. <b>Lisa Davis</b> lo transcribe.',
    '3. <b>Mandy Ellis</b> te hace unas preguntas y escribe el guion con la guía de cortes.',
    '4. Tú apruebas o pides cambios.',
    '5. <b>Sonny Quinn</b> corta y te entrega el reel aquí mismo.',
    '',
    'Una misión a la vez. /estado para ver cómo vamos, /cancelar para abortar.',
  ].join('\n'));
}

function estado_(chat) {
  const m = mision_();
  if (!m || LIBRES.indexOf(m.estado) >= 0 && m.estado !== 'lista') return enviar_(chat, '🎖 <b>Jason Hayes</b>: sin misión activa. Envíame un video.');
  enviar_(chat, '🎖 <b>Jason Hayes</b>: ' + esc_(m.codigo) + '\nMaterial: ' + esc_(m.nombre) + '\nEstado: <b>' + esc_(m.estado) + '</b>');
}

function cancelar_(chat) {
  const m = mision_();
  if (!m || LIBRES.indexOf(m.estado) >= 0) return enviar_(chat, 'No hay misión activa para cancelar.');
  m.estado = 'cancelada'; guardarMision_(m);
  compartir_(m.video_id, false);
  salaEvento_('jason', 'espera', 'Misión abortada por el mando.', { mision: null });
  enviar_(chat, '🛑 <b>Jason Hayes</b>: ' + esc_(m.codigo) + ' cancelada. Si un operador ya estaba trabajando, ignoraré su resultado.');
}

// ───────────────────────── Recepción del material ─────────────────────────

function recibirVideoTelegram_(chat, archivo) {
  if (!puedeIniciar_(chat)) return;
  if ((archivo.file_size || 0) > LIMITE_TELEGRAM) {
    return enviar_(chat, '📦 <b>Jason Hayes</b>: ese video pasa de 20 MB, el máximo que un bot puede descargar de Telegram.\n' +
      'Súbelo a la carpeta <b>entrada</b> de Drive y escribe /drive, o envíame su enlace de Drive.\n' +
      '<a href="https://drive.google.com/drive/folders/' + prop_('CARPETA_ENTRADA') + '">Abrir carpeta entrada</a>');
  }
  const f = tg_('getFile', { file_id: archivo.file_id });
  if (!f.ok) return enviar_(chat, '⚠️ No pude recibir el video de Telegram. Prueba subiéndolo a Drive (/drive).');
  const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + f.result.file_path).getBlob();
  const nombre = archivo.file_name || ('video_' + Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd_HHmmss') + '.mp4');
  const guardado = carpeta_('entrada').createFile(blob.setName(nombre));
  iniciarMision_(chat, guardado);
}

function iniciarConDrive_(chat, id) {
  if (!puedeIniciar_(chat)) return;
  let f;
  try { f = DriveApp.getFileById(id); } catch (e) { return enviar_(chat, '⚠️ No encuentro ese archivo en tu Drive.'); }
  if (!/^video\//.test(f.getMimeType())) return enviar_(chat, '⚠️ Ese archivo no es un video.');
  iniciarMision_(chat, f);
}

function listarDrive_(chat) {
  const it = carpeta_('entrada').getFiles();
  const videos = [];
  while (it.hasNext()) { const f = it.next(); if (/^video\//.test(f.getMimeType())) videos.push(f); }
  videos.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  if (!videos.length) {
    return enviar_(chat, '📂 La carpeta <b>entrada</b> está vacía. Sube ahí el video y vuelve a escribir /drive.\n' +
      '<a href="https://drive.google.com/drive/folders/' + prop_('CARPETA_ENTRADA') + '">Abrir carpeta entrada</a>');
  }
  const botones = videos.slice(0, 8).map(f => [{
    text: f.getName().slice(0, 40) + ' (' + Math.round(f.getSize() / 1048576) + ' MB)', callback_data: 'usar:' + f.getId(),
  }]);
  enviar_(chat, '📂 <b>Jason Hayes</b>: ¿con cuál trabajamos?', botones);
}

function idDrive_(t) {
  const m = String(t).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=download&)?id=)([\w-]{20,})/);
  return m ? m[1] : null;
}

function puedeIniciar_(chat) {
  const m = mision_();
  if (m && LIBRES.indexOf(m.estado) < 0 && m.estado !== 'error') {
    enviar_(chat, '🎖 <b>Jason Hayes</b>: tenemos en curso la ' + esc_(m.codigo) + '. Termínala o escribe /cancelar antes de abrir otra.');
    return false;
  }
  return true;
}

function iniciarMision_(chat, archivo) {
  const n = parseInt(prop_('CONTADOR', '0'), 10) + 1;
  P_().setProperty('CONTADOR', String(n));
  const m = {
    id: Utilities.formatDate(new Date(), 'America/Bogota', 'yyMMddHHmmss'),
    codigo: 'Operación ' + NOMBRES_OPERACION[(n - 1) % NOMBRES_OPERACION.length] + '-' + ('0' + n).slice(-2),
    estado: 'transcribiendo', chat: chat, video_id: archivo.getId(), nombre: archivo.getName(),
    preguntas: [], respuestas: [], idx: 0, duracion: 60, formato: 'vertical', ajustes: '', reels: 0, creada: Date.now(),
  };
  guardarMision_(m);
  guardarTrabajo_(m, {});
  if (!compartir_(m.video_id, true)) {
    m.estado = 'cancelada'; guardarMision_(m);
    return enviar_(chat, '⚠️ No pude compartir el video por enlace (lo necesita el operador en GitHub). Revisa si tu cuenta de Google lo permite.');
  }
  salaEvento_('jason', 'trabajando', 'Material recibido. Abriendo ' + m.codigo + '.', { mision: resumenSala_(m, 1) });
  enviar_(chat, '🎖 <b>Jason Hayes</b>: material recibido. Abrimos la <b>' + esc_(m.codigo) + '</b>.\n' +
    '🎧 <b>Lisa Davis</b> ya lo está transcribiendo; tarda unos minutos. Te aviso cuando Mandy tenga preguntas.');
  despachar_('transcribir', m);
  salaEvento_('lisa', 'trabajando', 'En camino al material.', { mision: resumenSala_(m, 2) });
}

/** Comparte el video por enlace solo mientras un operador lo necesita. */
function compartir_(id, abrir) {
  try {
    DriveApp.getFileById(id).setSharing(abrir ? DriveApp.Access.ANYONE_WITH_LINK : DriveApp.Access.PRIVATE,
      abrir ? DriveApp.Permission.VIEW : DriveApp.Permission.NONE);
    return true;
  } catch (e) { return !abrir; }
}

function despachar_(tipo, m) {
  const r = UrlFetchApp.fetch('https://api.github.com/repos/' + prop_('GITHUB_REPO') + '/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('GITHUB_TOKEN'), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ event_type: tipo, client_payload: { mision_id: m.id } }),
  });
  if (r.getResponseCode() !== 204) {
    throw new Error('GitHub no aceptó la orden (' + r.getResponseCode() + '). Revisa GITHUB_TOKEN y GITHUB_REPO.');
  }
}

// ───────────────────────── Reportes de los operadores ─────────────────────────

function operador_(b) {
  const m = mision_();
  if (!m || m.id !== b.mision_id || LIBRES.indexOf(m.estado) >= 0 && b.tipo !== 'listo') return; // misión vieja o cancelada
  const agente = b.agente === 'sonny' ? 'sonny' : 'lisa';

  if (b.tipo === 'progreso') {
    salaEvento_(agente, 'trabajando', b.texto || 'Trabajando', { mision: resumenSala_(m, agente === 'sonny' ? 6 : 2) });
    return;
  }

  if (b.tipo === 'error') {
    m.estado = 'error'; m.error_de = agente; guardarMision_(m);
    salaEvento_(agente, 'alerta', 'Operación con fallas. Esperando órdenes.', { mision: resumenSala_(m, agente === 'sonny' ? 6 : 2) });
    const tipo = agente === 'sonny' ? 'editar' : 'transcribir';
    return enviar_(m.chat, '⚠️ <b>' + AGENTES[agente].nombre + '</b> reporta un problema:\n<code>' + esc_(b.texto || 'sin detalle') + '</code>',
      [[{ text: '🔁 Reintentar', callback_data: 'reintentar:' + tipo }, { text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }

  if (b.tipo === 'transcripcion') {
    if (m.estado !== 'transcribiendo') return;
    const segmentos = b.segmentos || [];
    if (!segmentos.length) {
      m.estado = 'cancelada'; guardarMision_(m); compartir_(m.video_id, false);
      salaEvento_('lisa', 'espera', 'Sin voz en el material. Misión cerrada.', { mision: null });
      return enviar_(m.chat, '🎧 <b>Lisa Davis</b>: no encontré voz en ese video. Por ahora la sala trabaja con material hablado.');
    }
    guardarTrabajo_(m, { segmentos: segmentos, duracion: b.duracion || 0 });
    salaEvento_('lisa', 'listo', 'Transcripción entregada: ' + segmentos.length + ' frases.', { mision: resumenSala_(m, 3) });
    enviar_(m.chat, '🎧 <b>Lisa Davis</b>: transcripción lista (' + segmentos.length + ' frases, ' + mmss_(b.duracion || 0) + ' de video). Le paso el material a Mandy.');
    return iniciarInterrogatorio_(m, segmentos);
  }

  if (b.tipo === 'listo') {
    if (m.estado !== 'editando') return;
    m.estado = 'lista'; m.reels = (m.reels || 0) + 1; guardarMision_(m);
    compartir_(m.video_id, false);
    guardarGuionEnDrive_(m);
    const s = salaLeer_(); s.stats = s.stats || { reels: 0 }; s.stats.reels = (s.stats.reels || 0) + 1; salaGuardar_(s);
    salaEvento_('sonny', 'listo', 'Reel entregado. Misión cumplida.', { mision: resumenSala_(m, 7) });
    let maestra = '';
    if (b.maestra_id) maestra = '\n💾 Copia maestra (sin recomprimir, ' + (b.maestra_mb || '?') + ' MB): https://drive.google.com/file/d/' + b.maestra_id + '/view';
    else if (b.maestra_error) maestra = '\n⚠️ La copia maestra no se pudo guardar en Drive; el reel de Telegram sí está completo.';
    return enviar_(m.chat, '🎖 <b>Jason Hayes</b>: misión cumplida, comandante. El guion quedó guardado en la carpeta <b>salida</b> de Drive.' + maestra,
      [[{ text: '🎬 Otro reel con este video', callback_data: 'otro' }], [{ text: '✅ Cerrar misión', callback_data: 'cerrar' }]]);
  }
}

// ───────────────────────── Mandy Ellis: interrogatorio y guion ─────────────────────────

const REGLAS_MANDY = 'Eres MANDY ELLIS, guionista de la sala de edición de {medio}, un medio periodístico.\n' +
  'Trabajas con la transcripción de un video (con marcas de tiempo en segundos) y con las respuestas del periodista.\n' +
  'Reglas de oro:\n' +
  '1. Usa ÚNICAMENTE lo que dice el video y lo que responde el periodista. No agregues nombres, cargos, cifras, lugares ni fechas que no estén ahí, aunque los conozcas.\n' +
  '2. Si falta un dato importante, NO lo inventes: anótalo en "vacios_de_informacion".\n' +
  '3. Los cortes deben usar tiempos que existan en la transcripción. No cortes a mitad de una frase.\n' +
  '4. Escribe en español de Colombia, claro, periodístico y sin sensacionalismo.\n' +
  'Responde siempre en JSON válido, sin texto fuera del JSON.';

function iniciarInterrogatorio_(m, segmentos) {
  salaEvento_('mandy', 'trabajando', 'Revisando la transcripción.', { mision: resumenSala_(m, 3) });
  tg_('sendChatAction', { chat_id: m.chat, action: 'typing' });
  const r = ia_('Lee la transcripción y prepárate para hacer un reel.\n\nTRANSCRIPCIÓN:\n' + transcripcionTexto_(segmentos) +
    '\n\nDevuelve este JSON:\n{"resumen": "2 o 3 frases sobre de qué trata el video", "preguntas": ["pregunta 1", "..."]}\n' +
    'Haz entre 2 y 5 preguntas, solo las que de verdad necesites para un buen guion: quién habla y su cargo si no queda claro, ' +
    'el contexto del hecho, el enfoque o mensaje principal que busca el periodista, o datos dudosos (nombres o cifras que la transcripción pudo entender mal).');
  m.preguntas = (r.preguntas || []).slice(0, 5).map(String);
  m.preguntas.push('¿Algún enfoque o indicación especial para este reel?');
  m.respuestas = []; m.idx = 0; m.estado = 'preguntando'; m.resumen = String(r.resumen || '').slice(0, 600);
  guardarMision_(m);
  salaEvento_('mandy', 'trabajando', 'Interrogando al mando: ' + m.preguntas.length + ' preguntas.', { mision: resumenSala_(m, 3) });
  enviar_(m.chat, '🕵️‍♀️ <b>Mandy Ellis</b>: esto es lo que entendí:\n<i>' + esc_(m.resumen) + '</i>\n\n' +
    'Antes de escribir necesito saber algunas cosas. Si no sabes una respuesta, escribe /saltar y la marcaré como vacío de información.');
  enviarPregunta_(m);
}

function enviarPregunta_(m) {
  enviar_(m.chat, '<b>Pregunta ' + (m.idx + 1) + ' de ' + m.preguntas.length + ':</b>\n' + esc_(m.preguntas[m.idx]));
}

function responder_(chat, m, texto) {
  const salto = /^\/saltar/.test(texto) || !texto;
  m.respuestas.push({ p: m.preguntas[m.idx], r: salto ? '' : texto.slice(0, 800) });
  m.idx++;
  guardarMision_(m);
  if (m.idx < m.preguntas.length) return enviarPregunta_(m);
  m.estado = 'duracion'; guardarMision_(m);
  pedirDuracion_(chat, m);
}

function pedirDuracion_(chat, m) {
  salaEvento_('mandy', 'espera', 'Esperando duración y formato del mando.', { mision: resumenSala_(m, 4) });
  enviar_(chat, '⏱ <b>Mandy Ellis</b>: ¿cuánto debe durar el reel? (o escribe los segundos)', [[
    { text: '30 s', callback_data: 'dur:30' }, { text: '45 s', callback_data: 'dur:45' },
    { text: '60 s', callback_data: 'dur:60' }, { text: '90 s', callback_data: 'dur:90' },
  ]]);
}

function fijarDuracion_(chat, m, seg) {
  m.duracion = Math.max(10, Math.min(seg || 60, 600));
  m.estado = 'formato'; guardarMision_(m);
  enviar_(chat, '📐 <b>Mandy Ellis</b>: ' + m.duracion + ' segundos. ¿En qué formato?',
    Object.keys(FORMATOS).map(k => [{ text: FORMATOS[k][1], callback_data: 'fmt:' + k }]));
}

function ajustar_(chat, m, texto) {
  m.ajustes = texto.slice(0, 800);
  guardarMision_(m);
  escribirGuion_(chat, m);
}

function escribirGuion_(chat, m) {
  m.estado = 'escribiendo'; guardarMision_(m);
  salaEvento_('mandy', 'trabajando', 'Escribiendo el guion y la guía de cortes.', { mision: resumenSala_(m, 4) });
  tg_('sendChatAction', { chat_id: chat, action: 'typing' });
  enviar_(chat, '✍️ <b>Mandy Ellis</b>: escribiendo el guion...');
  const t = leerTrabajo_(m);
  const respuestas = (m.respuestas || []).map(x => '- ' + x.p + '\n  ' + (x.r || '(no lo sabe: dejar como vacío de información)')).join('\n');
  let g = null, cortes = [];
  for (let intento = 0; intento < 2 && !cortes.length; intento++) {
    const ajustes = intento === 0 ? m.ajustes : 'Los cortes anteriores no eran válidos. Usa tiempos que existan en la transcripción.';
    g = ia_(promptGuion_(transcripcionTexto_(t.segmentos), respuestas, m.duracion, ajustes));
    cortes = ajustarCortes_(g.cortes, t.segmentos, t.duracion || 1e9);
  }
  if (!cortes.length) {
    m.estado = 'revision'; guardarMision_(m);
    return enviar_(chat, '⚠️ <b>Mandy Ellis</b>: no logré una guía de cortes válida. ¿Pido otra versión?',
      [[{ text: '✏️ Indicar cambios', callback_data: 'cambiar' }, { text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }
  t.guion = g; t.cortes = cortes;
  guardarTrabajo_(m, t);
  m.titulo = String(g.titulo_pantalla || '').slice(0, 120);
  m.estado = 'revision'; guardarMision_(m);
  salaEvento_('mandy', 'listo', 'Guion listo. Esperando aprobación del mando.', { mision: resumenSala_(m, 5) });
  salaEvento_('mando', 'trabajando', 'Revisando el guion de Mandy.', { mision: resumenSala_(m, 5) });
  const largo = duracionCortes_(cortes) > 60;
  const aprobar = largo
    ? [[{ text: '✅ Aprobar y editar (+ copia maestra en Drive)', callback_data: 'aprobar' }]]
    : [[{ text: '✅ Aprobar y editar', callback_data: 'aprobar' }], [{ text: '💾 Aprobar + copia maestra en Drive', callback_data: 'aprobar_maestra' }]];
  enviar_(chat, guionTelegram_(g, cortes) + (largo ? '\n\n💾 Como pasa de 1 minuto, Sonny guardará también la copia maestra en Drive.' : ''),
    aprobar.concat([[{ text: '✏️ Pedir cambios', callback_data: 'cambiar' }, { text: '❌ Cancelar', callback_data: 'cancelar' }]]));
}

function promptGuion_(transcripcion, respuestas, duracion, ajustes) {
  return 'TRANSCRIPCIÓN:\n' + transcripcion + '\n\nRESPUESTAS DEL PERIODISTA:\n' + (respuestas || '(sin respuestas)') +
    '\n\nEscribe el guion de un reel de aproximadamente ' + duracion + ' segundos (tolerancia de ±20 %) armado con fragmentos de este video. ' +
    'Empieza por el momento más fuerte (gancho); el orden de los cortes puede no ser cronológico si así se cuenta mejor la historia.\n' +
    (ajustes ? '\nEl periodista revisó una versión anterior y pide estos cambios:\n' + ajustes + '\n' : '') +
    '\nDevuelve este JSON:\n{\n' +
    '  "titulo_pantalla": "titular corto para la pantalla, máximo 8 palabras",\n' +
    '  "guion": {"gancho": "qué se ve y se oye en los primeros segundos y por qué atrapa", "desarrollo": "cómo avanza la historia con los cortes elegidos", ' +
    '"cierre": "con qué se queda el espectador", "voz_en_off": "texto para narrar si hiciera falta; cadena vacía si el video se sostiene solo"},\n' +
    '  "cortes": [{"inicio": 0.0, "fin": 0.0, "motivo": "por qué este fragmento"}],\n' +
    '  "vacios_de_informacion": ["dato que falta y no se debe inventar"]\n}';
}

function aprobar_(chat, m, pidioMaestra) {
  const t = leerTrabajo_(m);
  const quiereMaestra = pidioMaestra || duracionCortes_(t.cortes || []) > 60;
  t.maestra_url = '';
  let avisoMaestra = '';
  if (quiereMaestra) {
    try {
      t.maestra_url = sesionSubidaDrive_(m);
      avisoMaestra = '\n💾 También guardará la copia maestra en tu carpeta <b>salida</b> de Drive.';
    } catch (e) {
      avisoMaestra = '\n⚠️ No pude preparar la copia maestra en Drive (' + esc_(String(e.message || e)).slice(0, 150) + '). Te llega solo por Telegram.';
    }
  }
  guardarTrabajo_(m, t);
  m.estado = 'editando'; guardarMision_(m);
  compartir_(m.video_id, true);
  despachar_('editar', m);
  salaEvento_('mando', 'listo', 'Guion aprobado. Luz verde para Bravo 3.', { mision: resumenSala_(m, 6) });
  salaEvento_('sonny', 'trabajando', 'Orden recibida. Preparando el equipo.', { mision: resumenSala_(m, 6) });
  enviar_(chat, '🎖 <b>Jason Hayes</b>: guion aprobado. <b>Sonny Quinn</b> en camino; te entrega el reel aquí mismo en unos minutos.' + avisoMaestra);
}

function duracionCortes_(cortes) {
  return (cortes || []).reduce((s, c) => s + (Number(c.fin) - Number(c.inicio)), 0);
}

/**
 * Crea una sesión de subida de un solo uso en la carpeta "salida" de Drive.
 * Sonny solo recibe esa dirección: sirve para subir ESE archivo y nada más.
 */
function sesionSubidaDrive_(m) {
  const fecha = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd-HHmm');
  const nombre = m.nombre.replace(/\.[^.]+$/, '') + '_reel_maestro_' + fecha + '.mp4';
  const r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': 'video/mp4' },
    payload: JSON.stringify({ name: nombre, parents: [carpeta_('salida').getId()], mimeType: 'video/mp4' }),
  });
  const h = r.getAllHeaders();
  const url = h.Location || h.location;
  if (r.getResponseCode() !== 200 || !url) throw new Error('Drive respondió ' + r.getResponseCode());
  return url;
}

/** Mandy piensa con Gemini (gratis) o, si no hay clave de Gemini, con Groq. */
function ia_(usuario) {
  const sistema = REGLAS_MANDY.replace('{medio}', prop_('NOMBRE_MEDIO', 'Torre Informativa'));
  return prop_('GEMINI_API_KEY') ? gemini_(sistema, usuario) : groq_(sistema, usuario);
}

/** Modelos gratuitos de Gemini, en orden de preferencia: si uno está saturado, se prueba el siguiente. */
function modelosGemini_() {
  const preferido = prop_('MODELO_GEMINI', 'gemini-3.8-flash');
  return [preferido, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
    .filter((m, i, lista) => lista.indexOf(m) === i);
}

function gemini_(sistema, usuario) {
  let ultimo = '';
  const modelos = modelosGemini_();
  for (let k = 0; k < modelos.length; k++) {
    for (let i = 0; i < 2; i++) {
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelos[k] + ':generateContent', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY') },
        payload: JSON.stringify({
          systemInstruction: { parts: [{ text: sistema }] },
          contents: [{ role: 'user', parts: [{ text: usuario }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
        }),
      });
      const c = r.getResponseCode();
      if (c === 200) {
        try {
          const d = JSON.parse(r.getContentText());
          return JSON.parse(d.candidates[0].content.parts.map(p => p.text || '').join(''));
        } catch (e) { ultimo = 'respuesta no válida'; continue; }
      }
      if (c === 400 || c === 401 || c === 403) throw new Error('Gemini rechazó la petición (' + c + '). Revisa GEMINI_API_KEY.');
      ultimo = c + ' en ' + modelos[k];
      if (c === 404) break;                      // ese modelo no está disponible: pasar al siguiente
      if (c === 429 || c >= 500) { if (i === 0) Utilities.sleep(5000); continue; }
      throw new Error('Gemini respondió ' + c + ': ' + r.getContentText().slice(0, 200));
    }
  }
  throw new Error('Gemini está saturado en este momento (' + ultimo + '). Intenta de nuevo en unos minutos.');
}

function groq_(sistema, usuario) {
  const modelo = prop_('MODELO_GUIONISTA', 'llama-3.3-70b-versatile');
  for (let i = 0; i < 3; i++) {
    const r = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + prop_('GROQ_API_KEY') },
      payload: JSON.stringify({
        model: modelo, temperature: 0.4, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }],
      }),
    });
    const c = r.getResponseCode();
    if (c === 200) {
      try { return JSON.parse(JSON.parse(r.getContentText()).choices[0].message.content); } catch (e) { continue; }
    }
    if (c === 413) throw new Error('La transcripción es demasiado larga para el plan gratuito de Groq. Usa un video más corto o cambia MODELO_GUIONISTA.');
    if (c === 429 && i < 2) { Utilities.sleep(15000); continue; }
    throw new Error('Groq respondió ' + c + ': ' + r.getContentText().slice(0, 200));
  }
  throw new Error('Mandy no logró una respuesta válida. Intenta de nuevo.');
}

/** Prueba rápida de la IA para configurar(): no muestra la clave. */
function probarIA_() {
  try {
    const r = ia_('Responde solo este JSON: {"ok": true}');
    return r && r.ok ? 'responde ✅' : 'respondió algo inesperado';
  } catch (e) {
    return 'ERROR — ' + String(e.message || e).slice(0, 200);
  }
}

/** Valida los cortes y los ajusta al inicio/fin de frase más cercano para no cortar palabras. */
function ajustarCortes_(cortes, segmentos, duracionVideo) {
  const inicios = (segmentos || []).map(s => s.inicio);
  const fines = (segmentos || []).map(s => s.fin);
  const cerca = (lista, t) => lista.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a, lista[0]);
  const limpios = [];
  (cortes || []).forEach(c => {
    let a = parseFloat(c && c.inicio), b = parseFloat(c && c.fin);
    if (isNaN(a) || isNaN(b)) return;
    a = Math.max(0, a); b = Math.min(duracionVideo, b);
    if (inicios.length) { const x = cerca(inicios, a); if (Math.abs(x - a) <= 2) a = x; }
    if (fines.length) { const y = cerca(fines, b); if (Math.abs(y - b) <= 2) b = y; }
    b = Math.min(b + 0.25, duracionVideo);
    if (b - a >= 1) limpios.push({ inicio: Math.round(a * 100) / 100, fin: Math.round(b * 100) / 100, motivo: String(c.motivo || '') });
  });
  return limpios;
}

function guionTelegram_(g, cortes) {
  const gu = g.guion || {};
  const total = cortes.reduce((s, c) => s + (c.fin - c.inicio), 0);
  const l = ['🕵️‍♀️ <b>Mandy Ellis</b>: guion listo.', '', '📰 <b>' + esc_(g.titulo_pantalla || 'Sin titular') + '</b>', '',
    '<b>Gancho:</b> ' + esc_(gu.gancho), '<b>Desarrollo:</b> ' + esc_(gu.desarrollo), '<b>Cierre:</b> ' + esc_(gu.cierre)];
  if (gu.voz_en_off) l.push('<b>Voz en off:</b> ' + esc_(gu.voz_en_off));
  l.push('', '✂️ <b>Guía de cortes</b>');
  cortes.forEach((c, i) => l.push((i + 1) + '. ' + mmss_(c.inicio) + ' → ' + mmss_(c.fin) + ' (' + Math.round(c.fin - c.inicio) + ' s) — ' + esc_(c.motivo)));
  l.push('⏱ Total: ' + Math.round(total) + ' s');
  const v = g.vacios_de_informacion || [];
  if (v.length) { l.push('', '⚠️ <b>Vacíos de información</b> (no se inventaron):'); v.forEach(x => l.push('• ' + esc_(x))); }
  return l.join('\n');
}

function guardarGuionEnDrive_(m) {
  const t = leerTrabajo_(m);
  if (!t.guion) return;
  const texto = guionTelegram_(t.guion, t.cortes || []).replace(/<[^>]+>/g, '') + '\n\nMaterial: ' + m.nombre + '\n' + m.codigo;
  const nombre = m.nombre.replace(/\.[^.]+$/, '') + '_guion' + (m.reels > 1 ? '_' + m.reels : '') + '.txt';
  carpeta_('salida').createFile(nombre, texto, MimeType.PLAIN_TEXT);
}

// ───────────────────────── Datos de la misión ─────────────────────────

function mision_() { try { return JSON.parse(prop_('MISION', 'null')); } catch (e) { return null; } }
function guardarMision_(m) { P_().setProperty('MISION', JSON.stringify(m)); }

function archivoTrabajo_(m) {
  const it = carpeta_('trabajo').getFilesByName('mision_' + m.id + '.json');
  return it.hasNext() ? it.next() : null;
}
function leerTrabajo_(m) {
  const f = archivoTrabajo_(m);
  try { return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : {}; } catch (e) { return {}; }
}
function guardarTrabajo_(m, datos) {
  const f = archivoTrabajo_(m);
  const txt = JSON.stringify(datos);
  if (f) f.setContent(txt);
  else carpeta_('trabajo').createFile('mision_' + m.id + '.json', txt, 'application/json');
}

function trabajoParaOperador_(m) {
  const t = leerTrabajo_(m);
  return {
    video_id: m.video_id, nombre: m.nombre, chat_id: m.chat,
    segmentos: t.segmentos || [], cortes: t.cortes || [], titulo: m.titulo || '', formato: m.formato || 'vertical',
    maestra_url: t.maestra_url || '',
    conf: { color: prop_('COLOR_MARCA', '#E30613'), fuente: prop_('FUENTE', 'Liberation Sans'), segundos_titulo: prop_('SEGUNDOS_TITULO', '0') },
  };
}

function transcripcionTexto_(segmentos) {
  return (segmentos || []).map(s => '[' + Number(s.inicio).toFixed(1) + '-' + Number(s.fin).toFixed(1) + '] ' + s.texto).join('\n');
}

function mmss_(t) {
  t = Number(t) || 0;
  const m = Math.floor(t / 60), s = (t % 60).toFixed(1);
  return ('0' + m).slice(-2) + ':' + (s.length < 4 ? '0' + s : s);
}

// ───────────────────────── Sala virtual (estado público) ─────────────────────────
// Lo público es deliberadamente mínimo: código de operación, etapa y estado de cada agente.
// Nunca se publican titulares, transcripciones ni nombres de archivos.

function salaLeer_() { try { return JSON.parse(prop_('SALA', '{}')); } catch (e) { return {}; } }
function salaGuardar_(s) { s.actualizado = Date.now(); P_().setProperty('SALA', JSON.stringify(s)); }

function salaEvento_(agente, estado, linea, extra) {
  const s = salaLeer_();
  s.agentes = s.agentes || {};
  s.agentes[agente] = { estado: estado, linea: String(linea || '').slice(0, 140), t: Date.now() };
  s.bitacora = s.bitacora || [];
  s.bitacora.unshift({ t: Date.now(), a: agente, x: String(linea || '').slice(0, 160) });
  s.bitacora = s.bitacora.slice(0, 25);
  if (extra) Object.keys(extra).forEach(k => { s[k] = extra[k]; });
  salaGuardar_(s);
}

function resumenSala_(m, etapa) {
  return { codigo: m.codigo, etapa: etapa, etapaNombre: ETAPAS[etapa] || '', inicio: m.creada };
}

function estadoSala_() {
  const s = salaLeer_();
  const agentes = {};
  Object.keys(AGENTES).forEach(k => {
    const a = (s.agentes || {})[k] || { estado: 'espera', linea: 'En posición.' };
    agentes[k] = Object.assign({}, AGENTES[k], a);
  });
  agentes.mando = Object.assign({ nombre: prop_('NOMBRE_MANDO', 'Mando'), alias: 'Comandante', rol: 'Aprueba cada misión' },
    (s.agentes || {}).mando || { estado: 'espera', linea: 'Al mando.' });
  return {
    ok: true, sala: 'Sala de Edición IA', medio: prop_('NOMBRE_MEDIO', 'Torre Informativa'),
    agentes: agentes, mision: s.mision || null, etapas: ETAPAS, bitacora: s.bitacora || [],
    stats: s.stats || { reels: 0 }, actualizado: s.actualizado || Date.now(),
  };
}
