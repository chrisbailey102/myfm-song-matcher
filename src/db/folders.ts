import { exec, newId, now, query, queryOne } from "./index.js";

export type DbFolder = {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type FolderWithCount = DbFolder & { playlist_count: number };

export async function createFolder(
  userId: string,
  name: string,
  sortOrder: number,
): Promise<DbFolder> {
  const id = newId();
  const ts = now();
  const trimmed = name.trim();
  await exec(
    `INSERT INTO folders (id, user_id, name, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, userId, trimmed, sortOrder, ts],
  );
  return (await getFolderById(id))!;
}

export async function getFolderById(id: string): Promise<DbFolder | null> {
  return queryOne<DbFolder>(`SELECT * FROM folders WHERE id = $1`, [id]);
}

export async function listFoldersWithCounts(
  userId: string,
): Promise<FolderWithCount[]> {
  return query<FolderWithCount>(
    `SELECT f.*, COALESCE(c.cnt, 0)::int AS playlist_count
     FROM folders f
     LEFT JOIN (
       SELECT folder_id, COUNT(*)::int AS cnt FROM projects
       WHERE folder_id IS NOT NULL GROUP BY folder_id
     ) c ON c.folder_id = f.id
     WHERE f.user_id = $1
     ORDER BY f.sort_order ASC, f.name ASC`,
    [userId],
  );
}

export async function updateFolderName(
  id: string,
  name: string,
): Promise<DbFolder | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  await exec(`UPDATE folders SET name = $1, updated_at = $2 WHERE id = $3`, [
    trimmed,
    now(),
    id,
  ]);
  return getFolderById(id);
}

export async function setFolderSortOrder(
  id: string,
  sortOrder: number,
): Promise<void> {
  await exec(`UPDATE folders SET sort_order = $1, updated_at = $2 WHERE id = $3`, [
    sortOrder,
    now(),
    id,
  ]);
}

/** Delete folder; playlists inside move to root. */
export async function deleteFolder(id: string): Promise<boolean> {
  const existing = await getFolderById(id);
  if (!existing) return false;
  const ts = now();
  const maxRoot = await queryOne<{ n: number }>(
    `SELECT COALESCE(MAX(s), -1)::int AS n FROM (
       SELECT sort_order AS s FROM projects WHERE user_id = $1 AND folder_id IS NULL
       UNION ALL
       SELECT sort_order AS s FROM folders WHERE user_id = $1 AND id <> $2
     ) t`,
    [existing.user_id, id],
  );
  let next = (maxRoot?.n ?? -1) + 1;
  const children = await query<{ id: string }>(
    `SELECT id FROM projects WHERE folder_id = $1 ORDER BY sort_order ASC, name ASC`,
    [id],
  );
  for (const child of children) {
    await exec(
      `UPDATE projects SET folder_id = NULL, sort_order = $1, updated_at = $2 WHERE id = $3`,
      [next++, ts, child.id],
    );
  }
  await exec(`DELETE FROM folders WHERE id = $1`, [id]);
  return true;
}
