// Student routes: a student only ever sees their own data.
const express = require("express");
const db = require("../db");
const { requireLogin, requireRole } = require("../middleware");

const router = express.Router();
router.use(requireLogin, requireRole("student"));

router.get("/timetable", async (req, res) => {
    res.json((await db.query(
        `SELECT t.day, to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end",
                t.room, sub.code, sub.name AS subject, f.name AS faculty_name
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN timetable t ON t.class_subject_id = cs.id
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN users f ON f.id = cs.faculty_id
         WHERE cl.student_id = $1 ORDER BY t.day, t.start_time`, [req.user.id]
    )).rows);
});

router.get("/marks", async (req, res) => {
    res.json((await db.query(
        `SELECT sub.code, sub.name AS subject, a.name AS assessment, a.max_marks::float8 AS max_marks,
                m.marks::float8 AS marks
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         JOIN assessments a ON a.class_subject_id = cs.id
         LEFT JOIN marks m ON m.assessment_id = a.id AND m.student_id = cl.student_id
         WHERE cl.student_id = $1 ORDER BY sub.code, a.created_at`, [req.user.id]
    )).rows);
});

// my attendance per subject: present out of classes held (flagged scans count once a faculty member accepts them)
router.get("/attendance", async (req, res) => {
    res.json((await db.query(
        `SELECT sub.code, sub.name AS subject,
                count(s.id)::int AS held,
                count(r.id) FILTER (WHERE r.status = 'present')::int AS present,
                count(r.id) FILTER (WHERE r.status = 'flagged')::int AS waiting_review
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN attendance_sessions s ON s.class_subject_id = cs.id
         LEFT JOIN attendance_records r ON r.session_id = s.id AND r.student_id = cl.student_id
         WHERE cl.student_id = $1
         GROUP BY sub.code, sub.name ORDER BY sub.code`, [req.user.id]
    )).rows);
});

router.get("/mentor", async (req, res) => {
    const row = (await db.query(
        `SELECT g.name AS group_name, u.name AS mentor_name, u.email AS mentor_email
         FROM mentor_group_students mgs JOIN mentor_groups g ON g.id = mgs.group_id
         LEFT JOIN users u ON u.id = g.mentor_id
         WHERE mgs.student_id = $1`, [req.user.id]
    )).rows[0];
    res.json(row || null);
});

module.exports = router;
