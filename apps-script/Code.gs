/**
 * Example Academy - backend of the request form.
 *
 * Google Apps Script Web App. The HTML form calls it in this order:
 *   1. getConfig     reads the active questions (they are defined in the admin panel).
 *   2. initRequest   finds or creates the user's folder and its subfolders.
 *   3. startUpload   opens a resumable Drive upload session for one file.
 *   4. uploadChunk   forwards one chunk of the file to that session (uploadStatus resumes it).
 *   5. submit        validates the answers, appends the row to the Sheet and notifies the admin.
 *
 * The admin panel (admin.html) uses adminLogin, adminGetConfig, adminSaveConfig,
 * adminChangePassword and adminLogout.
 *
 * Files are uploaded in chunks because a request to Apps Script cannot exceed ~50 MB
 * and the guide / draft fields accept up to 1 GB.
 *
 * Script properties (created by setup()):
 *   ROOT_FOLDER_ID       main folder in Drive
 *   SPREADSHEET_ID       spreadsheet where requests are recorded
 *   ADMIN_SALT, ADMIN_PASSWORD_HASH   admin panel password
 * The editable configuration (questions, notification emails) lives in the
 * hidden "Config" tab of that spreadsheet.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Size of each chunk. Drive requires multiples of 256 KB.
const CHUNK_SIZE = 8 * MB;

const ROOT_FOLDER_NAME = 'Requests - Main folder';
const SPREADSHEET_NAME = 'Requests - Responses';
const SHEET_NAME = 'Responses';
const CONFIG_SHEET_NAME = 'Config';
const TIMEZONE = 'America/La_Paz';
const CACHE_TTL = 6 * 60 * 60; // the maximum CacheService allows
const CONFIG_CACHE_TTL = 10 * 60;
const ADMIN_SESSION_TTL = 2 * 60 * 60;
const ADMIN_MAX_FAILS = 20;
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
// Country code added to local phone numbers typed without "+". 591 = Bolivia.
const PHONE_COUNTRY_CODE = '591';

// Site photos the admin panel can change. The ids match the data-slot attributes in index.html.
const SITE_SLOTS = [
  'services-1', 'services-2', 'services-3', 'services-4',
  'step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6',
  'faq-large', 'faq-small', 'stamp',
];
const SITE_IMAGES_FOLDER = 'Site - Images';
const MAX_SITE_IMAGE = 6 * MB;

const SUBFOLDERS = {
  identity: 'Identity',
  guide: 'Guide',
  draft: 'Current draft',
  payment: 'Payment',
};

const EXT_IMG_PDF = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const EXT_DOCS = EXT_IMG_PDF.concat(['doc', 'docx']);

// Limits of each file field. maxTotal is per field. They are sent to the form with getConfig.
const FILE_RULES = {
  identity: { extensions: EXT_IMG_PDF, maxTotal: 10 * MB, maxFiles: 2 },
  guide: { extensions: EXT_DOCS, maxTotal: 1 * GB, maxFiles: 20 },
  draft: { extensions: EXT_DOCS, maxTotal: 1 * GB, maxFiles: 20 },
  payment: { extensions: EXT_IMG_PDF, maxTotal: 10 * MB, maxFiles: 1 },
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

// Types the admin can use in new questions.
const CUSTOM_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox'];
const CHOICE_TYPES = ['select', 'radio', 'checkbox'];
const MAX_QUESTIONS = 60;
const MAX_OPTIONS = 40;

/**
 * Initial configuration: the factory questions.
 * system: factory question (cannot be deleted, and its type only changes within its family).
 * locked: also cannot be disabled or made optional (it builds the user's folder name).
 */
// Bump when the factory questions change: getConfig_ updates the stored ones (see migrateConfig_).
const CONFIG_VERSION = 3;

