// Admin only: subjects, classes, assigning faculty, mentor groups, timetable.
// Only the admin can assign classes (checked here on the server).
const express = require("express");
const db = require("../db");
const v = require("../validate");
const { requireLogin, requireRole, requireAdmin2FA } = require("../middleware");
const { audit } = require("../audit");

const router = express.Router();
router.use(requireLogin, requireRole("admin"), requireAdmin2FA);

const MENTOR_GROUP_SIZE = 15;

async function userWithRole(userId, role) {
    const u = (await db.query("SELECT id FROM users WHERE id = $1 AND role = $2 AND is_active", [userId, role])).rows[0];
    if (!u) throw new v.BadInput(`That ${role} does not exist`);
}

async function classExists(classId) {
    const c = (await db.query("SELECT id FROM classes WHERE id = $1", [classId])).rows[0];
    if (!c) throw new v.BadInput("Class not found", 404);
}

// ---------- Subjects ----------

router.get("/subjects", async (req, res) => {
    res.json((await db.query("SELECT id, code, name FROM subjects ORDER BY code")).rows);
});

router.post("/subjects", async (req, res) => {
    const code = v.text(req.body.code, "Subject code", { max: 20 }).toUpperCase();
    const name = v.text(req.body.name, "Subject name");
    const row = (await db.query(
        "INSERT INTO subjects (code, name) VALUES ($1, $2) RETURNING id, code, name", [code, name]
    )).rows[0];
    await audit(req, "subject_created", { subjectId: row.id, code });
    res.status(201).json(row);
});

// ---------- Classes ----------

router.get("/classes", async (req, res) => {
    res.json((await db.query(
        `SELECT c.id, c.name, count(cs.student_id)::int AS students
         FROM classes c LEFT JOIN class_students cs ON cs.class_id = c.id
         GROUP BY c.id ORDER BY c.name`
    )).rows);
});

router.post("/classes", async (req, res) => {
    const name = v.text(req.body.name, "Class name");
    const row = (await db.query("INSERT INTO classes (name) VALUES ($1) RETURNING id, name", [name])).rows[0];
    await audit(req, "class_created", { classId: row.id, name });
    res.status(201).json(row);
});

// everything about one class, for the admin class page
router.get("/classes/:id", async (req, res) => {
    const classId = v.id(req.params.id, "Class");
    const cls = (await db.query("SELECT id, name FROM classes WHERE id = $1", [classId])).rows[0];
    if (!cls) return res.status(404).json({ error: "Class not found" });

    cls.students = (await db.query(
        `SELECT u.id, u.name, u.email, s.reg_no, mgs.group_id
         FROM class_students cs
         JOIN users u ON u.id = cs.student_id
         JOIN students s ON s.user_id = u.id
         LEFT JOIN mentor_group_students mgs ON mgs.student_id = u.id
         WHERE cs.class_id = $1 ORDER BY s.reg_no`, [classId]
    )).rows;

    cls.subjects = (await db.query(
        `SELECT cs.id, sub.code, sub.name, cs.faculty_id, f.name AS faculty_name
         FROM class_subjects cs
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN users f ON f.id = cs.faculty_id
         WHERE cs.class_id = $1 ORDER BY sub.code`, [classId]
    )).rows;

    cls.mentorGroups = (await db.query(
        `SELECT g.id, g.name, g.mentor_id, m.name AS mentor_name,
                (SELECT count(*)::int FROM mentor_group_students x WHERE x.group_id = g.id) AS size
         FROM mentor_groups g LEFT JOIN users m ON m.id = g.mentor_id
         WHERE g.class_id = $1 ORDER BY g.name`, [classId]
    )).rows;

    cls.timetable = (await db.query(
        `SELECT t.id, t.class_subject_id, t.day, to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end",
                t.room, sub.code, sub.name AS subject, f.name AS faculty_name
         FROM timetable t
         JOIN class_subjects cs ON cs.id = t.class_subject_id
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN users f ON f.id = cs.faculty_id
         WHERE cs.class_id = $1 ORDER BY t.day, t.start_time`, [classId]
    )).rows;

    res.json(cls);
});

// add students to a class (a student can be in only one class)
router.post("/classes/:id/students", async (req, res) => {
    const classId = v.id(req.params.id, "Class");
    await classExists(classId);
    const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds.map((x) => v.id(x, "Student")) : [];
    if (ids.length === 0) throw new v.BadInput("Choose at least one student");

    for (const studentId of ids) {
        await userWithRole(studentId, "student");
        const already = (await db.query(
            "SELECT c.name FROM class_students cs JOIN classes c ON c.id = cs.class_id WHERE cs.student_id = $1", [studentId]
        )).rows[0];
        if (already) throw new v.BadInput(`A student is already in class ${already.name}`, 409);
    }
    // all or nothing: if one insert fails, no student is added
    await db.transaction(async (tx) => {
        for (const studentId of ids) {
            await tx.query("INSERT INTO class_students (student_id, class_id) VALUES ($1, $2)", [studentId, classId]);
        }
    });
    await audit(req, "class_students_added", { classId, count: ids.length });
    res.status(201).json({ added: ids.length });
});

