CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    username         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email            TEXT COLLATE NOCASE UNIQUE,
    password_hash    TEXT NOT NULL,
    gold             INTEGER NOT NULL DEFAULT 10000 CHECK (gold >= 0),
    avatar           TEXT,
    is_admin         INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    last_checkin     TEXT,
    checkin_streak   INTEGER NOT NULL DEFAULT 0,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    deleted_at_ms    INTEGER
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id),
    delta            INTEGER NOT NULL,
    balance_before   INTEGER NOT NULL,
    balance_after    INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    match_id         TEXT,
    hand_id          TEXT,
    operation_key    TEXT NOT NULL UNIQUE,
    metadata_json    TEXT,
    created_at_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_user_time
ON wallet_transactions(user_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS daily_checkins (
    user_id       TEXT NOT NULL REFERENCES users(id),
    checkin_date  TEXT NOT NULL,
    streak        INTEGER NOT NULL,
    reward        INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS user_messages (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    message_type  TEXT NOT NULL,
    text          TEXT NOT NULL,
    is_read       INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_user_read_time
ON user_messages(user_id, is_read, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS feedback (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    username      TEXT NOT NULL,
    text          TEXT NOT NULL,
    contact       TEXT,
    user_agent    TEXT,
    status        TEXT NOT NULL DEFAULT 'new',
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_time
ON feedback(created_at_ms DESC);

CREATE TABLE IF NOT EXISTS matches (
    id               TEXT PRIMARY KEY,
    room_code        TEXT NOT NULL,
    room_type        TEXT NOT NULL CHECK (room_type IN ('cash', 'sng')),
    status           TEXT NOT NULL,
    owner_user_id    TEXT NOT NULL REFERENCES users(id),
    name             TEXT NOT NULL,
    config_json      TEXT NOT NULL,
    invite_json      TEXT,
    state_version    INTEGER NOT NULL DEFAULT 0,
    started_at_ms    INTEGER,
    scheduled_end_ms INTEGER,
    ended_at_ms      INTEGER,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_status
ON matches(status, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_matches_room_code
ON matches(room_code);

CREATE TABLE IF NOT EXISTS match_players (
    match_id          TEXT NOT NULL REFERENCES matches(id),
    user_id           TEXT NOT NULL REFERENCES users(id),
    username_snapshot TEXT NOT NULL,
    seat               INTEGER,
    player_status      TEXT NOT NULL,
    buyin_gold_total   INTEGER NOT NULL DEFAULT 0,
    buyin_chips_total  INTEGER NOT NULL DEFAULT 0,
    current_chips      INTEGER NOT NULL DEFAULT 0,
    hands_played       INTEGER NOT NULL DEFAULT 0,
    settlement_gold    INTEGER,
    settled_at_ms      INTEGER,
    joined_at_ms       INTEGER NOT NULL,
    left_at_ms         INTEGER,
    PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_match_players_unsettled
ON match_players(user_id, settled_at_ms);

CREATE TABLE IF NOT EXISTS active_match_states (
    match_id      TEXT PRIMARY KEY REFERENCES matches(id),
    state_version INTEGER NOT NULL,
    hand_seq      INTEGER NOT NULL DEFAULT 0,
    phase         TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS match_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      TEXT NOT NULL REFERENCES matches(id),
    state_version INTEGER NOT NULL,
    event_type    TEXT NOT NULL,
    user_id       TEXT,
    payload_json  TEXT,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(match_id, state_version)
);

CREATE INDEX IF NOT EXISTS idx_match_events_match
ON match_events(match_id, state_version);

CREATE TABLE IF NOT EXISTS hands (
    id              TEXT PRIMARY KEY,
    match_id        TEXT NOT NULL REFERENCES matches(id),
    room_code       TEXT NOT NULL,
    hand_seq        INTEGER NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('cash', 'sng')),
    started_at_ms   INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    sb              INTEGER NOT NULL,
    bb              INTEGER NOT NULL,
    ante            INTEGER NOT NULL DEFAULT 0,
    button_user_id  TEXT,
    community_json  TEXT,
    payload_json    TEXT NOT NULL,
    UNIQUE(match_id, hand_seq)
);

CREATE INDEX IF NOT EXISTS idx_hands_match_seq
ON hands(match_id, hand_seq);

CREATE INDEX IF NOT EXISTS idx_hands_time
ON hands(started_at_ms DESC);

CREATE TABLE IF NOT EXISTS hand_players (
    hand_id           TEXT NOT NULL REFERENCES hands(id),
    user_id           TEXT NOT NULL REFERENCES users(id),
    username_snapshot TEXT NOT NULL,
    seat               INTEGER NOT NULL,
    start_chips        INTEGER NOT NULL,
    end_chips          INTEGER NOT NULL,
    won                INTEGER NOT NULL DEFAULT 0,
    hole_json          TEXT NOT NULL,
    PRIMARY KEY (hand_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_hand_players_user
ON hand_players(user_id, hand_id);

CREATE TABLE IF NOT EXISTS hand_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id    TEXT NOT NULL REFERENCES hands(id),
    action_seq INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    street     TEXT NOT NULL,
    action     TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    think_ms   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(hand_id, action_seq)
);

CREATE INDEX IF NOT EXISTS idx_hand_actions_user
ON hand_actions(user_id, hand_id);

CREATE TABLE IF NOT EXISTS legacy_imports (
    source_kind   TEXT NOT NULL,
    source_path   TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    imported_rows INTEGER NOT NULL,
    imported_at_ms INTEGER NOT NULL,
    PRIMARY KEY (source_kind, source_sha256)
);
