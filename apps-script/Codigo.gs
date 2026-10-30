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
  jason: { nombre: 'Jason Hayes', alias: 'Bravo 1', rol: 'Coordina y arma el plan de edición' },
  lisa:  { nombre: 'Lisa Davis',  alias: 'Inteligencia', rol: 'Transcribe el material' },
  mandy: { nombre: 'Mandy Ellis', alias: 'Enlace', rol: 'Guion de reels de entrevistas' },
  sonny: { nombre: 'Sonny Quinn', alias: 'Bravo 3', rol: 'Edita y entrega el video' },
  ray:   { nombre: 'Ray Perry',   alias: 'Bravo 2', rol: 'Control de calidad' },
};

const FORMATOS = {
  '1': ['vertical', 'Vertical con fondo desenfocado'],
  '2': ['vertical_recorte', 'Vertical recortado al centro'],
  '3': ['original', 'Formato original'],
};

const ETAPAS = ['Sin misión', 'Recepción', 'Inteligencia', 'Instrucción', 'Plan o guion', 'Aprobación', 'Edición', 'Entregado'];
const NOMBRES_OPERACION = ['Guatapurí', 'Tridente', 'Centinela', 'Halcón', 'Sierra', 'Relámpago', 'Ceiba', 'Acordeón', 'Cacique', 'Faro', 'Brújula', 'Cóndor'];
const LIBRES = ['lista', 'cancelada', 'cerrada'];
// Cambia con cada entrega de código. Sirve para detectar si falta crear la "Nueva versión" de la implementación.
const VERSION = '2026-10-30.2';
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
    { command: 'nota', description: 'Armar una nota con varios clips' },
    { command: 'reintentar', description: 'Relanzar a Lisa o a Sonny si se quedaron atascados' },
    { command: 'estilo', description: 'Ver o cambiar el manual de estilo' },
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
  if (p.accion === 'version') return json_({ ok: true, version: VERSION });
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
  if (/^\/nota/.test(texto)) return iniciarNota_(chat, false);
  if (/^\/reintentar/.test(texto)) return reintentarAtascada_(chat);
  if (/^\/estilo/i.test(texto)) return comandoEstilo_(chat, texto);
  if (/^\/redaccion/i.test(texto)) {
    const mr = mision_();
    if (!mr || mr.estado !== 'lista' || !tieneTexto_(mr)) return enviar_(chat, '📰 No hay una misión terminada con texto para pasar a la Sala de Redacción.');
    return pedirSeccionRedaccion_(chat, mr);
  }

  if (msg.voice) return recibirNotaDeVoz_(chat, msg.voice);
  const foto = fotoDe_(msg);
  if (foto) return recibirImagen_(chat, msg, foto, texto);
  const sonido = msg.audio || (msg.document && /^audio\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (sonido) return recibirMusica_(chat, sonido, texto);

  const doc = msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null;
  const archivo = msg.video || doc;
  if (archivo) return recibirVideoTelegram_(chat, archivo, texto, msg.media_group_id || null);

  const idDrive = idDrive_(texto);
  if (idDrive) return iniciarConDrive_(chat, idDrive, texto.replace(/https?:\/\/\S+/g, '').trim());

  return textoLibre_(chat, texto);
}