router.delete("/classes/:id/students/:studentId", async (req, res) => {
    const classId = v.id(req.params.id, "Class");
    const studentId = v.id(req.params.studentId, "Student");
    await db.transaction(async (tx) => {
        await tx.query("DELETE FROM mentor_group_students WHERE student_id = $1", [studentId]);
        await tx.query("DELETE FROM class_students WHERE class_id = $1 AND student_id = $2", [classId, studentId]);
    });
    await audit(req, "class_student_removed", { classId, studentId });
    res.json({ removed: true });
});

// add a subject to a class and choose the faculty who teaches it
router.post("/classes/:id/subjects", async (req, res) => {
    const classId = v.id(req.params.id, "Class");
    await classExists(classId);
    const subjectId = v.id(req.body.subjectId, "Subject");
    const facultyId = req.body.facultyId ? v.id(req.body.facultyId, "Faculty") : null;
    if (facultyId) await userWithRole(facultyId, "faculty");

    const row = (await db.query(
        `INSERT INTO class_subjects (class_id, subject_id, faculty_id) VALUES ($1, $2, $3)
         ON CONFLICT (class_id, subject_id) DO UPDATE SET faculty_id = EXCLUDED.faculty_id
         RETURNING id`, [classId, subjectId, facultyId]
    )).rows[0];
    await audit(req, "faculty_assigned", { classId, subjectId, facultyId });
    res.status(201).json(row);
});

// ---------- Mentor groups ----------

// split all students of a class into groups of 15 (only when the class has no groups yet)
router.post("/classes/:id/mentor-groups/auto", async (req, res) => {
    const classId = v.id(req.params.id, "Class");
    await classExists(classId);
    const existing = (await db.query("SELECT 1 FROM mentor_groups WHERE class_id = $1", [classId])).rows.length;
    if (existing) throw new v.BadInput("This class already has mentor groups", 409);

    const students = (await db.query(
        `SELECT cs.student_id FROM class_students cs JOIN students s ON s.user_id = cs.student_id
         WHERE cs.class_id = $1 ORDER BY s.reg_no`, [classId]
    )).rows;
    if (students.length === 0) throw new v.BadInput("Add students to the class first");

    const groups = Math.ceil(students.length / MENTOR_GROUP_SIZE);
    await db.transaction(async (tx) => {
        for (let g = 0; g < groups; g++) {
            const group = (await tx.query(
                "INSERT INTO mentor_groups (class_id, name) VALUES ($1, $2) RETURNING id", [classId, `Group ${g + 1}`]
            )).rows[0];
            const members = students.slice(g * MENTOR_GROUP_SIZE, (g + 1) * MENTOR_GROUP_SIZE);
            for (const m of members) {
                await tx.query("INSERT INTO mentor_group_students (student_id, group_id) VALUES ($1, $2)", [m.student_id, group.id]);
            }
        }
    });
    await audit(req, "mentor_groups_created", { classId, groups });
    res.status(201).json({ groups });
});

