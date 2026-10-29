import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { authorizeUrl, resolveMember, syncForum } from './discord.js';
import { encodeImage, writeMedia } from './media.js';
import { handleInteraction, registerCommand } from './interactions.js';

const MAX_MANUAL_IMAGES = 10;
const MAX_MANUAL_IMAGE_BYTES = 8 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
    referrerPolicy: { policy: 'same-origin' },
  }),
);
// Solo la route di inserimento manuale accetta payload grandi (immagini compresse in base64).
app.use('/api/admin/entries', express.json({ limit: '15mb' }));
// Interazioni Discord: corpo grezzo per la verifica della firma (deve stare prima del parser JSON globale).
app.post('/discord/interactions', express.raw({ type: '*/*', limit: '1mb' }), handleInteraction);
app.use(express.json({ limit: '4kb' }));

// Controllo di salute per Render (nessun dato, nessuna sessione).
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---------- helpers ----------

const SID = config.secureCookies ? '__Host-sid' : 'sid';
const STATE = config.secureCookies ? '__Host-oauth_state' : 'oauth_state';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const cookieOpts = (maxAgeSec) => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: 'lax',
  path: '/',
  maxAge: maxAgeSec * 1000,
});

function loadSession(req) {
  const token = readCookies(req)[SID];
  if (!token || token.length > 128) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), now());
  return s || null;
}

function requireAuth(req, res, next) {
  const s = loadSession(req);
  if (!s) return res.status(401).json({ error: 'unauthenticated' });
  req.user = { id: s.user_id, username: s.username, avatar: s.avatar, isAdmin: !!s.is_admin };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

/** Anti-CSRF: le richieste che modificano dati devono essere JSON same-origin con header custom. */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === config.baseUrl;
  const okHeader = req.headers['x-requested-with'] === 'fanart';
  if (!okOrigin || !okHeader) return res.status(403).json({ error: 'csrf' });
  next();
}

const votingOpen = () => getMeta('voting_open', '1') === '1';
const resultsVisible = (user) => user.isAdmin || !votingOpen();

// ---------- rate limit ----------

const limiter = (windowMs, limit, keyByUser = false) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyByUser ? (req) => `u:${req.user.id}` : undefined,
    validate: keyByUser ? { keyGeneratorIpFallback: false } : undefined,
    message: { error: 'rate_limited' },
  });

app.use(limiter(60_000, 240));

// ---------- auth ----------

app.get('/auth/login', limiter(10 * 60_000, 30), (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie(STATE, state, { ...cookieOpts(600), path: '/' });
  res.redirect(authorizeUrl(state));
});

app.get('/auth/callback', limiter(10 * 60_000, 30), async (req, res) => {
  const { code, state } = req.query;
  const saved = readCookies(req)[STATE];
  res.clearCookie(STATE, { path: '/', secure: config.secureCookies });

  const stateOk =
    typeof state === 'string' && typeof saved === 'string' && state.length === saved.length &&
    crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved));
  if (!stateOk || typeof code !== 'string' || code.length > 256) return res.redirect('/?error=state');

  try {
    const member = await resolveMember(code);
    if (member.error) return res.redirect(`/?error=${member.error}`);

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, username, avatar, is_admin, expires_at) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), member.id, member.username.slice(0, 80), member.avatar, config.adminIds.has(member.id) ? 1 : 0,
        now() + config.sessionDays * 86400);
    res.cookie(SID, token, cookieOpts(config.sessionDays * 86400));
    res.redirect('/');
  } catch (e) {
    console.error('auth callback:', e.message);
    res.redirect('/?error=auth');
  }
});

app.post('/auth/logout', csrfGuard, (req, res) => {
  const token = readCookies(req)[SID];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SID, { path: '/', secure: config.secureCookies });
  res.json({ ok: true });
});

// ---------- api ----------

const api = express.Router();
api.use(csrfGuard, requireAuth);

api.get('/me', (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    username: u.username,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
    isAdmin: u.isAdmin,
  });
});

api.get('/entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE hidden = 0 AND banned = 0').all();
  const mine = new Map(
    db.prepare('SELECT entry_id, score FROM votes WHERE user_id = ?').all(req.user.id).map((v) => [v.entry_id, v.score]),
  );
  // Ordine diverso per ogni utente (ma stabile) per non favorire i primi post.
  const order = (id) => sha256(req.user.id + id);
  rows.sort((a, b) => (order(a.id) < order(b.id) ? -1 : 1));

  const entries = rows.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    images: JSON.parse(e.images).map((f) => `/media/${f}`),
    own: e.author_id === req.user.id,
    myScore: mine.get(e.id) ?? null,
    author: e.author_name,
  }));
  res.json({
    open: votingOpen(),
    maxScore: config.maxScore,
    entries,
  });
});

api.put('/entries/:id/vote', limiter(60_000, 60, true), (req, res) => {
  if (!votingOpen()) return res.status(403).json({ error: 'closed' });
  const score = req.body?.score;
  if (!Number.isInteger(score) || score < 1 || score > config.maxScore) return res.status(400).json({ error: 'bad_score' });

  const entry = db.prepare('SELECT author_id FROM entries WHERE id = ? AND hidden = 0 AND banned = 0').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  if (entry.author_id === req.user.id) return res.status(403).json({ error: 'own_entry' });

  db.prepare(`INSERT INTO votes (entry_id, user_id, score, updated_at) VALUES (?,?,?,?)
              ON CONFLICT(entry_id, user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`)
    .run(req.params.id, req.user.id, score, now());
  db.prepare('INSERT INTO vote_log (entry_id, user_id, score, at) VALUES (?,?,?,?)').run(req.params.id, req.user.id, score, now());
  res.json({ ok: true, score });
});

