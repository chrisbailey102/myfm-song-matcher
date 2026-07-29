import { exec, newId, now, query, queryOne } from "./index.js";
import { setFolderSortOrder } from "./folders.js";

export type DbProject = {
  id: string;
  user_id: string;
  name: string;
  brief: string;
  playlist_id: string | null;
  playlist_name: string | null;
  playlist_url: string | null;
  folder_id: string | null;
  sort_order: number;
  status: string;
  created_at: number;
  updated_at: number;
};

export async function nextRootSortOrder(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COALESCE(MAX(s), -1)::int + 1 AS n FROM (
       SELECT sort_order AS s FROM projects WHERE user_id = $1 AND folder_id IS NULL
       UNION ALL
       SELECT sort_order AS s FROM folders WHERE user_id = $1
     ) t`,
    [userId],
  );
  return row?.n ?? 0;
}

export async function nextFolderSortOrder(
  userId: string,
  folderId: string,
): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS n
     FROM projects WHERE user_id = $1 AND folder_id = $2`,
    [userId, folderId],
  );
  return row?.n ?? 0;
}

export async function createProject(input: {
  user_id: string;
  name: string;
  brief?: string;
  playlist_id?: string;
  playlist_name?: string;
  playlist_url?: string;
  status?: string;
  folder_id?: string | null;
  sort_order?: number;
}): Promise<DbProject> {
  const id = newId();
  const ts = now();
  const sort_order =
    input.sort_order ??
    (input.folder_id
      ? await nextFolderSortOrder(input.user_id, input.folder_id)
      : await nextRootSortOrder(input.user_id));
  await exec(
    `INSERT INTO projects (
      id, user_id, name, brief, playlist_id, playlist_name, playlist_url,
      folder_id, sort_order, status, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [
      id,
      input.user_id,
      input.name,
      input.brief ?? "",
      input.playlist_id ?? null,
      input.playlist_name ?? null,
      input.playlist_url ?? null,
      input.folder_id ?? null,
      sort_order,
      input.status ?? "importing",
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
    `SELECT * FROM projects WHERE user_id = $1 ORDER BY sort_order ASC, name ASC`,
    [userId],
  );
}

export type ProjectWithCount = DbProject & { song_count: number };

export async function listProjectsWithCounts(
  userId: string,
): Promise<ProjectWithCount[]> {
  return query<ProjectWithCount>(
    `SELECT p.*, COALESCE(c.cnt, 0)::int AS song_count
     FROM projects p
     LEFT JOIN (
       SELECT project_id, COUNT(*)::int AS cnt FROM songs GROUP BY project_id
     ) c ON c.project_id = p.id
     WHERE p.user_id = $1
     ORDER BY p.sort_order ASC, p.name ASC`,
    [userId],
  );
}

export async function updateProjectName(
  id: string,
  name: string,
): Promise<DbProject | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  await exec(`UPDATE projects SET name = $1, updated_at = $2 WHERE id = $3`, [
    trimmed,
    now(),
    id,
  ]);
  return getProjectById(id);
}

export async function updateProjectSpotifyMeta(
  id: string,
  meta: { name?: string; playlist_name?: string; playlist_url?: string },
): Promise<void> {
  await exec(
    `UPDATE projects SET
      name = COALESCE($1, name),
      playlist_name = COALESCE($2, playlist_name),
      playlist_url = COALESCE($3, playlist_url),
      updated_at = $4
     WHERE id = $5`,
    [
      meta.name ?? null,
      meta.playlist_name ?? null,
      meta.playlist_url ?? null,
      now(),
      id,
    ],
  );
}

export async function setProjectSortOrder(
  id: string,
  sortOrder: number,
): Promise<void> {
  await exec(`UPDATE projects SET sort_order = $1, updated_at = $2 WHERE id = $3`, [
    sortOrder,
    now(),
    id,
  ]);
}

export async function setProjectFolder(
  projectId: string,
  folderId: string | null,
  userId: string,
): Promise<DbProject | null> {
  const sort_order = folderId
    ? await nextFolderSortOrder(userId, folderId)
    : await nextRootSortOrder(userId);
  await exec(
    `UPDATE projects SET folder_id = $1, sort_order = $2, updated_at = $3 WHERE id = $4`,
    [folderId, sort_order, now(), projectId],
  );
  return getProjectById(projectId);
}

type RootItem = { kind: "folder" | "project"; id: string; sort_order: number };

async function listRootItems(userId: string): Promise<RootItem[]> {
  const projects = await query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM projects WHERE user_id = $1 AND folder_id IS NULL`,
    [userId],
  );
  const folders = await query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM folders WHERE user_id = $1`,
    [userId],
  );
  return [
    ...folders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      sort_order: f.sort_order,
    })),
    ...projects.map((p) => ({
      kind: "project" as const,
      id: p.id,
      sort_order: p.sort_order,
    })),
  ].sort(
    (a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id),
  );
}

async function applyRootSort(item: RootItem, sortOrder: number): Promise<void> {
  if (item.kind === "folder") await setFolderSortOrder(item.id, sortOrder);
  else await setProjectSortOrder(item.id, sortOrder);
}

export async function moveRootItem(
  userId: string,
  kind: "folder" | "project",
  id: string,
  direction: -1 | 1,
): Promise<boolean> {
  const items = await listRootItems(userId);
  const idx = items.findIndex((i) => i.kind === kind && i.id === id);
  const j = idx + direction;
  if (idx < 0 || j < 0 || j >= items.length) return false;
  const a = items[idx];
  const b = items[j];
  const ao = a.sort_order;
  const bo = b.sort_order;
  if (ao === bo) {
    // Reindex then swap neighbors
    for (let i = 0; i < items.length; i++) {
      await applyRootSort(items[i], i);
    }
    return moveRootItem(userId, kind, id, direction);
  }
  await applyRootSort(a, bo);
  await applyRootSort(b, ao);
  return true;
}

export async function moveProjectInFolder(
  userId: string,
  projectId: string,
  direction: -1 | 1,
): Promise<boolean> {
  const project = await getProjectById(projectId);
  if (!project || project.user_id !== userId || !project.folder_id) return false;
  const siblings = await query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM projects
     WHERE user_id = $1 AND folder_id = $2
     ORDER BY sort_order ASC, name ASC`,
    [userId, project.folder_id],
  );
  const idx = siblings.findIndex((s) => s.id === projectId);
  const j = idx + direction;
  if (idx < 0 || j < 0 || j >= siblings.length) return false;
  const a = siblings[idx];
  const b = siblings[j];
  if (a.sort_order === b.sort_order) {
    for (let i = 0; i < siblings.length; i++) {
      await setProjectSortOrder(siblings[i].id, i);
    }
    return moveProjectInFolder(userId, projectId, direction);
  }
  await setProjectSortOrder(a.id, b.sort_order);
  await setProjectSortOrder(b.id, a.sort_order);
  return true;
}

export async function deleteProject(id: string): Promise<boolean> {
  const existing = await getProjectById(id);
  if (!existing) return false;
  await exec(`DELETE FROM projects WHERE id = $1`, [id]);
  return true;
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
