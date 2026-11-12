// Phase 3 routes: summaries, early-warning alerts, weekly digest.
const express = require("express");
const db = require("../db");
const v = require("../validate");
const ai = require("../ai");
const ins = require("../insights");
const { requireLogin, requireRole, requireAdmin2FA } = require("../middleware");
const { audit } = require("../audit");

const router = express.Router();
const faculty = [requireLogin, requireRole("faculty")];
const admin = [requireLogin, requireRole("admin"), requireAdmin2FA];

// alerts this faculty member may see: students they mentor, or a subject alert for a subject they teach that student
const VISIBLE = `(
    EXISTS (SELECT 1 FROM mentor_group_students mgs JOIN mentor_groups g ON g.id = mgs.group_id
            WHERE mgs.student_id = a.student_id AND g.mentor_id = $1)
    OR (a.subject_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM class_students cl JOIN class_subjects cs ON cs.class_id = cl.class_id
            WHERE cl.student_id = a.student_id AND cs.subject_id = a.subject_id AND cs.faculty_id = $1)))`;

async function canSeeStudent(facultyId, studentId) {
    const r = (await db.query(
        `SELECT 1 FROM class_students cl
         WHERE cl.student_id = $2 AND (
            EXISTS (SELECT 1 FROM class_subjects cs WHERE cs.class_id = cl.class_id AND cs.faculty_id = $1)
            OR EXISTS (SELECT 1 FROM mentor_group_students mgs JOIN mentor_groups g ON g.id = mgs.group_id
                       WHERE mgs.student_id = cl.student_id AND g.mentor_id = $1))`, [facultyId, studentId]
    )).rows[0];
    return !!r;
}

// ---------- Student ----------

router.get("/student/summary", requireLogin, requireRole("student"), async (req, res) => {
    const stats = await ins.studentStats(req.user.id);
    const lines = ins.studentSummaryText(stats);
    const written = await ai.rewrite(lines, "student");
    const alerts = (await db.query(
        `SELECT a.kind, a.details, sub.code FROM alerts a LEFT JOIN subjects sub ON sub.id = a.subject_id
         WHERE a.student_id = $1 AND a.status = 'open'`, [req.user.id]
    )).rows;
    const nudges = alerts.map((a) => ins.nudgeFor({ ...a, details: typeof a.details === "string" ? JSON.parse(a.details) : a.details })).filter(Boolean);
    res.json({ lines, text: written.text, by: written.by, nudges, attendance: stats.attendance, subjects: stats.subjects });
});

// ---------- Faculty ----------

router.get("/alerts", ...faculty, async (req, res) => {
    const status = ["open", "handled", "not_needed"].includes(req.query.status) ? req.query.status : "open";
    res.json((await db.query(
        `SELECT a.id, a.student_id, a.kind, a.severity, a.title, a.reason, a.suggestion, a.status,
                a.created_at, a.updated_at, a.handled_note, u.name, st.reg_no, sub.code,
                EXISTS (SELECT 1 FROM mentor_group_students mgs JOIN mentor_groups g ON g.id = mgs.group_id
                        WHERE mgs.student_id = a.student_id AND g.mentor_id = $1) AS as_mentor
         FROM alerts a JOIN users u ON u.id = a.student_id JOIN students st ON st.user_id = u.id
         LEFT JOIN subjects sub ON sub.id = a.subject_id
         WHERE a.status = $2 AND ${VISIBLE}
         ORDER BY CASE a.severity WHEN 'urgent' THEN 3 WHEN 'concern' THEN 2 ELSE 1 END DESC, a.updated_at DESC
         LIMIT 200`, [req.user.id, status]
    )).rows);
});

// "spoke to student" (handled) or "not needed", with an optional note
router.post("/alerts/:id/handle", ...faculty, async (req, res) => {
    const id = v.id(req.params.id, "Alert");
    const status = req.body.status;
    if (!["handled", "not_needed"].includes(status)) throw new v.BadInput("Status must be handled or not_needed");
    const note = String(req.body.note || "").trim().slice(0, 300) || null;

    const r = await db.query(
        `UPDATE alerts a SET status = $2, handled_by = $1, handled_at = now(), handled_note = $4
         WHERE a.id = $3 AND a.status = 'open' AND ${VISIBLE} RETURNING id`, [req.user.id, status, id, note]
    );
    if (r.rows.length === 0) throw new v.BadInput("Alert not found or already handled", 404);
    await audit(req, "alert_handled", { alertId: id, status, note });
    res.json({ updated: true });
});

// one student's summary, for their mentor or a faculty member who teaches them
router.get("/students/:id/summary", ...faculty, async (req, res) => {
    const studentId = v.id(req.params.id, "Student");
    if (!(await canSeeStudent(req.user.id, studentId))) throw new v.BadInput("Student not found", 404);
    const stats = await ins.studentStats(studentId);
    const lines = ins.studentSummaryText(stats).filter((l) => !l.startsWith("Next step"));
    const written = await ai.rewrite(lines, "faculty");
    res.json({ lines, text: written.text, by: written.by, attendance: stats.attendance, subjects: stats.subjects });
});

// how a class is doing in my subject
router.get("/class-subjects/:id/summary", ...faculty, async (req, res) => {
    const csId = v.id(req.params.id, "Class");
    const mine = (await db.query("SELECT 1 FROM class_subjects WHERE id = $1 AND faculty_id = $2", [csId, req.user.id])).rows[0];
    if (!mine) throw new v.BadInput("This class is not assigned to you", 404);
    const s = await ins.classSummary(csId);
    const written = await ai.rewrite(s.lines, "faculty");
    res.json({ ...s, text: written.text, by: written.by });
});

// this week's digest, built now (the same content is emailed on Monday morning)
router.get("/digest", ...faculty, async (req, res) => {
    res.json(await ins.buildDigest(req.user.id));
});

// ---------- Admin ----------

router.post("/run", ...admin, async (req, res) => {
    const result = await ins.runChecks();
    await audit(req, "insights_run", result);
    res.json(result);
});

router.post("/digests/send", ...admin, async (req, res) => {
    const result = await ins.sendWeeklyDigests();
    await audit(req, "digests_sent", result);
    res.json(result);
});

router.get("/admin/alerts", ...admin, async (req, res) => {
    res.json((await db.query(
        `SELECT a.id, a.kind, a.severity, a.title, a.reason, a.status, a.updated_at, u.name, st.reg_no, sub.code, c.name AS class_name,
                (SELECT m.name FROM mentor_group_students mgs JOIN mentor_groups g ON g.id = mgs.group_id
                 JOIN users m ON m.id = g.mentor_id WHERE mgs.student_id = a.student_id) AS mentor_name
         FROM alerts a JOIN users u ON u.id = a.student_id JOIN students st ON st.user_id = u.id
         LEFT JOIN subjects sub ON sub.id = a.subject_id
         LEFT JOIN class_students cl ON cl.student_id = a.student_id LEFT JOIN classes c ON c.id = cl.class_id
         WHERE a.status = 'open'
         ORDER BY CASE a.severity WHEN 'urgent' THEN 3 WHEN 'concern' THEN 2 ELSE 1 END DESC, a.updated_at DESC LIMIT 300`
    )).rows);
});

router.get("/status", ...admin, async (req, res) => {
    res.json({ ai: ai.enabled() ? `on (${ai.MODEL})` : "off (rules only)", rules: ins.RULES });
});

module.exports = router;
