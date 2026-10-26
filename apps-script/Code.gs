/**
 * Academia Ejemplo — backend del formulario de solicitudes.
 *
 * Web App de Google Apps Script. El formulario HTML lo llama en este orden:
 *   1. getConfig     lee las preguntas activas (las define el panel admin).
 *   2. initRequest   busca o crea la carpeta del usuario y sus subcarpetas.
 *   3. startUpload   abre una sesión de subida reanudable de Drive para un archivo.
 *   4. uploadChunk   reenvía un fragmento del archivo a esa sesión (uploadStatus para reanudar).
 *   5. submit        valida las respuestas, registra la fila en el Sheet y avisa al admin.
 *
 * El panel admin (admin.html) usa adminLogin, adminGetConfig, adminSaveConfig,
 * adminChangePassword y adminLogout.
 *
 * Los archivos se suben por fragmentos porque una petición a Apps Script
 * no puede superar ~50 MB y la guía/avance admiten hasta 1 GB.
 *
 * Propiedades del script (las crea setup()):
 *   ROOT_FOLDER_ID       carpeta principal en Drive
 *   SPREADSHEET_ID       hoja donde se registran las solicitudes
 *   ADMIN_SALT, ADMIN_PASSWORD_HASH   contraseña del panel admin
 * La configuración editable (preguntas, correos de aviso) vive en la pestaña
 * oculta "Configuración" de esa hoja.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Tamaño de cada fragmento. Drive exige múltiplos de 256 KB.
const CHUNK_SIZE = 8 * MB;

const ROOT_FOLDER_NAME = 'Solicitudes - Carpeta principal';
const SPREADSHEET_NAME = 'Solicitudes - Respuestas';
const SHEET_NAME = 'Respuestas';
const CONFIG_SHEET_NAME = 'Configuración';
const TIMEZONE = 'America/La_Paz';
const CACHE_TTL = 6 * 60 * 60; // máximo que permite CacheService
const CONFIG_CACHE_TTL = 10 * 60;
const ADMIN_SESSION_TTL = 2 * 60 * 60;
const ADMIN_MAX_FAILS = 20;
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

// Fotos del sitio que el panel admin puede cambiar. Los ids coinciden con data-slot en index.html.
const SITE_SLOTS = [
  'servicios-1', 'servicios-2', 'servicios-3', 'servicios-4',
  'paso-1', 'paso-2', 'paso-3', 'paso-4', 'paso-5', 'paso-6',
  'faq-grande', 'faq-chica', 'sello',
];
const SITE_IMAGES_FOLDER = 'Sitio - Imágenes';
const MAX_SITE_IMAGE = 6 * MB;

const SUBFOLDERS = {
  identidad: 'Identidad',
  guia: 'Guia',
  avance: 'Avance actual',
  pago: 'Pago',
};

const EXT_IMG_PDF = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const EXT_DOCS = EXT_IMG_PDF.concat(['doc', 'docx']);

// Límites de cada campo de archivo. maxTotal es por campo. Se envían al formulario con getConfig.
const FILE_RULES = {
  identidad: { extensions: EXT_IMG_PDF, maxTotal: 10 * MB, maxFiles: 2 },
  guia: { extensions: EXT_DOCS, maxTotal: 1 * GB, maxFiles: 20 },
  avance: { extensions: EXT_DOCS, maxTotal: 1 * GB, maxFiles: 20 },
  pago: { extensions: EXT_IMG_PDF, maxTotal: 10 * MB, maxFiles: 1 },
};

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Tipos que el admin puede usar en preguntas nuevas.
const CUSTOM_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox'];
const CHOICE_TYPES = ['select', 'radio', 'checkbox'];
const MAX_QUESTIONS = 60;
const MAX_OPTIONS = 40;

/**
 * Configuración inicial: copia del Google Form original.
 * system: pregunta de fábrica (no se borra ni cambia de tipo).
 * locked: además no se puede desactivar ni volver opcional (arma la carpeta del usuario).
 */
// Sube cuando cambian las preguntas de fábrica: getConfig_ actualiza las ya guardadas (ver migrateConfig_).
const CONFIG_VERSION = 3;

