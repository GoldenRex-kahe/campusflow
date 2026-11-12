-- Phase 2: phone lock, QR attendance, linked PCs.

-- the one phone an account is locked to (only its public key is stored, never the private key or fingerprint)
CREATE TABLE devices (
    id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key       text NOT NULL,          -- Ed25519 public key, base64
    hardware_id_hash text NOT NULL,          -- hash of the phone's id, to stop one phone serving two students
    platform         text,
    model            text,
    last_sig_time    bigint NOT NULL DEFAULT 0, -- each signed request must be newer than the last (no replays)
    created_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at       timestamptz
);
CREATE UNIQUE INDEX devices_one_active_per_user ON devices (user_id) WHERE revoked_at IS NULL;

-- one attendance session = one class period where faculty showed the QR
CREATE TABLE attendance_sessions (
    id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_subject_id integer NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    faculty_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret           text NOT NULL,          -- used to make the rotating QR codes
    started_at       timestamptz NOT NULL DEFAULT now(),
    ended_at         timestamptz,
    last_lat         double precision,       -- faculty phone location, updated every few seconds
    last_lng         double precision,
    last_accuracy    double precision,
    last_location_at timestamptz
);
CREATE UNIQUE INDEX attendance_one_open_per_faculty ON attendance_sessions (faculty_id) WHERE ended_at IS NULL;

-- the result for each student in a session
CREATE TABLE attendance_records (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  integer NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    student_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      text NOT NULL CHECK (status IN ('present', 'flagged', 'absent')),
    reason      text,
    distance_m  double precision,
    decided_by  integer REFERENCES users(id) ON DELETE SET NULL,  -- faculty who reviewed or added by hand
    decided_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, student_id)
);

-- every scan attempt, even rejected ones (for review and the AI proxy detector later)
CREATE TABLE attendance_attempts (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  integer REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    student_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   integer REFERENCES devices(id) ON DELETE SET NULL,
    result      text NOT NULL,              -- present / flagged / rejected
    reason      text,
    lat         double precision,
    lng         double precision,
    accuracy    double precision,
    mocked      boolean,
    distance_m  double precision,
    ip          text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- PCs linked to a faculty phone (like WhatsApp Web)
CREATE TABLE linked_pcs (
    id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    faculty_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent   text,
    ip           text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at   timestamptz
);

-- a PC showing a "link me" QR, waiting for a faculty phone to scan it
CREATE TABLE link_requests (
    id               text PRIMARY KEY,
    code_hash        text NOT NULL,
    poll_secret_hash text NOT NULL,
    faculty_id       integer REFERENCES users(id) ON DELETE CASCADE,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'used')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL
);

-- login tokens of a linked PC end when the link is removed
ALTER TABLE refresh_tokens ADD COLUMN linked_pc_id integer REFERENCES linked_pcs(id) ON DELETE CASCADE;
