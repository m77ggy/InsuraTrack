'use strict';
// SQLite database (Node's built-in node:sqlite, no install needed).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'insuratrack.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mobile        TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner','agent')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per vehicle/policy. user_id = the account that manages it
-- (an owner for their own cars, or an agent for their clients' cars).
CREATE TABLE IF NOT EXISTS vehicles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name       TEXT NOT NULL,
  owner_mobile     TEXT,
  owner_email      TEXT,
  plate_number     TEXT NOT NULL,
  insurance_expiry TEXT NOT NULL,            -- YYYY-MM-DD
  notify_sms       INTEGER NOT NULL DEFAULT 1,
  notify_email     INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicles_user   ON vehicles(user_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_expiry ON vehicles(insurance_expiry);

-- Digital Document Vault (files live in data/uploads, metadata lives here).
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('COC','ORCR','OTHER')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_vehicle ON documents(vehicle_id);

-- Every SMS / email the system sends (or simulates, or fails to send).
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  plate_number TEXT NOT NULL,
  owner_name   TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('sms','email')),
  recipient    TEXT NOT NULL,
  subject      TEXT,
  message      TEXT NOT NULL,
  days_left    INTEGER,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('auto','bulk','manual')),
  status       TEXT NOT NULL CHECK (status IN ('sent','simulated','failed')),
  error        TEXT,
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
-- Prevents the same reminder from ever being sent twice (failed attempts may retry).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
  ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL AND status != 'failed';
`);

module.exports = { db, DATA_DIR, UPLOAD_DIR };