// Sugerencias que el formulario muestra mientras se escribe. El campo sigue siendo libre.
const SUGGESTIONS = {
  universidades: [
    'Universidad Mayor de San Andrés (UMSA)', 'Universidad Mayor de San Simón (UMSS)',
    'Universidad Autónoma Gabriel René Moreno (UAGRM)', 'Universidad San Francisco Xavier de Chuquisaca (USFX)',
    'Universidad Técnica de Oruro (UTO)', 'Universidad Autónoma Tomás Frías (UATF)',
    'Universidad Autónoma Juan Misael Saracho (UAJMS)', 'Universidad Técnica del Beni (UTB)',
    'Universidad Amazónica de Pando (UAP)', 'Universidad Pública de El Alto (UPEA)',
    'Universidad Nacional Siglo XX (UNSXX)', 'Universidad Católica Boliviana San Pablo (UCB)',
    'Universidad Privada Boliviana (UPB)', 'Universidad Privada del Valle (UNIVALLE)',
    'Universidad Privada de Santa Cruz de la Sierra (UPSA)', 'Universidad Privada Domingo Savio (UPDS)',
    'Universidad de Aquino Bolivia (UDABOL)', 'Universidad Privada Franz Tamayo (UNIFRANZ)',
    'Universidad Salesiana de Bolivia (USB)', 'Universidad NUR',
    'Universidad Técnica Privada Cosmos (UNITEPC)', 'Universidad Tecnológica Privada de Santa Cruz (UTEPSA)',
    'Universidad Evangélica Boliviana (UEB)', 'Universidad Privada Abierta Latinoamericana (UPAL)',
    'Universidad Cristiana de Bolivia (UCEBOL)', 'Universidad Loyola',
    'Escuela Militar de Ingeniería (EMI)', 'Universidad Policial Antonio José de Sucre (UNIPOL)',
  ],
  ciudades: [
    'La Paz, Bolivia', 'El Alto, Bolivia', 'Santa Cruz de la Sierra, Bolivia', 'Cochabamba, Bolivia',
    'Sucre, Bolivia', 'Oruro, Bolivia', 'Potosí, Bolivia', 'Tarija, Bolivia', 'Trinidad, Bolivia',
    'Cobija, Bolivia', 'Montero, Bolivia', 'Warnes, Bolivia', 'Quillacollo, Bolivia', 'Sacaba, Bolivia',
    'Yacuiba, Bolivia', 'Riberalta, Bolivia', 'Villazón, Bolivia', 'Tupiza, Bolivia', 'Camiri, Bolivia',
    'Llallagua, Bolivia', 'Uyuni, Bolivia', 'Villa Tunari, Bolivia',
  ],
};

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  notifyEmails: [],
  sections: [
    { id: 's1', title: 'Datos personales' },
    { id: 's2', title: 'Datos académicos y del trabajo' },
    { id: 's3', title: 'Documentación y Cierre' },
  ],
  questions: [
    { id: 'nombre', section: 's1', type: 'text', label: 'Nombre y Apellido', system: true, locked: true },
    { id: 'celular', section: 's1', type: 'tel', label: 'Número de celular', system: true },
    { id: 'ci', section: 's1', type: 'ci', label: 'Número de carnet de identidad', system: true, locked: true },
    {
      id: 'extension', section: 's1', type: 'select', label: 'Extensión', system: true, locked: true,
      options: ['SC', 'LP', 'CB', 'CH', 'BN', 'OR', 'PT', 'TJ', 'PA'],
    },
    {
      id: 'identidad', section: 's1', type: 'file', category: 'identidad', label: 'Fotografía carnet de identidad',
      help: 'Puedes subir anverso y reverso. Tipos permitidos: PDF, PNG, JPG. Máximo 10 MB en total.', system: true, locked: true,
    },
    {
      id: 'nivel', section: 's2', type: 'radio', label: 'Nivel académico', system: true,
      options: ['Pregrado (Licenciatura o Ingenierías)', 'Diplomado', 'Especialidad', 'Posgrado (Maestría)', 'Doctorado'],
    },
    {
      id: 'universidad', section: 's2', type: 'text', label: 'Universidad / institución donde está cursando', system: true,
      suggest: 'universidades',
      help: 'Empieza a escribir y elige de la lista. Si tu universidad no aparece, escribe su nombre completo.',
    },
    {
      id: 'modalidad', section: 's2', type: 'radio', label: 'Modalidad', system: true,
      options: ['Proyecto de grado', 'Monografía', 'Perfil de tesis', 'Tesis', 'Artículo'],
    },
    {
      id: 'datos', section: 's2', type: 'radio', label: 'Indique si quiere datos fidedignos o ficticios para su documento.', system: true,
      options: ['Fidedignos', 'Ficticios'],
    },
    {
      id: 'estadoTitulo', section: 's2', type: 'radio', label: '¿Ya tienes definido el tema de tu trabajo?', system: true,
      options: [
        'Ya tengo mi tema o título definido o aprobado',
        'Aún no tengo tema: quiero que me propongan opciones para elegir',
        'Aún no tengo tema: elijan ustedes el más conveniente para mi carrera',
      ],
    },
    {
      id: 'titulo', section: 's2', type: 'textarea', label: 'Título tentativo o idea central del trabajo', system: true,
      help: 'Si ya tienes el título, escríbelo completo como te lo aprobaron. Si aún no, cuéntanos en una o dos frases el tema que te interesa o el problema que quieres resolver (por ejemplo: "gestión de residuos en hospitales de Santa Cruz"). Si todavía no tienes ninguna idea, escribe ND.',
    },
    {
      id: 'institucion', section: 's2', type: 'textarea', label: 'Institución, empresa o contexto de estudio', system: true,
      help: '¿En qué empresa, institución, colegio, universidad u hospital se llevará a cabo la investigación? Ej. Colegio Alemán, Hospital General, Banco Mercantil. Si es un estudio teórico, escribe ND.',
    },
    {
      id: 'ciudad', section: 's2', type: 'place', label: 'Ciudad y país de aplicación', system: true, suggest: 'ciudades',
      help: 'Escribe la ciudad y el país, por ejemplo: Santa Cruz de la Sierra, Bolivia. Solo letras.',
    },
    {
      id: 'servicio', section: 's2', type: 'radio', label: 'Tipo de servicio que necesitas', system: true,
      help: 'Elige el servicio principal. Si necesitas más de uno, cuéntanoslo en los comentarios del final.',
      options: [
        'Elaboración completa del trabajo',
        'Continuación o finalización de un avance previo',
        'Corrección de observaciones del tutor o tribunal',
        'Revisión de capítulos',
        'Diseño metodológico y análisis de datos',
        'Ajuste a la norma de formato académico',
        'Reducción de plagio e IA (Turnitin)',
      ],
    },
    {
      id: 'norma', section: 's2', type: 'radio', label: 'Norma de formato académico', system: true, other: true,
      help: 'Seleccione el estándar de citación y presentación aplicable a su documento.',
      options: ['APA7', 'ISO 690', 'Vancouver', 'Chicago', 'Harvard'],
    },
    {
      id: 'paginas', section: 's2', type: 'pages', label: 'Extensión estimada (Cantidad aproximada de páginas)', system: true,
      help: 'Ejemplo: 50-140 páginas, o según el reglamento de tu facultad.',
    },
    {
      id: 'fechaLimite', section: 's2', type: 'date', label: 'Fecha límite o plazo estimado de entrega', system: true, futureOnly: true,
      help: '¿Para qué fecha necesitas tener el borrador o documento final?',
    },
    {
      id: 'guia', section: 's3', type: 'file', category: 'guia', label: 'Guía institucional, formato o reglamento de titulación', system: true,
      help: 'Sube la guía de estructura de tu universidad para adaptarnos exactamente a los requisitos formales. Tipos permitidos: PDF, Word, PNG, JPG. Máximo 1 GB en total.',
    },
    {
      id: 'avance', section: 's3', type: 'file', category: 'avance', label: 'Avance actual o documento con observaciones', system: true,
      help: 'Si ya tienes algo redactado o el informe de corrección de tu tutor, adjúntalo aquí. Tipos permitidos: PDF, Word, PNG, JPG. Máximo 1 GB en total.',
    },
    {
      id: 'pago', section: 's3', type: 'file', category: 'pago', label: 'Comprobante de pago', system: true, required: false, enabled: false,
      help: 'Tipos permitidos: PDF, PNG, JPG. Máximo 10 MB.',
    },
    {
      id: 'comentarios', section: 's3', type: 'textarea', label: 'Comentarios o requerimientos adicionales', system: true,
      help: 'Indica cualquier detalle clave sobre entregas intermedias, exigencias del tutor, etc.',
    },
  ],
};

// Columnas fijas de la hoja que no son preguntas.
const META_COLUMNS = [
  { key: '_timestamp', label: 'Marca temporal' },
  { key: '_estado', label: 'ESTADO' },
  { key: '_detalle', label: 'DETALLE ESTADO' },
  { key: '_carpeta', label: 'Carpeta del usuario' },
  { key: '_requestId', label: 'ID solicitud' },
];

/** Error con mensaje apto para mostrar al usuario. */
class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'INVALID';
  }
}