// choose the mentor of a group
router.patch("/mentor-groups/:id", async (req, res) => {
    const groupId = v.id(req.params.id, "Group");
    const mentorId = req.body.mentorId ? v.id(req.body.mentorId, "Mentor") : null;
    if (mentorId) await userWithRole(mentorId, "faculty");
    const r = await db.query("UPDATE mentor_groups SET mentor_id = $1 WHERE id = $2 RETURNING id", [mentorId, groupId]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Group not found" });
    await audit(req, "mentor_assigned", { groupId, mentorId });
    res.json({ updated: true });
});

// move a student into a group (same class, at most 15 per group)
router.post("/mentor-groups/:id/students", async (req, res) => {
    const groupId = v.id(req.params.id, "Group");
    const studentId = v.id(req.body.studentId, "Student");

    const group = (await db.query(
        `SELECT g.class_id, (SELECT count(*)::int FROM mentor_group_students x WHERE x.group_id = g.id) AS size
         FROM mentor_groups g WHERE g.id = $1`, [groupId]
    )).rows[0];
    if (!group) return res.status(404).json({ error: "Group not found" });

    const inClass = (await db.query(
        "SELECT 1 FROM class_students WHERE student_id = $1 AND class_id = $2", [studentId, group.class_id]
    )).rows.length;
    if (!inClass) throw new v.BadInput("The student is not in this group's class");
    if (group.size >= MENTOR_GROUP_SIZE) throw new v.BadInput(`A group can have at most ${MENTOR_GROUP_SIZE} students`, 409);

    await db.query(
        `INSERT INTO mentor_group_students (student_id, group_id) VALUES ($1, $2)
         ON CONFLICT (student_id) DO UPDATE SET group_id = EXCLUDED.group_id`, [studentId, groupId]
    );
    await audit(req, "mentor_group_student_moved", { groupId, studentId });
    res.json({ moved: true });
});

// ---------- Timetable ----------

// "13:05" -> "1:05 PM" (for messages)
function ampm(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// check the form, and refuse if the class, the faculty or the room is already busy then.
// exceptId: the period being edited (it does not clash with itself)
async function checkPeriod(body, exceptId = null) {
    const classSubjectId = v.id(body.classSubjectId, "Subject");
    const day = v.number(body.day, "Day", { min: 1, max: 6 });
    const start = v.time(body.start, "Start time");
    const end = v.time(body.end, "End time");
    const room = v.text(body.room, "Room", { max: 30 });
    if (end <= start) throw new v.BadInput("End time must be after start time");

    const cs = (await db.query("SELECT class_id, faculty_id FROM class_subjects WHERE id = $1", [classSubjectId])).rows[0];
    if (!cs) throw new v.BadInput("Subject is not assigned to a class", 404);

    const clashes = (await db.query(
        `SELECT c.name AS class_name, sub.code, t.room, f.name AS faculty_name,
                to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end",
                (cs.class_id = $4) AS same_class,
                (cs.faculty_id IS NOT NULL AND cs.faculty_id = $5) AS same_faculty,
                (lower(t.room) = lower($6)) AS same_room
         FROM timetable t
         JOIN class_subjects cs ON cs.id = t.class_subject_id
         JOIN classes c ON c.id = cs.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN users f ON f.id = cs.faculty_id
         WHERE t.day = $1 AND t.start_time < $3::time AND t.end_time > $2::time
           AND ($7::int IS NULL OR t.id <> $7)
           AND (cs.class_id = $4 OR (cs.faculty_id IS NOT NULL AND cs.faculty_id = $5) OR lower(t.room) = lower($6))`,
        [day, start, end, cs.class_id, cs.faculty_id, room, exceptId]
    )).rows;

    const reasons = clashes.map((c) => {
        const why = [c.same_class && "class is busy", c.same_faculty && `${c.faculty_name} is busy`, c.same_room && `room ${c.room} is busy`]
            .filter(Boolean).join(", ");
        return `${ampm(c.start)} - ${ampm(c.end)} ${c.code} (${c.class_name}): ${why}`;
    });
    return { period: { classSubjectId, day, start, end, room }, clashes: reasons };
}

router.post("/timetable", async (req, res) => {
    const { period: p, clashes } = await checkPeriod(req.body);
    if (clashes.length) return res.status(409).json({ error: "Timetable clash", clashes });

    const row = (await db.query(
        `INSERT INTO timetable (class_subject_id, day, start_time, end_time, room)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [p.classSubjectId, p.day, p.start, p.end, p.room]
    )).rows[0];
    await audit(req, "timetable_added", { timetableId: row.id, ...p });
    res.status(201).json(row);
});

// change a period (same checks as adding)
router.patch("/timetable/:id", async (req, res) => {
    const timetableId = v.id(req.params.id, "Period");
    const old = (await db.query(
        "SELECT class_subject_id, day, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS \"end\", room FROM timetable WHERE id = $1",
        [timetableId]
    )).rows[0];
    if (!old) return res.status(404).json({ error: "Period not found" });

    const { period: p, clashes } = await checkPeriod(req.body, timetableId);
    if (clashes.length) return res.status(409).json({ error: "Timetable clash", clashes });

    await db.query(
        "UPDATE timetable SET class_subject_id = $1, day = $2, start_time = $3, end_time = $4, room = $5 WHERE id = $6",
        [p.classSubjectId, p.day, p.start, p.end, p.room, timetableId]
    );
    await audit(req, "timetable_changed", { timetableId, from: old, to: p });
    res.json({ updated: true });
});

router.delete("/timetable/:id", async (req, res) => {
    const timetableId = v.id(req.params.id, "Period");
    await db.query("DELETE FROM timetable WHERE id = $1", [timetableId]);
    await audit(req, "timetable_deleted", { timetableId });
    res.json({ deleted: true });
});

module.exports = router;
