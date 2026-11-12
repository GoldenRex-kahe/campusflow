-- Phase 0: users, roles and secure login.
-- Classes, mentor groups, attendance and marks come in later migrations.

CREATE TABLE users (
    id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         text NOT NULL,              -- always saved in lower case
    name          text NOT NULL,
    role          text NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
    password_hash text,                       -- only admins have a password
    totp_secret   text,                       -- admin 2FA secret
    totp_enabled  boolean NOT NULL DEFAULT false,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- extra details for students
CREATE TABLE students (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reg_no  text NOT NULL UNIQUE
);

-- one-time login codes sent by email (only a hash is stored, never the code)
CREATE TABLE email_codes (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts   integer NOT NULL DEFAULT 0,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_codes_user ON email_codes (user_id, created_at DESC);

-- long-lived login tokens (only a hash is stored)
CREATE TABLE refresh_tokens (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- who did what, when, from where
CREATE TABLE audit_log (
    id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
    action        text NOT NULL,
    details       jsonb NOT NULL DEFAULT '{}',
    ip            text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time ON audit_log (created_at DESC);
