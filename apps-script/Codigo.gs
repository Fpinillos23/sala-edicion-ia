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

  // Telegram no tolera la redirección (302) con la que responde Apps Script, y eso atasca los mensajes.
  // Por eso la sala RECOGE los mensajes con getUpdates cada minuto, en vez de usar webhook.
  const w = tg_('deleteWebhook', { drop_pending_updates: true });
  P_().deleteProperty('TG_OFFSET');
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'revisarTelegram').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('revisarTelegram').timeBased().everyMinutes(1).create();
  tg_('setMyCommands', { commands: [
    { command: 'estado', description: 'Cómo va la misión' },
    { command: 'drive', description: 'Usar un video de la carpeta de Drive' },
    { command: 'saltar', description: 'Saltar una pregunta de Mandy' },
    { command: 'cancelar', description: 'Cancelar la misión actual' },
    { command: 'ayuda', description: 'Cómo funciona la sala' },
  ] });
  if (!prop_('SALA')) salaEvento_('jason', 'espera', 'Sala instalada. Esperando material.', { mision: null });

  Logger.log('Telegram: ' + (w && w.ok ? 'recogida de mensajes cada minuto activa ✅' : 'ERROR ' + JSON.stringify(w)));
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
  const activadores = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'revisarTelegram').length;
  Logger.log('Recepción de mensajes: ' + (!url && activadores ? 'recogida cada minuto ✅' :
    (url ? 'webhook activo ❌ (ejecuta configurar para cambiar al modo de recogida)' : 'falta el activador ❌ (ejecuta configurar)')));
  Logger.log('Mensajes en espera: ' + (r.pending_update_count || 0));
  if (url) Logger.log('Último error de entrega: ' + (r.last_error_message || 'ninguno'));
  Logger.log('Dueño registrado: ' + (prop_('CHAT_DUENO') ? 'sí ✅' : 'todavía no (falta el primer /start)'));
  if (prop_('CHAT_DUENO')) {
    const r = tg_('sendMessage', { chat_id: prop_('CHAT_DUENO'), text: '🎖 Jason Hayes: prueba de comunicación desde el diagnóstico.' });
    Logger.log('Envío de prueba a tu chat: ' + (r.ok ? 'entregado ✅' : 'ERROR — ' + JSON.stringify(r).slice(0, 300)));
  }
  try { sesionSubidaDrive_({ nombre: 'prueba.mp4' }); Logger.log('Copia maestra en Drive: permiso de subida ✅ (la prueba no crea archivos)'); }
  catch (e) { Logger.log('Copia maestra en Drive: ERROR — ' + (e.message || e)); }
}

/**
 * Activador de cada minuto: recoge los mensajes nuevos de Telegram y los atiende.
 * Si hay conversación activa, sigue escuchando unos segundos para que las respuestas sean rápidas.
 */
function revisarTelegram() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // otra revisión u operador está trabajando
  try {
    const inicio = Date.now();
    let activo = false, vacios = 0;
    while (Date.now() - inicio < 40000) { // tope por revisión: cuida la cuota de 90 min/día de los activadores
      const offset = parseInt(prop_('TG_OFFSET', '0'), 10);
      const datos = { timeout: activo ? 8 : 0, allowed_updates: ['message', 'callback_query'] };
      if (offset) datos.offset = offset;
      const r = tg_('getUpdates', datos);
      if (!r.ok) break;
      const lista = r.result || [];
      lista.forEach(u => {
        P_().setProperty('TG_OFFSET', String(u.update_id + 1)); // se marca antes, para no repetirlo si algo falla
        try { telegram_(u); } catch (err) { avisarError_(err); }
      });
      if (lista.length) { activo = true; vacios = 0; }
      else if (!activo || ++vacios >= 2) break; // tras tu último mensaje escucha ~16-25 s más
    }
  } finally {
    lock.releaseLock();
  }
}

