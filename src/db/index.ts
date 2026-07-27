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

export async function migrate(): Promise<void> {
  const schemaPath = path.join(PROJECT_ROOT, "src", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const client = await getPool().connect();
  try {
    await client.query(sql);
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
