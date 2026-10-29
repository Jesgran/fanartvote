'use strict';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const lightbox = document.getElementById('lightbox');

const ERRORS = {
  not_member: 'Non risulti iscritto al server Discord.',
  no_role: 'Il tuo account non ha il ruolo necessario per votare.',
  state: 'Sessione di accesso scaduta, riprova.',
  auth: 'Accesso con Discord non riuscito, riprova.',
};

const MAX_MANUAL_IMAGES = 10;

const state = { me: null, entries: [], open: true, maxScore: 10, tab: 'todo', editing: null, results: null, admin: null };

// ---------- utils ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

let toastTimer;
function toast(msg, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), 2200);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Requested-With': 'fanart', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { state.me = null; renderLogin(); throw new Error('unauthenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'error'), { code: data.error });
  return data;
}

const API_MESSAGES = {
  closed: 'Le votazioni sono chiuse.',
  own_entry: 'Non puoi votare la tua opera.',
  rate_limited: 'Troppe richieste, aspetta un attimo.',
};
const apiError = (e) => API_MESSAGES[e.code] || 'Errore, riprova.';

// ---------- login ----------

function renderLogin() {
  const code = new URLSearchParams(location.search).get('error');
  history.replaceState(null, '', '/');
  app.replaceChildren(
    h('div', { class: 'center' },
      h('h1', { text: '🎨 Voto Fan Art' }),
      code ? h('p', { class: 'err', text: ERRORS[code] || ERRORS.auth }) : null,
      h('a', { class: 'btn', href: '/auth/login', text: 'Entra con Discord' }),
    ),
  );
}

// ---------- model ----------

const votedCount = () => state.entries.filter((e) => e.myScore != null).length;
const votable = () => state.entries.filter((e) => !e.own);
const resultsVisible = () => state.me.isAdmin || !state.open;

function visibleEntries() {
  const list = state.entries;
  if (state.tab === 'todo') return list.filter((e) => e.myScore == null && !e.own);
  if (state.tab === 'voted') return list.filter((e) => e.myScore != null);
  return list;
}

async function load() {
  const [me, data] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/entries')]);
  state.me = me;
  Object.assign(state, { entries: data.entries, open: data.open, maxScore: data.maxScore });
  render();
}

// ---------- shell ----------

function render() {
  const total = votable().length;
  const done = votedCount();
  const tabs = [
    ['todo', `Da votare (${total - done})`],
    ['voted', `Votati (${done})`],
    ['all', 'Tutti'],
  ];
  if (resultsVisible()) tabs.push(['results', 'Classifica']);
  if (state.me.isAdmin) tabs.push(['admin', 'Admin']);

  const header = h('header', { class: 'top' },
    h('div', { class: 'row' },
      h('div', { class: 'me' },
        state.me.avatar ? h('img', { src: state.me.avatar, alt: '', width: 28, height: 28 }) : null,
        h('span', { text: state.me.username })),
      h('button', { class: 'link', onclick: logout, text: 'Esci' })),
    h('div', { class: 'tabs', role: 'tablist' },
      tabs.map(([key, label]) =>
        h('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === key), onclick: () => { state.tab = key; state.editing = null; render(); scrollTo(0, 0); } },
          label))),
  );

  const content = h('div', { id: 'content' });
  app.replaceChildren(header, content);
  if (!state.open) content.append(h('div', { class: 'banner', text: 'Le votazioni sono chiuse: i voti non si possono più modificare.' }));

  if (state.tab === 'results') return renderResults(content);
  if (state.tab === 'admin') return renderAdmin(content);
  renderList(content);
}

function renderList(content) {
  const list = visibleEntries();
  if (!list.length) {
    const msg = {
      todo: state.entries.length ? '🎉 Hai votato tutto!' : 'Ancora nessuna opera, torna più tardi.',
      voted: 'Non hai ancora votato nessuna opera.',
      all: 'Ancora nessuna opera, torna più tardi.',
    }[state.tab];
    return content.append(h('p', { class: 'empty', text: msg }));
  }
  if (state.tab !== 'voted') return content.append(...list.map(card));

  // "Votati": elenco compatto, tocca una riga per cambiare o rimuovere il voto.
  for (const e of list) {
    content.append(state.editing === e.id ? card(e) : row(e));
  }
}

function row(e) {
  return h('ul', { class: 'list' },
    h('li', { tabindex: 0, role: 'button', 'aria-label': `${e.title}, voto ${e.myScore}. Tocca per modificare`,
      onclick: () => { state.editing = e.id; render(); },
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); state.editing = e.id; render(); } } },
      h('img', { src: e.images[0], alt: '', loading: 'lazy' }),
      h('div', { class: 't' }, h('strong', { text: e.title })),
      h('span', { class: 'n', text: e.myScore })));
}

