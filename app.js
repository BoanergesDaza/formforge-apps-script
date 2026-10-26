/**
 * Example Academy - request form.
 *
 * Sections and questions come from the Web App (they are defined in the admin panel).
 * It validates step by step, uploads each file in chunks and finally records the request.
 */
(function () {
  'use strict';

  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  const CONFIG = {
    SCRIPT_URL: window.APP_CONFIG.SCRIPT_URL,
    MAX_RETRIES: 4,
    PARALLEL_UPLOADS: 3,
    REQUEST_TIMEOUT_MS: 120000,
  };

  const state = {
    step: 1,
    sections: [],
    questions: [],
    fileRules: {},
    suggestions: {},
    files: {}, // category -> File[]
    // Kept between retries so that what was already uploaded is not uploaded again.
    requestId: null,
    requestKey: null,
    chunkSize: 0,
    uploaded: new Map(), // File -> uploadId
    busy: false,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const form = $('#request-form');

  class ApiError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code || 'INVALID';
    }
  }

  // -------------------------------------------------------------------------
  // Building the form from the configuration
  // -------------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'className') node.className = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  /** Suggestion lists (universities, cities) for the text fields that ask for them. */
  function buildSuggestions() {
    Object.keys(state.suggestions).forEach(function (name) {
      if (document.getElementById('dl-' + name)) return;
      const list = el('datalist', { id: 'dl-' + name }, state.suggestions[name].map((v) => el('option', { value: v })));
      form.appendChild(list);
    });
  }

  function buildForm() {
    const stepper = $('.stepper');
    const steps = $('#steps');
    stepper.textContent = '';
    steps.textContent = '';

    state.sections.forEach(function (section, i) {
      const n = i + 1;
      stepper.appendChild(el('li', { 'data-step-indicator': n }, [
        el('span', { className: 'num', text: String(n) }),
        el('span', { className: 'txt', text: section.title }),
      ]));
      const sectionEl = el('section', { className: 'step card', 'data-step': n, hidden: n !== 1 }, [
        el('h2', { text: section.title }),
      ]);
      state.questions.filter((q) => q.section === section.id).forEach((q) => sectionEl.appendChild(buildField(q)));
      steps.appendChild(sectionEl);
    });
  }

  function buildField(q) {
    const id = 'f-' + q.id;
    const optional = !q.required;
    const labelChildren = [document.createTextNode(q.label)];
    if (optional) labelChildren.push(el('span', { className: 'opt', text: ' (optional)' }));
    const hint = q.help ? el('p', { className: 'hint', id: id + '-hint', text: q.help }) : null;
    const error = el('p', { className: 'error', 'aria-live': 'polite' });

    if (q.type === 'radio' || q.type === 'checkbox') {
      const box = el('div', { className: 'choices' });
      q.options.concat(q.other ? ['Other'] : []).forEach(function (opt, i) {
        box.appendChild(el('label', { className: 'choice' }, [
          el('input', { type: q.type, name: q.id, value: opt, id: id + '-' + i }),
          el('span', { text: opt }),
        ]));
      });
      if (q.other) {
        box.appendChild(el('input', {
          type: 'text', className: 'other-input', maxlength: 190, placeholder: 'Please specify',
          'aria-label': 'Specify the Other option', hidden: true,
        }));
      }
      return el('fieldset', fieldAttrs(q, q.type), [el('legend', {}, labelChildren), hint, box, error]);
    }

    if (q.type === 'file') {
      const rule = state.fileRules[q.category];
      state.files[q.category] = [];
      const input = el('input', {
        type: 'file', multiple: rule.maxFiles > 1, 'data-category': q.category,
        accept: rule.extensions.map((e) => '.' + e).join(','), 'aria-describedby': hint ? id + '-hint' : false,
      });
      const drop = el('label', { className: 'drop' }, [
        input,
        el('span', { text: rule.maxFiles > 1 ? 'Tap to choose files or drag them here' : 'Tap to choose a file or drag it here' }),
      ]);
      return el('div', fieldAttrs(q, 'files'), [
        el('span', { className: 'label' }, labelChildren), hint, drop, el('ul', { className: 'file-list' }), error,
      ]);
    }

    let control;
    let kind = 'text';
    const extra = {};
    const describedBy = hint ? id + '-hint' : false;
    switch (q.type) {
      case 'textarea':
        control = el('textarea', { id: id, rows: 3, maxlength: 3000, 'aria-describedby': describedBy });
        break;
      case 'select':
        control = el('select', { id: id, 'aria-describedby': describedBy }, [el('option', { value: '', text: 'Choose' })]
          .concat(q.options.map((o) => el('option', { value: o, text: o }))));
        kind = 'select';
        break;
      case 'date':
        control = el('input', { id: id, type: 'date', min: q.futureOnly ? todayISO() : false, 'aria-describedby': describedBy });
        kind = 'date';
        if (q.futureOnly) extra['data-future'] = true;
        break;
      case 'number':
        control = el('input', { id: id, type: 'number', inputmode: 'decimal', step: 'any', 'aria-describedby': describedBy });
        kind = 'number';
        break;
      case 'tel':
        control = el('input', { id: id, type: 'tel', inputmode: 'tel', autocomplete: 'tel', maxlength: 20, placeholder: 'E.g. +15551234567', 'aria-describedby': describedBy });
        Object.assign(extra, {
          'data-normalize': 'phone',
          'data-pattern': '^(\\+\\d{8,15}|\\d{6,10})$',
          'data-msg': 'Type your number with the country code (for example +15551234567) or the local number only.',
        });
        break;
      case 'idnumber':
        control = el('input', { id: id, type: 'text', inputmode: 'numeric', maxlength: 15, 'aria-describedby': describedBy });
        Object.assign(extra, { 'data-normalize': 'upper', 'data-pattern': '^[0-9A-Z-]{4,15}$', 'data-msg': 'Enter a valid ID number: digits, letters or hyphen.' });
        break;
      case 'pages':
        control = el('input', { id: id, type: 'text', inputmode: 'numeric', maxlength: 15, placeholder: 'E.g. 80 or 50-140', 'aria-describedby': describedBy });
        Object.assign(extra, { 'data-normalize': 'nospace', 'data-pattern': '^\\d{1,4}(-\\d{1,4})?$', 'data-msg': 'Type a number or a range of pages, e.g. 80 or 50-140.' });
        break;
      case 'place':
        control = el('input', {
          id: id, type: 'text', maxlength: 80, autocomplete: 'off', placeholder: 'E.g. Santa Cruz de la Sierra, Bolivia',
          list: q.suggest ? 'dl-' + q.suggest : false, 'aria-describedby': describedBy,
        });
        Object.assign(extra, {
          'data-normalize': 'place',
          'data-pattern': "^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .,'’-]{1,79}$",
          'data-msg': 'Use letters only, no numbers.',
        });
        break;
      default:
        control = el('input', {
          id: id, type: 'text', maxlength: q.id === 'fullName' ? 120 : 200,
          autocomplete: q.id === 'fullName' ? 'name' : false,
          list: q.suggest ? 'dl-' + q.suggest : false, 'aria-describedby': describedBy,
        });
    }
    return el('div', Object.assign(fieldAttrs(q, kind), extra), [el('label', { for: id }, labelChildren), hint, control, error]);
  }

  function fieldAttrs(q, kind) {
    return { className: 'field', 'data-field': q.id, 'data-kind': kind, 'data-optional': !q.required };
  }

  function setupFileFields() {
    $$('input[type=file][data-category]').forEach(function (input) {
      const category = input.dataset.category;
      input.addEventListener('change', function () {
        addFiles(category, input.files);
        input.value = '';
      });

      const drop = input.closest('.drop');
      drop.addEventListener('dragover', function (e) {
        e.preventDefault();
        drop.classList.add('is-over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('is-over');
        addFiles(category, e.dataTransfer.files);
      });
    });
  }

  function fileField(category) {
    return $('input[data-category="' + category + '"]').closest('.field');
  }

  function addFiles(category, fileList) {
    const rule = state.fileRules[category];
    const list = state.files[category];
    const errors = [];
    Array.from(fileList).forEach(function (file) {
      if (rule.extensions.indexOf(extOf(file.name)) === -1) {
        errors.push(file.name + ': file type not allowed.');
      } else if (file.size === 0) {
        errors.push(file.name + ': the file is empty.');
      } else if (list.length >= rule.maxFiles) {
        errors.push('Maximum ' + rule.maxFiles + (rule.maxFiles === 1 ? ' file.' : ' files.'));
      } else if (totalSize(list) + file.size > rule.maxTotal) {
        errors.push(file.name + ': exceeds the limit of ' + formatBytes(rule.maxTotal) + ' in total.');
      } else {
        list.push(file);
      }
    });
    renderFileList(category);
    setError(fileField(category), errors.join(' '));
  }

  function renderFileList(category) {
    const ul = $('.file-list', fileField(category));
    ul.textContent = '';
    state.files[category].forEach(function (file, i) {
      const remove = el('button', { type: 'button', className: 'remove', text: 'Remove', 'aria-label': 'Remove ' + file.name });
      remove.addEventListener('click', function () {
        state.files[category].splice(i, 1);
        renderFileList(category);
      });
      ul.appendChild(el('li', {}, [
        el('span', { className: 'name', text: file.name }),
        el('span', { className: 'size', text: formatBytes(file.size) }),
        remove,
      ]));
    });
  }

  // -------------------------------------------------------------------------
  // Values and validation
  // -------------------------------------------------------------------------

  function fieldValue(field) {
    const kind = field.dataset.kind;
    if (kind === 'files') return state.files[$('input[type=file]', field).dataset.category];
    if (kind === 'radio') {
      const checked = $('input[type=radio]:checked', field);
      return checked ? withOther(field, checked.value) : '';
    }
    if (kind === 'checkbox') {
      return $$('input[type=checkbox]:checked', field).map((c) => withOther(field, c.value));
    }
    const value = $('input, textarea, select', field).value.trim();
    if (field.dataset.normalize === 'phone') return value.replace(/[\s-]/g, '');
    if (field.dataset.normalize === 'upper') return value.toUpperCase();
    if (field.dataset.normalize === 'nospace') return value.replace(/\s+/g, '');
    if (field.dataset.normalize === 'place') return value.replace(/\s+/g, ' ');
    return value;
  }

  /** "Other" is sent as "Other: <text>"; empty if the text is missing. */
  function withOther(field, value) {
    if (value !== 'Other') return value;
    const text = $('.other-input', field).value.trim();
    return text ? 'Other: ' + text : '';
  }

  function validateField(field) {
    const kind = field.dataset.kind;
    const value = fieldValue(field);
    const optional = field.hasAttribute('data-optional');
    const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
    const otherPicked = Boolean($('input[value="Other"]:checked', field));

    if (isEmpty) {
      if (kind === 'radio' && otherPicked) return 'Specify the "Other" option.';
      if (optional) return '';
      if (kind === 'files') return 'Upload at least one file.';
      if (kind === 'checkbox' || kind === 'radio' || kind === 'select') return 'Select an option.';
      return 'This field is required.';
    }
    if (kind === 'checkbox' && value.indexOf('') !== -1) return 'Specify the "Other" option.';
    if (field.dataset.pattern && !new RegExp(field.dataset.pattern).test(value)) return field.dataset.msg;
    if (kind === 'number' && !isFinite(Number(value))) return 'Type a number.';
    if (kind === 'date' && field.dataset.future !== undefined && value < todayISO()) return 'The date cannot be earlier than today.';
    return '';
  }

  function setError(field, message) {
    $('.error', field).textContent = message;
    field.classList.toggle('has-error', Boolean(message));
  }

  /** Validates the fields of a section and, if focus is set, focuses the first one with an error. */
  function validateStep(step, focus = true) {
    let firstInvalid = null;
    $$('.step[data-step="' + step + '"] .field').forEach(function (field) {
      const message = validateField(field);
      setError(field, message);
      if (message && !firstInvalid) firstInvalid = field;
    });
    if (firstInvalid && focus) {
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const focusable = $('input:not([type=file]):not([hidden]), textarea, select', firstInvalid);
      if (focusable) focusable.focus({ preventScroll: true });
    }
    return !firstInvalid;
  }

  function collectAnswers() {
    const answers = {};
    $$('.field').forEach(function (field) {
      if (field.dataset.kind !== 'files') answers[field.dataset.field] = fieldValue(field);
    });
    return answers;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  function totalSteps() {
    return state.sections.length;
  }

  function showStep(step) {
    state.step = step;
    $$('.step').forEach((s) => { s.hidden = Number(s.dataset.step) !== step; });
    $$('[data-step-indicator]').forEach(function (li) {
      const n = Number(li.dataset.stepIndicator);
      li.classList.toggle('is-active', n === step);
      li.classList.toggle('is-done', n < step);
    });
    $('#btn-back').hidden = step === 1;
    $('#btn-next').hidden = step === totalSteps();
    $('#btn-submit').hidden = step !== totalSteps();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showPanel(id) {
    form.hidden = id !== 'form';
    $('.stepper').hidden = id !== 'form';
    ['loading', 'progress', 'failed', 'done'].forEach((p) => { $('#' + p).hidden = p !== id; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  async function send() {
    if (state.busy) return;
    state.busy = true;
    showPanel('progress');
    setProgress(0, 'Preparing your folder...', '');

    const answers = collectAnswers();
    const key = answers.idNumber + '-' + answers.idExt + '-' + answers.fullName;
    // If the ID or the name changed after a failed attempt, start from scratch.
    if (state.requestKey !== key) resetRequest();

    try {
      if (!state.requestId) {
        const init = await withRetry(() => api('initRequest', {
          fullName: answers.fullName,
          idNumber: answers.idNumber,
          idExt: answers.idExt,
          website: $('#f-website').value,
        }));
        state.requestId = init.requestId;
        state.chunkSize = init.chunkSize;
        state.requestKey = key;
      }

      const queue = [];
      Object.keys(state.files).forEach(function (category) {
        state.files[category].forEach((file) => queue.push({ category, file }));
      });
      const totalBytes = queue.reduce((sum, item) => sum + item.file.size, 0) || 1;
      let doneBytes = queue.reduce((sum, item) => sum + (state.uploaded.has(item.file) ? item.file.size : 0), 0);
      const pending = queue.filter((item) => !state.uploaded.has(item.file));
      const inFlight = new Map();
      const reportProgress = function () {
        let sent = 0;
        inFlight.forEach((bytes) => { sent += bytes; });
        const filesDone = queue.filter((item) => state.uploaded.has(item.file)).length;
        setProgress((doneBytes + sent) / totalBytes, 'Uploading documents...', filesDone + ' of ' + queue.length + ' files ready');
      };

      // Several files at once: every call to Apps Script has a fixed latency of a few seconds.
      let nextIndex = 0;
      const worker = async function () {
        while (nextIndex < pending.length) {
          const { category, file } = pending[nextIndex++];
          inFlight.set(file, 0);
          try {
            const uploadId = await uploadFile(category, file, function (sent) {
              inFlight.set(file, sent);
              reportProgress();
            });
            state.uploaded.set(file, uploadId);
            doneBytes += file.size;
          } finally {
            inFlight.delete(file);
          }
          reportProgress();
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(CONFIG.PARALLEL_UPLOADS, pending.length) }, worker)
      );
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;

      setProgress(1, 'Recording your request...', '');
      const uploads = {};
      Object.keys(state.files).forEach(function (category) {
        uploads[category] = state.files[category].map((file) => state.uploaded.get(file));
      });
      await withRetry(() => api('submit', { requestId: state.requestId, answers, uploads }));

      resetRequest();
      showPanel('done');
    } catch (err) {
      if (err.code === 'EXPIRED') resetRequest();
      $('#failed-text').textContent = err.message || 'An unexpected error occurred.';
      showPanel('failed');
    } finally {
      state.busy = false;
    }
  }

  async function uploadFile(category, file, onProgress) {
    const { uploadId } = await withRetry(() => api('startUpload', {
      requestId: state.requestId,
      category,
      name: file.name,
      size: file.size,
    }));

    let offset = 0;
    let failures = 0;
    while (offset < file.size) {
      try {
        const data = await readBase64(file.slice(offset, offset + state.chunkSize));
        const r = await api('uploadChunk', { uploadId, offset, data });
        if (!r.done && r.next <= offset) throw new ApiError('Drive did not accept the chunk.', 'RETRY');
        offset = r.done ? file.size : r.next;
        failures = 0;
      } catch (err) {
        if (err.code !== 'RETRY' || ++failures > CONFIG.MAX_RETRIES) throw err;
        await sleep(1000 * 2 ** failures);
        // Ask Drive how many bytes arrived before retrying.
        const status = await api('uploadStatus', { uploadId }).catch(() => null);
        if (status) offset = status.done ? file.size : status.next;
      }
      onProgress(offset);
    }
    return uploadId;
  }

  async function api(action, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    let res;
    try {
      // text/plain avoids the CORS preflight request, which Apps Script does not answer.
      res = await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload)),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApiError('Cannot reach the server. Check your internet connection.', 'RETRY');
    } finally {
      clearTimeout(timer);
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new ApiError('The server answered with an error. Please try again.', 'RETRY');
    }
    if (!json.ok) throw new ApiError(json.error, json.code);
    return json.data;
  }

  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err.code !== 'RETRY' || attempt >= CONFIG.MAX_RETRIES) throw err;
        await sleep(1000 * 2 ** (attempt + 1));
      }
    }
  }

  function resetRequest() {
    state.requestId = null;
    state.requestKey = null;
    state.uploaded.clear();
  }

  function setProgress(ratio, title, detail) {
    const pct = Math.min(100, Math.round(ratio * 100));
    $('#progress-text').textContent = title + ' ' + pct + '%';
    $('#progress-detail').textContent = detail;
    $('#progress-bar').style.width = pct + '%';
    $('.bar').setAttribute('aria-valuenow', String(pct));
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  function readBase64(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new ApiError('The file could not be read.', 'INVALID'));
      reader.readAsDataURL(blob);
    });
  }

  function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  }

  function totalSize(files) {
    return files.reduce((sum, f) => sum + f.size, 0);
  }

  function formatBytes(bytes) {
    if (bytes >= GB) return (bytes / GB).toFixed(1).replace('.0', '') + ' GB';
    if (bytes >= MB) return (bytes / MB).toFixed(1).replace('.0', '') + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async function start() {
    $('#loading-text').textContent = 'Loading the form...';
    $('#loading-actions').hidden = true;
    try {
      const config = await withRetry(() => api('getConfig', {}));
      state.sections = config.sections.filter((s) => config.questions.some((q) => q.section === s.id));
      state.questions = config.questions;
      state.fileRules = config.fileRules;
      state.suggestions = config.suggestions || {};
      state.files = {};
      buildForm();
      buildSuggestions();
      setupFileFields();
      showPanel('form');
      showStep(1);
    } catch (err) {
      $('#loading-text').textContent = 'The form could not be loaded. ' + (err.message || '');
      $('#loading-actions').hidden = false;
    }
  }

  // Clears the error when corrected; shows the "Other" field when it applies.
  form.addEventListener('input', function (e) {
    const field = e.target.closest('.field');
    if (!field) return;
    if (e.target.type === 'radio' || e.target.type === 'checkbox') {
      const other = $('.other-input', field);
      if (other) {
        const show = Boolean($('input[value="Other"]:checked', field));
        other.hidden = !show;
        if (show && e.target.value === 'Other') other.focus();
      }
    }
    if (field.classList.contains('has-error')) setError(field, '');
  });

  $('#btn-next').addEventListener('click', function () {
    if (validateStep(state.step)) showStep(state.step + 1);
  });
  $('#btn-back').addEventListener('click', () => showStep(state.step - 1));
  // City and country: numbers cannot be typed.
  form.addEventListener('input', function (e) {
    if (e.target.closest && e.target.closest('[data-normalize="place"]')) {
      e.target.value = e.target.value.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ .,'’-]/g, '');
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    for (let s = 1; s <= totalSteps(); s++) {
      if (!validateStep(s, false)) {
        showStep(s);
        validateStep(s);
        return;
      }
    }
    send();
  });
  $('#btn-retry').addEventListener('click', send);
  $('#btn-edit').addEventListener('click', () => showPanel('form'));
  $('#btn-new').addEventListener('click', () => window.location.reload());
  $('#btn-reload').addEventListener('click', start);

  window.addEventListener('beforeunload', function (e) {
    if (state.busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  start();
})();