// Suggestions the form shows while typing. The field is still free text. Sample data: replace with yours.
const SUGGESTIONS = {
  universities: [
    'Massachusetts Institute of Technology (MIT)', 'Stanford University', 'University of Oxford', 'University of Cambridge',
    'University of Toronto', 'Universidad Nacional Autónoma de México (UNAM)', 'Universidad de Buenos Aires (UBA)',
    'Universidade de São Paulo (USP)', 'Universidad de Chile', 'Universidad Mayor de San Andrés (UMSA)',
    'Universidad Mayor de San Simón (UMSS)', 'Universidad Autónoma Gabriel René Moreno (UAGRM)',
  ],
  cities: [
    'La Paz, Bolivia', 'Santa Cruz de la Sierra, Bolivia', 'Cochabamba, Bolivia', 'Buenos Aires, Argentina',
    'São Paulo, Brazil', 'Santiago, Chile', 'Bogotá, Colombia', 'Mexico City, Mexico', 'Lima, Peru',
    'Madrid, Spain', 'London, United Kingdom', 'New York, United States', 'Toronto, Canada',
  ],
};

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  notifyEmails: [],
  sections: [
    { id: 's1', title: 'Personal details' },
    { id: 's2', title: 'Academic and project details' },
    { id: 's3', title: 'Documents and wrap-up' },
  ],
  questions: [
    { id: 'fullName', section: 's1', type: 'text', label: 'First and last name', system: true, locked: true },
    { id: 'phone', section: 's1', type: 'tel', label: 'Mobile phone number', system: true },
    { id: 'idNumber', section: 's1', type: 'idnumber', label: 'ID number', system: true, locked: true },
    {
      id: 'idExt', section: 's1', type: 'select', label: 'ID issuing country', system: true, locked: true,
      options: ['BO', 'AR', 'BR', 'CL', 'CO', 'MX', 'PE', 'ES', 'US', 'GB'],
    },
    {
      id: 'idPhoto', section: 's1', type: 'file', category: 'identity', label: 'ID photo',
      help: 'You can upload the front and the back. Allowed types: PDF, PNG, JPG. Maximum 10 MB in total.', system: true, locked: true,
    },
    {
      id: 'level', section: 's2', type: 'radio', label: 'Academic level', system: true,
      options: ['Bachelor degree', 'Diploma', 'Specialization', 'Master degree', 'Doctorate'],
    },
    {
      id: 'university', section: 's2', type: 'text', label: 'University / institution where you are studying', system: true,
      suggest: 'universities',
      help: 'Start typing and pick from the list. If your university is not listed, type its full name.',
    },
    {
      id: 'workType', section: 's2', type: 'radio', label: 'Type of work', system: true,
      options: ['Final project', 'Monograph', 'Thesis proposal', 'Thesis', 'Article'],
    },
    {
      id: 'language', section: 's2', type: 'radio', label: 'In which language is your document written?', system: true,
      options: ['English', 'Spanish', 'Portuguese'],
    },
    {
      id: 'topicStatus', section: 's2', type: 'radio', label: 'Have you already defined the topic of your work?', system: true,
      options: [
        'I already have my topic or title defined or approved',
        'I do not have a topic yet: I would like you to propose options to choose from',
        'I do not have a topic yet: please choose the most suitable one for my degree',
      ],
    },
    {
      id: 'title', section: 's2', type: 'textarea', label: 'Tentative title or central idea of the work', system: true,
      help: 'If you already have the title, write it in full as it was approved. If not, tell us in one or two sentences the topic you are interested in or the problem you want to solve (for example: "waste management in hospitals of Santa Cruz"). If you have no idea yet, write N/A.',
    },
    {
      id: 'institution', section: 's2', type: 'textarea', label: 'Institution, company or study context', system: true,
      help: 'In which company, institution, school, university or hospital will the research take place? E.g. German School, General Hospital, Mercantil Bank. If it is a theoretical study, write N/A.',
    },
    {
      id: 'city', section: 's2', type: 'place', label: 'City and country of application', system: true, suggest: 'cities',
      help: 'Type the city and the country, for example: Santa Cruz de la Sierra, Bolivia. Letters only.',
    },
    {
      id: 'service', section: 's2', type: 'radio', label: 'Type of service you need', system: true,
      help: 'Choose the main service. If you need more than one, tell us in the comments at the end.',
      options: [
        'Coaching through the whole work',
        'Continuation or completion of a previous draft',
        'Review of tutor or committee remarks',
        'Chapter review',
        'Methodological design and data analysis guidance',
        'Formatting to the academic standard',
        'Citation and similarity report review',
      ],
    },
    {
      id: 'style', section: 's2', type: 'radio', label: 'Academic format standard', system: true, other: true,
      help: 'Select the citation and presentation standard that applies to your document.',
      options: ['APA7', 'ISO 690', 'Vancouver', 'Chicago', 'Harvard'],
    },
    {
      id: 'pages', section: 's2', type: 'pages', label: 'Estimated length (approximate number of pages)', system: true,
      help: 'Example: 50-140 pages, or whatever your faculty regulations require.',
    },
    {
      id: 'deadline', section: 's2', type: 'date', label: 'Deadline or estimated delivery date', system: true, futureOnly: true,
      help: 'By what date do you need the draft or the final document?',
    },
    {
      id: 'guide', section: 's3', type: 'file', category: 'guide', label: 'Institutional guide, format or graduation regulations', system: true,
      help: 'Upload the structure guide of your university so we can match the formal requirements exactly. Allowed types: PDF, Word, PNG, JPG. Maximum 1 GB in total.',
    },
    {
      id: 'draft', section: 's3', type: 'file', category: 'draft', label: 'Current draft or document with remarks', system: true,
      help: 'If you already have something written, or the correction report from your tutor, attach it here. Allowed types: PDF, Word, PNG, JPG. Maximum 1 GB in total.',
    },
    {
      id: 'payment', section: 's3', type: 'file', category: 'payment', label: 'Proof of payment', system: true, required: false, enabled: false,
      help: 'Allowed types: PDF, PNG, JPG. Maximum 10 MB.',
    },
    {
      id: 'comments', section: 's3', type: 'textarea', label: 'Comments or additional requirements', system: true,
      help: 'Give any key detail about intermediate deliveries, tutor requirements, etc.',
    },
  ],
};