const ACTIONS = {
  getConfig: getConfig,
  initRequest: initRequest,
  startUpload: startUpload,
  uploadChunk: uploadChunk,
  uploadStatus: uploadStatus,
  submit: submit,
  adminLogin: adminLogin,
  adminLogout: adminLogout,
  adminGetConfig: adminGetConfig,
  adminSaveConfig: adminSaveConfig,
  adminChangePassword: adminChangePassword,
  getSiteImages: getSiteImages,
  adminUploadImage: adminUploadImage,
  adminResetImage: adminResetImage,
};

// ---------------------------------------------------------------------------
// Entradas del Web App
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, data: { service: 'form-solicitudes' } });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, body.action)) {
      throw new UserError('Acción no válida.');
    }
    return json_({ ok: true, data: ACTIONS[body.action](body) });
  } catch (err) {
    if (err instanceof UserError) {
      return json_({ ok: false, error: err.message, code: err.code });
    }
    console.error(err && err.stack ? err.stack : err);
    // RETRY: error transitorio, el cliente puede reintentar.
    return json_({ ok: false, error: 'Error temporal del servidor. Intenta de nuevo.', code: 'RETRY' });
  }
}

// ---------------------------------------------------------------------------
// Acciones públicas
// ---------------------------------------------------------------------------

/** Preguntas activas para el formulario. No incluye los correos de aviso. */
function getConfig() {
  const config = getConfig_();
  const fileRules = {};
  Object.keys(FILE_RULES).forEach(function (category) {
    const r = FILE_RULES[category];
    fileRules[category] = { extensions: r.extensions, maxTotal: r.maxTotal, maxFiles: r.maxFiles };
  });
  return {
    sections: config.sections,
    questions: config.questions.filter(function (q) { return q.enabled; }).map(function (q) {
      return {
        id: q.id, section: q.section, type: q.type, label: q.label, help: q.help,
        required: q.required, options: q.options, other: q.other, category: q.category,
        futureOnly: q.futureOnly, suggest: q.suggest,
      };
    }),
    fileRules: fileRules,
    suggestions: SUGGESTIONS,
  };
}

function initRequest(body) {
  if (body.website) throw new UserError('Solicitud rechazada.'); // honeypot anti-spam

  const config = getConfig_();
  const nombre = cleanName_(text_(body.nombre, 'Nombre y Apellido', 120));
  const ci = ciValue_(body.ci);
  const extension = choice_(body.extension, questionById_(config, 'extension').options, 'Extensión de carnet');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let userFolder;
  const folders = {};
  try {
    userFolder = findOrCreateUserFolder_(ci, extension, nombre);
    Object.keys(SUBFOLDERS).forEach(function (category) {
      if (category === 'pago' && !questionById_(config, 'pago').enabled) return;
      folders[category] = getOrCreateChild_(userFolder, SUBFOLDERS[category]).getId();
    });
  } finally {
    lock.releaseLock();
  }

  const requestId = Utilities.getUuid();
  putCache_('req:' + requestId, {
    ci: ci,
    extension: extension,
    userFolderUrl: userFolder.getUrl(),
    folders: folders,
  });
  return { requestId: requestId, chunkSize: CHUNK_SIZE };
}

function startUpload(body) {
  const req = getRequest_(body.requestId);
  const category = String(body.category || '');
  const rule = ruleFor_(getConfig_(), category);
  if (!req.folders[category]) throw new UserError('Categoría de archivo no válida.');

  const name = text_(body.name, 'Nombre de archivo', 200).replace(/[\\/\u0000-\u001f]/g, '_');
  const ext = extOf_(name);
  if (rule.extensions.indexOf(ext) === -1) {
    throw new UserError('Tipo de archivo no permitido: ' + name);
  }
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0 || size > rule.maxTotal) {
    throw new UserError('Tamaño de archivo no permitido: ' + name);
  }

  const mimeType = MIME_BY_EXT[ext];
  const datePrefix = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  const res = UrlFetchApp.fetch(DRIVE_UPLOAD_URL + '?uploadType=resumable&fields=id,webViewLink', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size),
    },
    payload: JSON.stringify({ name: datePrefix + ' - ' + name, parents: [req.folders[category]] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Drive no abrió la sesión de subida: ' + res.getResponseCode() + ' ' + res.getContentText());
  }

  const uploadId = Utilities.getUuid();
  putCache_('up:' + uploadId, {
    requestId: body.requestId,
    category: category,
    name: name,
    size: size,
    mimeType: mimeType,
    sessionUrl: header_(res, 'location'),
  });
  return { uploadId: uploadId };
}

function uploadChunk(body) {
  const up = getUpload_(body.uploadId);
  if (up.fileId) return { done: true };

  const offset = Number(body.offset);
  const bytes = Utilities.base64Decode(String(body.data || ''));
  const end = offset + bytes.length - 1;
  if (offset === 0) assertFileSignature_(bytes, up.name);
  const isLast = end === up.size - 1;
  if (
    !Number.isInteger(offset) || offset < 0 ||
    bytes.length === 0 || bytes.length > CHUNK_SIZE ||
    end >= up.size ||
    (!isLast && bytes.length % (256 * 1024) !== 0)
  ) {
    throw new UserError('Fragmento de archivo no válido.');
  }

  const res = UrlFetchApp.fetch(up.sessionUrl, {
    method: 'put',
    contentType: up.mimeType,
    headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + up.size },
    payload: bytes,
    muteHttpExceptions: true,
    followRedirects: false,
  });
  return handleUploadResponse_(body.uploadId, up, res);
}

/** Pregunta a Drive cuántos bytes recibió, para reanudar tras un fallo de red. */
function uploadStatus(body) {
  const up = getUpload_(body.uploadId);
  if (up.fileId) return { done: true };

  const res = UrlFetchApp.fetch(up.sessionUrl, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + up.size },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  return handleUploadResponse_(body.uploadId, up, res);
}

function submit(body) {
  const config = getConfig_();
  const answers = validateAnswers_(config, body.answers || {});

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let req;
  let files;
  try {
    // Dentro del lock para que un doble clic no registre dos filas.
    // Si la respuesta anterior se perdió y el cliente reintenta, ya está registrada.
    if (CacheService.getScriptCache().get('done:' + body.requestId)) return { received: true };
    req = getRequest_(body.requestId);
    if (answers.ci !== req.ci || answers.extension !== req.extension) {
      throw new UserError('Los datos del carnet cambiaron. Vuelve a enviar la solicitud.', 'EXPIRED');
    }
    files = collectFiles_(config, body.requestId, body.uploads || {});

    const values = { _timestamp: new Date(), _estado: 'PENDIENTE', _detalle: '', _carpeta: req.userFolderUrl, _requestId: body.requestId };
    config.questions.forEach(function (q) {
      if (!q.enabled) return;
      values[q.id] = q.type === 'file' ? links_(files[q.category]) : (q.type === 'date' ? dateValue_(answers[q.id]) : answers[q.id]);
    });
    appendRow_(config, values);
    CacheService.getScriptCache().remove('req:' + body.requestId);
    putCache_('done:' + body.requestId, true);
  } finally {
    lock.releaseLock();
  }

  notifyAdmin_(config, answers, files, req);
  return { received: true };
}

