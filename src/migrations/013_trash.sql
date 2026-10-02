CREATE TABLE IF NOT EXISTS trash_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_id     UUID NOT NULL,
  item_type       TEXT NOT NULL DEFAULT 'note' CHECK (item_type IN ('note')),
  title           TEXT NOT NULL,
  compressed_data BYTEA NOT NULL,
  compression     TEXT NOT NULL DEFAULT 'brotli' CHECK (compression IN ('brotli')),
  original_size   INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL,
  deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, original_id)
);

CREATE INDEX IF NOT EXISTS idx_trash_items_user_deleted
  ON trash_items (user_id, deleted_at DESC);
