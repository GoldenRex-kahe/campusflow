-- Phase 3: early-warning alerts and weekly digests.

-- one alert = one reason to look at a student (with the numbers behind it)
CREATE TABLE alerts (
    id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id   integer REFERENCES subjects(id) ON DELETE CASCADE,   -- null = about all subjects
    kind         text NOT NULL,      -- low_attendance, attendance_drop, absent_streak, marks_drop, low_marks, flagged_scans
    severity     text NOT NULL CHECK (severity IN ('watch', 'concern', 'urgent')),
    title        text NOT NULL,
    reason       text NOT NULL,      -- plain words with the numbers
    suggestion   text,               -- suggested next step for the faculty
    details      jsonb NOT NULL DEFAULT '{}',
    status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled', 'not_needed')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    handled_by   integer REFERENCES users(id) ON DELETE SET NULL,
    handled_at   timestamptz,
    handled_note text
);
-- at most one open alert per student, kind and subject (re-checks update it instead of adding more)
CREATE UNIQUE INDEX alerts_one_open ON alerts (student_id, kind, coalesce(subject_id, 0)) WHERE status = 'open';

-- the weekly report each faculty member got (kept for history)
CREATE TABLE digests (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start date NOT NULL,
    content    jsonb NOT NULL,
    sent_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, week_start)
);