// ---------------------------------------------------------------------------
// Panel admin
// ---------------------------------------------------------------------------

function adminLogin(body) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('admin-fails') || 0);
  if (fails >= ADMIN_MAX_FAILS) throw new UserError('Demasiados intentos fallidos. Espera 15 minutos.');

  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('ADMIN_SALT');
  const hash = props.getProperty('ADMIN_PASSWORD_HASH');
  if (!salt || !hash) throw new Error('Falta la contraseña del panel. Ejecuta setup().');

  if (hashPassword_(String(body.password || ''), salt) !== hash) {
    cache.put('admin-fails', String(fails + 1), 15 * 60);
    throw new UserError('Contraseña incorrecta.');
  }
  const token = Utilities.getUuid();
  cache.put('admin:' + token, '1', ADMIN_SESSION_TTL);
  return { token: token };
}

function adminLogout(body) {
  CacheService.getScriptCache().remove('admin:' + String(body.token || ''));
  return { ok: true };
}

function adminGetConfig(body) {
  requireAdmin_(body.token);
  return {
    config: getConfig_(),
    fileRules: getConfig().fileRules,
    customTypes: CUSTOM_TYPES,
    typeFamilies: TYPE_FAMILIES,
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + requiredProp_('SPREADSHEET_ID'),
    rootFolderUrl: DriveApp.getFolderById(requiredProp_('ROOT_FOLDER_ID')).getUrl(),
    images: siteImageUrls_(),
  };
}

function adminSaveConfig(body) {
  requireAdmin_(body.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const previous = getConfig_();
    const next = sanitizeConfig_(previous, body.config || {});
    syncSheetColumns_(next);
    syncFolderEditors_(previous.notifyEmails, next.notifyEmails);
    saveConfig_(next);
    return { config: next };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Fotos del sitio
// ---------------------------------------------------------------------------

/** Público: devuelve {slot: url} solo de las fotos que se cambiaron. */
function getSiteImages() {
  return { images: siteImageUrls_() };
}

function siteImages_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('SITE_IMAGES') || '{}');
  } catch (err) {
    return {};
  }
}

function siteImageUrls_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('site-images');
  if (cached) return JSON.parse(cached);
  const map = siteImages_();
  const urls = {};
  Object.keys(map).forEach(function (slot) { urls[slot] = map[slot].url; });
  cache.put('site-images', JSON.stringify(urls), CONFIG_CACHE_TTL);
  return urls;
}

function saveSiteImages_(map) {
  PropertiesService.getScriptProperties().setProperty('SITE_IMAGES', JSON.stringify(map));
  CacheService.getScriptCache().remove('site-images');
}