api.delete('/entries/:id/vote', limiter(60_000, 60, true), (req, res) => {
  if (!votingOpen()) return res.status(403).json({ error: 'closed' });
  const r = db.prepare('DELETE FROM votes WHERE entry_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (r.changes) db.prepare('INSERT INTO vote_log (entry_id, user_id, score, at) VALUES (?,?,NULL,?)').run(req.params.id, req.user.id, now());
  res.json({ ok: true });
});

api.get('/results', (req, res) => {
  if (!resultsVisible(req.user)) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare(`
    SELECT e.id, e.title, e.author_name, e.images, e.banned,
           COUNT(v.score) AS votes, ROUND(AVG(v.score), 2) AS avg, SUM(v.score) AS total
    FROM entries e LEFT JOIN votes v ON v.entry_id = e.id
    WHERE e.hidden = 0 AND (e.banned = 0 OR ?)
    GROUP BY e.id
    ORDER BY avg DESC, votes DESC
  `).all(req.user.isAdmin ? 1 : 0);
  res.json({
    open: votingOpen(),
    results: rows.map((r) => ({ ...r, images: undefined, thumb: `/media/${JSON.parse(r.images)[0]}` })),
  });
});

api.get('/admin/status', requireAdmin, (req, res) => {
  res.json({
    open: votingOpen(),
    lastSync: Number(getMeta('last_sync', 0)) || null,
    voters: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM votes').get().n,
    entries: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE hidden = 0 AND banned = 0').get().n,
  });
});

api.post('/admin/sync', requireAdmin, limiter(60_000, 6, true), async (req, res) => {
  try {
    res.json(await syncForum());
  } catch (e) {
    console.error('sync:', e.message);
    res.status(502).json({ error: 'sync_failed' });
  }
});

api.post('/admin/voting', requireAdmin, (req, res) => {
  if (typeof req.body?.open !== 'boolean') return res.status(400).json({ error: 'bad_request' });
  setMeta('voting_open', req.body.open ? '1' : '0');
  res.json({ open: req.body.open });
});

api.post('/admin/entries/:id/ban', requireAdmin, (req, res) => {
  if (typeof req.body?.banned !== 'boolean') return res.status(400).json({ error: 'bad_request' });
  db.prepare('UPDATE entries SET banned = ? WHERE id = ?').run(req.body.banned ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Inserimento manuale: serve finché il bot non può leggere i post del forum (Message Content Intent).
api.post('/admin/entries', requireAdmin, limiter(60_000, 30, true), async (req, res) => {
  const { title, authorName, description = '', images } = req.body || {};
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
  const t = clean(title, 200);
  const a = clean(authorName, 80);
  const d = clean(description, 2000);
  if (!t || !a || d === null || !Array.isArray(images) || !images.length || images.length > MAX_MANUAL_IMAGES) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const files = [];
  try {
    for (const dataUrl of images) {
      const m = typeof dataUrl === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) return res.status(400).json({ error: 'bad_image' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > MAX_MANUAL_IMAGE_BYTES) return res.status(400).json({ error: 'bad_image' });
      const file = `m_${crypto.randomBytes(12).toString('hex')}.webp`;
      writeMedia(file, await encodeImage(buf));
      files.push(file);
    }
  } catch (e) {
    console.error('manual image:', e.message);
    return res.status(400).json({ error: 'bad_image' });
  }

  const id = `m_${crypto.randomBytes(12).toString('hex')}`;
  db.prepare(`INSERT INTO entries (id, title, description, author_id, author_name, images, created_at, hidden)
              VALUES (?, ?, ?, 'manual', ?, ?, ?, 0)`)
    .run(id, t, d, a, JSON.stringify(files), now());
  res.json({ ok: true, id });
});

api.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use('/api', api);

// ---------- media (solo utenti loggati) & static ----------

app.use(
  '/media',
  requireAuth,
  express.static(config.mediaDir, {
    index: false,
    dotfiles: 'ignore',
    fallthrough: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=604800, immutable'),
  }),
);
// Percorso assoluto: funziona qualunque sia la cartella da cui si avvia il server.
app.use(express.static(path.join(import.meta.dirname, 'public'), { index: 'index.html', maxAge: '5m' }));

app.use((err, req, res, next) => {
  if (err.status === 404) return res.status(404).end();
  console.error(err.message);
  res.status(err.status || 500).json({ error: 'server_error' });
});

app.listen(config.port, (err) => {
  if (err) { console.error("Impossibile avviare il server:", err.message); process.exit(1); }
  console.log(`Fan art vote su ${config.baseUrl} (porta ${config.port})`);
  if (!config.adminIds.size) console.warn('ADMIN_IDS vuoto: nessun admin.');
  if (!config.discordPublicKey) console.warn('DISCORD_PUBLIC_KEY mancante: il comando "Aggiungi al voto" non funziona.');
  if (config.botToken) {
    registerCommand().then(() => console.log('Comando "Aggiungi al voto" registrato.'), (e) => console.error('comando:', e.message));
  }
  if (config.botToken && config.syncIntervalMin > 0) {
    const run = () => syncForum().then((s) => console.log('sync:', s), (e) => console.error('sync:', e.message));
    run();
    setInterval(run, config.syncIntervalMin * 60_000).unref();
  }
});
