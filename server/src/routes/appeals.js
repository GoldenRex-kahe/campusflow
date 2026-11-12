// Attendance appeals.
// A student who was not marked present (absent, flagged, or could not scan) can ask,
// within 7 days, to be marked present, with a reason. The subject faculty approves or rejects.
const express = require("express");
const clock = require("../clock");
const db = require("../db");
const v = require("../validate");
const { requireLogin, requireRole } = require("../middleware");
const { audit } = require("../audit");

const router = express.Router();
const APPEAL_DAYS = 7;

// ---------- Student ----------

// my classes of the last 14 days where I am not marked present, with any appeal I sent
router.get("/mine", requireLogin, requireRole("student"), async (req, res) => {
    res.json((await db.query(
        `SELECT s.id AS session_id, s.started_at, sub.code, sub.name AS subject,
                coalesce(r.status, 'absent') AS status, r.reason AS record_reason,
                ap.id AS appeal_id, ap.status AS appeal_status, ap.note AS appeal_note,
                (s.started_at > $2::timestamptz - make_interval(days => $3)) AS can_appeal
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         JOIN attendance_sessions s ON s.class_subject_id = cs.id AND s.ended_at IS NOT NULL
         LEFT JOIN attendance_records r ON r.session_id = s.id AND r.student_id = cl.student_id
         LEFT JOIN attendance_appeals ap ON ap.session_id = s.id AND ap.student_id = cl.student_id
         WHERE cl.student_id = $1 AND s.started_at > $2::timestamptz - interval '14 days'
           AND (r.status IS NULL OR r.status <> 'present' OR ap.id IS NOT NULL)
         ORDER BY s.started_at DESC`, [req.user.id, clock.now(), APPEAL_DAYS]
    )).rows);
});

router.post("/", requireLogin, requireRole("student"), async (req, res) => {
    const sessionId = v.id(req.body.sessionId, "Class");
    const reason = v.text(req.body.reason, "Reason", { max: 500 });

    const s = (await db.query(
        `SELECT s.id, s.ended_at, s.started_at > $3::timestamptz - make_interval(days => $4) AS recent, r.status
         FROM attendance_sessions s
         JOIN class_subjects cs ON cs.id = s.class_subject_id
         JOIN class_students cl ON cl.class_id = cs.class_id AND cl.student_id = $2
         LEFT JOIN attendance_records r ON r.session_id = s.id AND r.student_id = $2
         WHERE s.id = $1`, [sessionId, req.user.id, clock.now(), APPEAL_DAYS]
    )).rows[0];
    if (!s) throw new v.BadInput("Class not found", 404);
    if (!s.ended_at) throw new v.BadInput("Attendance for this class is still open. Scan the QR instead.", 409);
    if (s.status === "present") throw new v.BadInput("You are already marked present for this class", 409);
    if (!s.recent) throw new v.BadInput(`Appeals can be sent only within ${APPEAL_DAYS} days of the class`, 409);

    const row = (await db.query(
        "INSERT INTO attendance_appeals (session_id, student_id, reason) VALUES ($1, $2, $3) RETURNING id",
        [sessionId, req.user.id, reason]
    )).rows[0];
    await audit(req, "appeal_sent", { appealId: row.id, sessionId });
    res.status(201).json({ id: row.id });
});

// ---------- Faculty ----------

// appeals for classes I teach (pending by default)
router.get("/", requireLogin, requireRole("faculty"), async (req, res) => {
    const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending";
    res.json((await db.query(
        `SELECT ap.id, ap.reason, ap.status, ap.note, ap.created_at, s.started_at,
                u.name, st.reg_no, c.name AS class_name, sub.code, sub.name AS subject,
                coalesce(r.status, 'absent') AS marked, r.reason AS record_reason
         FROM attendance_appeals ap
         JOIN attendance_sessions s ON s.id = ap.session_id
         JOIN class_subjects cs ON cs.id = s.class_subject_id
         JOIN classes c ON c.id = cs.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         JOIN users u ON u.id = ap.student_id JOIN students st ON st.user_id = u.id
         LEFT JOIN attendance_records r ON r.session_id = s.id AND r.student_id = ap.student_id
         WHERE ap.status = $2 AND (s.faculty_id = $1 OR cs.faculty_id = $1)
         ORDER BY ap.created_at DESC LIMIT 200`, [req.user.id, status]
    )).rows);
});

// approve (mark present) or reject: { approve: true|false, note }
router.post("/:id/decide", requireLogin, requireRole("faculty"), async (req, res) => {
    const id = v.id(req.params.id, "Appeal");
    const approve = req.body.approve === true;
    const note = String(req.body.note || "").trim().slice(0, 300) || null;

    const ap = (await db.query(
        `SELECT ap.id, ap.session_id, ap.student_id, ap.reason FROM attendance_appeals ap
         JOIN attendance_sessions s ON s.id = ap.session_id JOIN class_subjects cs ON cs.id = s.class_subject_id
         WHERE ap.id = $1 AND ap.status = 'pending' AND (s.faculty_id = $2 OR cs.faculty_id = $2)`, [id, req.user.id]
    )).rows[0];
    if (!ap) throw new v.BadInput("Appeal not found or already decided", 404);

    await db.transaction(async (tx) => {
        await tx.query(
            "UPDATE attendance_appeals SET status = $1, decided_by = $2, decided_at = now(), note = $3 WHERE id = $4",
            [approve ? "approved" : "rejected", req.user.id, note, id]
        );
        if (approve) {
            await tx.query(
                `INSERT INTO attendance_records (session_id, student_id, status, reason, decided_by, decided_at)
                 VALUES ($1, $2, 'present', $3, $4, now())
                 ON CONFLICT (session_id, student_id) DO UPDATE
                 SET status = 'present', reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by, decided_at = now()`,
                [ap.session_id, ap.student_id, "Appeal approved: " + ap.reason, req.user.id]
            );
        }
    });
    await audit(req, approve ? "appeal_approved" : "appeal_rejected", { appealId: id, note });
    res.json({ status: approve ? "approved" : "rejected" });
});

module.exports = router;
