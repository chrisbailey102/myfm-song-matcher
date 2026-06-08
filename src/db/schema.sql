CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  spotify_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brief TEXT DEFAULT '',
  playlist_id TEXT,
  playlist_name TEXT,
  playlist_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  year TEXT,
  spotify_id_locked TEXT,
  spotify_id_resolved TEXT NOT NULL,
  spotify_url TEXT,
  spotify_name TEXT,
  spotify_artists TEXT,
  duration_ms INTEGER DEFAULT 0,
  popularity INTEGER DEFAULT 0,
  spotify_key INTEGER DEFAULT -1,
  spotify_mode INTEGER DEFAULT -1,
  tempo REAL DEFAULT 0,
  tempo_override REAL,
  camelot TEXT DEFAULT '',
  camelot_override TEXT,
  time_signature INTEGER DEFAULT 4,
  energy REAL DEFAULT 0,
  danceability REAL DEFAULT 0,
  match_confidence REAL DEFAULT 0,
  needs_review BOOLEAN DEFAULT FALSE,
  review_reason TEXT DEFAULT '',
  bpm_key_source TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(project_id, spotify_id_resolved)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  progress_total INTEGER DEFAULT 0,
  progress_label TEXT DEFAULT '',
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_songs_project ON songs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