// Fixed columns of the sheet that are not questions.
const META_COLUMNS = [
  { key: '_timestamp', label: 'Timestamp' },
  { key: '_status', label: 'STATUS' },
  { key: '_detail', label: 'STATUS DETAIL' },
  { key: '_folder', label: 'User folder' },
  { key: '_requestId', label: 'Request ID' },
];

/** Error with a message that is safe to show to the user. */
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
// Web App entry points
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, data: { service: 'request-form' } });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, body.action)) {
      throw new UserError('Invalid action.');
    }
    return json_({ ok: true, data: ACTIONS[body.action](body) });
  } catch (err) {
    if (err instanceof UserError) {
      return json_({ ok: false, error: err.message, code: err.code });
    }
    console.error(err && err.stack ? err.stack : err);
    // RETRY: transient error, the client may try again.
    return json_({ ok: false, error: 'Temporary server error. Please try again.', code: 'RETRY' });
  }
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/** Active questions for the form. Does not include the notification emails. */
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
  if (body.website) throw new UserError('Request rejected.'); // anti-spam honeypot

  const config = getConfig_();
  const fullName = cleanName_(text_(body.fullName, 'First and last name', 120));
  const idNumber = idNumberValue_(body.idNumber);
  const idExt = choice_(body.idExt, questionById_(config, 'idExt').options, 'ID issuing department');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let userFolder;
  const folders = {};
  try {
    userFolder = findOrCreateUserFolder_(idNumber, idExt, fullName);
    Object.keys(SUBFOLDERS).forEach(function (category) {
      if (category === 'payment' && !questionById_(config, 'payment').enabled) return;
      folders[category] = getOrCreateChild_(userFolder, SUBFOLDERS[category]).getId();
    });
  } finally {
    lock.releaseLock();
  }

  const requestId = Utilities.getUuid();
  putCache_('req:' + requestId, {
    idNumber: idNumber,
    idExt: idExt,
    userFolderUrl: userFolder.getUrl(),
    folders: folders,
  });
  return { requestId: requestId, chunkSize: CHUNK_SIZE };
}

