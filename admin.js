/**
 * Example Academy - admin panel.
 * Edits the notification emails and the form questions. Everything is saved in the Web App.
 */
(function () {
  'use strict';

  const SCRIPT_URL = window.APP_CONFIG.SCRIPT_URL;

  const TYPE_LABELS = {
    text: 'Short answer',
    textarea: 'Paragraph',
    number: 'Number',
    date: 'Date',
    select: 'Dropdown',
    radio: 'Single choice',
    checkbox: 'Checkboxes (several options)',
    tel: 'Mobile phone',
    place: 'City and country (letters only)',
    idnumber: 'ID number',
    pages: 'Number of pages',
    file: 'File upload',
  };
  const CHOICE_TYPES = ['select', 'radio', 'checkbox'];

  const state = {
    token: null,
    config: null,
    customTypes: [],
    typeFamilies: [],
    slots: [], // editable photos, read from index.html
    images: {}, // photos already changed: slot -> url
    active: null, // the question being edited now (one at a time, like in Google Forms)
    dirty: false,
    saving: false,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  function saveToken(token) {
    state.token = token;
    try {
      if (token) sessionStorage.setItem('form-admin', token);
      else sessionStorage.removeItem('form-admin');
    } catch (err) {
      // No storage: the session lasts as long as the tab.
    }
  }

  function loadToken() {
    try {
      return sessionStorage.getItem('form-admin');
    } catch (err) {
      return null;
    }
  }

  async function api(action, payload) {
    let res;
    try {
      res = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: state.token }, payload)),
      });
    } catch (err) {
      throw new Error('Cannot reach the server.');
    }
    const json = await res.json().catch(() => ({ ok: false, error: 'Invalid response from the server.' }));
    if (!json.ok) {
      if (json.code === 'AUTH') showLogin('Your session expired. Please sign in again.');
      const error = new Error(json.error);
      error.code = json.code;
      throw error;
    }
    return json.data;
  }

  function showLogin(message) {
    saveToken(null);
    $('#login').hidden = false;
    $('#panel').hidden = true;
    $('#save-bar').hidden = true;
    $('#btn-logout').hidden = true;
    $('#login-error').textContent = message || '';
  }

  async function openPanel() {
    const data = await api('adminGetConfig', {});
    state.config = data.config;
    state.customTypes = data.customTypes;
    state.typeFamilies = data.typeFamilies || [];
    $('#link-sheet').href = data.spreadsheetUrl;
    $('#link-folder').href = data.rootFolderUrl;
    state.images = data.images || {};
    await loadSlots();
    renderImages();
    $('#a-emails').value = state.config.notifyEmails.join('\n');
    $('#login').hidden = true;
    $('#panel').hidden = false;
    $('#save-bar').hidden = false;
    $('#btn-logout').hidden = false;
    setDirty(false);
    render();
  }

  // -------------------------------------------------------------------------
  // Site photos
  // -------------------------------------------------------------------------

  /** The photos and their names come from index.html: adding a data-slot there adds it to the panel. */
  async function loadSlots() {
    try {
      const res = await fetch('index.html', { cache: 'no-cache' });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      state.slots = Array.from(doc.querySelectorAll('img[data-slot]')).map((img) => ({
        slot: img.dataset.slot, label: img.dataset.slotLabel || img.dataset.slot, fallback: img.getAttribute('src'),
      }));
    } catch (err) {
      state.slots = [];
    }
  }

  function imageMessage(text, isError) {
    const node = $('#images-msg');
    node.textContent = text || '';
    node.classList.toggle('ok', !isError);
  }

  function renderImages() {
    const box = $('#images');
    box.textContent = '';
    if (!state.slots.length) {
      box.appendChild(el('p', { className: 'note', text: 'Could not read the list of photos of the home page.' }));
      return;
    }
    state.slots.forEach(function (item) {
      const custom = Boolean(state.images[item.slot]);
      const input = el('input', {
        type: 'file', accept: 'image/jpeg,image/png,image/webp', className: 'file-hidden', 'aria-label': 'Choose a photo for ' + item.label,
        onchange: (e) => { if (e.target.files[0]) changeImage(item, e.target.files[0]); e.target.value = ''; },
      });
      box.appendChild(el('figure', { className: 'img-tile' }, [
        el('img', { src: state.images[item.slot] || item.fallback, alt: '', loading: 'lazy' }),
        el('figcaption', { text: item.label }),
        el('div', { className: 'img-actions' }, [
          input,
          el('button', { type: 'button', className: 'btn ghost small', text: 'Change', onclick: () => input.click() }),
          custom ? el('button', { type: 'button', className: 'btn ghost small', text: 'Restore', onclick: () => resetImage(item) }) : null,
        ]),
      ]));
    });
  }

  /** Shrinks to 1600 px and converts to JPG in the browser: the server receives a light photo. */
  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('The image could not be processed.')); return; }
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('The image could not be read.'));
          reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That image could not be opened. Use JPG, PNG or WebP.'));
      };
      img.src = url;
    });
  }

  async function changeImage(item, file) {
    if (file.size > 30 * 1024 * 1024) { imageMessage('The image is too large (maximum 30 MB).', true); return; }
    imageMessage('Uploading "' + item.label + '"...');
    try {
      const data = await shrinkImage(file);
      const result = await api('adminUploadImage', { slot: item.slot, data });
      state.images[item.slot] = result.url;
      renderImages();
      imageMessage('Photo changed: ' + item.label + '. It is already live on the page.');
    } catch (err) {
      imageMessage('Could not upload: ' + err.message, true);
    }
  }

  async function resetImage(item) {
    imageMessage('Restoring...');
    try {
      await api('adminResetImage', { slot: item.slot });
      delete state.images[item.slot];
      renderImages();
      imageMessage('Foto original restaurada: ' + item.label + '.');
    } catch (err) {
      imageMessage('Could not restore: ' + err.message, true);
    }
  }

  // -------------------------------------------------------------------------
  // Editor drawing
  // -------------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      const v = attrs[k];
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value') node[k] = v;
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  function newId() {
    return 'q_' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  }

  function focusId(id) {
    const node = document.getElementById(id);
    if (node) node.focus();
  }

  function render() {
    const root = $('#sections');
    root.textContent = '';
    const total = state.config.sections.length;
    state.config.sections.forEach(function (section, si) {
      const wrap = el('section', { className: 'sec' });
      wrap.appendChild(el('div', { className: 'sec-head' }, [
        el('span', { className: 'sec-count', text: 'Section ' + (si + 1) + ' of ' + total }),
        el('input', {
          id: 'sec-' + section.id, type: 'text', maxlength: 80, value: section.title, 'aria-label': 'Title of section ' + (si + 1),
          oninput: (e) => { section.title = e.target.value; setDirty(true); },
        }),
      ]));
      state.config.questions
        .filter((q) => q.section === section.id)
        .forEach((q) => wrap.appendChild(renderQuestion(q)));
      const add = el('button', {
        type: 'button', className: 'add', onclick: () => addQuestion(section.id),
      }, [el('span', { className: 'add-plus', 'aria-hidden': 'true', text: '+' }), el('span', { text: 'Add question' })]);
      // Dropping a question here sends it to the end of the section.
      add.addEventListener('dragover', (e) => { if (drag.id) { e.preventDefault(); add.classList.add('drop'); } });
      add.addEventListener('dragleave', () => add.classList.remove('drop'));
      add.addEventListener('drop', function (e) {
        e.preventDefault();
        add.classList.remove('drop');
        moveTo(drag.id, null, false, section.id);
      });
      wrap.appendChild(add);
      root.appendChild(wrap);
    });
  }

  // -------------------------------------------------------------------------
  // Question card: compact view and, on click, editor
  // -------------------------------------------------------------------------

  const drag = { id: null };

  function renderQuestion(q) {
    const active = state.active === q.id;
    const card = el('article', { className: 'q' + (active ? ' active' : '') + (q.enabled ? '' : ' off'), 'data-id': q.id });

    card.appendChild(el('button', {
      type: 'button', className: 'q-grip', draggable: 'true', title: 'Drag to reorder', 'aria-label': 'Drag to reorder',
      text: '⠿',
      ondragstart: function (e) {
        drag.id = q.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', q.id);
        card.classList.add('dragging');
      },
      ondragend: function () {
        drag.id = null;
        card.classList.remove('dragging');
        document.querySelectorAll('.drop-before, .drop-after, .drop').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop'));
      },
    }));

    card.appendChild(el('div', { className: 'q-main' }, [active ? renderEditor(q) : renderPreview(q)]));

    card.addEventListener('dragover', function (e) {
      if (!drag.id || drag.id === q.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      card.classList.toggle('drop-before', before);
      card.classList.toggle('drop-after', !before);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', function (e) {
      if (!drag.id || drag.id === q.id) return;
      e.preventDefault();
      moveTo(drag.id, q.id, card.classList.contains('drop-before'));
    });
    return card;
  }

  function renderPreview(q) {
    const view = el('div', { className: 'q-view', tabindex: '0', role: 'button', 'aria-label': 'Edit: ' + (q.label || 'question without text') }, [
      el('div', { className: 'q-title', text: (q.label || 'Question without text') + (q.required ? ' *' : '') }),
      q.help ? el('div', { className: 'q-help', text: q.help }) : null,
    ]);

    if (CHOICE_TYPES.indexOf(q.type) !== -1) {
      const opts = el('div', { className: 'q-preview' });
      const filled = (q.options || []).filter(Boolean);
      filled.slice(0, 4).forEach((o, i) => opts.appendChild(el('div', { className: 'prev-opt', text: previewGlyph(q.type, i) + ' ' + o })));
      if (filled.length > 4) opts.appendChild(el('div', { className: 'prev-opt more', text: '... and ' + (filled.length - 4) + ' more' }));
      if (q.other) opts.appendChild(el('div', { className: 'prev-opt', text: previewGlyph(q.type, 0) + ' Other...' }));
      view.appendChild(opts);
    } else {
      view.appendChild(el('div', { className: 'q-preview muted', text: TYPE_LABELS[q.type] || q.type }));
    }

    view.appendChild(el('div', { className: 'q-tags' }, [
      q.required ? null : el('span', { className: 'tag', text: 'Optional' }),
      q.enabled ? null : el('span', { className: 'tag off', text: 'Disabled' }),
    ]));

    const open = () => activate(q.id);
    view.addEventListener('click', open);
    view.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return view;
  }

  function previewGlyph(type, i) {
    return type === 'checkbox' ? '☐' : type === 'radio' ? '○' : (i + 1) + '.';
  }

  function renderEditor(q) {
    const id = 'q-' + q.id;
    const wrap = el('div', { className: 'q-edit' });

    const typeSelect = el('select', {
      id: id + '-type', 'aria-label': 'Question type', disabled: typeChoices(q).length < 2,
      onchange: function (e) {
        q.type = e.target.value;
        if (CHOICE_TYPES.indexOf(q.type) !== -1 && !(q.options && q.options.length)) q.options = ['Option 1'];
        if (q.type === 'select') q.other = false;
        setDirty(true);
        render();
        focusId(id + '-type');
      },
    }, typeChoices(q).map((t) => el('option', { value: t, text: TYPE_LABELS[t] || t, selected: t === q.type })));

    wrap.appendChild(el('div', { className: 'q-top' }, [
      el('input', {
        id: id + '-label', className: 'q-title-input', type: 'text', maxlength: 300, value: q.label, placeholder: 'Question', 'aria-label': 'Question text',
        oninput: (e) => { q.label = e.target.value; setDirty(true); },
      }),
      typeSelect,
    ]));
    wrap.appendChild(el('input', {
      id: id + '-help', className: 'q-help-input', type: 'text', maxlength: 600, value: q.help || '', placeholder: 'Help text (optional)', 'aria-label': 'Help text',
      oninput: (e) => { q.help = e.target.value; setDirty(true); },
    }));

    if (CHOICE_TYPES.indexOf(q.type) !== -1) wrap.appendChild(renderOptions(q));

    if (q.locked) {
      wrap.appendChild(el('p', { className: 'note', text: 'This question builds the name of the user folder: it is always active and required.' }));
    } else if (q.type === 'file') {
      wrap.appendChild(el('p', { className: 'note', text: 'Files are saved in their own subfolder. The allowed types and sizes are fixed.' }));
    } else if (q.system && typeChoices(q).length < 2) {
      wrap.appendChild(el('p', { className: 'note', text: 'The type of this question is fixed because it validates a specific datum (phone, date, pages, city...).' }));
    }

    const canDuplicate = state.customTypes.indexOf(q.type) !== -1;
    const sectionSelect = el('select', {
      id: id + '-section', 'aria-label': 'Section of the question',
      onchange: (e) => { q.section = e.target.value; setDirty(true); render(); focusId(id + '-section'); },
    }, state.config.sections.map((sec, i) => el('option', { value: sec.id, text: 'Section ' + (i + 1), selected: sec.id === q.section })));

    wrap.appendChild(el('div', { className: 'q-foot' }, [
      el('div', { className: 'q-switches' }, [
        toggle(id + '-required', 'Required', q.required, Boolean(q.locked), (v) => { q.required = v; }),
        toggle(id + '-enabled', 'Active in the form', q.enabled, Boolean(q.locked), (v) => { q.enabled = v; }),
        q.type === 'date' && !q.system
          ? toggle(id + '-future', 'Only dates from today', Boolean(q.futureOnly), false, (v) => { q.futureOnly = v; })
          : null,
      ]),
      el('div', { className: 'q-actions' }, [
        sectionSelect,
        iconButton('↑', 'Move up', () => move(q, -1)),
        iconButton('↓', 'Move down', () => move(q, 1)),
        canDuplicate ? iconButton('⧉', 'Duplicate', () => duplicate(q)) : null,
        q.system ? null : iconButton('🗑', 'Delete', () => remove(q), true),
      ]),
    ]));
    return wrap;
  }

  /** Types the question can change to: those of its family if it is a factory question, all of them if it is new. */
  function typeChoices(q) {
    if (!q.system) return state.customTypes;
    if (q.locked) return [q.type];
    return state.typeFamilies.filter((f) => f.indexOf(q.type) !== -1)[0] || [q.type];
  }

  function renderOptions(q) {
    if (!q.options) q.options = [];
    const box = el('div', { className: 'opts' });
    const list = el('div', { className: 'opt-list' });
    const adders = el('div', { className: 'opt-adders' });
    box.appendChild(list);
    box.appendChild(adders);

    function redraw(focusIndex) {
      list.textContent = '';
      q.options.forEach(function (opt, i) {
        const input = el('input', {
          type: 'text', maxlength: 200, value: opt, placeholder: 'Option ' + (i + 1), 'aria-label': 'Option ' + (i + 1),
          oninput: (e) => { q.options[i] = e.target.value; setDirty(true); },
          onkeydown: function (e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              q.options.splice(i + 1, 0, '');
              setDirty(true);
              redraw(i + 1);
            } else if (e.key === 'Backspace' && !input.value && q.options.length > 1) {
              e.preventDefault();
              q.options.splice(i, 1);
              setDirty(true);
              redraw(Math.max(0, i - 1));
            }
          },
        });
        list.appendChild(el('div', { className: 'opt' }, [
          el('span', { className: 'opt-glyph', 'aria-hidden': 'true', text: previewGlyph(q.type, i) }),
          input,
          iconButton('×', 'Remove option ' + (i + 1), function () {
            q.options.splice(i, 1);
            setDirty(true);
            redraw(Math.max(0, i - 1));
          }, false, q.options.length <= 1),
        ]));
        if (i === focusIndex) setTimeout(() => input.focus());
      });
      if (q.other && q.type !== 'select') {
        list.appendChild(el('div', { className: 'opt opt-other' }, [
          el('span', { className: 'opt-glyph', 'aria-hidden': 'true', text: previewGlyph(q.type, 0) }),
          el('span', { className: 'opt-other-label', text: 'Other...' }),
          iconButton('×', 'Remove the "Other" option', function () { q.other = false; setDirty(true); redraw(); }),
        ]));
      }
      adders.textContent = '';
      adders.appendChild(el('button', {
        type: 'button', className: 'link-btn', text: 'Add option',
        onclick: () => { q.options.push(''); setDirty(true); redraw(q.options.length - 1); },
      }));
      if (q.type !== 'select' && !q.other) {
        adders.appendChild(el('span', { className: 'opt-or', text: 'or' }));
        adders.appendChild(el('button', {
          type: 'button', className: 'link-btn', text: 'add "Other"',
          onclick: () => { q.other = true; setDirty(true); redraw(); },
        }));
      }
    }
    redraw();
    return box;
  }

  function toggle(id, label, checked, disabled, onChange) {
    return el('label', { className: 'switch' + (disabled ? ' is-disabled' : ''), for: id }, [
      el('input', {
        id: id, type: 'checkbox', role: 'switch', checked: checked, disabled: disabled,
        onchange: function (e) { onChange(e.target.checked); setDirty(true); render(); focusId(id); },
      }),
      el('span', { className: 'switch-ui', 'aria-hidden': 'true' }),
      el('span', { text: label }),
    ]);
  }

  function iconButton(symbol, label, onClick, danger, disabled) {
    return el('button', {
      type: 'button', className: 'icon-btn' + (danger ? ' danger' : ''), title: label, 'aria-label': label,
      text: symbol, disabled: Boolean(disabled), onclick: onClick,
    });
  }

  // -------------------------------------------------------------------------
  // Changes to the questions
  // -------------------------------------------------------------------------

  function activate(id) {
    state.active = id;
    render();
    focusId('q-' + id + '-label');
  }

  function addQuestion(sectionId) {
    const id = newId();
    const list = state.config.questions;
    // It is inserted after the last question of that section.
    let index = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].section === sectionId) { index = i + 1; break; }
    }
    list.splice(index, 0, { id, section: sectionId, type: 'text', label: '', help: '', required: true, enabled: true });
    setDirty(true);
    state.active = id;
    render();
    focusId('q-' + id + '-label');
  }

  function duplicate(q) {
    const copy = {
      id: newId(), section: q.section, type: q.type, label: (q.label || '') + ' (copia)', help: q.help || '',
      required: q.required, enabled: true,
    };
    if (q.options) copy.options = q.options.slice();
    if (q.other) copy.other = true;
    if (q.futureOnly) copy.futureOnly = true;
    const list = state.config.questions;
    list.splice(list.indexOf(q) + 1, 0, copy);
    setDirty(true);
    activate(copy.id);
  }

  function move(q, direction) {
    const list = state.config.questions;
    const from = list.indexOf(q);
    let to = from + direction;
    while (to >= 0 && to < list.length && list[to].section !== q.section) to += direction;
    if (to < 0 || to >= list.length) return;
    list[from] = list[to];
    list[to] = q;
    setDirty(true);
    render();
    focusId('q-' + q.id + '-label');
  }

  /** Drag and drop: before or after another question, or at the end of a section. */
  function moveTo(id, targetId, before, sectionId) {
    const list = state.config.questions;
    const item = list.filter((x) => x.id === id)[0];
    if (!item || id === targetId) return;
    list.splice(list.indexOf(item), 1);
    if (targetId) {
      const target = list.filter((x) => x.id === targetId)[0];
      item.section = target.section;
      list.splice(list.indexOf(target) + (before ? 0 : 1), 0, item);
    } else {
      item.section = sectionId;
      let index = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].section === sectionId) { index = i + 1; break; }
      }
      list.splice(index, 0, item);
    }
    drag.id = null;
    setDirty(true);
    render();
  }

  function remove(q) {
    if (!window.confirm('Delete the question "' + q.label + '"? The answers already saved in the sheet are kept.')) return;
    state.config.questions.splice(state.config.questions.indexOf(q), 1);
    if (state.active === q.id) state.active = null;
    setDirty(true);
    render();
  }

  function setDirty(value) {
    state.dirty = value;
    $('#save-bar').classList.toggle('dirty', value);
    $('#save-status').textContent = value ? 'There are unsaved changes.' : 'No changes.';
  }

  async function save() {
    if (state.saving) return;
    state.saving = true;
    $('#btn-save').disabled = true;
    $('#save-status').textContent = 'Saving...';
    try {
      const config = Object.assign({}, state.config, {
        notifyEmails: $('#a-emails').value.split(/[\n,;]+/).map((e) => e.trim()).filter(Boolean),
      });
      const data = await api('adminSaveConfig', { config });
      state.config = data.config;
      $('#a-emails').value = state.config.notifyEmails.join('\n');
      setDirty(false);
      render();
      $('#save-status').textContent = 'Changes saved. The form already shows them.';
    } catch (err) {
      $('#save-status').textContent = 'Not saved: ' + err.message;
    } finally {
      state.saving = false;
      $('#btn-save').disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Inicio
  // -------------------------------------------------------------------------

  $('#login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const data = await api('adminLogin', { password: $('#a-password').value });
      saveToken(data.token);
      $('#a-password').value = '';
      await openPanel();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#password-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const msg = $('#password-msg');
    msg.textContent = '';
    try {
      await api('adminChangePassword', { current: $('#a-current').value, next: $('#a-next').value });
      e.target.reset();
      msg.textContent = 'Password updated.';
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  $('#a-emails').addEventListener('input', () => setDirty(true));
  $('#btn-save').addEventListener('click', save);
  $('#btn-logout').addEventListener('click', function () {
    api('adminLogout', {}).catch(() => null);
    showLogin('Signed out.');
  });
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  const saved = loadToken();
  if (saved) {
    state.token = saved;
    openPanel().catch(() => showLogin());
  }
})();
