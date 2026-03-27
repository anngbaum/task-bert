CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS handle (
  id INTEGER PRIMARY KEY,
  identifier TEXT NOT NULL,
  service TEXT,
  person_centric_id TEXT,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  chat_identifier TEXT NOT NULL,
  service_name TEXT,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS message (
  id INTEGER PRIMARY KEY,
  guid TEXT UNIQUE NOT NULL,
  text TEXT,
  is_from_me BOOLEAN DEFAULT FALSE,
  date TIMESTAMPTZ,
  date_read TIMESTAMPTZ,
  date_delivered TIMESTAMPTZ,
  handle_id INTEGER,
  service TEXT,
  associated_message_type INTEGER DEFAULT 0,
  thread_originator_guid TEXT,
  balloon_bundle_id TEXT,
  has_attachments BOOLEAN DEFAULT FALSE,
  text_search TSVECTOR,
  embedding vector(768),
  embedding_skipped BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS chat_message_join (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS chat_handle_join (
  chat_id INTEGER NOT NULL,
  handle_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, handle_id)
);

CREATE TABLE IF NOT EXISTS sync_meta (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_synced TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_metadata (
  chat_id INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS key_events (
  id SERIAL PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  title TEXT NOT NULL,
  date TIMESTAMPTZ,
  removed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suggested_follow_ups (
  id SERIAL PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  title TEXT NOT NULL,
  date TIMESTAMPTZ,
  key_event_id INTEGER REFERENCES key_events(id),
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS action_items (
  id SERIAL PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TIMESTAMPTZ,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metadata_meta (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_updated TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS link_preview (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  summary TEXT,
  item_type TEXT,
  author TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_message_text_search ON message USING GIN (text_search);
CREATE INDEX IF NOT EXISTS idx_message_date ON message (date);
CREATE INDEX IF NOT EXISTS idx_message_handle_id ON message (handle_id);
CREATE INDEX IF NOT EXISTS idx_message_is_from_me ON message (is_from_me);
CREATE INDEX IF NOT EXISTS idx_message_associated_type ON message (associated_message_type);
CREATE INDEX IF NOT EXISTS idx_chat_message_join_message ON chat_message_join (message_id);
CREATE INDEX IF NOT EXISTS idx_chat_handle_join_handle ON chat_handle_join (handle_id);
CREATE INDEX IF NOT EXISTS idx_message_date_id ON message (date, id);