function startUpload(body) {
  const req = getRequest_(body.requestId);
  const category = String(body.category || '');
  const rule = ruleFor_(getConfig_(), category);
  if (!req.folders[category]) throw new UserError('Invalid file category.');

  const name = text_(body.name, 'File name', 200).replace(/[\\/\u0000-\u001f]/g, '_');
  const ext = extOf_(name);
  if (rule.extensions.indexOf(ext) === -1) {
    throw new UserError('File type not allowed: ' + name);
  }
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0 || size > rule.maxTotal) {
    throw new UserError('File size not allowed: ' + name);
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
    throw new Error('Drive did not open the upload session: ' + res.getResponseCode() + ' ' + res.getContentText());
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
    throw new UserError('Invalid file chunk.');
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

/** Asks Drive how many bytes it received, to resume after a network failure. */
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
    // Inside the lock so a double click cannot record two rows.
    // If the previous response was lost and the client retries, it is already recorded.
    if (CacheService.getScriptCache().get('done:' + body.requestId)) return { received: true };
    req = getRequest_(body.requestId);
    if (answers.idNumber !== req.idNumber || answers.idExt !== req.idExt) {
      throw new UserError('The ID details changed. Please submit the request again.', 'EXPIRED');
    }
    files = collectFiles_(config, body.requestId, body.uploads || {});

    const values = { _timestamp: new Date(), _status: 'PENDING', _detail: '', _folder: req.userFolderUrl, _requestId: body.requestId };
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
// Admin panel
// ---------------------------------------------------------------------------

function adminLogin(body) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('admin-fails') || 0);
  if (fails >= ADMIN_MAX_FAILS) throw new UserError('Too many failed attempts. Wait 15 minutes.');

  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('ADMIN_SALT');
  const hash = props.getProperty('ADMIN_PASSWORD_HASH');
  if (!salt || !hash) throw new Error('The panel password is missing. Run setup().');

  if (hashPassword_(String(body.password || ''), salt) !== hash) {
    cache.put('admin-fails', String(fails + 1), 15 * 60);
    throw new UserError('Wrong password.');
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
// Site photos
// ---------------------------------------------------------------------------

/** Public: returns {slot: url} only for the photos that were changed. */
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

/** Recognizes the format by its first bytes; neither the file name nor the type declared by the browser is trusted. */
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
    // It no longer exists: nothing to delete.
  }
}

function adminUploadImage(body) {
  requireAdmin_(body.token);
  const slot = String(body.slot || '');
  if (SITE_SLOTS.indexOf(slot) === -1) throw new UserError('That photo cannot be changed.');

  const bytes = Utilities.base64Decode(String(body.data || ''));
  if (!bytes.length || bytes.length > MAX_SITE_IMAGE) throw new UserError('The image must weigh less than 6 MB.');
  const kind = sniffImage_(bytes);
  if (!kind) throw new UserError('Use a JPG, PNG or WebP image.');

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
  if (SITE_SLOTS.indexOf(slot) === -1) throw new UserError('That photo cannot be changed.');
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
    throw new UserError('The current password is not correct.');
  }
  const next = String(body.next || '');
  if (next.length < 8) throw new UserError('The new password must have at least 8 characters.');
  setPassword_(next);
  return { ok: true };
}

