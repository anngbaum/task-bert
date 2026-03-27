import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SCHEMA_PATH = path.join(import.meta.dirname, 'schema.sql');

let client: PGlite | null = null;

export async function getPglite(): Promise<PGlite> {
  if (client) return client;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  client = new PGlite(PG_DATA_DIR, {
    extensions: { vector },
  });

  await client.waitReady;

  return client;
}

export async function initSchema(): Promise<void> {
  const db = await getPglite();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

  // Split on semicolons and execute each statement
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await db.exec(stmt + ';');
  }

  // Migrations for existing databases
  try {
    await db.exec('ALTER TABLE key_events ADD COLUMN IF NOT EXISTS removed BOOLEAN DEFAULT FALSE;');
  } catch {
    // Column may already exist
  }
}

/**
 * Run cheap queries against core tables to verify the database isn't corrupted.
 * Returns true if healthy, false if something is wrong.
 */
export async function verifyDatabase(): Promise<boolean> {
  try {
    const db = await getPglite();
    // Check that core tables exist and are queryable
    await db.query('SELECT count(*) FROM message');
    await db.query('SELECT count(*) FROM handle');
    await db.query('SELECT count(*) FROM chat');
    await db.query('SELECT last_synced FROM sync_meta WHERE id = 1');
    return true;
  } catch (err) {
    console.error('[health] Database verification failed:', err);
    return false;
  }
}

/**
 * Wipe the PGLite data directory and reset the client so a fresh DB is created on next access.
 */
export async function wipePgliteData(): Promise<void> {
  await closePglite();
  if (fs.existsSync(PG_DATA_DIR)) {
    fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
    console.log('[health] Wiped corrupted PGLite data directory.');
  }
}

export async function closePglite(): Promise<void> {
  if (client) {
    const c = client;
    client = null; // Clear reference first to prevent re-use
    try {
      await c.close();
    } catch (err) {
      console.warn('[pglite] Error closing client:', err);
    }
  }
}
