export type CatalogRow = {
  artist: string;
  title: string;
  year?: string;
  /** If set, enrichment skips search and uses this Spotify track id */
  spotify_id?: string;
  /** ISRC from Spotify track external_ids (when known) */
  isrc?: string;
};

export type EnrichedSong = CatalogRow & {
  spotify_id_resolved: string;
  spotify_url: string;
  spotify_name: string;
  spotify_artists: string;
  duration_ms: number;
  popularity: number;
  /** Spotify audio-features key 0–11, or -1 unknown */
  spotify_key: number;
  /** 0 minor, 1 major, -1 unknown */
  spotify_mode: number;
  tempo: number;
  time_signature: number;
  energy: number;
  danceability: number;
  camelot: string;
  /** 0–1 heuristic from resolver */
  match_confidence: number;
  needs_review: boolean;
  review_reason: string;
  /** Filled after `myfm lyrics` */
  lyrics_source?: string;
  lyrics_fetched_at?: string;
  /** spotify | reccobeats | brizm | getsongbpm — where BPM/key came from */
  bpm_key_source?: string;
  /** Manual corrections (UI); used for pairing when set */
  tempo_override?: number | null;
  camelot_override?: string | null;
};

export type PairCandidate = {
  song_a_artist: string;
  song_a_title: string;
  song_a_spotify_id: string;
  song_b_artist: string;
  song_b_title: string;
  song_b_spotify_id: string;
  bpm_a: number;
  bpm_b: number;
  bpm_delta: number;
  camelot_a: string;
  camelot_b: string;
  key_relationship: string;
  /** 0–1 combined harmonic + bpm closeness */
  harmonic_score: number;
  lyric_score: number;
  bridge_phrases: string;
  notes: string;
};