function requireAdmin_(token) {
  if (!token || !CacheService.getScriptCache().get('admin:' + String(token))) {
    throw new UserError('Your session expired. Please sign in again.', 'AUTH');
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
 * Merges what the panel sends with the stored configuration.
 * Factory questions cannot be deleted and only change type within their family;
 * the locked ones also stay active and required.
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
    if (!isSystem && !/^q_[a-z0-9]{6,16}$/.test(id)) throw new UserError('Invalid question identifier.');

    // Factory questions can change type within their family (short answer <-> paragraph,
    // dropdown <-> single choice <-> checkboxes). Those that validate a specific datum or build the folder do not change.
    let type = String(raw.type || '');
    if (isSystem) {
      const family = prev.locked ? [prev.type] : typeFamily_(prev.type);
      type = family.indexOf(type) !== -1 ? type : prev.type;
    }
    if (!isSystem && CUSTOM_TYPES.indexOf(type) === -1) throw new UserError('Invalid question type.');

    const label = limit_(raw.label, 300);
    if (!label) throw new UserError('There is a question without text.');

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
        .filter(function (o, i, all) { return o && o !== 'Other' && all.indexOf(o) === i; })
        .slice(0, MAX_OPTIONS);
      if (!options.length) throw new UserError('The question "' + label + '" needs at least one option.');
      q.options = options;
      q.other = type !== 'select' && Boolean(raw.other);
    }
    seen[id] = true;
    questions.push(q);
  });

  // Factory questions cannot be deleted: if they are missing, they come back as they were.
  previous.questions.forEach(function (q) {
    if (q.system && !seen[q.id]) questions.push(q);
  });
  if (questions.length > MAX_QUESTIONS) throw new UserError('Maximum ' + MAX_QUESTIONS + ' questions.');

  const emails = (Array.isArray(incoming.notifyEmails) ? incoming.notifyEmails : [])
    .map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(function (e, i, all) { return e && all.indexOf(e) === i; });
  emails.forEach(function (e) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new UserError('Invalid email: ' + e);
  });
  if (!emails.length) throw new UserError('Add at least one notification email.');
  if (emails.length > 10) throw new UserError('Maximum 10 notification emails.');

  return { version: previous.version || CONFIG_VERSION, notifyEmails: emails, sections: sections, questions: questions, columns: previous.columns };
}

/** Gives a column to each new question and keeps the headers up to date. */
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

/** Notification emails can open the files: they get access to the main folder. */
function syncFolderEditors_(before, after) {
  const root = DriveApp.getFolderById(requiredProp_('ROOT_FOLDER_ID'));
  const owner = Session.getEffectiveUser().getEmail().toLowerCase();
  after.filter(function (e) { return before.indexOf(e) === -1 && e !== owner; }).forEach(function (e) {
    try { root.addEditor(e); } catch (err) { console.error('Could not share with ' + e + ': ' + err); }
  });
  before.filter(function (e) { return after.indexOf(e) === -1 && e !== owner; }).forEach(function (e) {
    try { root.removeEditor(e); } catch (err) { console.error('Could not remove ' + e + ': ' + err); }
  });
}

// ---------------------------------------------------------------------------
// Stored configuration
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
 * Brings the stored factory questions up to date when CONFIG_VERSION changes.
 * It only touches text, type, options and help of the listed questions; it keeps whether
 * they are active, whether they are required, their section and their order.
 */
const MIGRATED_IDS = ['level', 'workType', 'language', 'university', 'topicStatus', 'title', 'city', 'service', 'style'];

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
  // Columns in the same order as the questions, with the fixed ones at the end.
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
// Initial setup (run once by hand from the editor)
// ---------------------------------------------------------------------------

