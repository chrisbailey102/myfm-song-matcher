import type { EnrichedSong } from "./types.js";

type WithOverrides = {
  tempo: number;
  tempo_override?: number | null;
  camelot: string;
  camelot_override?: string | null;
};

export function effectiveTempo(s: WithOverrides): number {
  if (s.tempo_override != null && Number.isFinite(s.tempo_override) && s.tempo_override > 0) {
    return s.tempo_override;
  }
  return s.tempo;
}

export function effectiveCamelot(s: WithOverrides): string {
  const o = s.camelot_override?.trim();
  if (o) return o.toUpperCase();
  return s.camelot;
}

export function enrichedForPairing(songs: EnrichedSong[]): EnrichedSong[] {
  return songs.map((s) => ({
    ...s,
    tempo: effectiveTempo(s),
    camelot: effectiveCamelot(s),
  }));
}