/** Reconoce el formato por los primeros bytes; no se confía en el nombre ni en el tipo que declara el navegador. */
function sniffImage_(bytes) {
  const b = bytes.map(function (x) { return x & 255; });
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function trashSiteImage_(entry) {
  if (!entry || !entry.id) return;
  try {
    DriveApp.getFileById(entry.id).setTrashed(true);
  } catch (err) {
    // Ya no existe: nada que borrar.
  }
}

function adminUploadImage(body) {
  requireAdmin_(body.token);
  const slot = String(body.slot || '');
  if (SITE_SLOTS.indexOf(slot) === -1) throw new UserError('Esa foto no se puede cambiar.');

  const bytes = Utilities.base64Decode(String(body.data || ''));
  if (!bytes.length || bytes.length > MAX_SITE_IMAGE) throw new UserError('La imagen debe pesar menos de 6 MB.');
  const kind = sniffImage_(bytes);
  if (!kind) throw new UserError('Usa una imagen JPG, PNG o WebP.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const folder = getOrCreateChild_(getRootFolder_(), SITE_IMAGES_FOLDER);
    const file = folder.createFile(Utilities.newBlob(bytes, kind.mime, slot + '-' + Date.now() + '.' + kind.ext));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const map = siteImages_();
    trashSiteImage_(map[slot]);
    map[slot] = { id: file.getId(), url: 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1600' };
    saveSiteImages_(map);
    return { url: map[slot].url };
  } finally {
    lock.releaseLock();
  }
}

function adminResetImage(body) {
  requireAdmin_(body.token);
  const slot = String(body.slot || '');
  if (SITE_SLOTS.indexOf(slot) === -1) throw new UserError('Esa foto no se puede cambiar.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const map = siteImages_();
    trashSiteImage_(map[slot]);
    delete map[slot];
    saveSiteImages_(map);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function adminChangePassword(body) {
  requireAdmin_(body.token);
  const props = PropertiesService.getScriptProperties();
  if (hashPassword_(String(body.current || ''), props.getProperty('ADMIN_SALT')) !== props.getProperty('ADMIN_PASSWORD_HASH')) {
    throw new UserError('La contraseña actual no es correcta.');
  }
  const next = String(body.next || '');
  if (next.length < 8) throw new UserError('La nueva contraseña debe tener al menos 8 caracteres.');
  setPassword_(next);
  return { ok: true };
}

function requireAdmin_(token) {
  if (!token || !CacheService.getScriptCache().get('admin:' + String(token))) {
    throw new UserError('La sesión expiró. Vuelve a ingresar.', 'AUTH');
  }
}

function hashPassword_(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(digest);
}

function setPassword_(password) {
  const salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_SALT: salt,
    ADMIN_PASSWORD_HASH: hashPassword_(password, salt),
  });
}

/**
 * Combina lo que envía el panel con la configuración guardada.
 * Las preguntas de fábrica conservan su tipo y no se pueden borrar;
 * las bloqueadas además siguen activas y obligatorias.
 */
const TYPE_FAMILIES = [['text', 'textarea'], ['select', 'radio', 'checkbox']];

function typeFamily_(type) {
  return TYPE_FAMILIES.filter(function (f) { return f.indexOf(type) !== -1; })[0] || [type];
}

function sanitizeConfig_(previous, incoming) {
  const prevById = {};
  previous.questions.forEach(function (q) { prevById[q.id] = q; });

  const sectionIds = previous.sections.map(function (s) { return s.id; });
  const sections = previous.sections.map(function (s) {
    const found = (incoming.sections || []).filter(function (x) { return x && x.id === s.id; })[0];
    return { id: s.id, title: found ? limit_(found.title, 80) || s.title : s.title };
  });

  const seen = {};
  const questions = [];
  (Array.isArray(incoming.questions) ? incoming.questions : []).forEach(function (raw) {
    if (!raw || typeof raw !== 'object') return;
    const id = String(raw.id || '');
    if (seen[id]) return;
    const prev = prevById[id];
    const isSystem = prev && prev.system;
    if (!isSystem && !/^q_[a-z0-9]{6,16}$/.test(id)) throw new UserError('Identificador de pregunta no válido.');

    // Las preguntas de fábrica pueden cambiar de tipo dentro de su familia (respuesta corta <-> párrafo,
    // lista <-> opción única <-> casillas). Las que validan un dato concreto o arman la carpeta no cambian.
    let type = String(raw.type || '');
    if (isSystem) {
      const family = prev.locked ? [prev.type] : typeFamily_(prev.type);
      type = family.indexOf(type) !== -1 ? type : prev.type;
    }
    if (!isSystem && CUSTOM_TYPES.indexOf(type) === -1) throw new UserError('Tipo de pregunta no válido.');

    const label = limit_(raw.label, 300);
    if (!label) throw new UserError('Hay una pregunta sin texto.');

    const q = {
      id: id,
      section: sectionIds.indexOf(raw.section) !== -1 ? raw.section : (prev ? prev.section : sectionIds[0]),
      type: type,
      label: label,
      help: limit_(raw.help, 600),
      required: Boolean(raw.required),
      enabled: raw.enabled !== false,
    };
    if (isSystem) {
      q.system = true;
      if (prev.category) q.category = prev.category;
      if (prev.futureOnly) q.futureOnly = true;
      if (prev.suggest) q.suggest = prev.suggest;
      if (prev.locked) {
        q.locked = true;
        q.required = true;
        q.enabled = true;
      }
    } else if (type === 'date') {
      q.futureOnly = Boolean(raw.futureOnly);
    }

    if (CHOICE_TYPES.indexOf(type) !== -1) {
      const options = (Array.isArray(raw.options) ? raw.options : [])
        .map(function (o) { return limit_(o, 200); })
        .filter(function (o, i, all) { return o && o !== 'Otro' && all.indexOf(o) === i; })
        .slice(0, MAX_OPTIONS);
      if (!options.length) throw new UserError('La pregunta "' + label + '" necesita al menos una opción.');
      q.options = options;
      q.other = type !== 'select' && Boolean(raw.other);
    }
    seen[id] = true;
    questions.push(q);
  });

  // Las preguntas de fábrica no se pueden borrar: si faltan, vuelven como estaban.
  previous.questions.forEach(function (q) {
    if (q.system && !seen[q.id]) questions.push(q);
  });
  if (questions.length > MAX_QUESTIONS) throw new UserError('Máximo ' + MAX_QUESTIONS + ' preguntas.');

  const emails = (Array.isArray(incoming.notifyEmails) ? incoming.notifyEmails : [])
    .map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(function (e, i, all) { return e && all.indexOf(e) === i; });
  emails.forEach(function (e) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new UserError('Correo no válido: ' + e);
  });
  if (!emails.length) throw new UserError('Agrega al menos un correo de aviso.');
  if (emails.length > 10) throw new UserError('Máximo 10 correos de aviso.');

  return { version: previous.version || CONFIG_VERSION, notifyEmails: emails, sections: sections, questions: questions, columns: previous.columns };
}

/** Da una columna a cada pregunta nueva y mantiene los encabezados al día. */
function syncSheetColumns_(config) {
  const sheet = getResponsesSheet_();
  const columns = config.columns;
  config.questions.forEach(function (q) {
    if (!columns[q.id]) {
      columns[q.id] = Math.max(sheet.getLastColumn(), maxColumn_(columns)) + 1;
      setTextColumns_(sheet, columns[q.id], columns[q.id]);
    }
    sheet.getRange(1, columns[q.id]).setValue(q.label).setFontWeight('bold');
  });
}

/** Los correos de aviso pueden abrir los archivos: se les da acceso a la carpeta principal. */
function syncFolderEditors_(before, after) {
  const root = DriveApp.getFolderById(requiredProp_('ROOT_FOLDER_ID'));
  const owner = Session.getEffectiveUser().getEmail().toLowerCase();
  after.filter(function (e) { return before.indexOf(e) === -1 && e !== owner; }).forEach(function (e) {
    try { root.addEditor(e); } catch (err) { console.error('No se pudo compartir con ' + e + ': ' + err); }
  });
  before.filter(function (e) { return after.indexOf(e) === -1 && e !== owner; }).forEach(function (e) {
    try { root.removeEditor(e); } catch (err) { console.error('No se pudo quitar a ' + e + ': ' + err); }
  });
}

// ---------------------------------------------------------------------------
// Configuración guardada
// ---------------------------------------------------------------------------

function getConfig_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CONFIG_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const sheet = getConfigSheet_();
  const raw = sheet.getRange('A1').getValue();
  let config = raw ? JSON.parse(raw) : buildDefaultConfig_();
  if ((config.version || 1) < CONFIG_VERSION) {
    config = migrateConfig_(config);
    saveConfig_(config);
    return config;
  }
  cache.put(CONFIG_CACHE_KEY, JSON.stringify(config), CONFIG_CACHE_TTL);
  return config;
}

const CONFIG_CACHE_KEY = 'config-v2';

/**
 * Pone al día las preguntas de fábrica ya guardadas cuando cambia CONFIG_VERSION.
 * Solo toca texto, tipo, opciones y ayuda de las preguntas listadas; respeta si están
 * activas, si son obligatorias, su sección y su orden.
 */
const MIGRATED_IDS = ['nivel', 'modalidad', 'datos', 'universidad', 'estadoTitulo', 'titulo', 'ciudad', 'servicio', 'norma'];

function migrateConfig_(config) {
  const defaults = {};
  DEFAULT_CONFIG.questions.forEach(function (q) { defaults[q.id] = q; });
  config.questions.forEach(function (q) {
    if (MIGRATED_IDS.indexOf(q.id) === -1 || !defaults[q.id]) return;
    const d = defaults[q.id];
    q.type = d.type;
    q.label = d.label;
    q.help = d.help || '';
    if (d.options) q.options = d.options.slice(); else delete q.options;
    if (d.suggest) q.suggest = d.suggest; else delete q.suggest;
    if (d.type === 'radio' || d.type === 'checkbox') q.other = Boolean(d.other);
  });
  config.version = CONFIG_VERSION;
  return config;
}

