import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, setMeta } from './db.js';
import { encodeImage, writeMedia } from './media.js';

const API = 'https://discord.com/api/v10';
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_IMAGES_PER_ENTRY = 10;
export const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discord(pathname, { token, tokenType = 'Bot', method = 'GET', form } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + pathname, {
      method,
      headers: {
        ...(token ? { Authorization: `${tokenType} ${token}` } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await sleep(((body.retry_after ?? 1) + 0.5) * 1000);
      continue;
    }
    return res;
  }
  throw new Error(`Discord rate limit su ${pathname}`);
}

// ---------- OAuth ----------

export function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.baseUrl}/auth/callback`,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${p}`;
}

/** Scambia il code e restituisce il membro del server (null se non membro / senza ruolo). */
export async function resolveMember(code) {
  const tokenRes = await discord('/oauth2/token', {
    method: 'POST',
    form: {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.baseUrl}/auth/callback`,
    },
  });
  if (!tokenRes.ok) throw new Error('token_exchange');
  const { access_token } = await tokenRes.json();

  const res = await discord(`/users/@me/guilds/${config.guildId}/member`, {
    token: access_token,
    tokenType: 'Bearer',
  });
  if (res.status === 404 || res.status === 403) return { error: 'not_member' };
  if (!res.ok) throw new Error('member_lookup');
  const member = await res.json();

  if (config.voterRoleId && !member.roles?.includes(config.voterRoleId)) return { error: 'no_role' };

  const u = member.user;
  return {
    id: u.id,
    username: member.nick || u.global_name || u.username,
    avatar: u.avatar && /^[a-f0-9_]+$/i.test(u.avatar) ? u.avatar : null,
  };
}

// ---------- Sync forum ----------

async function listThreads() {
  const threads = new Map();

  const active = await discord(`/guilds/${config.guildId}/threads/active`, { token: config.botToken });
  if (!active.ok) throw new Error(`threads/active ${active.status}`);
  for (const t of (await active.json()).threads) {
    if (t.parent_id === config.forumChannelId) threads.set(t.id, t);
  }

  let before = '';
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: '100', ...(before ? { before } : {}) });
    const res = await discord(`/channels/${config.forumChannelId}/threads/archived/public?${qs}`, {
      token: config.botToken,
    });
    if (!res.ok) throw new Error(`threads/archived ${res.status}`);
    const body = await res.json();
    for (const t of body.threads) threads.set(t.id, t);
    if (!body.has_more || !body.threads.length) break;
    before = body.threads[body.threads.length - 1].thread_metadata.archive_timestamp;
  }
  return [...threads.values()];
}

export async function storeImage(attachment) {
  if (!/^\d+$/.test(attachment.id)) throw new Error('id allegato non valido');
  const file = `${attachment.id}.webp`;
  const dest = path.join(config.mediaDir, file);
  if (fs.existsSync(dest)) return file;

  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname)) throw new Error('host immagine non consentito');

  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD) throw new Error('immagine troppo grande');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error('immagine troppo grande');

  writeMedia(file, await encodeImage(buf));
  return file;
}

let syncing = false;

export async function syncForum() {
  if (!config.botToken) throw new Error('DISCORD_BOT_TOKEN non configurato');
  if (syncing) return { skipped: true };
  syncing = true;
  const stats = { added: 0, updated: 0, hidden: 0, errors: 0 };
  try {
    const threads = await listThreads();
    const seen = new Set();
    const upsert = db.prepare(`
      INSERT INTO entries (id, title, description, author_id, author_name, images, created_at, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
        author_name = excluded.author_name, images = excluded.images, hidden = 0
    `);
    const exists = db.prepare('SELECT 1 FROM entries WHERE id = ?');

    for (const t of threads) {
      try {
        // In un forum il messaggio iniziale ha lo stesso id del thread.
        const res = await discord(`/channels/${t.id}/messages/${t.id}`, { token: config.botToken });
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`message ${res.status}`);
        const msg = await res.json();

        const atts = (msg.attachments || [])
          .filter((a) => ALLOWED_TYPES.has(a.content_type?.split(';')[0]))
          .slice(0, MAX_IMAGES_PER_ENTRY);
        if (!atts.length) continue;

        const images = [];
        for (const a of atts) {
          try { images.push(await storeImage(a)); } catch (e) { stats.errors++; console.error('immagine', a.id, e.message); }
        }
        if (!images.length) continue;

        const isNew = !exists.get(t.id);
        upsert.run(
          t.id,
          String(t.name).slice(0, 200),
          String(msg.content || '').slice(0, 2000),
          msg.author.id,
          msg.author.global_name || msg.author.username,
          JSON.stringify(images),
          Math.floor(new Date(t.thread_metadata?.create_timestamp || msg.timestamp).getTime() / 1000),
        );
        seen.add(t.id);
        stats[isNew ? 'added' : 'updated']++;
      } catch (e) {
        stats.errors++;
        console.error('thread', t.id, e.message);
      }
    }

    // Post spariti dal forum (cancellati) → nascosti, i voti restano nel DB.
    if (!stats.errors) {
      // Le opere inserite a mano (author_id = 'manual') non sono nel forum: il sync non le tocca.
      for (const row of db.prepare("SELECT id FROM entries WHERE hidden = 0 AND author_id <> 'manual'").all()) {
        if (!seen.has(row.id)) {
          db.prepare('UPDATE entries SET hidden = 1 WHERE id = ?').run(row.id);
          stats.hidden++;
        }
      }
    }
    setMeta('last_sync', Math.floor(Date.now() / 1000));
    return stats;
  } finally {
    syncing = false;
  }
}
