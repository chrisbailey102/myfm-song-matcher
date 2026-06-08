import { parseCamelot, spotifyKeyModeToCamelot } from "./camelot.js";

export type GetSongBpmMeta = {
  tempo: number;
  camelot: string;
  time_signature: number;
};

type GetSongBpmHit = {
  tempo?: number | string;
  open_key?: string;
  key_of?: string;
  time_sig?: number | string;
  title?: string;
};

/**
 * Look up BPM + Camelot (open key) via GetSongBPM.
 * Free API key: https://getsongbpm.com/api
 */
export async function fetchGetSongBpmMeta(
  artist: string,
  title: string,
  apiKey: string,
): Promise<GetSongBpmMeta | null> {
  const lookup = `song:${title} artist:${artist}`;
  const params = new URLSearchParams({
    api_key: apiKey,
    type: "both",
    lookup,
    limit: "5",
  });
  const res = await fetch(`https://api.getsongbpm.com/search/?${params.toString()}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { search?: GetSongBpmHit[] };
  const hits = data.search ?? [];
  if (!hits.length) return null;

  const hit = hits[0];
  const tempo = Number(hit.tempo);
  if (!Number.isFinite(tempo) || tempo <= 0) return null;

  let camelot = normalizeCamelot(hit.open_key);
  if (!camelot && hit.key_of) {
    camelot = keyOfToCamelot(String(hit.key_of));
  }
  const time_signature = Number(hit.time_sig) || 4;

  return { tempo, camelot, time_signature };
}

function normalizeCamelot(raw: string | undefined): string {
  if (!raw) return "";
  const c = raw.trim().toUpperCase().replace(/\s+/g, "");
  return parseCamelot(c) ? c : "";
}

/** Best-effort: GetSongBPM sometimes returns "C#m" / "Am" style keys */
function keyOfToCamelot(keyOf: string): string {
  const s = keyOf.trim();
  const m = /^([A-G](?:#|b)?)\s*(m|min|minor|maj|major)?$/i.exec(s);
  if (!m) return "";
  const note = m[1].replace("b", "♭").replace("#", "♯");
  const minor = !m[2] || /^m(in(or)?)?$/i.test(m[2]);
  const pitchMap: Record<string, number> = {
    C: 0,
    "C#": 1,
    Db: 1,
    D: 2,
    "D#": 3,
    Eb: 3,
    E: 4,
    F: 5,
    "F#": 6,
    Gb: 6,
    G: 7,
    "G#": 8,
    Ab: 8,
    A: 9,
    "A#": 10,
    Bb: 10,
    B: 11,
  };
  const norm = note.replace("♭", "b").replace("♯", "#");
  const pitch = pitchMap[norm];
  if (pitch === undefined) return "";
  return spotifyKeyModeToCamelot(pitch, minor ? 0 : 1);
}
