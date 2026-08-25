/**
 * Paste ARTIST - TITLE lines → resolve on Spotify → create playlist.
 */
import { resolveBestTrack, searchTracksRadioHint } from "./spotify.js";
import {
  addTracksToPlaylist,
  createUserPlaylist,
} from "./spotifyPlaylist.js";

export type ParsedArtistTitle = {
  line: string;
  lineNo: number;
  artist: string;
  title: string;
};

export type MatchedLine = ParsedArtistTitle & {
  spotifyId: string;
  uri: string;
  matchedArtist: string;
  matchedTitle: string;
  matchConfidence: number;
  needsReview: boolean;
};

export type UnmatchedLine = {
  line: string;
  lineNo: number;
  reason: string;
};

/** Prefer spaced dashes so hyphenated artists (Jay-Z - Song) still parse; allow Artist- Title etc. */
function splitArtistTitle(line: string): { artist: string; title: string } | null {
  const patterns = [
    /\s+[-–—]\s+/, // Artist - Title
    /[-–—]\s+/, // Artist- Title  / Artist– Title
    /\s+[-–—]/ // Artist -Title
  ];
  for (const re of patterns) {
    const m = re.exec(line);
    if (!m || m.index == null) continue;
    const artist = line.slice(0, m.index).trim();
    const title = line.slice(m.index + m[0].length).trim();
    if (artist && title) return { artist, title };
  }
  return null;
}

export function parseArtistTitleLines(text: string): {
  parsed: ParsedArtistTitle[];
  unmatched: UnmatchedLine[];
} {
  const parsed: ParsedArtistTitle[] = [];
  const unmatched: UnmatchedLine[] = [];
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const split = splitArtistTitle(line);
    if (!split) {
      unmatched.push({
        line,
        lineNo,
        reason: 'Expected "ARTIST - TITLE" (spacing around the dash is optional)',
      });
      return;
    }
    parsed.push({ line, lineNo, artist: split.artist, title: split.title });
  });
  return { parsed, unmatched };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimum score to accept a Spotify match into the playlist. */
const MIN_ACCEPT_SCORE = 0.48;

export async function resolveArtistTitleLines(
  rows: ParsedArtistTitle[],
): Promise<{ matched: MatchedLine[]; unmatched: UnmatchedLine[] }> {
  const matched: MatchedLine[] = [];
  const unmatched: UnmatchedLine[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const candidates = await searchTracksRadioHint(row.artist, row.title, "US");
      if (!candidates.length) {
        unmatched.push({ line: row.line, lineNo: row.lineNo, reason: "No Spotify results" });
      } else {
        const r = resolveBestTrack(row.artist, row.title, candidates);
        if (r.match_confidence < MIN_ACCEPT_SCORE) {
          unmatched.push({
            line: row.line,
            lineNo: row.lineNo,
            reason: `Weak match (${r.match_confidence.toFixed(2)}) — ${r.chosen.artists?.map((a) => a.name).join(", ")} — ${r.chosen.name}`,
          });
        } else if (seenIds.has(r.chosen.id)) {
          // Still count as matched for reporting, but don’t duplicate URI
          matched.push({
            ...row,
            spotifyId: r.chosen.id,
            uri: `spotify:track:${r.chosen.id}`,
            matchedArtist: (r.chosen.artists ?? []).map((a) => a.name).join("; "),
            matchedTitle: r.chosen.name,
            matchConfidence: r.match_confidence,
            needsReview: r.needs_review,
          });
        } else {
          seenIds.add(r.chosen.id);
          matched.push({
            ...row,
            spotifyId: r.chosen.id,
            uri: `spotify:track:${r.chosen.id}`,
            matchedArtist: (r.chosen.artists ?? []).map((a) => a.name).join("; "),
            matchedTitle: r.chosen.name,
            matchConfidence: r.match_confidence,
            needsReview: r.needs_review,
          });
        }
      }
    } catch (e) {
      unmatched.push({
        line: row.line,
        lineNo: row.lineNo,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    if (i + 1 < rows.length) await sleep(180);
  }

  return { matched, unmatched };
}

export async function createPlaylistFromArtistTitleText(
  accessToken: string,
  opts: {
    name: string;
    text: string;
    isPublic?: boolean;
  },
): Promise<{
  playlist: { id: string; name: string; url: string };
  matched: MatchedLine[];
  unmatched: UnmatchedLine[];
  tracksAdded: number;
}> {
  const name = String(opts.name || "").trim() || "Song Matcher playlist";
  const { parsed, unmatched: parseUnmatched } = parseArtistTitleLines(opts.text);
  if (!parsed.length && !parseUnmatched.length) {
    throw new Error("Paste at least one ARTIST - TITLE line.");
  }
  if (!parsed.length) {
    throw new Error("No valid ARTIST - TITLE lines found.");
  }

  const { matched, unmatched: resolveUnmatched } = await resolveArtistTitleLines(parsed);
  const unmatched = [...parseUnmatched, ...resolveUnmatched].sort(
    (a, b) => a.lineNo - b.lineNo,
  );

  if (!matched.length) {
    throw new Error("Could not match any lines to Spotify tracks.");
  }

  const playlist = await createUserPlaylist(accessToken, {
    name,
    description: "Created with Song Matcher from a pasted track list",
    isPublic: opts.isPublic === true,
  });

  const uris = [...new Set(matched.map((m) => m.uri))];
  const tracksAdded = await addTracksToPlaylist(accessToken, playlist.id, uris);

  return { playlist, matched, unmatched, tracksAdded };
}