function saveConfig_(config) {
  getConfigSheet_().getRange('A1').setValue(JSON.stringify(config));
  CacheService.getScriptCache().put(CONFIG_CACHE_KEY, JSON.stringify(config), CONFIG_CACHE_TTL);
}

function buildDefaultConfig_() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.questions.forEach(function (q) {
    if (q.required === undefined) q.required = true;
    if (q.enabled === undefined) q.enabled = true;
    if (q.help === undefined) q.help = '';
    if (CHOICE_TYPES.indexOf(q.type) !== -1 && q.other === undefined) q.other = false;
  });
  // Columnas en el mismo orden que la hoja del Google Form, con las fijas al final.
  config.columns = { _timestamp: 1 };
  config.questions.forEach(function (q, i) { config.columns[q.id] = i + 2; });
  let col = config.questions.length + 2;
  META_COLUMNS.slice(1).forEach(function (m) { config.columns[m.key] = col++; });

  const legacyEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  config.notifyEmails = [(legacyEmail || Session.getEffectiveUser().getEmail()).toLowerCase()];
  return config;
}

function getConfigSheet_() {
  const spreadsheet = SpreadsheetApp.openById(requiredProp_('SPREADSHEET_ID'));
  let sheet = spreadsheet.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG_SHEET_NAME);
    sheet.hideSheet();
  }
  return sheet;
}

function questionById_(config, id) {
  return config.questions.filter(function (q) { return q.id === id; })[0] || {};
}

function maxColumn_(columns) {
  return Object.keys(columns).reduce(function (max, k) { return Math.max(max, columns[k]); }, 0);
}

// ---------------------------------------------------------------------------
// Configuración inicial (ejecutar a mano una vez desde el editor)
// ---------------------------------------------------------------------------

/**
 * Crea la carpeta principal, la hoja, la configuración y la contraseña del panel
 * si no existen. Para usar una carpeta u hoja ya existente, define antes
 * ROOT_FOLDER_ID o SPREADSHEET_ID en Propiedades del script.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty('ROOT_FOLDER_ID')) {
    props.setProperty('ROOT_FOLDER_ID', DriveApp.createFolder(ROOT_FOLDER_NAME).getId());
  }

  let spreadsheet;
  if (props.getProperty('SPREADSHEET_ID')) {
    spreadsheet = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
  } else {
    spreadsheet = SpreadsheetApp.create(SPREADSHEET_NAME);
    props.setProperty('SPREADSHEET_ID', spreadsheet.getId());
  }

  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    // Una hoja recién creada trae una pestaña vacía por defecto que sobra.
    spreadsheet.getSheets().forEach(function (s) {
      if (s.getName() !== SHEET_NAME && s.getName() !== CONFIG_SHEET_NAME && s.getLastRow() === 0) spreadsheet.deleteSheet(s);
    });
  }

  CacheService.getScriptCache().remove(CONFIG_CACHE_KEY);
  const configSheet = getConfigSheet_();
  if (!configSheet.getRange('A1').getValue()) saveConfig_(buildDefaultConfig_());
  const config = getConfig_();

  // Hoja nueva: encabezados y filas fijas. Hoja existente: solo se rellenan los
  // encabezados que falten, sin tocar los datos ni los encabezados que ya tiene.
  const isNew = sheet.getLastRow() === 0;
  const labels = {};
  META_COLUMNS.forEach(function (m) { labels[m.key] = m.label; });
  config.questions.forEach(function (q) { labels[q.id] = q.label; });
  Object.keys(config.columns).forEach(function (key) {
    const cell = sheet.getRange(1, config.columns[key]);
    if (isNew || !cell.getValue()) cell.setValue(labels[key] || key).setFontWeight('bold');
  });
  if (isNew) {
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(2);
    setTextColumns_(sheet, 2, maxColumn_(config.columns));
    sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');
  }

  if (!props.getProperty('ADMIN_PASSWORD_HASH')) {
    const password = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    setPassword_(password);
    console.log('Contraseña inicial del panel admin (cámbiala al entrar): ' + password);
  }

  console.log('Carpeta principal: ' + DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID')).getUrl());
  console.log('Hoja de respuestas: ' + spreadsheet.getUrl());
  console.log('Aviso a: ' + config.notifyEmails.join(', '));
}

/** Por si se olvida la contraseña: ejecutar desde el editor y leer el registro. */
function resetAdminPassword() {
  const password = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  setPassword_(password);
  console.log('Nueva contraseña del panel admin: ' + password);
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

function findOrCreateUserFolder_(ci, extension, nombre) {
  const props = PropertiesService.getScriptProperties();
  const key = 'user:' + ci + '-' + extension;
  const prefix = ci + '-' + extension + '-';

  const savedId = props.getProperty(key);
  if (savedId) {
    try {
      const saved = DriveApp.getFolderById(savedId);
      if (!saved.isTrashed()) return saved;
    } catch (err) {
      // La carpeta fue borrada: se busca o se crea otra.
    }
  }

  // Sin registro (p. ej. tras migrar de cuenta): buscar por nombre antes de crear.
  const root = getRootFolder_();
  const it = root.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    if (folder.getName().indexOf(prefix) === 0) {
      props.setProperty(key, folder.getId());
      return folder;
    }
  }

  const created = root.createFolder(prefix + initials_(nombre));
  props.setProperty(key, created.getId());
  return created;
}