/**
 * Creates the main folder, the spreadsheet, the configuration and the panel password
 * if they do not exist. To use an existing folder or spreadsheet, define
 * ROOT_FOLDER_ID or SPREADSHEET_ID in the script properties first.
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
    // A newly created spreadsheet comes with a default empty tab that is not needed.
    spreadsheet.getSheets().forEach(function (s) {
      if (s.getName() !== SHEET_NAME && s.getName() !== CONFIG_SHEET_NAME && s.getLastRow() === 0) spreadsheet.deleteSheet(s);
    });
  }

  CacheService.getScriptCache().remove(CONFIG_CACHE_KEY);
  const configSheet = getConfigSheet_();
  if (!configSheet.getRange('A1').getValue()) saveConfig_(buildDefaultConfig_());
  const config = getConfig_();

  // New sheet: headers and frozen rows. Existing sheet: only the missing headers are
  // filled in, without touching the data or the headers it already has.
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
    console.log('Initial admin panel password (change it after signing in): ' + password);
  }

  console.log('Main folder: ' + DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID')).getUrl());
  console.log('Responses sheet: ' + spreadsheet.getUrl());
  console.log('Notifications to: ' + config.notifyEmails.join(', '));
}

/** In case the password is forgotten: run it from the editor and read the log. */
function resetAdminPassword() {
  const password = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  setPassword_(password);
  console.log('New admin panel password: ' + password);
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

function findOrCreateUserFolder_(idNumber, idExt, fullName) {
  const props = PropertiesService.getScriptProperties();
  const key = 'user:' + idNumber + '-' + idExt;
  const prefix = idNumber + '-' + idExt + '-';

  const savedId = props.getProperty(key);
  if (savedId) {
    try {
      const saved = DriveApp.getFolderById(savedId);
      if (!saved.isTrashed()) return saved;
    } catch (err) {
      // The folder was deleted: look for another one or create it.
    }
  }

  // No record (e.g. after migrating accounts): look it up by name before creating.
  const root = getRootFolder_();
  const it = root.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    if (folder.getName().indexOf(prefix) === 0) {
      props.setProperty(key, folder.getId());
      return folder;
    }
  }

  const created = root.createFolder(prefix + initials_(fullName));
  props.setProperty(key, created.getId());
  return created;
}

/** Initials of the name without accents, e.g. "Juan Carlos Perez Mamani" -> "JCPM" (maximum 4). */
function initials_(fullName) {
  const letters = String(fullName || '')
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
    throw new UserError('The upload of "' + up.name + '" was interrupted. Please try again.');
  }
  throw new Error('Drive responded ' + code + ': ' + res.getContentText());
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
      if (ids.length) throw new UserError('The field "' + q.label + '" is not enabled.');
      result[category] = [];
      return;
    }
    if (q.required && !ids.length) {
      throw new UserError('Missing upload: ' + q.label + '.');
    }
    if (ids.length > rule.maxFiles) {
      throw new UserError('Too many files in: ' + q.label + '.');
    }

    const cached = ids.length ? cache.getAll(ids.map(function (id) { return 'up:' + id; })) : {};
    let total = 0;
    result[category] = ids.map(function (id) {
      const raw = cached['up:' + id];
      const up = raw ? JSON.parse(raw) : null;
      if (!up || up.requestId !== requestId || up.category !== category || !up.fileId) {
        throw new UserError('A file did not finish uploading. Please submit the request again.', 'EXPIRED');
      }
      total += up.size;
      return up;
    });
    if (total > rule.maxTotal) {
      throw new UserError('The maximum size was exceeded in: ' + q.label + '.');
    }
  });
  return result;
}

/** dd/mm/yyyy -> real date, so the sheet can sort and filter by deadline. */
function dateValue_(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text || ''));
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : text;
}

function links_(uploads) {
  return (uploads || []).map(function (up) { return up.link; }).join(', ');
}

// ---------------------------------------------------------------------------
// Sheet and email
// ---------------------------------------------------------------------------

function getResponsesSheet_() {
  const sheet = SpreadsheetApp.openById(requiredProp_('SPREADSHEET_ID')).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('The tab "' + SHEET_NAME + '" does not exist. Run setup().');
  return sheet;
}

