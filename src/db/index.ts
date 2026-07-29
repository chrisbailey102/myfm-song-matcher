import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { optionalEnv, PROJECT_ROOT } from "../config.js";

const { Pool } = pg;

/** Keeps Song Matcher tables out of public (dashboard owns public.projects). */
const SEARCH_PATH = "song_matcher";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = optionalEnv("DATABASE_URL");
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. For local dev: docker compose up -d db && export DATABASE_URL=postgresql://myfm:myfm@localhost:5432/myfm",
      );
    }
    pool = new Pool({
      connectionString: url,
      connectionTimeoutMillis: 10_000,
      ssl: url.includes("localhost") || url.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: false },
    });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${SEARCH_PATH}`);
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    await client.query(`SET search_path TO ${SEARCH_PATH}`);
    const res = await client.query<T>(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function exec(text: string, params?: unknown[]): Promise<void> {
  await query(text, params);
}

async function runStatements(
  client: pg.PoolClient,
  statements: string[],
): Promise<void> {
  await client.query(`SET search_path TO ${SEARCH_PATH}`);
  for (const raw of statements) {
    const sql = raw.trim();
    if (!sql || sql.startsWith("--")) continue;
    await client.query(sql);
  }
}

export async function migrate(): Promise<void> {
  const schemaPath = path.join(PROJECT_ROOT, "src", "db", "schema.sql");
  const altPath = path.join(PROJECT_ROOT, "dist", "db", "schema.sql");
  const resolved = fs.existsSync(schemaPath)
    ? schemaPath
    : fs.existsSync(altPath)
      ? altPath
      : schemaPath;
  const sql = fs.readFileSync(resolved, "utf8");

  // Run one statement at a time — safer on pooled Postgres connections.
  const fromFile = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split("\n").every((l) => l.trim().startsWith("--") || !l.trim()));

  const client = await getPool().connect();
  try {
    // Baseline schema first (CREATE TABLE IF NOT EXISTS).
    // Important: schema.sql must not CREATE INDEX on columns that only exist via
    // later ALTERs on existing databases (e.g. folder_id).
    await runStatements(client, fromFile);

    // Additive migrations for DBs created before folder_id / sort_order / folders
    await runStatements(client, [
      `ALTER TABLE ${SEARCH_PATH}.songs ADD COLUMN IF NOT EXISTS lyrics_source TEXT DEFAULT ''`,
      `ALTER TABLE ${SEARCH_PATH}.projects ADD COLUMN IF NOT EXISTS folder_id TEXT`,
      `ALTER TABLE ${SEARCH_PATH}.projects ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS ${SEARCH_PATH}.folders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES ${SEARCH_PATH}.users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_folder ON ${SEARCH_PATH}.projects(folder_id)`,
      `CREATE INDEX IF NOT EXISTS idx_folders_user ON ${SEARCH_PATH}.folders(user_id)`,
    ]);

    // Backfill sort_order once when every playlist is still at the default 0
    await client.query(`
      WITH ranked AS (
        SELECT id,
          (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC) - 1)::int AS rn
        FROM ${SEARCH_PATH}.projects
      )
      UPDATE ${SEARCH_PATH}.projects p SET sort_order = ranked.rn
      FROM ranked
      WHERE p.id = ranked.id
        AND (SELECT COALESCE(MAX(sort_order), 0) FROM ${SEARCH_PATH}.projects) = 0
    `);
  } finally {
    client.release();
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}
