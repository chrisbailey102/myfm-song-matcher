import crypto from "node:crypto";
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

export type LyricBoardBridge = {
  id: string;
  chips: LyricBoardChip[];
};

export type LyricBoardSuggestion = {
  hash: string;
  sentence: string;
  chips: LyricBoardChip[];
  score?: number;
  keyBpmMatched?: boolean;
};

export type LyricBoardCanvas = {
  /** One or more lyric bridges on the board (each is a linked chip chain). */
  bridges: LyricBoardBridge[];
  /** Cached generate results so revisiting a playlist doesn’t require regenerating. */
  suggestions: LyricBoardSuggestion[];
  suggestCursor: number;
};

export type LyricBoardRow = {
  scope_key: string;
  canvas_json: string;
  dismissed_json: string;
  updated_at: number;
};

export function libraryBoardScope(userId: string): string {
  return `library:${userId}`;
}

export function emptyCanvas(): LyricBoardCanvas {
  return { bridges: [], suggestions: [], suggestCursor: 0 };
}

export function normalizeCanvas(raw: unknown): LyricBoardCanvas {
  const empty = emptyCanvas();
  if (!raw || typeof raw !== "object") return empty;
  const j = raw as {
    bridges?: unknown;
    chips?: unknown;
    suggestions?: unknown;
    suggestCursor?: unknown;
  };

  let bridges: LyricBoardBridge[] = [];
  if (Array.isArray(j.bridges)) {
    bridges = j.bridges
      .map((b) => {
        const row = b as { id?: string; chips?: LyricBoardChip[] };
        const chips = Array.isArray(row.chips) ? row.chips : [];
        if (!chips.length) return null;
        return { id: String(row.id || crypto.randomUUID()), chips };
      })
      .filter((b): b is LyricBoardBridge => Boolean(b));
  } else if (Array.isArray(j.chips) && j.chips.length) {
    // Legacy flat chip list → one bridge
    bridges = [{ id: crypto.randomUUID(), chips: j.chips as LyricBoardChip[] }];
  }

  const suggestions = Array.isArray(j.suggestions)
    ? (j.suggestions as LyricBoardSuggestion[]).filter((s) => s && s.hash && Array.isArray(s.chips))
    : [];

  const suggestCursor =
    typeof j.suggestCursor === "number" && Number.isFinite(j.suggestCursor)
      ? Math.max(0, Math.floor(j.suggestCursor))
      : 0;

  return { bridges, suggestions, suggestCursor };
}

/** Flatten bridges for lyric-substring validation. */
export function allCanvasChips(canvas: LyricBoardCanvas): LyricBoardChip[] {
  return canvas.bridges.flatMap((b) => b.chips || []);
}

export async function getLyricBoard(scopeKey: string): Promise<{
  canvas: LyricBoardCanvas;
  dismissed: string[];
  updatedAt: number | null;
}> {
  const row = await queryOne<LyricBoardRow>(
    `SELECT scope_key, canvas_json, dismissed_json, updated_at
     FROM lyric_boards WHERE scope_key = $1`,
    [scopeKey],
  );
  if (!row) {
    return { canvas: emptyCanvas(), dismissed: [], updatedAt: null };
  }
  return {
    canvas: parseCanvas(row.canvas_json),
    dismissed: parseDismissed(row.dismissed_json),
    updatedAt: row.updated_at,
  };
}

export async function saveLyricBoard(
  scopeKey: string,
  canvas: LyricBoardCanvas,
): Promise<LyricBoardCanvas> {
  const normalized = normalizeCanvas(canvas);
  const t = now();
  const current = await getLyricBoard(scopeKey);
  await exec(
    `INSERT INTO lyric_boards (scope_key, canvas_json, dismissed_json, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope_key) DO UPDATE SET
       canvas_json = EXCLUDED.canvas_json,
       updated_at = EXCLUDED.updated_at`,
    [
      scopeKey,
      JSON.stringify(normalized),
      JSON.stringify(current.dismissed),
      t,
    ],
  );
  return normalized;
}

export async function dismissLyricBridges(
  scopeKey: string,
  hashes: string[],
): Promise<string[]> {
  const current = await getLyricBoard(scopeKey);
  const set = new Set(current.dismissed);
  for (const h of hashes) {
    if (h) set.add(h);
  }
  const dismissed = [...set].slice(-500);
  const suggestions = current.canvas.suggestions.filter((s) => !set.has(s.hash));
  const t = now();
  await exec(
    `INSERT INTO lyric_boards (scope_key, canvas_json, dismissed_json, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope_key) DO UPDATE SET
       canvas_json = EXCLUDED.canvas_json,
       dismissed_json = EXCLUDED.dismissed_json,
       updated_at = EXCLUDED.updated_at`,
    [
      scopeKey,
      JSON.stringify({ ...current.canvas, suggestions }),
      JSON.stringify(dismissed),
      t,
    ],
  );
  return dismissed;
}

function parseCanvas(raw: string): LyricBoardCanvas {
  try {
    return normalizeCanvas(JSON.parse(raw) as unknown);
  } catch {
    return emptyCanvas();
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