// ---------- card ----------

function card(e) {
  const slides = h('div', { class: 'slides' },
    e.images.map((src, i) =>
      h('img', { src, alt: `${e.title} (${i + 1}/${e.images.length})`, loading: 'lazy', decoding: 'async', onclick: () => openLightbox(src) })));
  const gallery = h('div', { class: 'gallery' }, slides);
  if (e.images.length > 1) {
    const counter = h('span', { class: 'count', text: `1/${e.images.length}` });
    const dots = h('div', { class: 'dots' }, e.images.map((_, i) => h('i', { class: i === 0 ? 'on' : '' })));
    slides.addEventListener('scroll', () => {
      const i = Math.round(slides.scrollLeft / slides.clientWidth);
      counter.textContent = `${i + 1}/${e.images.length}`;
      [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
    }, { passive: true });
    gallery.append(counter, dots);
  }

  const desc = h('p', { class: 'desc', text: e.description });
  const body = h('div', { class: 'body' },
    h('h2', {}, e.title, e.author ? h('span', { class: 'by', text: ` - ${e.author}` }) : null),
    e.description ? desc : null,
  );
  if (e.description.length > 140 || e.description.split('\n').length > 3) {
    const more = h('button', { class: 'more', text: 'Leggi tutto', 'aria-expanded': 'false' });
    more.addEventListener('click', () => {
      const open = desc.classList.toggle('open');
      more.textContent = open ? 'Mostra meno' : 'Leggi tutto';
      more.setAttribute('aria-expanded', String(open));
    });
    body.append(more);
  }
  const vote = voteBlock(e);
  body.append(vote);
  return h('article', { class: 'card', 'data-id': e.id }, gallery, body);
}

function voteBlock(e) {
  const block = h('div', { class: 'vote' });
  if (e.own) {
    block.append(h('div', { class: 'status own', text: 'È la tua opera: non puoi votarla.' }));
    return block;
  }
  const status = e.myScore != null && state.open
    ? h('div', { class: 'status' }, h('button', { class: 'link', text: 'Rimuovi voto', onclick: () => removeVote(e, block) }))
    : null;
  const scores = h('div', { class: 'scores', role: 'group', 'aria-label': 'Voto', style: `--n:${state.maxScore}` },
    Array.from({ length: state.maxScore }, (_, i) => i + 1).map((n) =>
      h('button', { text: n, 'aria-pressed': String(e.myScore === n), disabled: !state.open, onclick: () => setVote(e, n, block) })));
  block.append(...[status, scores].filter(Boolean));
  return block;
}

function updateTabCounts() {
  const total = votable().length, done = votedCount();
  const tabs = document.querySelectorAll('.tab');
  tabs[0].textContent = `Da votare (${total - done})`;
  tabs[1].textContent = `Votati (${done})`;
}

/** Aggiorna subito la vista: un'opera votata esce da "Da votare" senza ricaricare la pagina. */
function refreshAfterVote(e, block) {
  block.replaceWith(voteBlock(e));
  updateTabCounts();
  if (state.tab === 'todo' && e.myScore != null) {
    document.querySelector(`[data-id="${CSS.escape(e.id)}"]`)?.remove();
    if (!document.querySelector('.card')) render();
  }
}

async function setVote(e, n, block) {
  const prev = e.myScore;
  if (prev === n) return;
  e.myScore = n;
  refreshAfterVote(e, block);
  try {
    await api('PUT', `/api/entries/${encodeURIComponent(e.id)}/vote`, { score: n });
    toast(prev == null ? `Voto ${n} salvato ✓` : `Voto cambiato: ${prev} → ${n} ✓`);
  } catch (err) {
    if (err.message === 'unauthenticated') return;
    e.myScore = prev;
    render();
    toast(apiError(err), true);
  }
}

async function removeVote(e, block) {
  const prev = e.myScore;
  e.myScore = null;
  refreshAfterVote(e, block);
  if (state.tab === 'voted') { state.editing = null; render(); }
  try {
    await api('DELETE', `/api/entries/${encodeURIComponent(e.id)}/vote`);
    toast('Voto rimosso');
  } catch (err) {
    if (err.message === 'unauthenticated') return;
    e.myScore = prev;
    render();
    toast(apiError(err), true);
  }
}

// ---------- lightbox ----------

function openLightbox(src) {
  lightbox.querySelector('img').src = src;
  lightbox.showModal();
}
lightbox.addEventListener('click', () => lightbox.close());

// ---------- risultati ----------

async function renderResults(content) {
  content.append(h('p', { class: 'empty', text: 'Caricamento…' }));
  try {
    const { results, open } = await api('GET', '/api/results');
    const ul = h('ol', { class: 'list' },
      results.map((r, i) =>
        h('li', {},
          h('span', { class: 'rank', text: i + 1 }),
          h('img', { src: r.thumb, alt: '' }),
          h('div', { class: 't' }, h('strong', { text: r.title }), h('small', { text: `${r.author_name} · ${r.votes} voti${r.banned ? ' · nascosta' : ''}` })),
          h('span', { class: 'n', text: r.avg ?? '–' }))));
    content.replaceChildren(
      !open ? null : h('div', { class: 'banner', text: 'Provvisoria — visibile solo agli admin finché le votazioni sono aperte.' }),
      ul);
  } catch (e) {
    content.replaceChildren(h('p', { class: 'empty err', text: apiError(e) }));
  }
}

// ---------- admin ----------

async function renderAdmin(content) {
  try {
    state.admin = await api('GET', '/api/admin/status');
  } catch (e) {
    return content.append(h('p', { class: 'empty err', text: apiError(e) }));
  }
  const s = state.admin;
  const last = s.lastSync ? new Date(s.lastSync * 1000).toLocaleString('it-IT') : 'mai';
  const syncBtn = h('button', { class: 'btn small', text: 'Sincronizza dal forum' });
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      const r = await api('POST', '/api/admin/sync');
      toast(r.skipped ? 'Sync già in corso' : `Nuove ${r.added}, aggiornate ${r.updated}, nascoste ${r.hidden}`);
      await load();
      state.tab = 'admin'; render();
    } catch (e) { toast(e.code === 'sync_failed' ? 'Sync fallita (vedi log server)' : apiError(e), true); }
    syncBtn.disabled = false;
  });
  const toggle = h('button', { class: 'btn small ghost', text: s.open ? 'Chiudi votazioni' : 'Riapri votazioni' });
  toggle.addEventListener('click', async () => {
    if (s.open && !confirm('Chiudere le votazioni? Tutti vedranno la classifica e gli autori.')) return;
    await api('POST', '/api/admin/voting', { open: !s.open });
    await load(); state.tab = 'admin'; render();
  });
  content.append(h('section', { class: 'admin' },
    h('h3', { text: 'Admin' }),
    h('div', { text: `${s.entries} opere · ${s.voters} votanti · ultima sync: ${last}` }),
    h('div', { class: 'actions' }, syncBtn, toggle)), manualForm());
}

