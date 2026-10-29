import fs from 'node:fs';
import path from 'node:path';

const envFile = path.join(import.meta.dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) {
    console.error(`Variabile d'ambiente mancante: ${name} (vedi .env.example)`);
    process.exit(1);
  }
  return v;
}

const baseUrl = required('BASE_URL').replace(/\/+$/, '');

export const config = {
  port: Number(env.PORT) || 3000,
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
  clientId: required('DISCORD_CLIENT_ID'),
  clientSecret: required('DISCORD_CLIENT_SECRET'),
  botToken: env.DISCORD_BOT_TOKEN || '',
  discordPublicKey: env.DISCORD_PUBLIC_KEY || '',
  guildId: required('GUILD_ID'),
  forumChannelId: required('FORUM_CHANNEL_ID'),
  voterRoleId: env.VOTER_ROLE_ID || '',
  adminIds: new Set((env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)),
  maxScore: Math.min(Math.max(Number(env.MAX_SCORE) || 10, 2), 10),
  syncIntervalMin: Number(env.SYNC_INTERVAL_MIN ?? 10),
  dataDir: path.resolve(env.DATA_DIR || path.join(import.meta.dirname, 'data')),
  sessionDays: 30,
};

config.mediaDir = path.join(config.dataDir, 'media');
fs.mkdirSync(config.mediaDir, { recursive: true });