/** Iniciales del nombre sin tildes, p. ej. "Juan Carlos Pérez Mamani" -> "JCPM" (máximo 4). */
function initials_(nombre) {
  const letters = String(nombre || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().split(/\s+/)
    .map(function (w) { return w.replace(/[^A-Z]/g, '').charAt(0); })
    .filter(Boolean);
  return (letters.join('') || 'X').slice(0, 4);
}

function getOrCreateChild_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getRootFolder_() {
  return DriveApp.getFolderById(requiredProp_('ROOT_FOLDER_ID'));
}

function handleUploadResponse_(uploadId, up, res) {
  const code = res.getResponseCode();
  if (code === 308) {
    const match = /bytes=0-(\d+)/.exec(header_(res, 'range') || '');
    return { done: false, next: match ? Number(match[1]) + 1 : 0 };
  }
  if (code === 200 || code === 201) {
    const file = JSON.parse(res.getContentText());
    up.fileId = file.id;
    up.link = file.webViewLink;
    putCache_('up:' + uploadId, up);
    return { done: true };
  }
  if (code === 404 || code === 410) {
    throw new UserError('La subida de "' + up.name + '" se interrumpió. Vuelve a intentar.');
  }
  throw new Error('Drive respondió ' + code + ': ' + res.getContentText());
}

function collectFiles_(config, requestId, uploads) {
  const cache = CacheService.getScriptCache();
  const result = {};
  config.questions.forEach(function (q) {
    if (q.type !== 'file') return;
    const category = q.category;
    const rule = FILE_RULES[category];
    const ids = Array.isArray(uploads[category]) ? uploads[category].map(String) : [];

    if (!q.enabled) {
      if (ids.length) throw new UserError('El campo "' + q.label + '" no está habilitado.');
      result[category] = [];
      return;
    }
    if (q.required && !ids.length) {
      throw new UserError('Falta subir: ' + q.label + '.');
    }
    if (ids.length > rule.maxFiles) {
      throw new UserError('Demasiados archivos en: ' + q.label + '.');
    }

    const cached = ids.length ? cache.getAll(ids.map(function (id) { return 'up:' + id; })) : {};
    let total = 0;
    result[category] = ids.map(function (id) {
      const raw = cached['up:' + id];
      const up = raw ? JSON.parse(raw) : null;
      if (!up || up.requestId !== requestId || up.category !== category || !up.fileId) {
        throw new UserError('Un archivo no terminó de subirse. Vuelve a enviar la solicitud.', 'EXPIRED');
      }
      total += up.size;
      return up;
    });
    if (total > rule.maxTotal) {
      throw new UserError('Se superó el tamaño máximo en: ' + q.label + '.');
    }
  });
  return result;
}

/** dd/mm/yyyy -> fecha real, para que la hoja pueda ordenar y filtrar por plazo. */
function dateValue_(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text || ''));
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : text;
}

function links_(uploads) {
  return (uploads || []).map(function (up) { return up.link; }).join(', ');
}

// ---------------------------------------------------------------------------
// Hoja y correo
// ---------------------------------------------------------------------------

function getResponsesSheet_() {
  const sheet = SpreadsheetApp.openById(requiredProp_('SPREADSHEET_ID')).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No existe la pestaña "' + SHEET_NAME + '". Ejecuta setup().');
  return sheet;
}

/**
 * Escribe cada valor en la columna que le corresponde según la configuración.
 * No toca formatos de celda: en hojas nuevas las columnas ya nacen como texto (setup),
 * y en una tabla de Sheets el tipo de cada columna lo define la tabla.
 */
function appendRow_(config, values) {
  const sheet = getResponsesSheet_();
  const width = Math.max(sheet.getLastColumn(), maxColumn_(config.columns));
  const row = new Array(width).fill('');
  Object.keys(values).forEach(function (key) {
    const col = config.columns[key];
    if (col) row[col - 1] = safeCell_(values[key]);
  });

  const target = sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, width).setValues([row]);
  SpreadsheetApp.flush();
  // Si la hoja descarta la escritura sin avisar, que el envío falle en vez de dar por bueno un registro vacío.
  if (sheet.getRange(target, 1).getValue() === '') {
    throw new Error('La fila ' + target + ' de "' + sheet.getName() + '" quedó vacía tras escribirla.');
  }
}

/** Columnas en texto plano para que CI y celular no se conviertan en números. Una tabla con tipos propios las rechaza: se ignora. */
function setTextColumns_(sheet, fromCol, toCol) {
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  try {
    sheet.getRange(2, fromCol, rows, toCol - fromCol + 1).setNumberFormat('@');
    SpreadsheetApp.flush();
  } catch (err) {
    console.log('Formato de texto omitido en las columnas ' + fromCol + '-' + toCol + ': ' + err.message);
  }
}

/** Evita que un texto del usuario se interprete como fórmula. */
function safeCell_(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
}

