import { exec, newId, now, query, queryOne } from "./index.js";

export type DbProject = {
  id: string;
  user_id: string;
  name: string;
  brief: string;
  playlist_id: string | null;
  playlist_name: string | null;
  playlist_url: string | null;
  status: string;
  created_at: number;
  updated_at: number;
};

export async function createProject(input: {
  user_id: string;
  name: string;
  brief?: string;
  playlist_id?: string;
  playlist_name?: string;
  playlist_url?: string;
}): Promise<DbProject> {
  const id = newId();
  const ts = now();
  await exec(
    `INSERT INTO projects (id, user_id, name, brief, playlist_id, playlist_name, playlist_url, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'importing', $8, $8)`,
    [
      id,
      input.user_id,
      input.name,
      input.brief ?? "",
      input.playlist_id ?? null,
      input.playlist_name ?? null,
      input.playlist_url ?? null,
      ts,
    ],
  );
  return (await getProjectById(id))!;
}

export async function getProjectById(id: string): Promise<DbProject | null> {
  return queryOne<DbProject>(`SELECT * FROM projects WHERE id = $1`, [id]);
}

export async function listProjectsForUser(userId: string): Promise<DbProject[]> {
  return query<DbProject>(
    `SELECT * FROM projects WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
}

export async function updateProjectStatus(id: string, status: string): Promise<void> {
  await exec(`UPDATE projects SET status = $1, updated_at = $2 WHERE id = $3`, [
    status,
    now(),
    id,
  ]);
}

export async function touchProject(id: string): Promise<void> {
  await exec(`UPDATE projects SET updated_at = $1 WHERE id = $2`, [now(), id]);
}
