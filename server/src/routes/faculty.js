// Faculty routes. A faculty member can only touch the classes and subjects
// the admin assigned to them, and only see the mentor groups they lead.
const express = require("express");
const db = require("../db");
const v = require("../validate");
const { requireLogin, requireRole } = require("../middleware");
const { audit } = require("../audit");

const router = express.Router();
router.use(requireLogin, requireRole("faculty"));

// throws 404 if this class-subject is not assigned to this faculty member
async function ownClassSubject(facultyId, classSubjectId) {
    const row = (await db.query(
        `SELECT cs.id, cs.class_id, c.name AS class_name, sub.code, sub.name AS subject
         FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE cs.id = $1 AND cs.faculty_id = $2`, [classSubjectId, facultyId]
    )).rows[0];
    if (!row) throw new v.BadInput("This class is not assigned to you", 404);
    return row;
}

async function ownAssessment(facultyId, assessmentId) {
    const a = (await db.query(
        `SELECT a.id, a.name, a.max_marks::float8 AS max_marks, a.class_subject_id
         FROM assessments a JOIN class_subjects cs ON cs.id = a.class_subject_id
         WHERE a.id = $1 AND cs.faculty_id = $2`, [assessmentId, facultyId]
    )).rows[0];
    if (!a) throw new v.BadInput("This assessment is not yours", 404);
    return a;
}

// the classes and subjects I teach
router.get("/classes", async (req, res) => {
    res.json((await db.query(
        `SELECT cs.id, c.name AS class_name, sub.code, sub.name AS subject,
                (SELECT count(*)::int FROM class_students x WHERE x.class_id = cs.class_id) AS students
         FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE cs.faculty_id = $1 ORDER BY c.name, sub.code`, [req.user.id]
    )).rows);
});

router.get("/timetable", async (req, res) => {
    res.json((await db.query(
        `SELECT t.id, t.day, to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end",
                t.room, c.name AS class_name, sub.code, sub.name AS subject
         FROM timetable t JOIN class_subjects cs ON cs.id = t.class_subject_id
         JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE cs.faculty_id = $1 ORDER BY t.day, t.start_time`, [req.user.id]
    )).rows);
});

router.get("/class-subjects/:id/assessments", async (req, res) => {
    const cs = await ownClassSubject(req.user.id, v.id(req.params.id, "Class"));
    res.json((await db.query(
        `SELECT id, name, max_marks::float8 AS max_marks, to_char(held_on, 'YYYY-MM-DD') AS held_on
         FROM assessments WHERE class_subject_id = $1 ORDER BY created_at`, [cs.id]
    )).rows);
});

router.post("/class-subjects/:id/assessments", async (req, res) => {
    const cs = await ownClassSubject(req.user.id, v.id(req.params.id, "Class"));
    const name = v.text(req.body.name, "Assessment name", { max: 60 });
    const maxMarks = v.number(req.body.maxMarks, "Maximum marks", { min: 1, max: 1000 });
    const heldOn = v.date(req.body.heldOn, "Date");

    const row = (await db.query(
        `INSERT INTO assessments (class_subject_id, name, max_marks, held_on, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [cs.id, name, maxMarks, heldOn, req.user.id]
    )).rows[0];
    await audit(req, "assessment_created", { assessmentId: row.id, classSubjectId: cs.id, name });
    res.status(201).json(row);
});

// every student of the class, with their mark for this assessment (empty if not entered)
router.get("/assessments/:id/marks", async (req, res) => {
    const a = await ownAssessment(req.user.id, v.id(req.params.id, "Assessment"));
    const students = (await db.query(
        `SELECT u.id AS student_id, u.name, s.reg_no, m.marks::float8 AS marks
         FROM class_subjects cs
         JOIN class_students cl ON cl.class_id = cs.class_id
         JOIN users u ON u.id = cl.student_id
         JOIN students s ON s.user_id = u.id
         LEFT JOIN marks m ON m.assessment_id = $1 AND m.student_id = u.id
         WHERE cs.id = $2 ORDER BY s.reg_no`, [a.id, a.class_subject_id]
    )).rows;
    res.json({ assessment: a, students });
});

// save marks for many students at once: { marks: [{ studentId, marks }] }
router.put("/assessments/:id/marks", async (req, res) => {
    const a = await ownAssessment(req.user.id, v.id(req.params.id, "Assessment"));
    const list = Array.isArray(req.body.marks) ? req.body.marks : [];
    if (list.length === 0) throw new v.BadInput("No marks to save");

    const classStudents = new Set((await db.query(
        `SELECT cl.student_id FROM class_subjects cs JOIN class_students cl ON cl.class_id = cs.class_id WHERE cs.id = $1`,
        [a.class_subject_id]
    )).rows.map((r) => r.student_id));

    // check everything first, then save, so a mistake saves nothing
    const clean = list.map((item) => {
        const studentId = v.id(item.studentId, "Student");
        if (!classStudents.has(studentId)) throw new v.BadInput("A student is not in this class");
        return { studentId, marks: v.number(item.marks, "Marks", { min: 0, max: a.max_marks }) };
    });

    const changes = [];
    await db.transaction(async (tx) => {
        for (const m of clean) {
            const old = (await tx.query(
                "SELECT marks::float8 AS marks FROM marks WHERE assessment_id = $1 AND student_id = $2", [a.id, m.studentId]
            )).rows[0];
            await tx.query(
                `INSERT INTO marks (assessment_id, student_id, marks, entered_by) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (assessment_id, student_id)
                 DO UPDATE SET marks = EXCLUDED.marks, entered_by = EXCLUDED.entered_by, updated_at = now()`,
                [a.id, m.studentId, m.marks, req.user.id]
            );
            if (!old || old.marks !== m.marks) changes.push({ studentId: m.studentId, from: old ? old.marks : null, to: m.marks });
        }
    });
    await audit(req, "marks_saved", { assessmentId: a.id, changes });
    res.json({ saved: clean.length, changed: changes.length });
});

// my mentor groups: each student with their average % per subject
router.get("/mentor-groups", async (req, res) => {
    const groups = (await db.query(
        `SELECT g.id, g.name, c.name AS class_name
         FROM mentor_groups g JOIN classes c ON c.id = g.class_id
         WHERE g.mentor_id = $1 ORDER BY c.name, g.name`, [req.user.id]
    )).rows;

    for (const g of groups) {
        g.students = (await db.query(
            `SELECT u.id, u.name, s.reg_no FROM mentor_group_students mgs
             JOIN users u ON u.id = mgs.student_id JOIN students s ON s.user_id = u.id
             WHERE mgs.group_id = $1 ORDER BY s.reg_no`, [g.id]
        )).rows;

        const averages = (await db.query(
            `SELECT m.student_id, sub.code, round(avg(m.marks * 100 / a.max_marks), 1)::float8 AS percent
             FROM mentor_group_students mgs
             JOIN marks m ON m.student_id = mgs.student_id
             JOIN assessments a ON a.id = m.assessment_id
             JOIN class_subjects cs ON cs.id = a.class_subject_id
             JOIN subjects sub ON sub.id = cs.subject_id
             WHERE mgs.group_id = $1
             GROUP BY m.student_id, sub.code`, [g.id]
        )).rows;

        for (const st of g.students) {
            st.subjects = {};
            for (const row of averages.filter((x) => x.student_id === st.id)) st.subjects[row.code] = row.percent;
        }
    }
    res.json(groups);
});

module.exports = router;
