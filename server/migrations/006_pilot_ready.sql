-- Phase 4: pilot readiness and attendance appeals.

-- the last 2FA code time-step used by each admin: a code can be used only once
ALTER TABLE users ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;

-- a student asks to be marked present for a class (wrongly absent, phone problem, flagged scan)
CREATE TABLE attendance_appeals (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  integer NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    student_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      text NOT NULL,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_by  integer REFERENCES users(id) ON DELETE SET NULL,
    decided_at  timestamptz,
    note        text,
    UNIQUE (session_id, student_id)   -- one appeal per class
);