/**
 * Writes each value in the column that corresponds to it according to the configuration.
 * It does not touch cell formats: in new sheets the columns are born as text (setup),
 * and in a Sheets table the type of each column is defined by the table.
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
  // If the sheet silently discards the write, fail the submission instead of accepting an empty record.
  if (sheet.getRange(target, 1).getValue() === '') {
    throw new Error('Row ' + target + ' of "' + sheet.getName() + '" was empty after writing it.');
  }
}

/** Plain-text columns so that ID and phone numbers are not turned into numbers. A table with its own column types rejects it: it is ignored. */
function setTextColumns_(sheet, fromCol, toCol) {
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  try {
    sheet.getRange(2, fromCol, rows, toCol - fromCol + 1).setNumberFormat('@');
    SpreadsheetApp.flush();
  } catch (err) {
    console.log('Text format skipped in columns ' + fromCol + '-' + toCol + ': ' + err.message);
  }
}

/** Prevents user text from being interpreted as a formula. */
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
      if (count) rows.push([q.label, count + (count === 1 ? ' file' : ' files')]);
      return;
    }
    if (answers[q.id] !== '' && answers[q.id] !== undefined) rows.push([q.label, answers[q.id]]);
  });

  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + requiredProp_('SPREADSHEET_ID');
  const html =
    '<p>A new request arrived from the web form.</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
    rows.map(function (r) {
      return '<tr><td style="border:1px solid #ddd;font-weight:bold">' + escapeHtml_(r[0]) +
        '</td><td style="border:1px solid #ddd">' + escapeHtml_(String(r[1])) + '</td></tr>';
    }).join('') +
    '</table>' +
    '<p><a href="' + req.userFolderUrl + '">Open user folder</a> · ' +
    '<a href="' + sheetUrl + '">Open responses sheet</a></p>';

  try {
    MailApp.sendEmail({
      to: to,
      subject: 'New request: ' + answers.fullName + ' (' + answers.idNumber + '-' + answers.idExt + ')',
      htmlBody: html,
      name: 'Request form',
    });
  } catch (err) {
    // The request is already recorded; an email failure must not cancel it.
    console.error('Could not send the notification: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Validation
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
    if (q.required) throw new UserError('Missing: ' + q.label + '.');
    return '';
  }
  const choices = (q.options || []).concat(q.other ? ['Other'] : []);
  switch (q.type) {
    case 'text': {
      const v = text_(value, q.label, q.id === 'fullName' ? 120 : 200).replace(/\s+/g, ' ');
      return q.id === 'fullName' ? titleCase_(v) : canonicalSuggestion_(q, v);
    }
    case 'place': return place_(value, q);
    case 'textarea': return text_(value, q.label, 3000);
    case 'tel': return phone_(value, q.label);
    case 'idnumber': return idNumberValue_(value);
    case 'number': {
      const n = Number(value);
      if (!isFinite(n)) throw new UserError(q.label + ' must be a number.');
      return n;
    }
    case 'pages': return pages_(value);
    case 'date': return date_(value, q);
    case 'select':
    case 'radio': return choice_(value, choices, q.label);
    case 'checkbox': return multi_(value, choices, q.label);
  }
  throw new UserError('Invalid question: ' + q.label);
}

