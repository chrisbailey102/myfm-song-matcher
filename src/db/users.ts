import { exec, newId, now, query, queryOne } from "./index.js";

export type DbUser = {
  id: string;
  spotify_id: string;
  display_name: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
  created_at: number;
};

export async function upsertUser(input: {
  spotify_id: string;
  display_name: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
}): Promise<DbUser> {
  const existing = await queryOne<DbUser>(
    `SELECT * FROM users WHERE spotify_id = $1`,
    [input.spotify_id],
  );
  const ts = now();
  if (existing) {
    await exec(
      `UPDATE users SET display_name = $1, access_token = $2, refresh_token = $3,
       token_expires_at = $4 WHERE id = $5`,
      [
        input.display_name,
        input.access_token,
        input.refresh_token,
        input.token_expires_at,
        existing.id,
      ],
    );
    return {
      ...existing,
      display_name: input.display_name,
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      token_expires_at: input.token_expires_at,
    };
  }
  const id = newId();
  await exec(
    `INSERT INTO users (id, spotify_id, display_name, access_token, refresh_token, token_expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.spotify_id,
      input.display_name,
      input.access_token,
      input.refresh_token,
      input.token_expires_at,
      ts,
    ],
  );
  return {
    id,
    spotify_id: input.spotify_id,
    display_name: input.display_name,
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    token_expires_at: input.token_expires_at,
    created_at: ts,
  };
}

export async function getUserById(id: string): Promise<DbUser | null> {
  return queryOne<DbUser>(`SELECT * FROM users WHERE id = $1`, [id]);
}

export async function updateUserTokens(
  id: string,
  access_token: string,
  token_expires_at: number,
): Promise<void> {
  await exec(`UPDATE users SET access_token = $1, token_expires_at = $2 WHERE id = $3`, [
    access_token,
    token_expires_at,
    id,
  ]);
}
