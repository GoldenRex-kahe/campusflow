-- Attendance follows the timetable:
-- one session per timetable period per day, QR open only for the first 20 minutes,
-- reopening needs a request approved by the admin.

ALTER TABLE attendance_sessions ADD COLUMN timetable_id integer REFERENCES timetable(id) ON DELETE SET NULL;
ALTER TABLE attendance_sessions ADD COLUMN session_date date;
ALTER TABLE attendance_sessions ADD COLUMN closes_at timestamptz;   -- the QR stops working at this time

-- the same period on the same day is always the same session (restarting continues it)
CREATE UNIQUE INDEX attendance_one_per_period ON attendance_sessions (timetable_id, session_date)
    WHERE timetable_id IS NOT NULL;

-- "please let me open the QR again" for one period on one day
CREATE TABLE reopen_requests (
    id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timetable_id integer NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
    session_date date NOT NULL,
    faculty_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason       text NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by   integer REFERENCES users(id) ON DELETE SET NULL,
    decided_at   timestamptz,
    note         text
);
CREATE UNIQUE INDEX reopen_one_active ON reopen_requests (timetable_id, session_date) WHERE status IN ('pending', 'approved');