function avisarError_(err) {
  console.error('Error atendiendo Telegram: ' + (err && err.stack || err));
  const m = mision_();
  const chat = (m && m.chat) || prop_('CHAT_DUENO');
  if (chat) enviar_(chat, '⚠️ <b>Jason Hayes</b>: tuvimos un problema.\n<code>' + esc_(String(err.message || err)).slice(0, 600) + '</code>');
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
  ['entrada', 'trabajo', 'salida', 'imagenes', 'audios'].forEach(n => {
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

  if (msg.voice) return recibirNotaDeVoz_(chat, msg.voice);
  const foto = fotoDe_(msg);
  if (foto) return recibirImagen_(chat, msg, foto, texto);
  const sonido = msg.audio || (msg.document && /^audio\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (sonido) return recibirMusica_(chat, sonido, texto);

  const doc = msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null;
  const archivo = msg.video || doc;
  if (archivo) return recibirVideoTelegram_(chat, archivo, texto);

  const idDrive = idDrive_(texto);
  if (idDrive) return iniciarConDrive_(chat, idDrive, texto.replace(/https?:\/\/\S+/g, '').trim());

  return textoLibre_(chat, texto);
}

/** Todo texto (o nota de voz ya transcrita) que no es un comando ni un archivo. */
function textoLibre_(chat, texto) {
  const m = mision_();
  if (m && m.estado === 'instruccion') { agregarOrden_(m, texto); return planificar_(chat, m); }
  if (m && m.estado === 'imagenes') {
    if (/^(\/?listo|ya|ya est[aá]|son todas|eso es todo)\b/i.test(texto)) return imagenesListas_(chat, m);
    agregarOrden_(m, texto);
    return enviar_(chat, '🖼 <b>Jason Hayes</b>: anotado. Estoy recibiendo imágenes (' + (m.imagenes || []).length + ' hasta ahora). ' +
      'Envía las que falten y pulsa el botón cuando termines.', [[{ text: '✅ Ya envié todas', callback_data: 'img:listo' }]]);
  }
  if (m && m.estado === 'revision' && m.modo === 'plan') { agregarOrden_(m, 'Cambio pedido: ' + texto); return planificar_(chat, m); }
  if (m && m.estado === 'preguntando') return responder_(chat, m, texto);
  if (m && m.estado === 'ajuste') return ajustar_(chat, m, texto);
  if (m && m.estado === 'duracion' && /^\d{1,3}$/.test(texto)) return fijarDuracion_(chat, m, parseInt(texto, 10));
  if (m && ['transcribiendo', 'escribiendo', 'editando'].indexOf(m.estado) >= 0) {
    const quien = { transcribiendo: 'Lisa está transcribiendo', escribiendo: 'Mandy está escribiendo el guion', editando: 'Sonny está editando' }[m.estado];
    return enviar_(chat, '⏳ <b>Jason Hayes</b>: ' + quien + '. Te aviso apenas termine.');
  }
  enviar_(chat, '🎖 <b>Jason Hayes</b>: envíame un video (hasta 20 MB) o un enlace de Google Drive para abrir una misión. ' +
    'Si vas a usar imágenes, puedes mandarlas antes o después del video. Escribe /ayuda si lo necesitas.');
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
  if (d === 'modo:reel' && m.estado === 'instruccion') return elegirReel_(chat, m);
  if (d === 'img:listo' && m.estado === 'imagenes') return imagenesListas_(chat, m);
  if (d.indexOf('dur:') === 0 && m.estado === 'duracion') return fijarDuracion_(chat, m, parseInt(d.slice(4), 10));
  if (d.indexOf('fmt:') === 0 && m.estado === 'formato') {
    m.formato = (FORMATOS[d.slice(4)] || FORMATOS['1'])[0];
    m.ajustes = '';
    guardarMision_(m);
    return escribirGuion_(chat, m);
  }
  if ((d === 'aprobar' || d === 'aprobar_maestra') && m.estado === 'revision') return aprobar_(chat, m, d === 'aprobar_maestra');
  if (d === 'cambiar' && m.estado === 'revision' && m.modo === 'plan') {
    return enviar_(chat, '✏️ <b>Jason Hayes</b>: dime qué cambio (por escrito o con una nota de voz). Por ejemplo: ' +
      '<i>"que las fotos salgan en pantalla completa"</i>, <i>"déjale la voz pero quítale la música"</i>, <i>"córtalo a 30 segundos"</i>.');
  }
  if (d === 'cambiar' && m.estado === 'revision') {
    m.estado = 'ajuste'; guardarMision_(m);
    salaEvento_('mando', 'trabajando', 'Mando pidió ajustes al guion.', { mision: resumenSala_(m, 4) });
    return enviar_(chat, '✏️ <b>Mandy Ellis</b>: dime qué cambio quieres (por ejemplo: "empieza con la cifra", "más corto", "quita el segundo corte").');
  }
  if (d === 'otro' && m.estado === 'lista') {
    if (m.modo !== 'reel') {
      m.instruccion = ''; guardarMision_(m);
      return preguntarInstruccion_(m, '🎖 <b>Jason Hayes</b>: otra versión con el mismo material. ¿Qué hacemos esta vez?');
    }
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
    compartirMaterial_(m, true);
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
    '2. <b>Te pregunto qué hacemos con él</b>. Respóndeme con tus palabras, por escrito o con una nota de voz 🎙. También puedes darme la orden en el pie de foto del video.',
    '   Ejemplos: <i>"quítale la música y pon encima las fotos"</i>, <i>"déjale la voz, quita la música y ponle subtítulos"</i>, ' +
    '<i>"del segundo 10 al 40, en blanco y negro, con el titular Festival Vallenato"</i>, <i>"un reel de 45 segundos con lo que dice el alcalde"</i>.',
    '   🖼 Fotos y 🎵 música de fondo: envíamelas antes o después del video.',
    '   Te muestro el plan de edición antes de tocar nada. Si algo no lo sé hacer, te lo digo.',
    '3. Tú apruebas o pides cambios.',
    '4. <b>Sonny Quinn</b> edita y te entrega el video aquí mismo.',
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
  compartirMaterial_(m, false);
  salaEvento_('jason', 'espera', 'Misión abortada por el mando.', { mision: null });
  enviar_(chat, '🛑 <b>Jason Hayes</b>: ' + esc_(m.codigo) + ' cancelada. Si un operador ya estaba trabajando, ignoraré su resultado.');
}

// ───────────────────────── Recepción del material ─────────────────────────

function recibirVideoTelegram_(chat, archivo, instruccion) {
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
  iniciarMision_(chat, guardado, instruccion, archivo.duration || 0);
}

function iniciarConDrive_(chat, id, instruccion) {
  if (!puedeIniciar_(chat)) return;
  let f;
  try { f = DriveApp.getFileById(id); } catch (e) { return enviar_(chat, '⚠️ No encuentro ese archivo en tu Drive.'); }
  if (/^image\//.test(f.getMimeType())) return guardarImagen_(chat, f, null, instruccion);
  if (!/^video\//.test(f.getMimeType())) return enviar_(chat, '⚠️ Ese archivo no es un video ni una imagen.');
  iniciarMision_(chat, f, instruccion, duracionDrive_(id));
}

/** Duración de un video de Drive (en segundos), si Drive ya la calculó. */
function duracionDrive_(id) {
  try {
    const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?fields=videoMediaMetadata(durationMillis)&supportsAllDrives=true',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    const ms = Number(((JSON.parse(r.getContentText()) || {}).videoMediaMetadata || {}).durationMillis || 0);
    return Math.round(ms / 100) / 10;
  } catch (e) { return 0; }
}

// ───────────────────────── Imágenes para el modo visual ─────────────────────────

/** Devuelve la foto (la de mayor resolución) o la imagen enviada como archivo, si el mensaje trae una. */
function fotoDe_(msg) {
  if (msg.photo && msg.photo.length) return msg.photo[msg.photo.length - 1];
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document;
  return null;
}

function recibirImagen_(chat, msg, foto, texto) {
  if ((foto.file_size || 0) > LIMITE_TELEGRAM) {
    return enviar_(chat, '📦 <b>Jason Hayes</b>: esa imagen pasa de 20 MB. Súbela a la carpeta <b>imagenes</b> de Drive y pégame su enlace.');
  }
  const f = tg_('getFile', { file_id: foto.file_id });
  if (!f.ok) return enviar_(chat, '⚠️ No pude recibir esa imagen de Telegram. Intenta enviarla de nuevo.');
  const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + f.result.file_path).getBlob();
  const ext = (String(f.result.file_path).match(/\.(\w{3,4})$/) || [0, 'jpg'])[1];
  const nombre = foto.file_name || ('imagen_' + Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd_HHmmss') + '_' + msg.message_id + '.' + ext);
  const guardada = carpeta_('imagenes').createFile(blob.setName(nombre));
  guardarImagen_(chat, guardada, msg.media_group_id || null, texto);
}

/** Suma la imagen a la misión en curso o, si aún no hay video, la deja en espera. Responde una sola vez por álbum. */
function guardarImagen_(chat, archivo, grupo, texto) {
  const m = mision_();
  const activa = m && LIBRES.indexOf(m.estado) < 0 && m.estado !== 'error';
  let total;
  if (activa) {
    m.imagenes = (m.imagenes || []).concat([archivo.getId()]);
    if (texto) agregarOrden_(m, texto);
    guardarMision_(m);
    total = m.imagenes.length;
  } else {
    const pend = pendientes_().concat([archivo.getId()]);
    P_().setProperty('IMAGENES_PENDIENTES', JSON.stringify(pend));
    if (texto) P_().setProperty('INSTRUCCION_PENDIENTE', texto.slice(0, 800));
    total = pend.length;
  }
  const cache = CacheService.getScriptCache();
  if (grupo) {
    if (cache.get('album_' + grupo)) return;          // ya respondí a este álbum
    cache.put('album_' + grupo, '1', 600);
  }
  if (!activa) {
    return enviar_(chat, '🖼 <b>Jason Hayes</b>: ' + (grupo ? 'recibo el álbum' : 'imagen guardada') + ' (' + total +
      ' en espera). Ahora envíame el <b>video</b> y te pregunto qué hacemos con todo.');
  }
  if (m.estado === 'imagenes' || m.estado === 'instruccion' || m.estado === 'revision' && m.modo === 'plan') {
    return enviar_(chat, '🖼 <b>Jason Hayes</b>: ' + (grupo ? 'recibo el álbum' : 'imagen recibida') + ' (' + total +
      ' en total, en el orden en que llegan). ¿Envías más?', [[{ text: '✅ Ya envié todas', callback_data: 'img:listo' }]]);
  }
  enviar_(chat, '🖼 <b>Jason Hayes</b>: guardé la imagen en la misión (' + total + ').');
}

/** Música o audio de fondo enviado como archivo (no nota de voz). */
function recibirMusica_(chat, sonido, texto) {
  if ((sonido.file_size || 0) > LIMITE_TELEGRAM) return enviar_(chat, '📦 <b>Jason Hayes</b>: ese audio pasa de 20 MB.');
  const f = tg_('getFile', { file_id: sonido.file_id });
  if (!f.ok) return enviar_(chat, '⚠️ No pude recibir ese audio de Telegram.');
  const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + f.result.file_path).getBlob();
  const nombre = sonido.file_name || ('audio_' + Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd_HHmmss') + '.mp3');
  const id = carpeta_('audios').createFile(blob.setName(nombre)).getId();
  const m = mision_();
  if (m && LIBRES.indexOf(m.estado) < 0 && m.estado !== 'error') {
    m.musica = id; if (texto) agregarOrden_(m, texto); guardarMision_(m);
    if (texto && (m.estado === 'instruccion' || m.estado === 'revision' && m.modo === 'plan')) return planificar_(chat, m);
    return enviar_(chat, '🎵 <b>Jason Hayes</b>: audio de fondo recibido para la misión. Dime cómo usarlo (por ejemplo, <i>"ponla de fondo, suave"</i>).');
  }
  P_().setProperty('MUSICA_PENDIENTE', id);
  if (texto) P_().setProperty('INSTRUCCION_PENDIENTE', texto.slice(0, 800));
  enviar_(chat, '🎵 <b>Jason Hayes</b>: audio de fondo guardado. Ahora envíame el <b>video</b>.');
}

/** Las notas de voz son órdenes: Gemini las transcribe y se tratan como texto. */
function recibirNotaDeVoz_(chat, voz) {
  if (!prop_('GEMINI_API_KEY')) return enviar_(chat, '🎙 <b>Jason Hayes</b>: para entender notas de voz necesito la clave de Gemini. Por ahora, escríbeme la instrucción.');
  if ((voz.file_size || 0) > LIMITE_TELEGRAM) return enviar_(chat, '🎙 Esa nota de voz es muy larga. ¿Me la escribes?');
  let texto = '';
  try {
    const f = tg_('getFile', { file_id: voz.file_id });
    const bytes = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + f.result.file_path).getBlob().getBytes();
    tg_('sendChatAction', { chat_id: chat, action: 'typing' });
    const r = gemini_('Transcribes notas de voz en español de Colombia, palabra por palabra, sin resumir ni agregar nada.', [
      { inline_data: { mime_type: voz.mime_type || 'audio/ogg', data: Utilities.base64Encode(bytes) } },
      { text: 'Transcribe esta nota de voz. Devuelve JSON: {"texto": "lo que dice"}' }]);
    texto = String((r && r.texto) || '').trim();
  } catch (e) {
    console.error('Nota de voz: ' + (e.message || e));
  }
  if (!texto) return enviar_(chat, '🎙 <b>Jason Hayes</b>: no logré entender la nota de voz. ¿Me la repites o me la escribes?');
  enviar_(chat, '🎙 Entendí: <i>«' + esc_(texto.slice(0, 600)) + '»</i>');
  const m = mision_();
  if (!m || LIBRES.indexOf(m.estado) >= 0 || m.estado === 'error') {
    P_().setProperty('INSTRUCCION_PENDIENTE', texto.slice(0, 800));
    return enviar_(chat, '🎖 <b>Jason Hayes</b>: anotada la instrucción. Ahora envíame el <b>video</b>.');
  }
  textoLibre_(chat, texto);
}

function pendientes_() { try { return JSON.parse(prop_('IMAGENES_PENDIENTES', '[]')) || []; } catch (e) { return []; } }

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

function iniciarMision_(chat, archivo, instruccion, duracionVideo) {
  const n = parseInt(prop_('CONTADOR', '0'), 10) + 1;
  P_().setProperty('CONTADOR', String(n));
  const m = {
    id: Utilities.formatDate(new Date(), 'America/Bogota', 'yyMMddHHmmss'),
    codigo: 'Operación ' + NOMBRES_OPERACION[(n - 1) % NOMBRES_OPERACION.length] + '-' + ('0' + n).slice(-2),
    estado: 'instruccion', chat: chat, video_id: archivo.getId(), nombre: archivo.getName(),
    duracion_video: Number(duracionVideo) || 0, imagenes: pendientes_(), musica: prop_('MUSICA_PENDIENTE', ''), modo: '', audio: 'silencio', instruccion: '',
    preguntas: [], respuestas: [], idx: 0, duracion: 60, formato: 'vertical', ajustes: '', reels: 0, creada: Date.now(),
  };
  const pendiente = prop_('INSTRUCCION_PENDIENTE', '');
  P_().deleteProperty('IMAGENES_PENDIENTES');
  P_().deleteProperty('INSTRUCCION_PENDIENTE');
  P_().deleteProperty('MUSICA_PENDIENTE');
  guardarMision_(m);
  guardarTrabajo_(m, {});
  salaEvento_('jason', 'trabajando', 'Material recibido. Esperando la orden del mando.', { mision: resumenSala_(m, 1) });
  const orden = [String(instruccion || '').trim(), pendiente].filter(Boolean).join('\n');
  if (orden) {
    enviar_(chat, '🎖 <b>Jason Hayes</b>: material recibido. Abrimos la <b>' + esc_(m.codigo) + '</b>. Reviso tu instrucción...');
    agregarOrden_(m, orden);
    return planificar_(chat, m);
  }
  preguntarInstruccion_(m, '🎖 <b>Jason Hayes</b>: material recibido. Abrimos la <b>' + esc_(m.codigo) + '</b>.\n' +
    'Antes de mover al equipo, dime: <b>¿qué hacemos con este video?</b>');
}

/** Jason no mueve al equipo hasta tener la orden del mando. La orden es libre: texto o nota de voz. */
function preguntarInstruccion_(m, encabezado) {
  m.estado = 'instruccion'; guardarMision_(m);
  const n = (m.imagenes || []).length;
  const extras = [];
  if (n) extras.push('🖼 ' + n + ' imagen' + (n > 1 ? 'es' : ''));
  if (m.musica) extras.push('🎵 un audio de fondo');
  enviar_(m.chat, encabezado + (extras.length ? '\n📎 Tengo además: ' + extras.join(' y ') + '.' : '') +
    '\n\nDime con tus palabras qué hacemos, por escrito o con una <b>nota de voz</b> 🎙. Por ejemplo:\n' +
    '• <i>"Quítale la música y pon encima las fotos que te mandé"</i>\n' +
    '• <i>"Déjale la voz, quítale la música y ponle subtítulos"</i>\n' +
    '• <i>"Del segundo 10 al 40, en blanco y negro, con el titular Festival Vallenato"</i>\n' +
    '• <i>"Un reel de 45 segundos con lo que dice el alcalde"</i>\n' +
    'Si vas a usar fotos o música, envíamelas cuando quieras.',
    [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]]);
}

function agregarOrden_(m, texto) {
  texto = String(texto || '').trim();
  if (!texto) return;
  m.instruccion = ((m.instruccion ? m.instruccion + '\n' : '') + texto).slice(-3000);
  guardarMision_(m);
}

const CAPACIDADES_PLAN =
  'La sala ejecuta un PLAN de edición sobre UN video. Puede hacer exactamente esto:\n' +
  '- formato: "vertical" (9:16 con fondo desenfocado), "vertical_recorte" (9:16 recortando el centro), "cuadrado" (1:1), "original".\n' +
  '- tramos: partes del video a conservar, en el orden en que deben salir [{"inicio": s, "fin": s}]. Vacío = video completo.\n' +
  '- velocidad: 0.25 a 4 (1 = normal; 2 = doble de rápido; 0.5 = cámara lenta).\n' +
  '- color: {"filtro": "ninguno|blanco_negro|calido|frio|contraste|vivo", "brillo": -0.3 a 0.3}.\n' +
  '- audio: {"modo": "original|silencio|solo_voz", "volumen": 0 a 3, "musica": true/false, "volumen_musica": 0 a 2}. ' +
  '"silencio" quita TODO el sonido. "solo_voz" separa la voz y quita la música de fondo (tarda más). "musica" usa el audio de fondo que envió el periodista (solo si existe).\n' +
  '- subtitulos: true/false (solo si hay transcripción con voz).\n' +
  '- textos en pantalla: [{"texto": "", "inicio": s, "fin": s, "posicion": "arriba|centro|abajo", "estilo": "titular|rotulo|simple"}]. ' +
  'titular = recuadro de color de marca; rotulo = banda oscura (fuentes, nombres, cargos); simple = letra blanca con borde.\n' +
  '- imagenes: {"usar": [números de imagen en orden], "estilo": "recuadro_flotante|pantalla_completa|esquina", ' +
  '"posicion": "arriba|centro|abajo|izquierda|derecha" o "", "tamano": 0.15 a 1 o 0 (automático), ' +
  '"tiempos": [{"imagen": n, "inicio": s, "fin": s}] o [] para repartirlas parejo a lo largo del video}. Todas entran y salen con fundido.\n' +
  '- fundido: {"entrada": segundos, "salida": segundos} (0 a 3).\n' +
  '- logo: true/false (logo del medio arriba a la derecha, si existe).\n' +
  'Los tiempos de textos e imágenes van en la línea de tiempo del video FINAL (después de cortes y cambio de velocidad).\n' +
  'NO puede: unir varios videos, generar imágenes o voces nuevas, traducir, narrar con voz artificial, quitar objetos o personas, ' +
  'efectos de transición entre tramos distintos del corte directo, ni ningún efecto que no esté en esta lista.';

/** Convierte la instrucción libre del mando en un plan de edición, o pregunta lo que falte. */
function planificar_(chat, m) {
  const t = leerTrabajo_(m);
  const n = (m.imagenes || []).length;
  let transcripcion;
  if (t.segmentos && t.segmentos.length) transcripcion = transcripcionTexto_(t.segmentos).slice(0, 12000);
  else if (t.transcrito) transcripcion = '(Lisa ya revisó el video: NO tiene voz.)';
  else transcripcion = '(No disponible todavía. Si la instrucción depende de lo que se DICE en el video, responde tipo "necesito_transcripcion".)';
  salaEvento_('jason', 'trabajando', 'Traduciendo la orden del mando a un plan.', { mision: resumenSala_(m, 4) });
  tg_('sendChatAction', { chat_id: chat, action: 'typing' });
  let r = null;
  try {
    r = iaJason_('Tu trabajo es convertir la instrucción del periodista en un plan de edición ejecutable.\n\n' +
      CAPACIDADES_PLAN + '\n\nMATERIAL:\n' +
      '- Video de ' + (m.duracion_video ? m.duracion_video + ' segundos' : 'duración desconocida') + '.\n' +
      '- Imágenes del periodista: ' + n + (n ? ' (numeradas del 1 al ' + n + ' en el orden en que llegaron)' : '') + '.\n' +
      '- Audio de fondo enviado por el periodista: ' + (m.musica ? 'sí' : 'no') + '.\n' +
      '- Transcripción del video:\n' + transcripcion + '\n' +
      (t.plan ? '\nPLAN ANTERIOR (el periodista pide cambios sobre este):\n' + JSON.stringify(t.plan) + '\n' : '') +
      '\nINSTRUCCIONES DEL PERIODISTA (en orden; las últimas mandan):\n' + m.instruccion + '\n\n' +
      'Reglas:\n' +
      '1. Haz lo que pide, ni más ni menos. Lo que no pidió queda con valores neutros (formato "vertical" si no dice, audio original, sin color, sin textos).\n' +
      '2. Nunca inventes textos para la pantalla: usa solo palabras que el periodista dio, o frases literales de la transcripción si él pidió sacarlas de ahí.\n' +
      '3. Si algo esencial es ambiguo, responde tipo "preguntar" con máximo 3 preguntas cortas. No preguntes lo que tiene un valor razonable por defecto.\n' +
      '4. Si pide imágenes y no hay ninguna, tipo "necesito_imagenes". Si depende de lo que se dice y no hay transcripción, tipo "necesito_transcripcion".\n' +
      '5. Si pide armar un REEL periodístico eligiendo los mejores fragmentos de lo que se dice (entrevista, declaración) y no da los tiempos, tipo "reel": ' +
      'lo hará Mandy con su guion. Si da tiempos o pide algo concreto, es tipo "plan".\n' +
      '6. Lo que la sala no sabe hacer va en "no_se_puede", explicado en una frase; igual planea el resto si tiene sentido.\n\n' +
      'Devuelve este JSON:\n{"tipo": "plan" | "reel" | "preguntar" | "necesito_imagenes" | "necesito_transcripcion", ' +
      '"entendido": "una o dos frases, en segunda persona, de lo que vas a hacer", "preguntas": [], "no_se_puede": [], ' +
      '"plan": {"formato": "", "tramos": [], "velocidad": 1, "color": {}, "audio": {}, "subtitulos": false, "textos": [], "imagenes": {}, "fundido": {}, "logo": true}}');
  } catch (e) {
    console.error('Planificar: ' + (e.message || e));
    m.estado = 'instruccion'; guardarMision_(m);
    return enviar_(chat, '⚠️ <b>Jason Hayes</b>: no pude consultar a Gemini ahora (' + esc_(String(e.message || e)).slice(0, 150) + '). ' +
      'Repíteme la instrucción en un minuto.', [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }
  r = r || {};
  const tipo = r.tipo;
  const noSe = (r.no_se_puede || []).map(String).filter(Boolean);
  const avisoNo = noSe.length ? '\n\n🚫 <b>Esto no lo sé hacer</b>:\n' + noSe.map(x => '• ' + esc_(x)).join('\n') : '';

  if (tipo === 'reel') return elegirReel_(chat, m);
  if (tipo === 'necesito_imagenes' && !n) {
    m.estado = 'imagenes'; guardarMision_(m);
    return enviar_(chat, '🖼 <b>Jason Hayes</b>: ' + esc_(r.entendido || 'entendido.') + '\nEnvíame las <b>imágenes</b> (fotos o archivos) en el orden en que quieres que salgan. ' +
      'Cuando termines pulsa <b>✅ Ya envié todas</b>.' + avisoNo);
  }
  if (tipo === 'necesito_transcripcion' && !t.transcrito) {
    if (!compartir_(m.video_id, true)) {
      return enviar_(chat, '⚠️ No pude compartir el video por enlace (lo necesita Lisa en GitHub).\n<code>' +
        esc_(prop_('ULTIMO_ERROR_COMPARTIR', 'sin detalle')) + '</code>');
    }
    m.flujo = 'plan'; m.estado = 'transcribiendo'; guardarMision_(m);
    enviar_(chat, '🎧 <b>Jason Hayes</b>: ' + esc_(r.entendido || 'entendido.') + '\nPara eso necesito saber qué se dice: <b>Lisa Davis</b> lo transcribe y luego te muestro el plan.');
    despachar_('transcribir', m);
    return salaEvento_('lisa', 'trabajando', 'Transcribiendo para el plan.', { mision: resumenSala_(m, 2) });
  }
  const preguntas = (r.preguntas || []).map(String).filter(Boolean).slice(0, 3);
  if (tipo === 'preguntar' || !r.plan) {
    m.estado = 'instruccion'; guardarMision_(m);
    const qs = preguntas.length ? preguntas : ['¿Me cuentas con un poco más de detalle qué quieres que haga con el video?'];
    return enviar_(chat, '🤔 <b>Jason Hayes</b>: ' + (r.entendido ? esc_(r.entendido) + '\n' : '') + 'Antes de editar necesito saber:\n' +
      qs.map((q, i) => (i + 1) + '. ' + esc_(q)).join('\n') + avisoNo + '\n\nRespóndeme en un solo mensaje (texto o voz).',
      [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }

  // Plan listo: se guarda y se muestra para aprobación.
  t.plan = r.plan;
  guardarTrabajo_(m, t);
  m.modo = 'plan'; m.estado = 'revision';
  const titular = (r.plan.textos || []).filter(x => x && x.estilo === 'titular')[0];
  m.titulo = titular ? String(titular.texto).slice(0, 120) : '';
  guardarMision_(m);
  const largo = duracionSalida_(m, t) > 60;
  salaEvento_('mando', 'trabajando', 'Revisando el plan de edición.', { mision: resumenSala_(m, 5) });
  const aprobar = largo
    ? [[{ text: '✅ Aprobar y editar (+ copia maestra en Drive)', callback_data: 'aprobar' }]]
    : [[{ text: '✅ Aprobar y editar', callback_data: 'aprobar' }], [{ text: '💾 Aprobar + copia maestra en Drive', callback_data: 'aprobar_maestra' }]];
  enviar_(chat, '🎬 <b>Plan de edición</b>\n' + (r.entendido ? '<i>' + esc_(r.entendido) + '</i>\n' : '') + '\n' + describirPlan_(r.plan, m, t) + avisoNo +
    (largo ? '\n\n💾 Como pasa de 1 minuto, Sonny guardará también la copia maestra en Drive.' : '') +
    '\n\n¿Lo apruebas? Si quieres cambiar algo, escríbemelo o mándame una nota de voz.',
    aprobar.concat([[{ text: '✏️ Cambiar algo', callback_data: 'cambiar' }, { text: '❌ Cancelar', callback_data: 'cancelar' }]]));
}

/** Jason piensa con su propio rol (Mandy tiene el suyo). */
function iaJason_(usuario) {
  const sistema = 'Eres JASON HAYES, coordinador de la sala de edición de video de ' + prop_('NOMBRE_MEDIO', 'Torre Informativa') +
    ', un medio periodístico. Conviertes las instrucciones del periodista en planes de edición ejecutables. ' +
    'Escribes en español de Colombia. Responde siempre en JSON válido, sin texto fuera del JSON.';
  return prop_('GEMINI_API_KEY') ? gemini_(sistema, usuario) : groq_(sistema, usuario);
}

/** Texto del plan escrito por el código (no por la IA), para que lo que apruebas sea exactamente lo que Sonny hará. */
function describirPlan_(p, m, t) {
  const l = [];
  const formatos = { vertical: 'vertical 9:16 con fondo desenfocado', vertical_recorte: 'vertical 9:16 recortado al centro', cuadrado: 'cuadrado 1:1', original: 'formato original' };
  l.push('• Formato: ' + (formatos[p.formato] || formatos.vertical) + '.');
  const tramos = (p.tramos || []).filter(x => x && Number(x.fin) > Number(x.inicio));
  if (tramos.length) l.push('• Partes del video: ' + tramos.map(x => mmss_(x.inicio) + '→' + mmss_(x.fin)).join(', ') + '.');
  else l.push('• Video completo' + (m.duracion_video ? ' (' + mmss_(m.duracion_video) + ')' : '') + ', sin cortes.');
  const v = Number(p.velocidad) || 1;
  if (v !== 1) l.push('• Velocidad: ' + (v > 1 ? v + '× más rápido' : 'cámara lenta (' + v + '×)') + '.');
  const c = p.color || {};
  const colores = { blanco_negro: 'blanco y negro', calido: 'tono cálido', frio: 'tono frío', contraste: 'más contraste', vivo: 'colores más vivos' };
  if (colores[c.filtro] || Number(c.brillo)) l.push('• Color: ' + [colores[c.filtro], Number(c.brillo) ? (c.brillo > 0 ? 'más brillo' : 'menos brillo') : ''].filter(Boolean).join(', ') + '.');
  const a = p.audio || {};
  const audios = { silencio: '<b>silencio total</b> (se quita todo el sonido)', solo_voz: 'solo la voz (se separa y se quita la música; tarda unos minutos más)', original: 'el original' };
  let au = audios[a.modo] || audios.original;
  if (a.modo !== 'silencio' && a.volumen !== undefined && Number(a.volumen) !== 1) au += ' al ' + Math.round(Number(a.volumen) * 100) + ' %';
  if (a.musica && m.musica) au += ' + tu audio de fondo' + (a.volumen_musica !== undefined ? ' al ' + Math.round(Number(a.volumen_musica) * 100) + ' %' : '');
  l.push('• Audio: ' + au + '.');
  if (p.subtitulos) l.push('• Subtítulos con lo que se dice' + ((t.segmentos || []).length ? '' : ' (⚠️ no hay transcripción con voz: no saldrán)') + '.');
  (p.textos || []).filter(x => x && x.texto).forEach(x => {
    const estilos = { titular: 'titular', rotulo: 'rótulo', simple: 'texto' };
    l.push('• ' + (estilos[x.estilo] || 'Texto').replace(/^./, s => s.toUpperCase()) + ' ' + (x.posicion || 'arriba') + ': «' + esc_(x.texto) + '»' +
      (x.inicio !== undefined && x.fin !== undefined ? ' (' + mmss_(x.inicio) + '→' + mmss_(x.fin) + ')' : ''));
  });
  const im = p.imagenes || {};
  const n = (m.imagenes || []).length;
  if (n) {
    const usar = (im.usar && im.usar.length ? im.usar : Array.from({ length: n }, (_, i) => i + 1)).filter(i => i >= 1 && i <= n);
    const estilos = { recuadro_flotante: 'en un recuadro flotante con borde blanco', pantalla_completa: 'en pantalla completa con acercamiento lento', esquina: 'pequeñas en una esquina' };
    if (usar.length) {
      l.push('• Imágenes: ' + usar.length + ' de ' + n + ' (' + usar.join(', ') + ') ' + (estilos[im.estilo] || estilos.recuadro_flotante) +
        (im.posicion ? ', ' + im.posicion : '') + ', ' + ((im.tiempos || []).length
          ? 'en estos momentos: ' + im.tiempos.map(x => '#' + x.imagen + ' ' + mmss_(x.inicio) + '→' + mmss_(x.fin)).join(', ')
          : 'repartidas a lo largo del video') + '.');
    }
  }
  const f = p.fundido || {};
  if (Number(f.entrada) || Number(f.salida)) l.push('• Fundido: ' + [Number(f.entrada) ? 'entrada ' + f.entrada + ' s' : '', Number(f.salida) ? 'salida ' + f.salida + ' s' : ''].filter(Boolean).join(', ') + '.');
  const d = duracionSalida_(m, t);
  if (d) l.push('⏱ Duración final aproximada: ' + mmss_(d) + '.');
  return l.join('\n');
}

/** Duración aproximada del video final (para decidir la copia maestra automática). */
function duracionSalida_(m, t) {
  if (m.modo === 'reel') return duracionCortes_(t.cortes || []);
  const p = t.plan;
  if (!p) return m.duracion_video || 0;
  const tramos = (p.tramos || []).filter(x => x && Number(x.fin) > Number(x.inicio));
  const base = tramos.length ? tramos.reduce((s, x) => s + Math.min(Number(x.fin), m.duracion_video || 1e9) - Number(x.inicio), 0) : (m.duracion_video || 0);
  const v = Math.max(0.25, Math.min(4, Number(p.velocidad) || 1));
  return Math.round(base / v * 10) / 10;
}

/** Reel periodístico con lo que se dice: Lisa transcribe y Mandy interroga y escribe el guion. */
function elegirReel_(chat, m) {
  m.modo = 'reel'; guardarMision_(m);
  const t = leerTrabajo_(m);
  if (t.segmentos && t.segmentos.length) return iniciarInterrogatorio_(m, t.segmentos); // ya estaba transcrito
  if (t.transcrito) return preguntarInstruccion_(m, '🎧 <b>Lisa Davis</b>: este video no tiene voz, así que no puedo armar un reel con lo que se dice.');
  if (!compartir_(m.video_id, true)) {
    return enviar_(chat, '⚠️ No pude compartir el video por enlace (lo necesita el operador en GitHub).\n<code>' +
      esc_(prop_('ULTIMO_ERROR_COMPARTIR', 'sin detalle')) + '</code>');
  }
  m.estado = 'transcribiendo'; m.flujo = ''; guardarMision_(m);
  enviar_(chat, '🎖 <b>Jason Hayes</b>: entendido, <b>reel con lo que se dice</b>.\n' +
    '🎧 <b>Lisa Davis</b> ya lo está transcribiendo; tarda unos minutos. Te aviso cuando Mandy tenga preguntas.');
  despachar_('transcribir', m);
  salaEvento_('lisa', 'trabajando', 'En camino al material.', { mision: resumenSala_(m, 2) });
}

function imagenesListas_(chat, m) {
  if (!m.instruccion) return preguntarInstruccion_(m, '🖼 <b>Jason Hayes</b>: tengo ' + (m.imagenes || []).length + ' imágenes.');
  enviar_(chat, '🖼 <b>Jason Hayes</b>: ' + (m.imagenes || []).length + ' imágenes listas. Armo el plan...');
  planificar_(chat, m);
}

/** Abre o cierra el acceso por enlace del video y, si el plan los usa, de las imágenes y el audio de fondo. */
function compartirMaterial_(m, abrir) {
  let ok = compartir_(m.video_id, abrir);
  if (m.modo === 'plan' || m.modo === 'visual') {
    (m.imagenes || []).forEach(id => { ok = compartir_(id, abrir) && ok; });
    if (m.musica) ok = compartir_(m.musica, abrir) && ok;
  }
  return ok;
}

/** Comparte el video por enlace solo mientras un operador lo necesita. */
function compartir_(id, abrir) {
  if (abrir) {
    // Si el video ya se puede abrir por enlace (por ejemplo, porque la carpeta lo hereda), no hay nada que cambiar.
    try {
      const acc = DriveApp.getFileById(id).getSharingAccess();
      if (acc === DriveApp.Access.ANYONE_WITH_LINK || acc === DriveApp.Access.ANYONE) return true;
    } catch (e) { /* se intenta compartir abajo */ }
  }
  try {
    DriveApp.getFileById(id).setSharing(abrir ? DriveApp.Access.ANYONE_WITH_LINK : DriveApp.Access.PRIVATE,
      abrir ? DriveApp.Permission.VIEW : DriveApp.Permission.NONE);
    return true;
  } catch (e) {
    // DriveApp puede negar el cambio ("Acceso denegado: DriveApp"); se intenta con la API de Drive.
    try { compartirApi_(id, abrir); return true; } catch (e2) {
      console.error('No se pudo cambiar el acceso del video: ' + (e2.message || e2));
      P_().setProperty('ULTIMO_ERROR_COMPARTIR', String(e2.message || e2).slice(0, 300));
      return !abrir;
    }
  }
}

/** Abre (solo lectura, cualquiera con el enlace) o cierra el acceso por enlace usando la API de Drive. */
function compartirApi_(id, abrir) {
  const base = 'https://www.googleapis.com/drive/v3/files/' + id + '/permissions';
  const h = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  const lista = UrlFetchApp.fetch(base + '?fields=permissions(id,type,role)', { headers: h, muteHttpExceptions: true });
  if (lista.getResponseCode() !== 200) throw new Error('Drive (lista de permisos) respondió ' + lista.getResponseCode());
  const publicos = (JSON.parse(lista.getContentText()).permissions || []).filter(p => p.type === 'anyone');
  // Siempre se quitan los accesos públicos previos (por ejemplo, "cualquiera con el enlace puede editar").
  publicos.forEach(p => {
    const r = UrlFetchApp.fetch(base + '/' + p.id, { method: 'delete', headers: h, muteHttpExceptions: true });
    if (r.getResponseCode() >= 300) throw new Error('Drive (quitar acceso público) respondió ' + r.getResponseCode());
  });
  if (abrir) {
    const r = UrlFetchApp.fetch(base, {
      method: 'post', contentType: 'application/json', headers: h, muteHttpExceptions: true,
      payload: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }),
    });
    if (r.getResponseCode() >= 300) throw new Error('Drive (compartir por enlace) respondió ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 150));
  }
}

/** Prueba: intenta compartir por enlace el video más reciente de "entrada" y explica qué pasa. */
function probarCompartir() {
  const it = carpeta_('entrada').getFiles();
  let f = null;
  while (it.hasNext()) { const x = it.next(); if (/^video\//.test(x.getMimeType()) && (!f || x.getDateCreated() > f.getDateCreated())) f = x; }
  if (!f) return Logger.log('No hay videos en la carpeta entrada.');
  let dueno = '?';
  try { dueno = f.getOwner() ? f.getOwner().getEmail() : '(unidad compartida)'; } catch (e) { dueno = 'no disponible'; }
  Logger.log('Video: ' + f.getName() + ' — dueño: ' + dueno);
  Logger.log('Acceso actual del video: ' + f.getSharingAccess() + ' / ' + f.getSharingPermission());
  const ent = carpeta_('entrada'), base = DriveApp.getFolderById(prop_('CARPETA_ID'));
  Logger.log('Carpeta "entrada": ' + ent.getSharingAccess() + ' / ' + ent.getSharingPermission());
  Logger.log('Carpeta "Sala de Edición IA": ' + base.getSharingAccess() + ' / ' + base.getSharingPermission());
  const padres = f.getParents(); while (padres.hasNext()) { const p = padres.next(); Logger.log('Carpeta que contiene el video: "' + p.getName() + '" — ' + p.getSharingAccess() + ' / ' + p.getSharingPermission()); }
  try { compartirApi_(f.getId(), true); Logger.log('Compartir por enlace (solo lectura) con la API de Drive: funciona ✅'); }
  catch (e) { Logger.log('Compartir por enlace: ERROR — ' + (e.message || e)); }
  try { compartirApi_(f.getId(), false); Logger.log('Volver a privado: funciona ✅'); }
  catch (e) { Logger.log('Volver a privado: ERROR — ' + (e.message || e)); }
  Logger.log('Acceso final: ' + DriveApp.getFileById(f.getId()).getSharingAccess());
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
    if (m.flujo === 'plan') {
      const tp = leerTrabajo_(m);
      tp.segmentos = segmentos; tp.duracion = b.duracion || 0; tp.transcrito = true;
      guardarTrabajo_(m, tp);
      if (b.duracion) m.duracion_video = b.duracion;
      m.flujo = ''; m.estado = 'instruccion'; guardarMision_(m);
      compartir_(m.video_id, false);
      salaEvento_('lisa', 'listo', 'Transcripción entregada.', { mision: resumenSala_(m, 3) });
      enviar_(m.chat, '🎧 <b>Lisa Davis</b>: ' + (segmentos.length ? 'transcripción lista (' + segmentos.length + ' frases).' : 'no encontré voz en el video.') +
        ' Armo el plan con eso.');
      return planificar_(m.chat, m);
    }
    if (!segmentos.length) {
      compartir_(m.video_id, false);
      salaEvento_('lisa', 'espera', 'Sin voz en el material. Esperando órdenes.', { mision: resumenSala_(m, 1) });
      const ts = leerTrabajo_(m); ts.segmentos = []; ts.transcrito = true; guardarTrabajo_(m, ts);
      m.modo = ''; guardarMision_(m);
      return preguntarInstruccion_(m, '🎧 <b>Lisa Davis</b>: no encontré voz en ese video, así que no hay nada que transcribir para un reel.\n' +
        '🎖 <b>Jason Hayes</b>: ¿qué hacemos entonces con el material?');
    }
    guardarTrabajo_(m, { segmentos: segmentos, duracion: b.duracion || 0 });
    salaEvento_('lisa', 'listo', 'Transcripción entregada: ' + segmentos.length + ' frases.', { mision: resumenSala_(m, 3) });
    enviar_(m.chat, '🎧 <b>Lisa Davis</b>: transcripción lista (' + segmentos.length + ' frases, ' + mmss_(b.duracion || 0) + ' de video). Le paso el material a Mandy.');
    return iniciarInterrogatorio_(m, segmentos);
  }

  if (b.tipo === 'listo') {
    if (m.estado !== 'editando') return;
    m.estado = 'lista'; m.reels = (m.reels || 0) + 1; guardarMision_(m);
    compartirMaterial_(m, false);
    guardarGuionEnDrive_(m);
    const s = salaLeer_(); s.stats = s.stats || { reels: 0 }; s.stats.reels = (s.stats.reels || 0) + 1; salaGuardar_(s);
    salaEvento_('sonny', 'listo', 'Reel entregado. Misión cumplida.', { mision: resumenSala_(m, 7) });
    let maestra = '';
    if (b.maestra_id) maestra = '\n💾 Copia maestra (sin recomprimir, ' + (b.maestra_mb || '?') + ' MB): https://drive.google.com/file/d/' + b.maestra_id + '/view';
    else if (b.maestra_error) maestra = '\n⚠️ La copia maestra no se pudo guardar en Drive; el reel de Telegram sí está completo.';
    return enviar_(m.chat, '🎖 <b>Jason Hayes</b>: misión cumplida, comandante.' +
      (m.modo === 'visual' ? '' : ' El guion quedó guardado en la carpeta <b>salida</b> de Drive.') + maestra,
      [[{ text: m.modo === 'visual' ? '🎬 Otra versión con este material' : '🎬 Otro reel con este video', callback_data: 'otro' }],
        [{ text: '✅ Cerrar misión', callback_data: 'cerrar' }]]);
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
  const r = ia_('Lee la transcripción y prepárate para hacer un reel.\n' +
    (m.instruccion ? '\nINSTRUCCIÓN DEL PERIODISTA (tiene prioridad): ' + m.instruccion + '\n' : '') +
    '\nTRANSCRIPCIÓN:\n' + transcripcionTexto_(segmentos) +
    '\n\nDevuelve este JSON:\n{"resumen": "2 o 3 frases sobre de qué trata el video", "preguntas": ["pregunta 1", "..."]}\n' +
    'Haz entre 2 y 5 preguntas, solo las que de verdad necesites para un buen guion: quién habla y su cargo si no queda claro, ' +
    'el contexto del hecho, el enfoque o mensaje principal que busca el periodista, o datos dudosos (nombres o cifras que la transcripción pudo entender mal).');
  m.preguntas = (r.preguntas || []).slice(0, 5).map(String);
  if (!m.instruccion) m.preguntas.push('¿Algún enfoque o indicación especial para este reel?');
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
  const respuestas = (m.instruccion ? '- Instrucción del periodista al enviar el material (tiene prioridad)\n  ' + m.instruccion + '\n' : '') +
    (m.respuestas || []).map(x => '- ' + x.p + '\n  ' + (x.r || '(no lo sabe: dejar como vacío de información)')).join('\n');
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
  const quiereMaestra = pidioMaestra || duracionSalida_(m, t) > 60;
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
  if (!compartirMaterial_(m, true)) {
    return enviar_(chat, '⚠️ No pude compartir el material por enlace (lo necesita Sonny en GitHub).\n<code>' +
      esc_(prop_('ULTIMO_ERROR_COMPARTIR', 'sin detalle')) + '</code>',
      [[{ text: '🔁 Reintentar', callback_data: 'aprobar' }, { text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }
  m.estado = 'editando'; guardarMision_(m);
  despachar_('editar', m);
  const que = m.modo === 'reel' ? 'Guion' : 'Plan';
  salaEvento_('mando', 'listo', que + ' aprobado. Luz verde para Bravo 3.', { mision: resumenSala_(m, 6) });
  salaEvento_('sonny', 'trabajando', 'Orden recibida. Preparando el equipo.', { mision: resumenSala_(m, 6) });
  enviar_(chat, '🎖 <b>Jason Hayes</b>: ' + que.toLowerCase() + ' aprobado. <b>Sonny Quinn</b> en camino; te entrega el video aquí mismo en unos minutos.' + avisoMaestra);
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
          contents: [{ role: 'user', parts: Array.isArray(usuario) ? usuario : [{ text: usuario }] }],
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
    modo: m.modo || 'reel', imagenes: m.modo === 'plan' || m.modo === 'visual' ? (m.imagenes || []) : [], audio: m.audio || 'silencio',
    plan: t.plan || null, musica: m.modo === 'plan' && t.plan && t.plan.audio && t.plan.audio.musica ? (m.musica || '') : '',
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