// ---------- inserimento manuale ----------

/** Riduce l'immagine nel browser (lato lungo 1600px, JPEG) così il caricamento resta leggero da telefono. */
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function manualForm() {
  const title = h('input', { type: 'text', maxlength: 200, required: true, placeholder: 'Titolo dell’opera' });
  const author = h('input', { type: 'text', maxlength: 80, required: true, placeholder: 'Autore' });
  const description = h('textarea', { maxlength: 2000, rows: 3, placeholder: 'Descrizione (facoltativa)' });
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, required: true });
  const submit = h('button', { class: 'btn small', type: 'submit', text: 'Aggiungi opera' });

  const form = h('form', { class: 'admin manual' },
    h('h3', { text: 'Aggiungi opera a mano' }),
    title, author, description,
    h('label', {}, 'Immagini (fino a 10): ', files),
    submit);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const picked = [...files.files].slice(0, MAX_MANUAL_IMAGES);
    if (!picked.length) return toast('Scegli almeno un’immagine', true);
    submit.disabled = true;
    try {
      const images = [];
      for (const [i, f] of picked.entries()) {
        submit.textContent = `Preparo ${i + 1}/${picked.length}…`;
        images.push(await compressImage(f));
      }
      submit.textContent = 'Caricamento…';
      await api('POST', '/api/admin/entries', {
        title: title.value, authorName: author.value, description: description.value, images,
      });
      toast('Opera aggiunta ✓');
      await load();
      state.tab = 'admin';
      render();
    } catch (e) {
      if (e.message === 'unauthenticated') return;
      toast(e.code === 'bad_image' ? 'Immagine non valida' : 'Caricamento fallito, riprova', true);
      submit.disabled = false;
      submit.textContent = 'Aggiungi opera';
    }
  });
  return form;
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  state.me = null;
  renderLogin();
}

// ---------- boot ----------

if (new URLSearchParams(location.search).has('error')) {
  renderLogin();
} else {
  load().catch((e) => { if (e.message === 'unauthenticated') return; app.replaceChildren(h('p', { class: 'empty err', text: 'Errore di caricamento.' })); });
}
