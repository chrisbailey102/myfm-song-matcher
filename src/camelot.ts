/**
 * Spotify pitch classes: 0=C, 1=C#, …, 11=B.
 * Camelot / Open Key (Mixed In Key style) for DJ harmonic mixing.
 */
const SPOTIFY_MAJOR_CAMELOT = [
  "8B",
  "3B",
  "10B",
  "5B",
  "12B",
  "7B",
  "2B",
  "9B",
  "4B",
  "11B",
  "6B",
  "1B",
] as const;

const SPOTIFY_MINOR_CAMELOT = [
  "5A",
  "12A",
  "7A",
  "2A",
  "9A",
  "4A",
  "11A",
  "6A",
  "1A",
  "8A",
  "3A",
  "10A",
] as const;

export function spotifyKeyModeToCamelot(key: number, mode: number): string {
  if (key < 0 || key > 11 || (mode !== 0 && mode !== 1)) {
    return "";
  }
  return mode === 1
    ? SPOTIFY_MAJOR_CAMELOT[key]
    : SPOTIFY_MINOR_CAMELOT[key];
}

export type ParsedCamelot = { num: number; letter: "A" | "B" };

export function parseCamelot(code: string): ParsedCamelot | null {
  const m = /^(\d{1,2})([AB])$/i.exec(code.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const letter = m[2].toUpperCase() as "A" | "B";
  if (num < 1 || num > 12) return null;
  return { num, letter };
}

/** Minimal circular distance on 1–12 clock */
function numDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

/**
 * Mixed In Key style harmonic compatibility (subset).
 * Same code, relative (same number A/B), or ±1 number same letter.
 */
export function isMikCompatible(a: string, b: string): boolean {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return false;
  if (pa.num === pb.num && pa.letter === pb.letter) return true;
  if (pa.num === pb.num && pa.letter !== pb.letter) return true;
  if (pa.letter === pb.letter && numDistance(pa.num, pb.num) === 1) return true;
  return false;
}

export function keyRelationship(a: string, b: string): string {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return "unknown";
  if (pa.num === pb.num && pa.letter === pb.letter) return "same";
  if (pa.num === pb.num && pa.letter !== pb.letter) return "relative_major_minor";
  if (pa.letter === pb.letter && numDistance(pa.num, pb.num) === 1) {
    return "adjacent_camelot_same_mode";
  }
  if (pa.letter === pb.letter) return `same_mode_number_gap_${numDistance(pa.num, pb.num)}`;
  return "other";
}

/** 0–1 higher = closer BPM for mashups */
export function bpmClosenessScore(
  bpmA: number,
  bpmB: number,
  maxDelta = 10,
): number {
  if (!Number.isFinite(bpmA) || !Number.isFinite(bpmB)) return 0;
  const d = Math.abs(bpmA - bpmB);
  if (d >= maxDelta) return 0;
  return 1 - d / maxDelta;
}

/** 0–1 harmonic component */
export function harmonicComponent(
  camelotA: string,
  camelotB: string,
  bpmA: number,
  bpmB: number,
): number {
  if (!camelotA || !camelotB) return 0;
  const k = isMikCompatible(camelotA, camelotB) ? 1 : 0;
  const b = bpmClosenessScore(bpmA, bpmB);
  return 0.55 * k + 0.45 * b;
}
