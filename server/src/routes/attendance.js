// QR attendance, following the timetable.
// - Faculty can start attendance only during a period on today's timetable.
// - The QR is open for the first 20 minutes of the period, then closes by itself.
// - Starting again in the same period continues the same session (it is one class).
// - After the 20 minutes, the QR opens again only with a reopen request approved by the admin (10 minutes, same day).
// - A session nobody scanned can be cancelled (started by mistake).
// The student scan is checked for: registered phone + fingerprint (signature), fresh QR,
// student in the class, not marked yet, and distance to the faculty phone.
const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const config = require("../config");
const clock = require("../clock");
const db = require("../db");
const v = require("../validate");
const { requireLogin, requireRole, requireAdmin2FA } = require("../middleware");
const { requireDevice } = require("./devices");
const { audit } = require("../audit");

const router = express.Router();

const QR_SECONDS = 20;               // the QR changes this often
const FACULTY_LOCATION_MAX_AGE = 30; // seconds: older than this and the QR pauses
const BASE_RADIUS_M = 40;            // allowed distance before adding GPS inaccuracy
const WEAK_GPS_M = 100;              // accuracy worse than this = flag for review

// ---------- helpers ----------

// "13:05" -> "1:05 PM"
function ampm(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function qrWindow(now = clock.now().getTime()) {
    return Math.floor(now / (QR_SECONDS * 1000));
}

function qrSignature(secret, sessionId, window) {
    return crypto.createHmac("sha256", secret).update(`${sessionId}.${window}`).digest("base64url").slice(0, 22);
}

function makeQrText(session, window = qrWindow()) {
    return `CF1.${session.id}.${window}.${qrSignature(session.secret, session.id, window)}`;
}

// distance in metres between two GPS points
function distanceMetres(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function readLocation(body) {
    return {
        lat: v.number(body.lat, "Latitude", { min: -90, max: 90 }),
        lng: v.number(body.lng, "Longitude", { min: -180, max: 180 }),
        accuracy: v.number(body.accuracy, "GPS accuracy", { min: 0, max: 100000 }),
    };
}

// close every session whose QR time is over (called before reading sessions)
async function closeExpired(now) {
    await db.query(
        "UPDATE attendance_sessions SET ended_at = closes_at WHERE ended_at IS NULL AND closes_at IS NOT NULL AND closes_at <= $1",
        [now]
    );
}

// today's periods of a faculty member (in the college time zone), with start/window/end as real times
async function todaysPeriods(facultyId, now, timetableId = null) {
    return (await db.query(
        `WITH local AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS t)
         SELECT t.id AS timetable_id, c.name AS class_name, sub.code, sub.name AS subject, t.room,
                to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end",
                to_char(local.t::date, 'YYYY-MM-DD') AS session_date,
                ((local.t::date + t.start_time) AT TIME ZONE $2) AS starts_at,
                ((local.t::date + t.start_time) AT TIME ZONE $2) + make_interval(mins => $3) AS window_closes_at,
                ((local.t::date + t.end_time) AT TIME ZONE $2) AS ends_at
         FROM local, timetable t
         JOIN class_subjects cs ON cs.id = t.class_subject_id
         JOIN classes c ON c.id = cs.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         WHERE cs.faculty_id = $4
           AND t.day = extract(isodow FROM local.t)
           AND ($5::int IS NULL OR t.id = $5)
         ORDER BY t.start_time`,
        [now, config.collegeTimezone, config.attendanceWindowMinutes, facultyId, timetableId]
    )).rows;
}

async function ownSession(facultyId, sessionId) {
    const s = (await db.query(
        `SELECT s.*, c.name AS class_name, sub.code, sub.name AS subject, cs.class_id,
                extract(epoch FROM $3::timestamptz - s.last_location_at)::float8 AS location_age
         FROM attendance_sessions s
         JOIN class_subjects cs ON cs.id = s.class_subject_id
         JOIN classes c ON c.id = cs.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         WHERE s.id = $1 AND s.faculty_id = $2`, [sessionId, facultyId, clock.now()]
    )).rows[0];
    if (!s) throw new v.BadInput("Session not found", 404);
    return s;
}

const faculty = [requireLogin, requireRole("faculty")];
const admin = [requireLogin, requireRole("admin"), requireAdmin2FA];

// ---------- Faculty ----------

// today's classes with what the faculty can do now
router.get("/today", ...faculty, async (req, res) => {
    const now = clock.now();
    await closeExpired(now);
    const periods = await todaysPeriods(req.user.id, now);

    for (const p of periods) {
        const s = (await db.query(
            `SELECT id, ended_at, closes_at,
                    (SELECT count(*)::int FROM attendance_records r WHERE r.session_id = s.id AND r.status = 'present') AS present
             FROM attendance_sessions s WHERE timetable_id = $1 AND session_date = $2`, [p.timetable_id, p.session_date]
        )).rows[0];
        const reqRow = (await db.query(
            `SELECT id, status, note FROM reopen_requests WHERE timetable_id = $1 AND session_date = $2
             ORDER BY requested_at DESC LIMIT 1`, [p.timetable_id, p.session_date]
        )).rows[0];
        p.session = s || null;
        p.request = reqRow || null;

        if (s && !s.ended_at) p.state = "open";                         // QR is running
        else if (now < p.starts_at) p.state = "upcoming";               // not started yet
        else if (now < p.window_closes_at) p.state = "can_start";       // inside the first 20 minutes
        else if (reqRow && reqRow.status === "approved") p.state = "reopen_approved";
        else if (reqRow && reqRow.status === "pending") p.state = "request_pending";
        else p.state = "closed";                                         // can send a reopen request
    }
    res.json(periods);
});

// my open session (if any), for the phone and the linked PC
router.get("/open", ...faculty, async (req, res) => {
    await closeExpired(clock.now());
    const s = (await db.query(
        `SELECT s.id, c.name AS class_name, sub.code, sub.name AS subject, s.started_at, s.closes_at
         FROM attendance_sessions s JOIN class_subjects cs ON cs.id = s.class_subject_id
         JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE s.faculty_id = $1 AND s.ended_at IS NULL`, [req.user.id]
    )).rows[0];
    res.json(s || null);
});

// start (or continue, or reopen) attendance for a period of today: only from the faculty phone (signed)
router.post("/sessions", ...faculty, requireDevice, async (req, res) => {
    const timetableId = v.id(req.body.timetableId, "Class period");
    const loc = readLocation(req.body);
    const now = clock.now();
    await closeExpired(now);

    const period = (await todaysPeriods(req.user.id, now, timetableId))[0];
    if (!period) throw new v.BadInput("This class is not on your timetable today", 409);
    if (now < period.starts_at) throw new v.BadInput(`This class starts at ${ampm(period.start)}. Attendance opens then.`, 409);

    const existing = (await db.query(
        "SELECT id, ended_at FROM attendance_sessions WHERE timetable_id = $1 AND session_date = $2",
        [timetableId, period.session_date]
    )).rows[0];

    // already running: just continue it
    if (existing && !existing.ended_at) return res.json({ id: existing.id, continued: true });

    const other = (await db.query("SELECT id FROM attendance_sessions WHERE faculty_id = $1 AND ended_at IS NULL", [req.user.id])).rows[0];
    if (other) throw new v.BadInput("Stop your other open attendance session first", 409);

    // inside the first 20 minutes: open until the window ends.
    // after that: only with an approved reopen request, for a few minutes.
    let closesAt = period.window_closes_at;
    let reopenRequestId = null;
    if (now >= period.window_closes_at) {
        const approved = (await db.query(
            "SELECT id FROM reopen_requests WHERE timetable_id = $1 AND session_date = $2 AND status = 'approved'",
            [timetableId, period.session_date]
        )).rows[0];
        if (!approved) {
            return res.status(409).json({
                error: `The ${config.attendanceWindowMinutes}-minute attendance time is over. Send a reopen request to the admin.`,
                needReopen: true,
            });
        }
        reopenRequestId = approved.id;
        closesAt = new Date(now.getTime() + config.reopenMinutes * 60 * 1000);
    }

    let id;
    if (existing) {
        // the same period again: continue the same session (it is one class, not a new one)
        await db.query(
            `UPDATE attendance_sessions SET ended_at = NULL, closes_at = $1,
                    last_lat = $2, last_lng = $3, last_accuracy = $4, last_location_at = $5 WHERE id = $6`,
            [closesAt, loc.lat, loc.lng, loc.accuracy, now, existing.id]
        );
        id = existing.id;
    } else {
        const cs = (await db.query("SELECT class_subject_id FROM timetable WHERE id = $1", [timetableId])).rows[0];
        id = (await db.query(
            `INSERT INTO attendance_sessions (class_subject_id, faculty_id, secret, timetable_id, session_date, closes_at,
                                              started_at, last_lat, last_lng, last_accuracy, last_location_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7) RETURNING id`,
            [cs.class_subject_id, req.user.id, crypto.randomBytes(32).toString("hex"), timetableId, period.session_date,
                closesAt, now, loc.lat, loc.lng, loc.accuracy]
        )).rows[0].id;
    }

    if (reopenRequestId) await db.query("UPDATE reopen_requests SET status = 'used' WHERE id = $1", [reopenRequestId]);
    await audit(req, existing ? "attendance_reopened" : "attendance_started", { sessionId: id, timetableId, reopenRequestId });
    res.status(existing ? 200 : 201).json({ id, continued: !!existing, closesAt });
});

// the faculty phone sends its location every few seconds while the session is open
router.post("/sessions/:id/location", ...faculty, requireDevice, async (req, res) => {
    const now = clock.now();
    await closeExpired(now);
    const s = await ownSession(req.user.id, v.id(req.params.id, "Session"));
    if (s.ended_at) throw new v.BadInput("This session has ended", 409);
    const loc = readLocation(req.body);
    await db.query(
        "UPDATE attendance_sessions SET last_lat = $1, last_lng = $2, last_accuracy = $3, last_location_at = $4 WHERE id = $5",
        [loc.lat, loc.lng, loc.accuracy, now, s.id]
    );
    res.json({ ok: true });
});

// the current QR (phone or linked PC). Paused if the phone stopped sending its location.
router.get("/sessions/:id/qr", ...faculty, async (req, res) => {
    const now = clock.now();
    await closeExpired(now);
    const s = await ownSession(req.user.id, v.id(req.params.id, "Session"));
    if (s.ended_at) return res.json({ ended: true });
    const closesIn = s.closes_at ? Math.max(0, Math.round((new Date(s.closes_at) - now) / 1000)) : null;
    if (s.location_age === null || s.location_age > FACULTY_LOCATION_MAX_AGE) {
        return res.json({ paused: true, closesIn, reason: "Waiting for the faculty phone. Keep the CampusFlow app open on the session screen." });
    }
    const text = makeQrText(s, qrWindow(now.getTime()));
    const validFor = QR_SECONDS - Math.floor((now.getTime() / 1000) % QR_SECONDS);
    res.json({ paused: false, qr: await QRCode.toDataURL(text, { margin: 1, width: 480 }), validFor, closesIn });
});

// everything about a session: who is present, flagged, not yet marked
router.get("/sessions/:id", ...faculty, async (req, res) => {
    await closeExpired(clock.now());
    const s = await ownSession(req.user.id, v.id(req.params.id, "Session"));
    const students = (await db.query(
        `SELECT u.id AS student_id, u.name, st.reg_no, r.id AS record_id, r.status, r.reason, r.distance_m
         FROM class_students cl
         JOIN users u ON u.id = cl.student_id
         JOIN students st ON st.user_id = u.id
         LEFT JOIN attendance_records r ON r.session_id = $1 AND r.student_id = u.id
         WHERE cl.class_id = $2 ORDER BY st.reg_no`, [s.id, s.class_id]
    )).rows;
    const attempts = (await db.query("SELECT count(*)::int AS n FROM attendance_attempts WHERE session_id = $1", [s.id])).rows[0].n;
    res.json({
        id: s.id,
        class_name: s.class_name,
        code: s.code,
        subject: s.subject,
        started_at: s.started_at,
        ended_at: s.ended_at,
        closes_at: s.closes_at,
        can_cancel: attempts === 0 && students.every((x) => !x.status),
        counts: {
            total: students.length,
            present: students.filter((x) => x.status === "present").length,
            flagged: students.filter((x) => x.status === "flagged").length,
        },
        students,
    });
});

router.post("/sessions/:id/stop", ...faculty, async (req, res) => {
    const s = await ownSession(req.user.id, v.id(req.params.id, "Session"));
    if (!s.ended_at) {
        await db.query("UPDATE attendance_sessions SET ended_at = $1 WHERE id = $2", [clock.now(), s.id]);
        await audit(req, "attendance_stopped", { sessionId: s.id });
    }
    res.json({ stopped: true });
});

// started by mistake: delete a session nobody has scanned (it then does not count as a class held)
router.post("/sessions/:id/cancel", ...faculty, async (req, res) => {
    const s = await ownSession(req.user.id, v.id(req.params.id, "Session"));
    const used = (await db.query(
        `SELECT (SELECT count(*) FROM attendance_records WHERE session_id = $1)
              + (SELECT count(*) FROM attendance_attempts WHERE session_id = $1) AS n`, [s.id]
    )).rows[0];
    if (Number(used.n) > 0) throw new v.BadInput("Students have already scanned in this session, so it cannot be cancelled", 409);
    await db.query("DELETE FROM attendance_sessions WHERE id = $1", [s.id]);
    await audit(req, "attendance_cancelled", { sessionId: s.id, timetableId: s.timetable_id, date: s.session_date });
    res.json({ cancelled: true });
});

// review a flagged scan, or correct a record: { status: "present" | "absent" }
router.post("/records/:id/decide", ...faculty, async (req, res) => {
    const recordId = v.id(req.params.id, "Record");
    const status = req.body.status;
    if (!["present", "absent"].includes(status)) throw new v.BadInput("Status must be present or absent");

    const r = (await db.query(
        `SELECT r.id, r.status FROM attendance_records r JOIN attendance_sessions s ON s.id = r.session_id
         WHERE r.id = $1 AND s.faculty_id = $2`, [recordId, req.user.id]
    )).rows[0];
    if (!r) throw new v.BadInput("Record not found", 404);

    await db.query(
        "UPDATE attendance_records SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3",
        [status, req.user.id, recordId]
    );
    await audit(req, "attendance_decided", { recordId, from: r.status, to: status });
    res.json({ updated: true });
});

// fallback when the app fails: faculty marks a student present by hand (with a reason, audited)
router.post("/sessions/:id/manual", ...faculty, async (req, res) => {
    const s = await ownSession(req.user.id, v.id(req.params.id, "Session"));
    const studentId = v.id(req.body.studentId, "Student");
    const reason = v.text(req.body.reason, "Reason", { max: 200 });

    const inClass = (await db.query("SELECT 1 FROM class_students WHERE student_id = $1 AND class_id = $2", [studentId, s.class_id])).rows[0];
    if (!inClass) throw new v.BadInput("The student is not in this class");

    await db.query(
        `INSERT INTO attendance_records (session_id, student_id, status, reason, decided_by, decided_at)
         VALUES ($1, $2, 'present', $3, $4, now())
         ON CONFLICT (session_id, student_id) DO UPDATE
         SET status = 'present', reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by, decided_at = now()`,
        [s.id, studentId, "Marked by hand: " + reason, req.user.id]
    );
    await audit(req, "attendance_manual", { sessionId: s.id, studentId, reason });
    res.json({ marked: true });
});

// ---------- Reopen requests ----------

// faculty: ask the admin to open the QR again for a period of today
router.post("/requests", ...faculty, async (req, res) => {
    const timetableId = v.id(req.body.timetableId, "Class period");
    const reason = v.text(req.body.reason, "Reason", { max: 300 });
    const now = clock.now();
    await closeExpired(now);

    const period = (await todaysPeriods(req.user.id, now, timetableId))[0];
    if (!period) throw new v.BadInput("This class is not on your timetable today", 409);
    if (now < period.window_closes_at) throw new v.BadInput("Attendance is still open for this class. No request needed.", 409);

    const open = (await db.query(
        "SELECT 1 FROM attendance_sessions WHERE timetable_id = $1 AND session_date = $2 AND ended_at IS NULL",
        [timetableId, period.session_date]
    )).rows[0];
    if (open) throw new v.BadInput("Attendance is already open for this class", 409);

    const row = (await db.query(
        `INSERT INTO reopen_requests (timetable_id, session_date, faculty_id, reason, requested_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [timetableId, period.session_date, req.user.id, reason, now]
    )).rows[0];
    await audit(req, "reopen_requested", { requestId: row.id, timetableId, reason });
    res.status(201).json({ id: row.id });
});

// admin: requests to decide (pending by default)
router.get("/requests", ...admin, async (req, res) => {
    const status = ["pending", "approved", "rejected", "used"].includes(req.query.status) ? req.query.status : "pending";
    res.json((await db.query(
        `SELECT r.id, r.status, r.reason, r.note, r.requested_at, to_char(r.session_date, 'YYYY-MM-DD') AS session_date,
                f.name AS faculty_name, c.name AS class_name, sub.code, sub.name AS subject,
                to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end", t.room
         FROM reopen_requests r
         JOIN users f ON f.id = r.faculty_id
         JOIN timetable t ON t.id = r.timetable_id
         JOIN class_subjects cs ON cs.id = t.class_subject_id
         JOIN classes c ON c.id = cs.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         WHERE r.status = $1 ORDER BY r.requested_at DESC LIMIT 200`, [status]
    )).rows);
});

// admin: approve or reject { approve: true|false, note }
router.post("/requests/:id/decide", ...admin, async (req, res) => {
    const id = v.id(req.params.id, "Request");
    const approve = req.body.approve === true;
    const note = String(req.body.note || "").trim().slice(0, 300) || null;

    const r = (await db.query(
        `SELECT id, session_date = ($2::timestamptz AT TIME ZONE $3)::date AS today
         FROM reopen_requests WHERE id = $1 AND status = 'pending'`, [id, clock.now(), config.collegeTimezone]
    )).rows[0];
    if (!r) throw new v.BadInput("Request not found or already decided", 404);
    if (approve && !r.today) throw new v.BadInput("This request was for an earlier day and can no longer be approved", 409);

    await db.query(
        "UPDATE reopen_requests SET status = $1, decided_by = $2, decided_at = now(), note = $3 WHERE id = $4",
        [approve ? "approved" : "rejected", req.user.id, note, id]
    );
    await audit(req, approve ? "reopen_approved" : "reopen_rejected", { requestId: id, note });
    res.json({ status: approve ? "approved" : "rejected" });
});

// ---------- Student ----------

// scan the QR: signed by the registered phone (so fingerprint/face was used)
router.post("/mark", requireLogin, requireRole("student"), requireDevice, async (req, res) => {
    const now = clock.now();
    await closeExpired(now);
    const qr = String(req.body.qr || "");
    const mocked = req.body.mocked === true;
    let loc = null;
    try {
        loc = readLocation(req.body);
    } catch {
        loc = null;
    }

    let sessionId = null;
    let distance = null;

    async function logAttempt(result, reason) {
        await db.query(
            `INSERT INTO attendance_attempts (session_id, student_id, device_id, result, reason, lat, lng, accuracy, mocked, distance_m, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [sessionId, req.user.id, req.device.id, result, reason, loc && loc.lat, loc && loc.lng, loc && loc.accuracy, mocked, distance, req.ip]
        );
    }

    async function finish(result, reason, status) {
        await logAttempt(result, reason);
        if (status) {
            await db.query(
                `INSERT INTO attendance_records (session_id, student_id, status, reason, distance_m)
                 VALUES ($1, $2, $3, $4, $5)`, [sessionId, req.user.id, status, reason, distance]
            );
        }
        const code = result === "rejected" ? 400 : 200;
        return res.status(code).json({ result, reason, ...(result === "rejected" ? { error: reason } : {}) });
    }

    // 1. the QR must be ours and fresh (this window or the one before, for slow scans)
    const parts = qr.split(".");
    if (parts.length !== 4 || parts[0] !== "CF1") return finish("rejected", "This is not a CampusFlow attendance QR");
    sessionId = Number(parts[1]);
    const window = Number(parts[2]);
    const session = Number.isInteger(sessionId) && (await db.query(
        `SELECT s.id, s.secret, s.ended_at, s.last_lat, s.last_lng, s.last_accuracy, cs.class_id,
                extract(epoch FROM $2::timestamptz - s.last_location_at)::float8 AS location_age
         FROM attendance_sessions s JOIN class_subjects cs ON cs.id = s.class_subject_id WHERE s.id = $1`, [sessionId, now]
    )).rows[0];
    if (!session) { sessionId = null; return finish("rejected", "Unknown attendance QR"); }

    const current = qrWindow(now.getTime());
    const sigOk = [current, current - 1].includes(window)
        && crypto.timingSafeEqual(Buffer.from(qrSignature(session.secret, session.id, window)), Buffer.from(parts[3].padEnd(22).slice(0, 22)));
    if (!sigOk) return finish("rejected", "This QR has expired. Scan the code on the screen now.");
    if (session.ended_at) return finish("rejected", "Attendance for this class is closed");

    // 2. the student must be in this class, and not marked already
    const inClass = (await db.query("SELECT 1 FROM class_students WHERE student_id = $1 AND class_id = $2", [req.user.id, session.class_id])).rows[0];
    if (!inClass) return finish("rejected", "You are not in this class");
    const already = (await db.query("SELECT status FROM attendance_records WHERE session_id = $1 AND student_id = $2", [session.id, req.user.id])).rows[0];
    if (already) {
        // still log it: repeated scans can be a sign of sharing a phone or QR
        await logAttempt("duplicate", "Already scanned");
        return res.json({ result: already.status, reason: "You already scanned for this class" });
    }

    // 3. location checks
    if (!loc) return finish("flagged", "No location from your phone", "flagged");
    if (mocked) return finish("flagged", "Fake location app detected", "flagged");
    if (session.location_age === null || session.location_age > FACULTY_LOCATION_MAX_AGE) {
        return finish("flagged", "Faculty phone location not available", "flagged");
    }

    distance = Math.round(distanceMetres(loc.lat, loc.lng, session.last_lat, session.last_lng));
    if (loc.accuracy > WEAK_GPS_M || session.last_accuracy > WEAK_GPS_M) {
        return finish("flagged", `Weak GPS (about ${distance} m away)`, "flagged");
    }
    const allowed = BASE_RADIUS_M + Math.min(loc.accuracy + session.last_accuracy, 60);
    if (distance <= allowed) return finish("present", `Near the faculty (${distance} m)`, "present");
    if (distance > allowed * 3) return finish("rejected", `Too far from the class (${distance} m)`);
    return finish("flagged", `A bit far from the faculty (${distance} m)`, "flagged");
});

module.exports = { router, distanceMetres, makeQrText, qrWindow };
