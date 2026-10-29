import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { ALLOWED_TYPES, storeImage } from './discord.js';

const API = 'https://discord.com/api/v10';
const PING = 1;
const APP_COMMAND = 2;
const MESSAGE_COMMAND = 3;
const RESP_PONG = 1;
const RESP_MESSAGE = 4;
const RESP_DEFERRED = 5;
const FLAG_EPHEMERAL = 64;
const COMMAND_NAME = 'Aggiungi al voto';
const MAX_IMAGES = 10;

// Discord dà la chiave pubblica in esadecimale: va avvolta nel prefisso DER di una chiave Ed25519.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifySignature(rawBody, signature, timestamp) {
  if (!config.discordPublicKey || !signature || !timestamp) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(config.discordPublicKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** Registra il comando nel server (sovrascrive quello esistente, quindi è sicuro ripeterlo). */
export async function registerCommand() {
  if (!config.botToken) throw new Error('DISCORD_BOT_TOKEN non configurato');
  const res = await fetch(`${API}/applications/${config.clientId}/guilds/${config.guildId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${config.botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: COMMAND_NAME, type: MESSAGE_COMMAND }]),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`registrazione comando: HTTP ${res.status}`);
}

const immediate = (content) => ({ type: RESP_MESSAGE, data: { content, flags: FLAG_EPHEMERAL } });

async function editOriginal(body, content) {
  await fetch(`${API}/webhooks/${body.application_id}/${body.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => console.error('risposta interazione:', e.message));
}

/** Salva il post (primo messaggio del thread) come opera, con le stesse regole del sync. */
async function addEntry(msg, channel) {
  if (!msg || msg.id !== msg.channel_id) throw new Error('usa il comando sul primo messaggio del post');
  const atts = (msg.attachments || [])
    .filter((a) => ALLOWED_TYPES.has(a.content_type?.split(';')[0]))
    .slice(0, MAX_IMAGES);
  if (!atts.length) throw new Error('nessuna immagine nel post');

  const images = [];
  for (const a of atts) images.push(await storeImage(a));

  const id = msg.channel_id;
  const title = String(channel?.name || 'Senza titolo').slice(0, 200);
  db.prepare(`
    INSERT INTO entries (id, title, description, author_id, author_name, images, created_at, hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
      author_name = excluded.author_name, images = excluded.images, hidden = 0
  `).run(
    id,
    title,
    String(msg.content || '').slice(0, 2000),
    msg.author.id,
    msg.author.global_name || msg.author.username,
    JSON.stringify(images),
    Math.floor(Date.parse(msg.timestamp) / 1000),
  );
  return { title, count: images.length };
}

export async function handleInteraction(req, res) {
  const raw = req.body; // Buffer: la route usa express.raw, serve il corpo esatto per la firma
  if (!verifySignature(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
    return res.status(401).end();
  }
  const body = JSON.parse(raw.toString('utf8'));

  if (body.type === PING) return res.json({ type: RESP_PONG });
  if (body.type !== APP_COMMAND || body.data?.type !== MESSAGE_COMMAND || body.data?.name !== COMMAND_NAME) {
    return res.json(immediate('Comando non riconosciuto.'));
  }

  const userId = body.member?.user?.id ?? body.user?.id;
  if (!config.adminIds.has(userId)) return res.json(immediate('Solo gli admin possono aggiungere opere.'));

  // Il download e la conversione possono superare i 3 secondi che Discord concede: rispondo subito e poi edito.
  res.json({ type: RESP_DEFERRED, data: { flags: FLAG_EPHEMERAL } });
  try {
    const msg = body.data.resolved?.messages?.[body.data.target_id];
    const { title, count } = await addEntry(msg, body.channel);
    await editOriginal(body, `✅ "${title}" aggiunta al voto con ${count} immagini.`);
  } catch (e) {
    console.error('aggiungi al voto:', e.message);
    await editOriginal(body, `Non ho aggiunto il post: ${e.message}.`);
  }
}