/** Todo texto (o nota de voz ya transcrita) que no es un comando ni un archivo. */
function textoLibre_(chat, texto) {
  const m = mision_();
  if (m && m.modo === 'nota' && LIBRES.indexOf(m.estado) < 0) {
    if (/^clip\s*\d+/i.test(texto) && reetiquetar_(chat, m, texto)) return;
    if (m.estado === 'recibiendo') {
      if (/^(\/?listo|ya|ya est[aá]|es todo|eso es todo|terminé|termine)\b/i.test(texto)) return notaLista_(chat, m);
      agregarOrden_(m, texto);
      return enviar_(chat, '📝 <b>Jason Hayes</b>: anotado para el armado.\n' + inventarioNota_(m), [[{ text: '✅ Ya envié todo', callback_data: 'nota:listo' }]]);
    }
    if (m.estado === 'indicaciones' || m.estado === 'instruccion') { agregarOrden_(m, texto); return continuarNota_(chat, m); }
    if (m.estado === 'revision') { agregarOrden_(m, 'Cambio pedido: ' + texto); return planificarNota_(chat, m); }
  }
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
  if (d.indexOf('etq:') === 0 && m.modo === 'nota') return etiquetarBoton_(chat, m, d);
  if (d === 'nota:listo' && m.modo === 'nota' && m.estado === 'recibiendo') return notaLista_(chat, m);
  if (d === 'nota:armar' && m.modo === 'nota' && (m.estado === 'indicaciones' || m.estado === 'instruccion')) return continuarNota_(chat, m);
  if (d === 'img:listo' && m.estado === 'imagenes') return imagenesListas_(chat, m);
  if (d.indexOf('dur:') === 0 && m.estado === 'duracion') return fijarDuracion_(chat, m, parseInt(d.slice(4), 10));
  if (d.indexOf('fmt:') === 0 && m.estado === 'formato') {
    m.formato = (FORMATOS[d.slice(4)] || FORMATOS['1'])[0];
    m.ajustes = '';
    guardarMision_(m);
    return escribirGuion_(chat, m);
  }
  if ((d === 'aprobar' || d === 'aprobar_maestra') && m.estado === 'revision') return aprobar_(chat, m, d === 'aprobar_maestra');
  if (d === 'cambiar' && m.estado === 'revision' && (m.modo === 'plan' || m.modo === 'nota')) {
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
  if (d === 'redaccion' && m.estado === 'lista') return pedirSeccionRedaccion_(chat, m);
  if (d.indexOf('red:') === 0 && m.estado === 'lista') {
    if (d === 'red:no') return enviar_(chat, 'Entendido. Si luego la quieres pasar, escribe /redaccion mientras la misión siga abierta.');
    return enviarARedaccion_(chat, m, d.slice(4));
  }
  if (d === 'cerrar' && m.estado === 'lista') {
    m.estado = 'cerrada'; guardarMision_(m);
    salaEvento_('jason', 'espera', 'Misión cerrada. Esperando nuevo material.', { mision: null });
    return enviar_(chat, '🎖 <b>Jason Hayes</b>: misión cerrada. Buen trabajo, comandante. Envíame el próximo video cuando quieras.');
  }
  if (d.indexOf('reintentar:') === 0 && m.estado === 'error') {
    if (!implementacionAlDia_(chat)) return enviar_(chat, '🔁 Cuando la publiques, pulsa aquí.', [[{ text: '🔁 Reintentar', callback_data: d }]]);
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
    '📘 /estilo: el manual de estilo que la sala aprende de tus pedidos. 📰 Al terminar, puedes pasar el material a la Sala de Redacción.',
    '🧩 <b>Nota con varios clips</b>: escribe /nota y mándame los clips con su etiqueta (<code>entrada</code>, <code>entrevista: Nombre, cargo</code>, <code>apoyo</code>, <code>off</code>, <code>salida</code>). Lisa los transcribe, yo armo la escaleta con los apoyos encima y Sonny la monta.',
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

function recibirVideoTelegram_(chat, archivo, instruccion, grupo) {
  let nota = notaRecibiendo_();
  if (!nota && etiquetaDe_(instruccion) && (!mision_() || LIBRES.indexOf(mision_().estado) >= 0 || mision_().estado === 'error')) {
    nota = iniciarNota_(chat, true); // un video etiquetado abre una nota sola
    if (!nota) return;
  }
  if (!nota && !puedeIniciar_(chat)) return;
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
  if (nota) return agregarClip_(chat, mision_(), guardado, instruccion, archivo.duration || 0, grupo);
  iniciarMision_(chat, guardado, instruccion, archivo.duration || 0);
}

/** Sigue la nota: si ya está transcrita, arma; si no, manda a Lisa. */
function continuarNota_(chat, m) {
  const t = leerTrabajo_(m);
  return t.segmentos_por_clip ? planificarNota_(chat, m) : transcribirNota_(chat, m);
}

function iniciarConDrive_(chat, id, instruccion) {
  let f;
  try { f = DriveApp.getFileById(id); } catch (e) { return enviar_(chat, '⚠️ No encuentro ese archivo en tu Drive.'); }
  let nota = notaRecibiendo_();
  const tipoArchivo = f.getMimeType();
  if (!nota && etiquetaDe_(instruccion) && /^(video|audio)\//.test(tipoArchivo) &&
      (!mision_() || LIBRES.indexOf(mision_().estado) >= 0 || mision_().estado === 'error')) {
    nota = iniciarNota_(chat, true);
    if (!nota) return;
  }
  if (nota) {
    if (/^image\//.test(tipoArchivo)) return guardarImagen_(chat, f, null, instruccion);
    if (!/^(video|audio)\//.test(tipoArchivo)) return enviar_(chat, '⚠️ Ese archivo no es un video, un audio ni una imagen.');
    const dur = /^video\//.test(tipoArchivo) ? duracionDrive_(id) : 0;
    return agregarClip_(chat, mision_(), f, /^audio\//.test(tipoArchivo) && !etiquetaDe_(instruccion) ? 'off ' + (instruccion || '') : instruccion, dur, null);
  }
  if (!puedeIniciar_(chat)) return;
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
/** En una nota, los audios y notas de voz son voz en off (salvo que el pie diga "música"). */
function guardarAudioComoOff_(chat, m, sonido, nombre, texto) {
  if ((sonido.file_size || 0) > LIMITE_TELEGRAM) return enviar_(chat, '📦 <b>Jason Hayes</b>: ese audio pasa de 20 MB. Súbelo a Drive y pégame el enlace con la etiqueta <code>off</code>.');
  const f = tg_('getFile', { file_id: sonido.file_id });
  if (!f.ok) return enviar_(chat, '⚠️ No pude recibir ese audio de Telegram.');
  const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + f.result.file_path).getBlob();
  const guardado = carpeta_('audios').createFile(blob.setName(sonido.file_name || nombre));
  agregarClip_(chat, m, guardado, etiquetaDe_(texto) ? texto : 'off ' + (texto || ''), sonido.duration || 0, null);
}

function recibirMusica_(chat, sonido, texto) {
  const notaAudio = notaRecibiendo_();
  if (notaAudio && !/m[uú]sica/i.test(texto || '')) {
    return guardarAudioComoOff_(chat, notaAudio, sonido, 'off_' + Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd_HHmmss') + '.mp3', texto);
  }
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
  const notaVoz = notaRecibiendo_();
  if (notaVoz) return guardarAudioComoOff_(chat, notaVoz, voz, 'off_' + Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd_HHmmss') + '.ogg', '');
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
  '- textos en pantalla: [{"texto": "", "subtexto": "", "inicio": s, "fin": s, "posicion": "arriba|centro|abajo", "estilo": "titular|rotulo|simple", "animado": true}]. ' +
  'titular = barra del color del medio; rotulo = banda oscura para nombre (texto) y cargo o fuente (subtexto); simple = letra blanca con sombra. ' +
  'Por defecto entran y salen ANIMADOS (gráficos hechos con Remotion); "animado": false los deja fijos.\n' +
  '- intro: {"texto": "", "subtexto": "", "segundos": 3} = tarjeta animada al inicio con ese titular y la firma del medio. null si no la pide.\n' +
  '- cierre: {"texto": "", "subtexto": "", "segundos": 3} = tarjeta final con el nombre del medio (texto vacío = solo el medio). null si no la pide.\n' +
  '- imagenes: {"usar": [números de imagen en orden], "estilo": "recuadro_flotante|pantalla_completa|esquina", ' +
  '"posicion": "arriba|centro|abajo|izquierda|derecha" o "", "tamano": 0.15 a 1 o 0 (automático), ' +
  '"tiempos": [{"imagen": n, "inicio": s, "fin": s}] o [] para repartirlas parejo a lo largo del video, ' +
  '"retoque": true}. Todas entran y salen con fundido. "retoque" = retoque fotográfico natural (luz, color y nitidez suaves, sin alterar rostros); ' +
  'va activado salvo que el periodista diga que no.\n' +
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
      '"plan": {"formato": "", "tramos": [], "velocidad": 1, "color": {}, "audio": {}, "subtitulos": false, "textos": [], "imagenes": {}, ' +
      '"intro": null, "cierre": null, "fundido": {}, "logo": true}, ' + PIDE_REGLAS + '}');
  } catch (e) {
    console.error('Planificar: ' + (e.message || e));
    m.estado = 'instruccion'; guardarMision_(m);
    return enviar_(chat, '⚠️ <b>Jason Hayes</b>: no pude consultar a Gemini ahora (' + esc_(String(e.message || e)).slice(0, 150) + '). ' +
      'Repíteme la instrucción en un minuto.', [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }
  r = r || {};
  aprenderReglas_(chat, r.reglas_nuevas);
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
    if (!implementacionAlDia_(chat)) { m.estado = 'instruccion'; guardarMision_(m); return; }
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
function iaJason_(usuario, esquema) {
  const sistema = 'Eres JASON HAYES, coordinador de la sala de edición de video de ' + prop_('NOMBRE_MEDIO', 'Torre Informativa') +
    ', un medio periodístico. Conviertes las instrucciones del periodista en planes de edición ejecutables. ' +
    'Escribes en español de Colombia. Responde siempre en JSON válido, sin texto fuera del JSON.' + textoManual_();
  return prop_('GEMINI_API_KEY') ? gemini_(sistema, usuario, { rapido: true, esquema: esquema || null }) : groq_(sistema, usuario);
}

// Estructura obligatoria del armado de una nota (Gemini la respeta campo por campo: menos planes mal armados).
const _N = { type: 'number' }, _S = { type: 'string' }, _B = { type: 'boolean' };
const _TARJETA = { type: ['object', 'null'], properties: { texto: _S, subtexto: _S, segundos: _N } };
const ESQUEMA_NOTA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['plan', 'preguntar'] },
    entendido: _S,
    preguntas: { type: 'array', items: _S },
    no_se_puede: { type: 'array', items: _S },
    identificados: { type: 'array', items: { type: 'object', properties: { clip: { type: 'integer' }, nombre: _S, cargo: _S, evidencia: _S },
      required: ['clip', 'nombre', 'evidencia'] } },
    titular_sugerido: _S,
    plan: { type: 'object', properties: {
      formato: { type: 'string', enum: ['vertical', 'vertical_recorte', 'cuadrado', 'original'] },
      bloques: { type: 'array', items: { type: 'object', properties: { clip: { type: 'integer' }, inicio: _N, fin: _N }, required: ['clip', 'inicio', 'fin'] } },
      tapas: { type: 'array', items: { type: 'object', properties: { apoyo: { type: 'integer' }, desde: _N, en: _N, dura: _N }, required: ['apoyo', 'en', 'dura'] } },
      textos: { type: 'array', items: { type: 'object', properties: { texto: _S, subtexto: _S, inicio: _N, fin: _N,
        posicion: { type: 'string', enum: ['arriba', 'centro', 'abajo'] }, estilo: { type: 'string', enum: ['titular', 'rotulo', 'simple'] }, animado: _B },
        required: ['texto', 'inicio', 'fin', 'estilo'] } },
      subtitulos: _B,
      color: { type: 'object', properties: { filtro: { type: 'string', enum: ['ninguno', 'blanco_negro', 'calido', 'frio', 'contraste', 'vivo'] }, brillo: _N } },
      audio: { type: 'object', properties: { modo: { type: 'string', enum: ['original', 'silencio', 'solo_voz'] }, volumen: _N, musica: _B, volumen_musica: _N } },
      imagenes: { type: 'object', properties: { usar: { type: 'array', items: { type: 'integer' } },
        estilo: { type: 'string', enum: ['recuadro_flotante', 'pantalla_completa', 'esquina'] }, posicion: _S, tamano: _N,
        tiempos: { type: 'array', items: { type: 'object', properties: { imagen: { type: 'integer' }, inicio: _N, fin: _N } } }, retoque: _B } },
      intro: _TARJETA, cierre: _TARJETA,
      fundido: { type: 'object', properties: { entrada: _N, salida: _N } },
      logo: _B,
    }, required: ['bloques', 'tapas', 'textos', 'subtitulos'] },
    reglas_nuevas: { type: 'array', items: _S },
  },
  required: ['tipo', 'entendido'],
};

// ───────────────────────── Manual de estilo: lo que el mando enseña queda para siempre ─────────────────────────

const PIDE_REGLAS = '"reglas_nuevas": [] // SOLO preferencias GENERALES y duraderas que el periodista expresó en sus instrucciones y que ' +
  'aplicarían a cualquier video futuro (ej. "los titulares siempre van arriba", "nunca música en notas judiciales", "subtítulos en todos los reels"). ' +
  'No incluyas detalles de este video (tiempos, nombres, este titular). Lista vacía si no hay.';

function manual_() { try { return JSON.parse(prop_('MANUAL_ESTILO', '[]')) || []; } catch (e) { return []; } }
function guardarManual_(lista) { P_().setProperty('MANUAL_ESTILO', JSON.stringify(lista.slice(-30))); }

function textoManual_() {
  const l = manual_();
  return l.length ? '\n\nMANUAL DE ESTILO DE LA CASA (reglas que el periodista ya fijó; aplícalas siempre, salvo que ahora pida otra cosa):\n' +
    l.map(x => '- ' + x.regla).join('\n') : '';
}

/** Guarda las reglas nuevas que detectó la IA y se lo cuenta al mando para que pueda borrarlas. */
function aprenderReglas_(chat, reglas) {
  const actual = manual_();
  const norm = x => String(x || '').toLowerCase().replace(/[^a-záéíóúñü0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const vistas = actual.map(x => norm(x.regla));
  const nuevas = (reglas || []).map(x => String(x || '').trim()).filter(x => x.length >= 8 && x.length <= 200 && vistas.indexOf(norm(x)) < 0).slice(0, 3);
  if (!nuevas.length) return;
  guardarManual_(actual.concat(nuevas.map(x => ({ regla: x, t: Date.now() }))));
  enviar_(chat, '📘 <b>Jason Hayes</b>: lo anoté en el manual de estilo para las próximas misiones:\n' + nuevas.map(x => '• ' + esc_(x)).join('\n') +
    '\nEscribe /estilo para ver el manual o borrar una regla.');
}

/** /estilo, /estilo agregar …, /estilo borrar N, /estilo borrar todo */
function comandoEstilo_(chat, texto) {
  const resto = texto.replace(/^\/estilo\s*/i, '').trim();
  let l = manual_();
  let r;
  if ((r = resto.match(/^agregar\s+(.+)$/i))) {
    l.push({ regla: r[1].slice(0, 200), t: Date.now() }); guardarManual_(l);
    return enviar_(chat, '📘 Agregada al manual: <i>' + esc_(r[1]) + '</i>');
  }
  if (/^borrar\s+todo$/i.test(resto)) { guardarManual_([]); return enviar_(chat, '📘 Manual de estilo vacío.'); }
  if ((r = resto.match(/^borrar\s+(\d+)$/i))) {
    const i = parseInt(r[1], 10) - 1;
    if (!l[i]) return enviar_(chat, '⚠️ No hay una regla número ' + (i + 1) + '.');
    const quitada = l.splice(i, 1)[0]; guardarManual_(l);
    return enviar_(chat, '📘 Borrada: <i>' + esc_(quitada.regla) + '</i>');
  }
  enviar_(chat, '📘 <b>Manual de estilo</b> (Jason, Mandy y Sonny lo aplican en cada misión)\n' +
    (l.length ? l.map((x, i) => (i + 1) + '. ' + esc_(x.regla)).join('\n') : '<i>Todavía vacío. Se llena solo con tus pedidos.</i>') +
    '\n\nPara cambiarlo: <code>/estilo agregar …</code> · <code>/estilo borrar 2</code> · <code>/estilo borrar todo</code>');
}

/** Texto del plan escrito por el código (no por la IA), para que lo que apruebas sea exactamente lo que Sonny hará. */
function describirPlan_(p, m, t) {
  const l = [];
  const formatos = { vertical: 'vertical 9:16 con fondo desenfocado', vertical_recorte: 'vertical 9:16 recortado al centro', cuadrado: 'cuadrado 1:1', original: 'formato original' };
  l.push('• Formato: ' + (formatos[p.formato] || formatos.vertical) + '.');
  const tramos = (p.tramos || []).filter(x => x && Number(x.fin) > Number(x.inicio));
  if (Array.isArray(p.bloques)) l.push(describirBloques_(p, m));
  else if (tramos.length) l.push('• Partes del video: ' + tramos.map(x => mmss_(x.inicio) + '→' + mmss_(x.fin)).join(', ') + '.');
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
  const hayVoz = (t.segmentos || []).length || Object.keys(t.segmentos_por_clip || {}).some(k => (t.segmentos_por_clip[k] || []).length);
  if (p.subtitulos) l.push('• Subtítulos con lo que se dice' + (hayVoz ? '' : ' (⚠️ no hay transcripción con voz: no saldrán)') + '.');
  (p.textos || []).filter(x => x && x.texto).forEach(x => {
    const estilos = { titular: 'titular', rotulo: 'rótulo', simple: 'texto' };
    l.push('• ' + (estilos[x.estilo] || 'Texto').replace(/^./, s => s.toUpperCase()) + (x.animado === false ? ' fijo' : ' animado') + ' ' + (x.posicion || 'arriba') +
      ': «' + esc_(x.texto) + '»' + (x.subtexto ? ' / «' + esc_(x.subtexto) + '»' : '') +
      (x.inicio !== undefined && x.fin !== undefined ? ' (' + mmss_(x.inicio) + '→' + mmss_(x.fin) + ')' : ''));
  });
  const im = p.imagenes || {};
  const n = (m.imagenes || []).length;
  const notaSinFotos = Array.isArray(p.bloques) && !(im.usar || []).length && !(im.tiempos || []).length;
  if (n && !notaSinFotos) {
    const usar = (im.usar && im.usar.length ? im.usar : Array.from({ length: n }, (_, i) => i + 1)).filter(i => i >= 1 && i <= n);
    const estilos = { recuadro_flotante: 'en un recuadro flotante con borde blanco', pantalla_completa: 'en pantalla completa con acercamiento lento', esquina: 'pequeñas en una esquina' };
    if (usar.length) {
      l.push('• Imágenes: ' + usar.length + ' de ' + n + ' (' + usar.join(', ') + ') ' + (estilos[im.estilo] || estilos.recuadro_flotante) +
        (im.posicion ? ', ' + im.posicion : '') + ', ' + ((im.tiempos || []).length
          ? 'en estos momentos: ' + im.tiempos.map(x => '#' + x.imagen + ' ' + mmss_(x.inicio) + '→' + mmss_(x.fin)).join(', ')
          : 'repartidas a lo largo del video') + (im.retoque === false ? ', sin retoque' : ', con retoque fotográfico natural') + '.');
    }
  }
  if (p.intro && p.intro.texto) l.push('• Intro animada: «' + esc_(p.intro.texto) + '»' + (p.intro.subtexto ? ' / «' + esc_(p.intro.subtexto) + '»' : '') + '.');
  if (p.cierre) l.push('• Cierre animado con la firma de ' + esc_(prop_('NOMBRE_MEDIO', 'Torre Informativa')) + (p.cierre.texto ? ': «' + esc_(p.cierre.texto) + '»' : '') + '.');
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
  if (m.modo === 'nota' && p) {
    const tarj = (p.intro && p.intro.texto ? Number(p.intro.segundos) || 3 : 0) + (p.cierre ? Number(p.cierre.segundos) || 3 : 0);
    return Math.round(((p.bloques || []).reduce((s, b) => s + (Number(b.fin) - Number(b.inicio)), 0) + tarj) * 10) / 10;
  }
  if (!p) return m.duracion_video || 0;
  const tramos = (p.tramos || []).filter(x => x && Number(x.fin) > Number(x.inicio));
  const base = tramos.length ? tramos.reduce((s, x) => s + Math.min(Number(x.fin), m.duracion_video || 1e9) - Number(x.inicio), 0) : (m.duracion_video || 0);
  const v = Math.max(0.25, Math.min(4, Number(p.velocidad) || 1));
  const tarjetas = (p.intro && p.intro.texto ? Number(p.intro.segundos) || 3 : 0) + (p.cierre ? Number(p.cierre.segundos) || 3 : 0);
  return Math.round((base / v + tarjetas) * 10) / 10;
}

/** Reel periodístico con lo que se dice: Lisa transcribe y Mandy interroga y escribe el guion. */
function elegirReel_(chat, m) {
  m.modo = 'reel'; guardarMision_(m);
  const t = leerTrabajo_(m);
  if (t.segmentos && t.segmentos.length) return iniciarInterrogatorio_(m, t.segmentos); // ya estaba transcrito
  if (t.transcrito) return preguntarInstruccion_(m, '🎧 <b>Lisa Davis</b>: este video no tiene voz, así que no puedo armar un reel con lo que se dice.');
  if (!implementacionAlDia_(chat)) { m.estado = 'instruccion'; guardarMision_(m); return; }
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
  if (m.modo === 'nota') {
    let okn = true;
    (m.clips || []).forEach(c => { okn = compartir_(c.id, abrir) && okn; });
    (m.imagenes || []).forEach(id => { okn = compartir_(id, abrir) && okn; });
    if (m.musica) okn = compartir_(m.musica, abrir) && okn;
    return okn;
  }
  let ok = compartir_(m.video_id, abrir);
  if (m.modo === 'plan' || m.modo === 'visual') {
    (m.imagenes || []).forEach(id => { ok = compartir_(id, abrir) && ok; });
    if (m.musica) ok = compartir_(m.musica, abrir) && ok;
  }
  return ok;
}

// ───────────────────────── Modo nota: varios clips (entrada, entrevistas, off, apoyos, salida) ─────────────────────────

const TIPOS_CLIP = {
  entrada: '🎙 Entrada', entrevista: '🗣 Entrevista', apoyo: '🎞 Apoyo', salida: '👋 Salida', off: '🎧 Voz en off', sin_etiqueta: '❓ Sin etiqueta',
};

/** Lee la etiqueta que el periodista pone en el pie de foto del clip. */
function etiquetaDe_(texto) {
  const t = String(texto || '').trim();
  let r;
  if ((r = t.match(/^(entrada|presentaci[oó]n|apertura)\b[\s:,.-]*(.*)$/i))) return { tipo: 'entrada', resto: r[2] };
  if ((r = t.match(/^(entrevistas?|entrevistado|entrevistada|declaraci[oó]n|testimonio)\b[\s:,.-]*(.*)$/i))) {
    const partes = r[2].split(/\s*[,;–—-]\s*/);
    return { tipo: 'entrevista', persona: (partes.shift() || '').slice(0, 60), cargo: partes.join(', ').slice(0, 80), resto: '' };
  }
  if ((r = t.match(/^(apoyos?|recursos?|b-?roll|tomas?|im[aá]genes de apoyo)\b[\s:,.-]*(.*)$/i))) return { tipo: 'apoyo', resto: r[2] };
  if ((r = t.match(/^(salida|cierre|despedida)\b[\s:,.-]*(.*)$/i))) return { tipo: 'salida', resto: r[2] };
  if ((r = t.match(/^(off|voz en off|locuci[oó]n)\b[\s:,.-]*(.*)$/i))) return { tipo: 'off', resto: r[2] };
  return null;
}

function notaRecibiendo_() {
  const m = mision_();
  return m && m.modo === 'nota' && m.estado === 'recibiendo' ? m : null;
}

/** /nota: abre una misión para armar una nota con varios clips. */
function iniciarNota_(chat, primerClip) {
  if (!puedeIniciar_(chat)) return null;
  const n = parseInt(prop_('CONTADOR', '0'), 10) + 1;
  P_().setProperty('CONTADOR', String(n));
  const m = {
    id: Utilities.formatDate(new Date(), 'America/Bogota', 'yyMMddHHmmss'),
    codigo: 'Operación ' + NOMBRES_OPERACION[(n - 1) % NOMBRES_OPERACION.length] + '-' + ('0' + n).slice(-2),
    estado: 'recibiendo', modo: 'nota', chat: chat, video_id: '', nombre: 'Nota con varios clips', clips: [],
    duracion_video: 0, imagenes: pendientes_(), musica: prop_('MUSICA_PENDIENTE', ''), instruccion: prop_('INSTRUCCION_PENDIENTE', ''),
    preguntas: [], respuestas: [], idx: 0, duracion: 60, formato: 'vertical', ajustes: '', reels: 0, creada: Date.now(),
  };
  ['IMAGENES_PENDIENTES', 'MUSICA_PENDIENTE', 'INSTRUCCION_PENDIENTE'].forEach(k => P_().deleteProperty(k));
  guardarMision_(m);
  guardarTrabajo_(m, {});
  salaEvento_('jason', 'trabajando', 'Recibiendo clips para una nota.', { mision: resumenSala_(m, 1) });
  if (!primerClip) {
    enviar_(chat, '🎬 <b>Jason Hayes</b>: abrimos la <b>' + esc_(m.codigo) + '</b> para armar una nota completa.\n\n' +
      'Envíame los clips uno por uno (o en álbum), cada uno con su <b>etiqueta en el pie de foto</b>:\n' +
      '• <code>entrada</code> — tu presentación a cámara\n' +
      '• <code>entrevista: María Pérez, secretaria de Obras</code> — nombre y cargo salen en el rótulo\n' +
      '• <code>apoyo</code> — tomas para poner encima\n' +
      '• <code>off</code> — tu voz en off (también como audio o nota de voz 🎙)\n' +
      '• <code>salida</code> — tu cierre a cámara\n\n' +
      'Videos de más de 20 MB: súbelos a la carpeta <b>entrada</b> de Drive y usa /drive, o pega el enlace con la etiqueta. ' +
      'Fotos y música de fondo también sirven. Cuando termines pulsa <b>✅ Ya envié todo</b>.',
      [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]]);
  }
  return m;
}

/** Suma un clip a la nota. Si llegó sin etiqueta, pregunta qué es. */
function agregarClip_(chat, m, archivo, texto, duracion, grupo) {
  const e = etiquetaDe_(texto) || (texto && /\S/.test(texto) ? null : null);
  const clip = { id: archivo.getId(), archivo: archivo.getName(), tipo: e ? e.tipo : 'sin_etiqueta',
    persona: e && e.persona || '', cargo: e && e.cargo || '', dur: Number(duracion) || 0 };
  m.clips = (m.clips || []).concat([clip]);
  if (!m.video_id) m.video_id = clip.id;
  m.nombre = 'Nota con ' + m.clips.length + ' clip' + (m.clips.length > 1 ? 's' : '');
  const nota = e ? e.resto : String(texto || '').trim();
  if (nota) agregarOrden_(m, 'Sobre el clip ' + m.clips.length + ' (' + clip.tipo + '): ' + nota);
  guardarMision_(m);
  const n = m.clips.length;
  if (clip.tipo === 'sin_etiqueta') {
    return enviar_(chat, '❓ <b>Jason Hayes</b>: el clip <b>' + n + '</b> (' + esc_(clip.archivo).slice(0, 40) + ') llegó sin etiqueta. ¿Qué es?',
      [[{ text: '🎙 Entrada', callback_data: 'etq:' + n + ':entrada' }, { text: '🗣 Entrevista', callback_data: 'etq:' + n + ':entrevista' }],
        [{ text: '🎞 Apoyo', callback_data: 'etq:' + n + ':apoyo' }, { text: '🎧 Off', callback_data: 'etq:' + n + ':off' }, { text: '👋 Salida', callback_data: 'etq:' + n + ':salida' }]]);
  }
  const cache = CacheService.getScriptCache();
  if (grupo) { if (cache.get('albumclip_' + grupo)) return; cache.put('albumclip_' + grupo, '1', 600); }
  enviar_(chat, '✅ Clip <b>' + n + '</b>: ' + TIPOS_CLIP[clip.tipo] + (clip.persona ? ' — ' + esc_(clip.persona) + (clip.cargo ? ', ' + esc_(clip.cargo) : '') : '') +
    '.\n' + inventarioNota_(m), [[{ text: '✅ Ya envié todo', callback_data: 'nota:listo' }]]);
}

function inventarioNota_(m) {
  const cuenta = {};
  (m.clips || []).forEach(c => { cuenta[c.tipo] = (cuenta[c.tipo] || 0) + 1; });
  const partes = Object.keys(TIPOS_CLIP).filter(k => cuenta[k]).map(k => TIPOS_CLIP[k] + ': ' + cuenta[k]);
  if ((m.imagenes || []).length) partes.push('🖼 Fotos: ' + m.imagenes.length);
  if (m.musica) partes.push('🎵 Música: sí');
  return '<i>' + partes.join(' · ') + '</i>';
}

/** Texto "clip 3: entrevista Juan Gómez, alcalde" para corregir una etiqueta. */
function reetiquetar_(chat, m, texto) {
  const r = String(texto).match(/^clip\s*(\d+)\s*[:,.-]?\s*(.+)$/i);
  if (!r) return false;
  const i = parseInt(r[1], 10), c = (m.clips || [])[i - 1], e = etiquetaDe_(r[2]);
  if (!c || !e) { enviar_(chat, '⚠️ No entendí. Escribe, por ejemplo: <code>clip 3: entrevista Juan Gómez, alcalde</code>'); return true; }
  c.tipo = e.tipo; c.persona = e.persona || ''; c.cargo = e.cargo || ''; c.detectado = false;
  guardarMision_(m);
  const enRevision = m.estado === 'revision';
  enviar_(chat, '✅ Clip <b>' + i + '</b> ahora es ' + TIPOS_CLIP[c.tipo] + (c.persona ? ' — ' + esc_(c.persona) + (c.cargo ? ', ' + esc_(c.cargo) : '') : '') + '.\n' +
    (enRevision ? (c.persona ? 'Lleva rótulo en su primera aparición. ' : '') + 'Si ya está todo, aprueba el armado.' : inventarioNota_(m)),
    m.estado === 'recibiendo' ? [[{ text: '✅ Ya envié todo', callback_data: 'nota:listo' }]]
      : enRevision ? [[{ text: '✅ Aprobar y armar', callback_data: 'aprobar' }], [{ text: '✏️ Cambiar algo', callback_data: 'cambiar' }]] : null);
  return true;
}

function etiquetarBoton_(chat, m, d) {
  const r = d.match(/^etq:(\d+):(\w+)$/);
  const c = r && (m.clips || [])[parseInt(r[1], 10) - 1];
  if (!c || !TIPOS_CLIP[r[2]]) return;
  c.tipo = r[2];
  guardarMision_(m);
  enviar_(chat, '✅ Clip <b>' + r[1] + '</b>: ' + TIPOS_CLIP[c.tipo] + '.' +
    (c.tipo === 'entrevista' ? '\nSi quieres rótulo con nombre y cargo, escribe: <code>clip ' + r[1] + ': entrevista Nombre, cargo</code>' : '') +
    '\n' + inventarioNota_(m), [[{ text: '✅ Ya envié todo', callback_data: 'nota:listo' }]]);
}

/** Termina la recepción: revisa etiquetas, pide indicaciones y manda a Lisa a transcribir. */
function notaLista_(chat, m) {
  const clips = m.clips || [];
  if (!clips.length) return enviar_(chat, '🎬 <b>Jason Hayes</b>: todavía no tengo clips. Envíame al menos la entrada o una entrevista.');
  const sin = clips.map((c, i) => c.tipo === 'sin_etiqueta' ? i + 1 : 0).filter(Boolean);
  if (sin.length) {
    return enviar_(chat, '❓ <b>Jason Hayes</b>: me falta saber qué son los clips ' + sin.join(', ') + '. Usa los botones de cada uno, o escribe por ejemplo <code>clip ' + sin[0] + ': apoyo</code>.');
  }
  if (!clips.some(c => c.tipo !== 'apoyo')) return enviar_(chat, '🎬 <b>Jason Hayes</b>: solo tengo apoyos. Necesito al menos un clip con voz (entrada, entrevista, off o salida).');
  m.estado = 'indicaciones'; guardarMision_(m);
  enviar_(chat, '🎬 <b>Jason Hayes</b>: recibido todo.\n' + inventarioNota_(m) + '\n\n' +
    '¿Alguna indicación para el armado? Por ejemplo: <i>"máximo 1 minuto 30"</i>, <i>"empieza con lo que dice el alcalde sobre el presupuesto"</i>, ' +
    '<i>"titular: Obras en el Guatapurí"</i>, <i>"con intro y cierre"</i>. Escríbela o mándame una nota de voz, o pulsa el botón y lo armo con mi criterio.',
    [[{ text: '▶️ Ármala con tu criterio', callback_data: 'nota:armar' }], [{ text: '❌ Cancelar', callback_data: 'cancelar' }]]);
}

function transcribirNota_(chat, m) {
  if (!implementacionAlDia_(chat)) return;
  if (!compartirMaterial_(m, true)) {
    return enviar_(chat, '⚠️ No pude compartir los clips por enlace (los necesita Lisa en GitHub).\n<code>' +
      esc_(prop_('ULTIMO_ERROR_COMPARTIR', 'sin detalle')) + '</code>');
  }
  m.estado = 'transcribiendo'; m.flujo = 'nota'; guardarMision_(m);
  const hablados = (m.clips || []).filter(c => c.tipo !== 'apoyo').length;
  enviar_(chat, '🎧 <b>Lisa Davis</b>: escucho los ' + hablados + ' clips con voz y mido todos. Tarda unos minutos; luego Jason te muestra el armado.');
  despachar_('transcribir', m);
  salaEvento_('lisa', 'trabajando', 'Transcribiendo los clips de la nota.', { mision: resumenSala_(m, 2) });
}

/** Jason arma la nota: orden de bloques, apoyos encima, rótulos y lo demás que pida el mando. */
function planificarNota_(chat, m) {
  const t = leerTrabajo_(m);
  const clips = m.clips || [];
  const durs = t.duraciones || {};
  let resto = 14000;
  const inventario = clips.map((c, i) => {
    const k = String(i + 1);
    let linea = 'CLIP ' + k + ' · ' + c.tipo + (c.persona ? ' · ' + c.persona + (c.cargo ? ', ' + c.cargo : '') : '') +
      ' · ' + (Number(durs[k]) || c.dur || '?') + ' s';
    if (c.tipo !== 'apoyo') {
      const txt = transcripcionTexto_((t.segmentos_por_clip || {})[k] || []).slice(0, Math.max(0, resto));
      resto -= txt.length;
      linea += '\n' + (txt || '(sin voz)');
    } else {
      const v = (t.apoyos || {})[k];
      if (v) linea += (v.descripcion ? ' · se ve: ' + v.descripcion : '') + (v.calidad ? ' · calidad: ' + v.calidad : '') +
        (v.plano ? ' · plano ' + v.plano : '') + (v.usable === false ? ' · NO USABLE' : '');
    }
    return linea;
  }).join('\n\n');
  salaEvento_('jason', 'trabajando', 'Armando la nota.', { mision: resumenSala_(m, 4) });
  tg_('sendChatAction', { chat_id: chat, action: 'typing' });
  let r = null;
  try {
    r = iaJason_('Tu trabajo es armar una NOTA periodística de video con los clips del periodista, como en un noticiero.\n\n' +
      'MATERIAL (los números de clip empiezan en 1; los tiempos de las transcripciones son segundos dentro de cada clip):\n' + inventario + '\n\n' +
      'Imágenes sueltas del periodista: ' + (m.imagenes || []).length + '. Música de fondo: ' + (m.musica ? 'sí' : 'no') + '.\n' +
      (t.plan ? '\nARMADO ANTERIOR (el periodista pide cambios sobre este):\n' + JSON.stringify(t.plan) + '\n' : '') +
      '\nINDICACIONES DEL PERIODISTA (las últimas mandan):\n' + (m.instruccion || '(ninguna: usa tu criterio periodístico)') + '\n\n' +
      'CÓMO SE ARMA:\n' +
      '- "bloques": la nota en orden: [{"clip": n, "inicio": s, "fin": s}]. Solo clips de entrada, entrevista, off o salida. ' +
      'Normalmente: entrada → off y entrevistas intercaladas → salida. Corta en inicios y finales de frase de la transcripción; ' +
      'de cada entrevista usa los fragmentos más fuertes, no todo. Un clip puede aparecer en varios bloques con tiempos distintos.\n' +
      '- "tapas": apoyos ENCIMA de la imagen mientras sigue sonando la voz: [{"apoyo": n, "desde": s (dentro del apoyo), "en": s (segundo de la nota final), "dura": s}]. ' +
      'Úsalos sobre la voz en off (allí son obligatorios: el off no tiene imagen propia) y, con medida, sobre partes largas de entrevistas, ' +
      'pero deja ver la cara del entrevistado al menos los primeros 3 segundos de cada bloque suyo. No tapes la entrada ni la salida salvo que lo pidan. ' +
      'Si no alcanzas a cubrir todo el off, la sala lo rellena sola con los apoyos.\n' +
      '- Elige cada apoyo por lo que SE VE (dato "se ve" de cada clip de apoyo) para que ilustre lo que se dice en ese momento. ' +
      'Nunca uses los marcados NO USABLE y, si hay alternativas, evita los de calidad movida, oscura o desenfocada.\n' +
      '- Los rótulos con nombre y cargo de cada entrevistado los pone la sala sola en su primera aparición.\n' +
      '- "identificados": para cada clip de ENTREVISTA que no trae nombre en el inventario, si en alguna transcripción la persona dice su nombre ' +
      'o el periodista la presenta (ej. "nos acompaña el secretario de Salud, Juan Pérez"), devuelve {"clip": n, "nombre": "", "cargo": "", ' +
      '"evidencia": "la frase COPIADA LITERALMENTE de la transcripción donde aparece el nombre"}. Si no se dice en el audio, no lo pongas: nunca adivines por la cara ni por el contexto.\n' +
      '- Subtítulos: en las notas van ACTIVADOS ("subtitulos": true), porque muchos ven los videos sin sonido; solo van en false si el periodista lo pide.\n' +
      '- Titular: si el periodista no dio uno y no pidió nota sin titular, propón en "titular_sugerido" un titular corto (máximo 9 palabras) ' +
      'que diga solo hechos que se escuchan en las transcripciones, sin adjetivos ni opiniones. No lo pongas en "textos": la sala lo ubica.\n' +
      '- Además puedes usar del plan de edición libre: ' + CAPACIDADES_PLAN.split('\n').filter(l => /formato|velocidad|color|audio|subtitulos|textos|intro|cierre|fundido|logo|imagenes/.test(l) && !/tramos/.test(l)).join(' ') + '\n' +
      'Duración: si el periodista no dice, apunta a entre 60 y 120 segundos.\n' +
      'Reglas: nunca inventes textos (titulares solo con palabras del periodista o literales de la transcripción); si algo esencial es ambiguo, ' +
      'tipo "preguntar" con máximo 3 preguntas; lo que no se pueda hacer va en "no_se_puede".\n\n' +
      'Devuelve este JSON:\n{"tipo": "plan" | "preguntar", "entendido": "una o dos frases, en segunda persona", "preguntas": [], "no_se_puede": [], ' +
      '"identificados": [], "titular_sugerido": "", ' +
      '"plan": {"formato": "vertical", "bloques": [], "tapas": [], "textos": [], "subtitulos": true, "audio": {}, "intro": null, "cierre": null, "fundido": {}, "logo": true}, ' + PIDE_REGLAS + '}',
      ESQUEMA_NOTA);
  } catch (e) {
    console.error('Planificar nota: ' + (e.message || e));
    m.estado = 'indicaciones'; guardarMision_(m);
    return enviar_(chat, '⚠️ <b>Jason Hayes</b>: no pude consultar a Gemini ahora (' + esc_(String(e.message || e)).slice(0, 150) + '). ' +
      'Repíteme la indicación en un minuto o pulsa el botón.', [[{ text: '▶️ Ármala con tu criterio', callback_data: 'nota:armar' }]]);
  }
  r = r || {};
  aprenderReglas_(chat, r.reglas_nuevas);
  const noSe = (r.no_se_puede || []).map(String).filter(Boolean);
  const avisoNo = noSe.length ? '\n\n🚫 <b>Esto no lo sé hacer</b>:\n' + noSe.map(x => '• ' + esc_(x)).join('\n') : '';
  if (r.tipo === 'preguntar' || !r.plan) {
    m.estado = 'indicaciones'; guardarMision_(m);
    const qs = (r.preguntas || []).map(String).filter(Boolean).slice(0, 3);
    return enviar_(chat, '🤔 <b>Jason Hayes</b>: ' + (r.entendido ? esc_(r.entendido) + '\n' : '') + 'Antes de armar necesito saber:\n' +
      (qs.length ? qs : ['¿Qué quieres destacar en la nota?']).map((q, i) => (i + 1) + '. ' + esc_(q)).join('\n') + avisoNo,
      [[{ text: '▶️ Ármala con tu criterio', callback_data: 'nota:armar' }]]);
  }
  // Ajusta los cortes a inicios y finales de frase de cada clip.
  const p = r.plan;
  p.bloques = (p.bloques || []).map(b => {
    const k = String(Number(b.clip));
    const c = clips[Number(b.clip) - 1];
    if (!c || c.tipo === 'apoyo') return null;
    const ajust = ajustarCortes_([b], (t.segmentos_por_clip || {})[k] || [], Number(durs[k]) || 1e9)[0];
    return ajust ? { clip: Number(b.clip), inicio: ajust.inicio, fin: ajust.fin } : null;
  }).filter(Boolean);
  completarTextosNota_(m, t, p, r);
  t.plan = p;
  guardarTrabajo_(m, t);
  m.estado = 'revision';
  const titular = (p.textos || []).filter(x => x && x.estilo === 'titular')[0];
  m.titulo = titular ? String(titular.texto).slice(0, 120) : '';
  guardarMision_(m);
  const largo = duracionSalida_(m, t) > 60;
  salaEvento_('mando', 'trabajando', 'Revisando el armado de la nota.', { mision: resumenSala_(m, 5) });
  const aprobar = largo
    ? [[{ text: '✅ Aprobar y armar (+ copia maestra en Drive)', callback_data: 'aprobar' }]]
    : [[{ text: '✅ Aprobar y armar', callback_data: 'aprobar' }], [{ text: '💾 Aprobar + copia maestra en Drive', callback_data: 'aprobar_maestra' }]];
  enviar_(chat, '🎬 <b>Armado de la nota</b>\n' + (r.entendido ? '<i>' + esc_(r.entendido) + '</i>\n' : '') + '\n' + describirPlan_(p, m, t) + avisoNo +
    (largo ? '\n\n💾 Como pasa de 1 minuto, Sonny guardará también la copia maestra en Drive.' : '') +
    '\n\n¿Lo apruebas? Si quieres cambiar algo, escríbemelo o mándame una nota de voz.',
    aprobar.concat([[{ text: '✏️ Cambiar algo', callback_data: 'cambiar' }, { text: '❌ Cancelar', callback_data: 'cancelar' }]]));
}

function norm_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lo que necesita quien ve la nota sin sonido: subtítulos, titular y el nombre de cada entrevistado. */
function completarTextosNota_(m, t, p, r) {
  const instr = String(m.instruccion || '');
  // Subtítulos activados, salvo que el periodista haya hablado de subtítulos y Jason los haya quitado
  p.subtitulos = p.subtitulos === false && /subt[ií]tulo/i.test(instr) ? false : true;
  // Titular propuesto por Jason (solo hechos del audio), si no hay uno y no se pidió nota sin titular
  p.textos = (p.textos || []).filter(x => x && String(x.texto || '').trim());
  const hayTitular = p.textos.some(x => x.estilo === 'titular') || (p.intro && String(p.intro.texto || '').trim());
  const sug = String((r && r.titular_sugerido) || '').replace(/["«»“”]/g, '').trim();
  m.titular_propuesto = '';
  if (!hayTitular && sug && sug.split(/\s+/).length <= 12 && !/(sin|no\b.{0,20})\s*titular/i.test(instr)) {
    const total = (p.bloques || []).reduce((s, b) => s + (Number(b.fin) - Number(b.inicio)), 0);
    p.textos.unshift({ texto: sug.slice(0, 90), subtexto: '', inicio: 0.3, fin: Math.max(1, Math.min(5, total - 0.5)), posicion: 'arriba', estilo: 'titular', animado: true });
    m.titular_propuesto = sug.slice(0, 90);
  }
  // Nombres que se dicen en el audio: solo si la frase de evidencia está de verdad en una transcripción
  const todo = ' ' + Object.keys(t.segmentos_por_clip || {}).map(k => (t.segmentos_por_clip[k] || []).map(x => x.texto).join(' ')).map(norm_).join(' ') + ' ';
  ((r && r.identificados) || []).forEach(x => {
    const c = (m.clips || [])[Number(x && x.clip) - 1];
    const nombre = String((x && x.nombre) || '').trim(), ev = norm_(x && x.evidencia);
    if (!c || c.tipo !== 'entrevista' || c.persona || !nombre || ev.length < 12) return;
    const apellido = norm_(nombre).split(' ').filter(w => w.length > 2);
    if (todo.indexOf(' ' + ev + ' ') < 0 || !apellido.length || !apellido.every(w => (' ' + ev + ' ').indexOf(' ' + w + ' ') >= 0)) return;
    c.persona = nombre.slice(0, 60); c.cargo = String(x.cargo || '').trim().slice(0, 80); c.detectado = true;
  });
}

/** Escaleta de la nota, escrita por el código para que lo que apruebas sea lo que Sonny hará. */
function describirBloques_(p, m) {
  const clips = m.clips || [];
  const l = ['🧩 <b>Escaleta</b>'];
  let pos = 0;
  (p.bloques || []).forEach((b, i) => {
    const c = clips[b.clip - 1] || {};
    const d = Number(b.fin) - Number(b.inicio);
    l.push((i + 1) + '. ' + mmss_(pos) + ' ' + (TIPOS_CLIP[c.tipo] || 'Clip') + (c.persona ? ' — ' + esc_(c.persona) : '') +
      ' (clip ' + b.clip + ', ' + mmss_(b.inicio) + '→' + mmss_(b.fin) + ', ' + Math.round(d) + ' s)');
    pos += d;
  });
  const tapas = p.tapas || [];
  const offs = (p.bloques || []).filter(b => (clips[b.clip - 1] || {}).tipo === 'off').length;
  if (tapas.length) {
    l.push('🎞 <b>Apoyos encima</b> (la voz sigue debajo):');
    tapas.slice(0, 12).forEach(x => l.push('• clip ' + x.apoyo + ' en ' + mmss_(x.en) + ' por ' + Math.round(Number(x.dura) || 0) + ' s'));
    if (tapas.length > 12) l.push('• … y ' + (tapas.length - 12) + ' más');
  }
  if (offs) l.push('🎞 Lo que el off no tenga cubierto se rellena solo con tus apoyos.');
  if (clips.some(c => c.tipo === 'entrevista' && c.persona)) l.push('🏷 Rótulo con nombre y cargo en la primera aparición de cada entrevistado.');
  const usados = [];
  (p.bloques || []).forEach(b => { if (usados.indexOf(b.clip) < 0) usados.push(b.clip); });
  const detectados = usados.filter(n => (clips[n - 1] || {}).detectado);
  detectados.forEach(n => {
    const c = clips[n - 1];
    l.push('👂 Nombre tomado del audio — clip ' + n + ': <b>' + esc_(c.persona) + '</b>' + (c.cargo ? ', ' + esc_(c.cargo) : '') +
      '. Si no es así: <code>clip ' + n + ': entrevista Nombre, cargo</code>');
  });
  const sinNombre = usados.filter(n => (clips[n - 1] || {}).tipo === 'entrevista' && !(clips[n - 1] || {}).persona);
  if (sinNombre.length) {
    l.push('⚠️ <b>Sin nombre</b> (no llevan rótulo): clip ' + sinNombre.join(', ') + '. ¿Quién habla? Escribe por ejemplo ' +
      '<code>clip ' + sinNombre[0] + ': entrevista Nombre, cargo</code> y después apruebas.');
  }
  if (m.titular_propuesto) l.push('📰 Titular propuesto por Jason (sale de lo que se dice en los clips): «' + esc_(m.titular_propuesto) + '». Si quieres otro, escríbemelo.');
  return l.join('\n');
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

/** Diagnóstico: muestra en el registro lo que Sonny recibe de la misión actual (sin claves). Ejecútala desde el editor. */
function diagnosticarMision() {
  const m = mision_();
  if (!m) return Logger.log('No hay misión guardada.');
  const t = trabajoParaOperador_(m);
  Logger.log('Misión: ' + m.codigo + ' · estado ' + m.estado + ' · modo ' + (m.modo || '(vacío)') + ' · duración del video ' + (m.duracion_video || '?') + ' s');
  Logger.log('Instrucciones: ' + (m.instruccion || '(ninguna)'));
  Logger.log('Imágenes: ' + (m.imagenes || []).length + ' · música: ' + (m.musica ? 'sí' : 'no'));
  Logger.log('Plan que recibe Sonny: ' + JSON.stringify(t.plan));
  Logger.log('Modo que recibe Sonny: ' + t.modo + ' · cortes: ' + (t.cortes || []).length + ' · segmentos: ' + (t.segmentos || []).length);
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

/**
 * Lisa y Sonny leen el trabajo de la implementación PUBLICADA, no del código guardado.
 * Si el código cambió y no se creó una "Nueva versión", el operador recibiría datos viejos.
 * Esta revisión lo detecta antes de despachar y le explica al mando cómo arreglarlo.
 */
function implementacionAlDia_(chat) {
  const cache = CacheService.getScriptCache();
  if (cache.get('impl_ok_' + VERSION)) return true;
  let publicada = '';
  try {
    const r = UrlFetchApp.fetch(prop_('URL_WEBAPP') + '?accion=version', { muteHttpExceptions: true, followRedirects: true });
    try { publicada = String((JSON.parse(r.getContentText()) || {}).version || ''); } catch (e) { publicada = 'anterior'; }
  } catch (e) {
    console.error('No se pudo revisar la implementación: ' + (e.message || e));
    return true; // si la revisión misma falla, no se frena la misión
  }
  if (publicada === VERSION) { cache.put('impl_ok_' + VERSION, '1', 21600); return true; }
  enviar_(chat, '🛠 <b>Jason Hayes</b>: antes de mover al equipo, falta un paso en Apps Script.\n' +
    'El código guardado es la versión <b>' + VERSION + '</b>, pero la implementación publicada es ' + (publicada ? 'la <b>' + esc_(publicada) + '</b>' : 'una anterior') + '. ' +
    'Si sigo así, Lisa y Sonny recibirían el trabajo viejo.\n\n' +
    '<b>Implementar → Administrar implementaciones → ✏️ → Versión: Nueva versión → Implementar</b>.\n' +
    'Luego repite el último paso (el botón o tu mensaje). Tu misión sigue guardada.');
  return false;
}

/** /reintentar: relanza al operador si la misión quedó esperando (por ejemplo, si GitHub cortó el trabajo). */
function reintentarAtascada_(chat) {
  const m = mision_();
  if (!m || ['transcribiendo', 'editando', 'error'].indexOf(m.estado) < 0) {
    return enviar_(chat, '🎖 <b>Jason Hayes</b>: no hay ningún trabajo de Lisa o Sonny pendiente para relanzar.');
  }
  if (!implementacionAlDia_(chat)) return;
  const tipo = m.estado === 'editando' || (m.estado === 'error' && m.error_de === 'sonny') ? 'editar' : 'transcribir';
  if (m.estado === 'error') m.estado = tipo === 'editar' ? 'editando' : 'transcribiendo';
  if (tipo === 'transcribir' && m.modo === 'nota') m.flujo = 'nota';
  guardarMision_(m);
  compartirMaterial_(m, true);
  despachar_(tipo, m);
  salaEvento_(tipo === 'editar' ? 'sonny' : 'lisa', 'trabajando', 'Relanzado por el mando.', { mision: resumenSala_(m, tipo === 'editar' ? 6 : 2) });
  enviar_(chat, '🔁 <b>Jason Hayes</b>: relancé a ' + (tipo === 'editar' ? '<b>Sonny Quinn</b>' : '<b>Lisa Davis</b>') + '. Te aviso cuando termine.');
}

// ───────────────────────── Puente con la Sala de Redacción (Robin, Vivi, Usopp, Nami, Brook y Luffy) ─────────────────────────

const SHEET_REDACCION = '1X4SQeHEcYMVP4-tHCESFobn2_qEX4xd6Kj14-knAgB8'; // hoja de la Sala de Redacción (se puede cambiar con la propiedad SHEET_REDACCION)

function tieneTexto_(m) {
  const t = leerTrabajo_(m);
  if ((t.segmentos || []).length) return true;
  const spc = t.segmentos_por_clip || {};
  return Object.keys(spc).some(k => (spc[k] || []).length);
}

function pedirSeccionRedaccion_(chat, m) {
  enviar_(chat, '📰 <b>Jason Hayes</b>: le paso a la Sala de Redacción la transcripción' + (m.modo === 'nota' ? ' de todos los clips, con quién habla en cada uno,' : '') +
    ' y tus indicaciones. El reportero escribe la nota web, Nami la verifica, Brook hace el post de Instagram y Luffy te la manda por el bot de redacción.\n¿En qué sección va?',
    [[{ text: '⚖️ Judicial (Robin)', callback_data: 'red:judicial' }, { text: '🏛 Política (Vivi)', callback_data: 'red:politica' }],
      [{ text: '🏘 Valledupar y comunidad (Usopp)', callback_data: 'red:comunidad' }], [{ text: '❌ Ahora no', callback_data: 'red:no' }]]);
}

/** Arma los hechos con las transcripciones y los deja como una fila nueva en la hoja "Entradas" de la Sala de Redacción. */
function enviarARedaccion_(chat, m, seccion) {
  const t = leerTrabajo_(m);
  const etiqueta = { entrada: 'Entrada del periodista', off: 'Voz en off del periodista', salida: 'Salida del periodista', sin_etiqueta: 'Clip' };
  const bloques = [];
  if (m.modo === 'nota') {
    (m.clips || []).forEach((c, i) => {
      const segs = (t.segmentos_por_clip || {})[String(i + 1)] || [];
      if (!segs.length) return;
      const quien = c.tipo === 'entrevista' ? 'Entrevista' + (c.persona ? ' – ' + c.persona + (c.cargo ? ', ' + c.cargo : '') : ' (persona sin identificar)') : etiqueta[c.tipo] || 'Clip';
      bloques.push('[' + quien + ']: ' + segs.map(x => x.texto).join(' '));
    });
  } else {
    bloques.push('[Video]: ' + (t.segmentos || []).map(x => x.texto).join(' '));
    (m.respuestas || []).filter(x => x.r).forEach(x => bloques.push('[Dato del editor] ' + x.p + ' → ' + x.r));
  }
  if (!bloques.length) return enviar_(chat, '⚠️ Esta misión no tiene texto transcrito para pasar a la Sala de Redacción.');
  enviar_(chat, '📰 <b>Lisa Davis</b>: preparo la ficha de hechos para la Sala de Redacción…');
  const hechos = hechosParaRedaccion_(m, bloques);
  try {
    const hoja = SpreadsheetApp.openById(prop_('SHEET_REDACCION', SHEET_REDACCION)).getSheetByName('Entradas');
    if (!hoja) throw new Error('la hoja no tiene la pestaña "Entradas"');
    hoja.appendRow([Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd'), seccion, hechos,
      'Reportería propia en video (Sala de Edición IA, ' + m.codigo + ')', 'Fabián Pinillos (Sala de Edición)', '']);
  } catch (e) {
    return enviar_(chat, '⚠️ No pude dejar la nota en la Sala de Redacción: <code>' + esc_(String(e.message || e)).slice(0, 200) + '</code>\n' +
      'Revisa que esta cuenta de Google pueda editar la hoja de la Sala de Redacción (en Apps Script ejecuta <b>probarSalaRedaccion</b>).');
  }
  m.enviada_redaccion = Date.now(); guardarMision_(m);
  salaEvento_('jason', 'listo', 'Material enviado a la Sala de Redacción.', { mision: resumenSala_(m, 7) });
  enviar_(chat, '📰 <b>Jason Hayes</b>: listo, quedó en la Sala de Redacción (sección ' + seccion + '). En unos minutos te llega la nota web y el post por el bot de redacción.',
    [[{ text: '✅ Cerrar misión', callback_data: 'cerrar' }]]);
}

// La Sala de Redacción trabaja con Groq gratis (unos 8.000 tokens por minuto por pedido): lo que se le manda debe ser corto.
const LIMITE_REDACCION = 9000; // caracteres, unas 2.500 palabras

/**
 * Convierte las transcripciones en una FICHA DE HECHOS corta, con el mismo formato que usan los reporteros de la redacción.
 * Las citas solo pasan si están literalmente en la transcripción. Si Gemini falla, se mandan las transcripciones recortadas.
 */
function hechosParaRedaccion_(m, bloques) {
  const cabeza = 'INFORMACIÓN DEL EDITOR (reportería propia de Torre Informativa grabada en video; la Sala de Edición IA transcribió los clips ' +
    'y preparó esta ficha: las citas están copiadas de la transcripción automática, que puede traer errores de transcripción; corrígelos sin cambiar el sentido; ' +
    'las personas sin identificar no se nombran). ' +
    (m.titulo ? 'Titular usado en el video: ' + m.titulo + '. ' : '') +
    (m.instruccion ? 'Indicaciones del editor para el video: ' + m.instruccion.replace(/\n/g, ' ').slice(0, 400) + '. ' : '');
  const transcripcion = bloques.join(' ||| ');
  let ficha = '';
  try {
    if (prop_('GEMINI_API_KEY') && transcripcion.length > 1500) {
      const r = gemini_('Eres LISA DAVIS, de inteligencia de la sala de edición de ' + prop_('NOMBRE_MEDIO', 'Torre Informativa') + '. ' +
        'Preparas para la sala de redacción la FICHA DE HECHOS de una nota grabada en video. Usa SOLO lo que se dice en las transcripciones: ' +
        'no agregues datos, causas ni contexto propios. Cada hecho, corto (máximo 25 palabras) y con quién lo dijo. ' +
        'Las citas van COPIADAS LITERALMENTE de la transcripción (máximo 40 palabras cada una), con nombre y cargo de quien habla tal como aparecen en la etiqueta del clip; ' +
        'si la persona no está identificada, "quien" = "persona sin identificar". En "vacios" pon lo que un periodista necesitaría confirmar (fechas, cifras sin fuente, nombres incompletos). Responde en JSON.',
        'TRANSCRIPCIONES POR CLIP (cada una con su etiqueta entre corchetes):\n' + transcripcion.slice(0, 60000),
        { rapido: true, esquema: { type: 'object', properties: {
          que: { type: 'string' }, quien: { type: 'string' }, cuando: { type: 'string' }, donde: { type: 'string' },
          hechos: { type: 'array', items: { type: 'object', properties: { dato: { type: 'string' }, fuente: { type: 'string' } }, required: ['dato', 'fuente'] } },
          citas: { type: 'array', items: { type: 'object', properties: { quien: { type: 'string' }, cargo: { type: 'string' }, texto: { type: 'string' } }, required: ['quien', 'texto'] } },
          vacios: { type: 'array', items: { type: 'string' } } }, required: ['hechos', 'citas'] } });
      const base = ' ' + norm_(transcripcion) + ' ';
      const citas = (r.citas || []).filter(c => c && c.texto && base.indexOf(' ' + norm_(c.texto) + ' ') >= 0).slice(0, 12);
      const l = ['FICHA DE HECHOS:'];
      const rotulo = { que: 'QUÉ', quien: 'QUIÉN', cuando: 'CUÁNDO', donde: 'DÓNDE' };
      Object.keys(rotulo).forEach(k => { if (r[k]) l.push(rotulo[k] + ': ' + r[k]); });
      (r.hechos || []).slice(0, 25).forEach(h => h && h.dato && l.push('- ' + h.dato + (h.fuente ? ' (fuente: ' + h.fuente + ')' : '')));
      if (citas.length) l.push('CITAS TEXTUALES (copiadas de la transcripción):');
      citas.forEach(c => l.push('- ' + c.quien + (c.cargo ? ', ' + c.cargo : '') + ': "' + String(c.texto).trim() + '"'));
      if ((r.vacios || []).length) l.push('POR CONFIRMAR: ' + r.vacios.slice(0, 6).join('; '));
      ficha = l.join('\n');
    }
  } catch (e) { console.warn('Ficha para la redacción: ' + (e.message || e)); }
  // Lo que quede de espacio va con la transcripción, para que el verificador de la redacción compare contra el audio
  const resto = LIMITE_REDACCION - cabeza.length - ficha.length - 40;
  const extracto = resto > 300 ? (ficha ? '\nTRANSCRIPCIÓN (extracto): ' : 'TRANSCRIPCIONES: ') + transcripcion.slice(0, resto) +
    (transcripcion.length > resto ? ' […]' : '') : '';
  return (cabeza + ficha + extracto).slice(0, LIMITE_REDACCION);
}

/** Ejecútala una vez desde el editor: autoriza el acceso a la hoja de la Sala de Redacción y comprueba que se pueda leer. */
function probarSalaRedaccion() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_REDACCION', SHEET_REDACCION));
  const hoja = ss.getSheetByName('Entradas');
  Logger.log('Hoja: ' + ss.getName() + ' · pestaña Entradas: ' + (hoja ? 'sí, ' + hoja.getLastRow() + ' filas' : 'NO EXISTE'));
  if (hoja) Logger.log('Encabezados: ' + hoja.getRange(1, 1, 1, 6).getDisplayValues()[0].join(' | '));
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
  const agente = ['sonny', 'ray'].indexOf(b.agente) >= 0 ? b.agente : 'lisa';

  if (b.tipo === 'progreso') {
    salaEvento_(agente, 'trabajando', b.texto || 'Trabajando', { mision: resumenSala_(m, agente === 'lisa' ? 2 : 6) });
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
    if (m.flujo === 'nota') {
      const tn = leerTrabajo_(m);
      tn.segmentos_por_clip = b.segmentos_por_clip || {}; tn.duraciones = b.duraciones || {}; tn.transcrito = true; tn.apoyos = b.apoyos || {};
      guardarTrabajo_(m, tn);
      (m.clips || []).forEach((c, i) => { c.dur = Number((b.duraciones || {})[String(i + 1)]) || c.dur; });
      m.flujo = ''; m.estado = 'indicaciones'; guardarMision_(m);
      compartirMaterial_(m, false);
      const frases = Object.keys(tn.segmentos_por_clip).reduce((s, k) => s + (tn.segmentos_por_clip[k] || []).length, 0);
      salaEvento_('lisa', 'listo', 'Clips transcritos.', { mision: resumenSala_(m, 3) });
      const fallidos = (b.fallidos || []).map(Number).filter(Boolean);
      enviar_(m.chat, '🎧 <b>Lisa Davis</b>: listo, ' + frases + ' frases en ' + (m.clips || []).length + ' clips. Jason arma la nota.' +
        (fallidos.length ? '\n⚠️ No pude transcribir los clips ' + fallidos.join(', ') + ' (la conexión falló). Jason los tratará como clips sin texto; ' +
          'si los necesitas con su texto, al final escribe /reintentar antes de aprobar.' : ''));
      return planificarNota_(m.chat, m);
    }
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
    m.ultima_entrega = { duracion: b.duracion || 0, peso_mb: b.peso_mb || 0, t: Date.now() };
    m.estado = 'lista'; m.reels = (m.reels || 0) + 1; guardarMision_(m);
    compartirMaterial_(m, false);
    guardarGuionEnDrive_(m);
    const s = salaLeer_(); s.stats = s.stats || { reels: 0 }; s.stats.reels = (s.stats.reels || 0) + 1;
    // Minutos de cada misión (de la recepción a la entrega), para el promedio de la sala virtual
    if (m.creada) s.stats.minutos = (s.stats.minutos || []).concat(Math.round((Date.now() - m.creada) / 60000)).slice(-20);
    salaGuardar_(s);
    salaEvento_('sonny', 'listo', (m.modo === 'nota' ? 'Nota entregada' : 'Reel entregado') + '. Misión cumplida.', { mision: resumenSala_(m, 7) });
    let maestra = '';
    if (b.maestra_id) maestra = '\n💾 Copia maestra (sin recomprimir, ' + (b.maestra_mb || '?') + ' MB): https://drive.google.com/file/d/' + b.maestra_id + '/view';
    else if (b.maestra_error) maestra = '\n⚠️ La copia maestra no se pudo guardar en Drive; el reel de Telegram sí está completo.';
    const rv = b.revision || {};
    let control = '';
    if (rv.ok === true) {
      control = '\n🔎 <b>Ray Perry</b> (control de calidad): sin problemas' + (rv.lufs !== null && rv.lufs !== undefined ? ' · volumen ' + Number(rv.lufs).toFixed(1) + ' LUFS' : '') + '.';
      salaEvento_('ray', 'listo', 'Revisión sin problemas.', { mision: resumenSala_(m, 7) });
    } else if (rv.ok === false) {
      control = '\n🔎 <b>Ray Perry</b> (control de calidad) encontró esto:\n' + (rv.hallazgos || []).map(x => '• ' + esc_(x)).join('\n') +
        '\nSi algo no va, pide los cambios con «Otra versión».';
      salaEvento_('ray', 'alerta', 'Revisión con ' + (rv.hallazgos || []).length + ' observaciones.', { mision: resumenSala_(m, 7) });
    }
    const botones = [[{ text: m.modo === 'reel' ? '🎬 Otro reel con este video' : '🎬 Otra versión con este material', callback_data: 'otro' }]];
    if (tieneTexto_(m)) botones.push([{ text: '📰 Pasar a la sala de redacción', callback_data: 'redaccion' }]);
    botones.push([{ text: '✅ Cerrar misión', callback_data: 'cerrar' }]);
    return enviar_(m.chat, '🎖 <b>Jason Hayes</b>: misión cumplida, comandante.' +
      (m.modo === 'reel' ? ' El guion quedó guardado en la carpeta <b>salida</b> de Drive.' : '') + maestra + control, botones);
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
  if (!implementacionAlDia_(chat)) {
    return enviar_(chat, '✅ Cuando la publiques, apruébalo aquí.', [[{ text: '✅ Aprobar y editar', callback_data: pidioMaestra ? 'aprobar_maestra' : 'aprobar' }]]);
  }
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
  const sistema = REGLAS_MANDY.replace('{medio}', prop_('NOMBRE_MEDIO', 'Torre Informativa')) + textoManual_();
  return prop_('GEMINI_API_KEY') ? gemini_(sistema, usuario) : groq_(sistema, usuario);
}

/** Modelos gratuitos de Gemini, en orden de preferencia: si uno está saturado, se prueba el siguiente. */
function modelosGemini_() {
  const preferido = prop_('MODELO_GEMINI', 'gemini-3.8-flash');
  return [preferido, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
    .filter((m, i, lista) => lista.indexOf(m) === i);
}

function gemini_(sistema, usuario, opciones) {
  let ultimo = '';
  const modelos = modelosGemini_();
  const cache = CacheService.getScriptCache();
  for (let k = 0; k < modelos.length; k++) {
    for (let i = 0; i < 2; i++) {
      // "rápido": pide razonamiento corto. Si el modelo no acepta la opción, se recuerda y se pide sin ella.
      const rapido = opciones && opciones.rapido && !cache.get('sin_razonamiento_' + modelos[k]);
      // "esquema": la respuesta debe seguir exactamente esa estructura (JSON Schema). Si el modelo no lo acepta, se pide sin él.
      const esquema = opciones && opciones.esquema && !cache.get('sin_esquema_' + modelos[k]);
      const config = { responseMimeType: 'application/json', temperature: 0.4 };
      if (rapido) config.thinkingConfig = { thinkingLevel: 'low' };
      if (esquema) config.responseJsonSchema = opciones.esquema;
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelos[k] + ':generateContent', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY') },
        payload: JSON.stringify({
          systemInstruction: { parts: [{ text: sistema }] },
          contents: [{ role: 'user', parts: Array.isArray(usuario) ? usuario : [{ text: usuario }] }],
          generationConfig: config,
        }),
      });
      const c = r.getResponseCode();
      if (c === 400 && esquema) {
        console.warn('Gemini no aceptó el esquema en ' + modelos[k] + ': ' + r.getContentText().slice(0, 200));
        cache.put('sin_esquema_' + modelos[k], '1', 21600); i--; continue;
      }
      if (c === 400 && rapido) { cache.put('sin_razonamiento_' + modelos[k], '1', 21600); i--; continue; }
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

/*
 * El trabajo de la misión (transcripción, plan, guion) se guarda en las Propiedades del script, en trozos de 8 KB.
 * Antes iba solo en un archivo de Drive, pero Drive puede devolver una copia vieja justo después de escribir,
 * y una lectura vieja al aprobar borraba el plan. Las propiedades siempre devuelven lo último escrito.
 * En Drive queda una copia de respaldo (solo escritura).
 */
const TROZO = 8000;

function archivoTrabajo_(m) {
  const it = carpeta_('trabajo').getFilesByName('mision_' + m.id + '.json');
  return it.hasNext() ? it.next() : null;
}

function leerTrabajo_(m) {
  const props = P_().getProperties();
  if (props.TRABAJO_ID === m.id) {
    const n = parseInt(props.TRABAJO_N || '0', 10);
    let txt = '';
    for (let i = 0; i < n; i++) txt += props['TRABAJO_' + i] || '';
    try { return JSON.parse(txt || '{}'); } catch (e) { console.error('Trabajo dañado en propiedades: ' + e); }
  }
  // Misiones anteriores a este cambio: se lee el archivo de Drive.
  const f = archivoTrabajo_(m);
  try { return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : {}; } catch (e) { return {}; }
}

function guardarTrabajo_(m, datos) {
  const txt = JSON.stringify(datos || {});
  const anterior = parseInt(prop_('TRABAJO_N', '0'), 10);
  const nuevas = { TRABAJO_ID: m.id };
  let n = 0;
  for (let i = 0; i < txt.length; i += TROZO) nuevas['TRABAJO_' + (n++)] = txt.slice(i, i + TROZO);
  nuevas.TRABAJO_N = String(n);
  P_().setProperties(nuevas);
  for (let i = n; i < anterior; i++) P_().deleteProperty('TRABAJO_' + i);
  try { // copia de respaldo en Drive
    const f = archivoTrabajo_(m);
    if (f) f.setContent(txt); else carpeta_('trabajo').createFile('mision_' + m.id + '.json', txt, 'application/json');
  } catch (e) { console.error('Respaldo del trabajo en Drive: ' + (e.message || e)); }
}

function trabajoParaOperador_(m) {
  const t = leerTrabajo_(m);
  return {
    video_id: m.video_id, nombre: m.nombre, chat_id: m.chat,
    segmentos: t.segmentos || [], cortes: t.cortes || [], titulo: m.titulo || '', formato: m.formato || 'vertical',
    maestra_url: t.maestra_url || '',
    modo: m.modo || 'reel', imagenes: ['plan', 'visual', 'nota'].indexOf(m.modo) >= 0 ? (m.imagenes || []) : [], audio: m.audio || 'silencio',
    plan: t.plan || null, musica: (m.modo === 'plan' || m.modo === 'nota') && t.plan && t.plan.audio && t.plan.audio.musica ? (m.musica || '') : '',
    clips: m.modo === 'nota' ? (m.clips || []).map((c, i) => ({ id: c.id, tipo: c.tipo, nombre: c.persona || '', cargo: c.cargo || '',
      usable: ((t.apoyos || {})[String(i + 1)] || {}).usable !== false })) : [],
    duracion_esperada: duracionSalida_(m, t),
    segmentos_por_clip: m.modo === 'nota' ? (t.segmentos_por_clip || {}) : {},
    conf: { color: prop_('COLOR_MARCA', '#E30613'), fuente: prop_('FUENTE', 'Liberation Sans'), segundos_titulo: prop_('SEGUNDOS_TITULO', '0'),
      medio: prop_('NOMBRE_MEDIO', 'Torre Informativa') },
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
  return { codigo: m.codigo, etapa: etapa, etapaNombre: ETAPAS[etapa] || '', inicio: m.creada, fin: etapa >= ETAPAS.length - 1 ? Date.now() : null };
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
    agentes: agentes, mision: s.mision || null, etapas: ETAPAS, bitacora: s.bitacora || [], version: VERSION,
    stats: s.stats || { reels: 0 }, actualizado: s.actualizado || Date.now(),
  };
}