/** Names: capital initial in every word; Spanish particles (de, del, la...) stay lowercase. Edit the list for your languages. */
function titleCase_(text) {
  const small = ['de', 'del', 'la', 'las', 'los', 'y', 'e'];
  return String(text).trim().replace(/\s+/g, ' ').split(' ').map(function (word, i) {
    return word.split('-').map(function (part) {
      const lower = part.toLowerCase();
      return i > 0 && small.indexOf(lower) !== -1 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join('-');
  }).join(' ');
}

/** If what was typed matches a suggestion (ignoring case), it is saved with the spelling of the list. */
function canonicalSuggestion_(q, value) {
  const list = SUGGESTIONS[q.suggest] || [];
  const key = value.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    if (list[i].toLowerCase() === key) return list[i];
  }
  return value;
}

/**
 * Phone numbers always come out as +<country code><number>. A number typed with a leading "+" is kept as it is;
 * a local number (6 to 10 digits) gets PHONE_COUNTRY_CODE in front. Change the constant for your country.
 */
function phone_(value, label) {
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.charAt(0) === '+' && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (/^\d{6,10}$/.test(digits)) return '+' + PHONE_COUNTRY_CODE + digits;
  throw new UserError(label + ': type your number with the country code (for example +15551234567) or the local number only.');
}

/** City and country: only letters, spaces, comma, period, hyphen and apostrophe. */
function place_(value, q) {
  const v = text_(value, q.label, 80).replace(/\s+/g, ' ');
  if (!/^\p{L}[\p{L} .,'’-]{1,79}$/u.test(v)) throw new UserError(q.label + ': use letters only, no numbers.');
  return canonicalSuggestion_(q, titleCase_(v).replace(/(^|, )([a-záéíóúñ])/g, function (m, a, b) { return a + b.toUpperCase(); }));
}

function text_(value, label, maxLength) {
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new UserError('Missing: ' + label + '.');
  if (v.length > maxLength) throw new UserError(label + ' is too long.');
  return v;
}

function match_(value, regex, label) {
  if (!value) throw new UserError('Missing: ' + label + '.');
  if (!regex.test(value)) throw new UserError(label + ' is not valid.');
  return value;
}

function idNumberValue_(value) {
  return match_(String(value || '').trim().toUpperCase(), /^[0-9A-Z-]{4,15}$/, 'ID number');
}

/** Accepts an option from the list or "Other: <text>" if the list includes "Other". */
function choice_(value, list, label) {
  const v = String(value || '').trim();
  if (!v) throw new UserError('Missing: ' + label + '.');
  if (v !== 'Other' && (list || []).indexOf(v) !== -1) return v;
  if ((list || []).indexOf('Other') !== -1 && /^Other: \S/.test(v) && v.length <= 200) return v;
  throw new UserError('Invalid option in ' + label + '.');
}

function multi_(values, list, label) {
  if (!Array.isArray(values) || !values.length) throw new UserError('Missing: ' + label + '.');
  if (values.length > list.length) throw new UserError('Invalid option in ' + label + '.');
  return values.map(function (v) { return choice_(v, list, label); }).join(', ');
}

/** Accepts a number of pages or a range, e.g. "80" or "50-140". */
function pages_(value) {
  const v = String(value || '').replace(/\s+/g, '');
  if (!/^\d{1,4}(-\d{1,4})?$/.test(v)) {
    throw new UserError('The estimated length must be a number or a range of pages, e.g. 50-140.');
  }
  return v;
}

/** Receives yyyy-mm-dd and returns dd/mm/yyyy. */
function date_(value, q) {
  const v = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UserError('Invalid date in: ' + q.label + '.');
  if (q.futureOnly && v < Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd')) {
    throw new UserError(q.label + ': the date cannot be earlier than today.');
  }
  return v.split('-').reverse().join('/');
}

function cleanName_(value) {
  return value.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function ruleFor_(config, category) {
  const q = config.questions.filter(function (x) { return x.type === 'file' && x.category === category; })[0];
  if (!q || !q.enabled || !Object.prototype.hasOwnProperty.call(FILE_RULES, category)) {
    throw new UserError('Invalid file category.');
  }
  return FILE_RULES[category];
}

/**
 * The content must match the declared extension (an .exe renamed to .pdf does not pass).
 * Only the first chunk is checked: it holds the header bytes of each format.
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
  if (!ok || !ok()) throw new UserError('The file "' + name + '" is not a valid ' + ext.toUpperCase() + '. Check that it is not damaged.');
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
  if (!raw) throw new UserError('The session expired. Please submit the request again.', 'EXPIRED');
  return JSON.parse(raw);
}

function getUpload_(uploadId) {
  const raw = CacheService.getScriptCache().get('up:' + String(uploadId || ''));
  if (!raw) throw new UserError('The upload expired. Please submit the request again.', 'EXPIRED');
  return JSON.parse(raw);
}

function putCache_(key, value) {
  CacheService.getScriptCache().put(key, JSON.stringify(value), CACHE_TTL);
}

function requiredProp_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('The property ' + name + ' is missing. Run setup().');
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