function notifyAdmin_(config, answers, files, req) {
  const to = config.notifyEmails.join(',');
  if (!to) return;

  const rows = [];
  config.questions.forEach(function (q) {
    if (!q.enabled) return;
    if (q.type === 'file') {
      const count = (files[q.category] || []).length;
      if (count) rows.push([q.label, count + (count === 1 ? ' archivo' : ' archivos')]);
      return;
    }
    if (answers[q.id] !== '' && answers[q.id] !== undefined) rows.push([q.label, answers[q.id]]);
  });

  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + requiredProp_('SPREADSHEET_ID');
  const html =
    '<p>Llegó una nueva solicitud desde el formulario web.</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
    rows.map(function (r) {
      return '<tr><td style="border:1px solid #ddd;font-weight:bold">' + escapeHtml_(r[0]) +
        '</td><td style="border:1px solid #ddd">' + escapeHtml_(String(r[1])) + '</td></tr>';
    }).join('') +
    '</table>' +
    '<p><a href="' + req.userFolderUrl + '">Abrir carpeta del usuario</a> · ' +
    '<a href="' + sheetUrl + '">Abrir hoja de respuestas</a></p>';

  try {
    MailApp.sendEmail({
      to: to,
      subject: 'Nueva solicitud: ' + answers.nombre + ' (' + answers.ci + '-' + answers.extension + ')',
      htmlBody: html,
      name: 'Formulario de solicitudes',
    });
  } catch (err) {
    // La solicitud ya quedó registrada; un fallo del correo no debe anularla.
    console.error('No se pudo enviar el aviso: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

function validateAnswers_(config, raw) {
  const out = {};
  config.questions.forEach(function (q) {
    if (!q.enabled || q.type === 'file') return;
    out[q.id] = validateQuestion_(q, raw[q.id]);
  });
  return out;
}

function validateQuestion_(q, value) {
  const empty = value == null || (Array.isArray(value) ? value.length === 0 : String(value).trim() === '');
  if (empty) {
    if (q.required) throw new UserError('Falta: ' + q.label + '.');
    return '';
  }
  const choices = (q.options || []).concat(q.other ? ['Otro'] : []);
  switch (q.type) {
    case 'text': {
      const v = text_(value, q.label, q.id === 'nombre' ? 120 : 200).replace(/\s+/g, ' ');
      return q.id === 'nombre' ? titleCase_(v) : canonicalSuggestion_(q, v);
    }
    case 'place': return place_(value, q);
    case 'textarea': return text_(value, q.label, 3000);
    case 'tel': return phone_(value, q.label);
    case 'ci': return ciValue_(value);
    case 'number': {
      const n = Number(value);
      if (!isFinite(n)) throw new UserError(q.label + ' debe ser un número.');
      return n;
    }
    case 'pages': return pages_(value);
    case 'date': return date_(value, q);
    case 'select':
    case 'radio': return choice_(value, choices, q.label);
    case 'checkbox': return multi_(value, choices, q.label);
  }
  throw new UserError('Pregunta no válida: ' + q.label);
}

/** Nombres: mayúscula inicial en cada palabra y partículas (de, del, la…) en minúscula. */
function titleCase_(text) {
  const small = ['de', 'del', 'la', 'las', 'los', 'y', 'e'];
  return String(text).trim().replace(/\s+/g, ' ').split(' ').map(function (word, i) {
    return word.split('-').map(function (part) {
      const lower = part.toLowerCase();
      return i > 0 && small.indexOf(lower) !== -1 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join('-');
  }).join(' ');
}

/** Si lo escrito coincide con una sugerencia (sin mayúsculas), se guarda con el nombre de la lista. */
function canonicalSuggestion_(q, value) {
  const list = SUGGESTIONS[q.suggest] || [];
  const key = value.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    if (list[i].toLowerCase() === key) return list[i];
  }
  return value;
}

/** Celular de Bolivia (8 dígitos que empiezan con 6 o 7) o internacional; siempre sale como +<código><número>. */
function phone_(value, label) {
  const digits = String(value).replace(/\D/g, '');
  if (/^[67]\d{7}$/.test(digits)) return '+591' + digits;
  if (/^591[67]\d{7}$/.test(digits)) return '+' + digits;
  if (String(value).trim().charAt(0) === '+' && digits.length >= 10 && digits.length <= 15) return '+' + digits;
  throw new UserError(label + ': escribe 8 dígitos que empiecen con 6 o 7, o un número internacional con su código de país.');
}

/** Ciudad y país: solo letras, espacios, coma, punto, guion y apóstrofo. */
function place_(value, q) {
  const v = text_(value, q.label, 80).replace(/\s+/g, ' ');
  if (!/^\p{L}[\p{L} .,'’-]{1,79}$/u.test(v)) throw new UserError(q.label + ': usa solo letras, sin números.');
  return canonicalSuggestion_(q, titleCase_(v).replace(/(^|, )([a-záéíóúñ])/g, function (m, a, b) { return a + b.toUpperCase(); }));
}

function text_(value, label, maxLength) {
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new UserError('Falta: ' + label + '.');
  if (v.length > maxLength) throw new UserError(label + ' es demasiado largo.');
  return v;
}

function match_(value, regex, label) {
  if (!value) throw new UserError('Falta: ' + label + '.');
  if (!regex.test(value)) throw new UserError(label + ' no es válido.');
  return value;
}

function ciValue_(value) {
  return match_(String(value || '').trim().toUpperCase(), /^[0-9A-Z-]{4,15}$/, 'Número de carnet');
}

/** Acepta una opción de la lista o "Otro: <texto>" si la lista incluye "Otro". */
function choice_(value, list, label) {
  const v = String(value || '').trim();
  if (!v) throw new UserError('Falta: ' + label + '.');
  if (v !== 'Otro' && (list || []).indexOf(v) !== -1) return v;
  if ((list || []).indexOf('Otro') !== -1 && /^Otro: \S/.test(v) && v.length <= 200) return v;
  throw new UserError('Opción no válida en ' + label + '.');
}

function multi_(values, list, label) {
  if (!Array.isArray(values) || !values.length) throw new UserError('Falta: ' + label + '.');
  if (values.length > list.length) throw new UserError('Opción no válida en ' + label + '.');
  return values.map(function (v) { return choice_(v, list, label); }).join(', ');
}

/** Acepta un número de páginas o un rango, p. ej. "80" o "50-140". */
function pages_(value) {
  const v = String(value || '').replace(/\s+/g, '');
  if (!/^\d{1,4}(-\d{1,4})?$/.test(v)) {
    throw new UserError('La extensión estimada debe ser un número o un rango de páginas, p. ej. 50-140.');
  }
  return v;
}

/** Recibe yyyy-mm-dd y devuelve dd/mm/yyyy, como en la hoja del Form. */
function date_(value, q) {
  const v = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UserError('Fecha no válida en: ' + q.label + '.');
  if (q.futureOnly && v < Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd')) {
    throw new UserError(q.label + ': la fecha no puede ser anterior a hoy.');
  }
  return v.split('-').reverse().join('/');
}

function cleanName_(value) {
  return value.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function ruleFor_(config, category) {
  const q = config.questions.filter(function (x) { return x.type === 'file' && x.category === category; })[0];
  if (!q || !q.enabled || !Object.prototype.hasOwnProperty.call(FILE_RULES, category)) {
    throw new UserError('Categoría de archivo no válida.');
  }
  return FILE_RULES[category];
}

/**
 * El contenido debe coincidir con la extensión declarada (un .exe renombrado a .pdf no pasa).
 * Se revisa solo el primer fragmento: son los bytes de cabecera de cada formato.
 */
function assertFileSignature_(bytes, name) {
  const ext = extOf_(name);
  const b = Array.prototype.slice.call(bytes, 0, 16).map(function (x) { return x & 255; });
  const starts = function (sig, at) {
    at = at || 0;
    return sig.every(function (v, i) { return b[at + i] === v; });
  };
  const ascii = function (text, at) {
    return starts(text.split('').map(function (c) { return c.charCodeAt(0); }), at);
  };
  const ok = {
    pdf: () => ascii('%PDF-'),
    jpg: () => starts([0xff, 0xd8, 0xff]),
    jpeg: () => starts([0xff, 0xd8, 0xff]),
    png: () => starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    webp: () => ascii('RIFF') && ascii('WEBP', 8),
    heic: () => ascii('ftyp', 4),
    heif: () => ascii('ftyp', 4),
    docx: () => starts([0x50, 0x4b, 0x03, 0x04]),
    doc: () => starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  }[ext];
  if (!ok || !ok()) throw new UserError('El archivo "' + name + '" no es un ' + ext.toUpperCase() + ' válido. Revisa que no esté dañado.');
}

function extOf_(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function limit_(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function getRequest_(requestId) {
  const raw = CacheService.getScriptCache().get('req:' + String(requestId || ''));
  if (!raw) throw new UserError('La sesión expiró. Vuelve a enviar la solicitud.', 'EXPIRED');
  return JSON.parse(raw);
}

function getUpload_(uploadId) {
  const raw = CacheService.getScriptCache().get('up:' + String(uploadId || ''));
  if (!raw) throw new UserError('La subida expiró. Vuelve a enviar la solicitud.', 'EXPIRED');
  return JSON.parse(raw);
}

function putCache_(key, value) {
  CacheService.getScriptCache().put(key, JSON.stringify(value), CACHE_TTL);
}

function requiredProp_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Falta la propiedad ' + name + '. Ejecuta setup().');
  return value;
}

function header_(res, name) {
  const headers = res.getAllHeaders();
  const key = Object.keys(headers).find(function (k) { return k.toLowerCase() === name; });
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] : value;
}

function escapeHtml_(value) {
  return value.replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
