import { exec, now, queryOne } from "./index.js";

export type LyricBoardChip = {
  id: string;
  spotifyId: string;
  artist: string;
  title: string;
  text: string;
  startMs: number | null;
  sourceIndex: number;
  x?: number;
  y?: number;
};

export type LyricBoardCanvas = {
  chips: LyricBoardChip[];
};

export type LyricBoardRow = {
  project_id: string;
  canvas_json: string;
  dismissed_json: string;
  updated_at: number;
};

export async function getLyricBoard(projectId: string): Promise<{
  canvas: LyricBoardCanvas;
  dismissed: string[];
  updatedAt: number | null;
}> {
  const row = await queryOne<LyricBoardRow>(
    `SELECT project_id, canvas_json, dismissed_json, updated_at
     FROM lyric_boards WHERE project_id = $1`,
    [projectId],
  );
  if (!row) {
    return { canvas: { chips: [] }, dismissed: [], updatedAt: null };
  }
  return {
    canvas: parseCanvas(row.canvas_json),
    dismissed: parseDismissed(row.dismissed_json),
    updatedAt: row.updated_at,
  };
}

export async function saveLyricBoard(
  projectId: string,
  canvas: LyricBoardCanvas,
): Promise<void> {
  const t = now();
  await exec(
    `INSERT INTO lyric_boards (project_id, canvas_json, dismissed_json, updated_at)
     VALUES ($1, $2, '[]', $3)
     ON CONFLICT (project_id) DO UPDATE SET
       canvas_json = EXCLUDED.canvas_json,
       updated_at = EXCLUDED.updated_at`,
    [projectId, JSON.stringify({ chips: canvas.chips || [] }), t],
  );
}

export async function dismissLyricBridges(
  projectId: string,
  hashes: string[],
): Promise<string[]> {
  const current = await getLyricBoard(projectId);
  const set = new Set(current.dismissed);
  for (const h of hashes) {
    if (h) set.add(h);
  }
  const dismissed = [...set].slice(-500);
  const t = now();
  await exec(
    `INSERT INTO lyric_boards (project_id, canvas_json, dismissed_json, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id) DO UPDATE SET
       dismissed_json = EXCLUDED.dismissed_json,
       updated_at = EXCLUDED.updated_at`,
    [
      projectId,
      JSON.stringify(current.canvas),
      JSON.stringify(dismissed),
      t,
    ],
  );
  return dismissed;
}

function parseCanvas(raw: string): LyricBoardCanvas {
  try {
    const j = JSON.parse(raw) as LyricBoardCanvas;
    return { chips: Array.isArray(j.chips) ? j.chips : [] };
  } catch {
    return { chips: [] };
  }
}

function parseDismissed(raw: string): string[] {
  try {
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}
