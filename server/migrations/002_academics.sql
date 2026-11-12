-- Phase 1: subjects, classes, who teaches what, mentor groups, timetable, marks.

CREATE TABLE subjects (
    id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,      -- for example CS201
    name text NOT NULL
);

-- a class = one section of students, for example "CSE-A 2nd year"
CREATE TABLE classes (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- each student belongs to exactly one class
CREATE TABLE class_students (
    student_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    class_id   integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE
);

-- which faculty teaches which subject to which class (assigned only by admin)
CREATE TABLE class_subjects (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_id   integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    subject_id integer NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    faculty_id integer REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (class_id, subject_id)
);

-- mentor groups of up to 15 students inside a class
CREATE TABLE mentor_groups (
    id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_id  integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    name      text NOT NULL,
    mentor_id integer REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (class_id, name)
);

-- each student is in at most one mentor group
CREATE TABLE mentor_group_students (
    student_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    group_id   integer NOT NULL REFERENCES mentor_groups(id) ON DELETE CASCADE
);

-- weekly timetable: day 1 = Monday ... 6 = Saturday
CREATE TABLE timetable (
    id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_subject_id integer NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    day              smallint NOT NULL CHECK (day BETWEEN 1 AND 6),
    start_time       time NOT NULL,
    end_time         time NOT NULL,
    room             text NOT NULL,
    CHECK (end_time > start_time)
);

-- a test or exam, for example "Internal 1" out of 50
CREATE TABLE assessments (
    id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_subject_id integer NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
    name             text NOT NULL,
    max_marks        numeric(6,2) NOT NULL CHECK (max_marks > 0),
    held_on          date,
    created_by       integer REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (class_subject_id, name)
);

CREATE TABLE marks (
    assessment_id integer NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    student_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    marks         numeric(6,2) NOT NULL CHECK (marks >= 0),
    entered_by    integer REFERENCES users(id) ON DELETE SET NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (assessment_id, student_id)
);
