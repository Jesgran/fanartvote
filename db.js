import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'fanart.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS votes (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS vote_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    score INTEGER,
    at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const getMeta = (key, fallback) =>
  db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? fallback;

export const setMeta = (key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
