// Phase 3 "AI v1": early warnings, marks summaries and the weekly mentor digest.
// Everything here is plain rules on the numbers in the database, so every alert can say exactly why.
// (ai.js can optionally rewrite the finished text in friendlier words; it never decides anything.)
const config = require("./config");
const clock = require("./clock");
const db = require("./db");
const { sendText } = require("./email");

// ---------- the rules (change the numbers here) ----------
const RULES = {
    minAttendance: 75,          // % below this = concern (college rule)
    urgentAttendance: 65,       // % below this = urgent
    minClassesForAttendance: 4, // do not judge attendance on fewer classes than this
    recentDays: 21,             // "recent" attendance = last 3 weeks
    dropPoints: 20,             // recent % this much lower than before = drop
    minClassesForDrop: 3,       // classes needed on each side to call it a drop
    streakConcern: 3,           // missed this many classes in a row = concern
    streakUrgent: 5,            // ... this many = urgent
    lowMarks: 40,               // average % below this (with 2+ tests) = concern
    marksDropPoints: 15,        // last 3 tests falling, last one this much below the first = drop
    flaggedScans: 3,            // this many flagged/rejected scans in 14 days = watch
    quietDays: 14,              // after "handled", do not raise the same alert again for this long (unless worse)
};

const SEVERITY_RANK = { watch: 1, concern: 2, urgent: 3 };

const pct = (part, whole) => (whole ? Math.round((part * 100) / whole) : null);

// ---------- one student's numbers ----------

async function studentStats(studentId, now = clock.now()) {
    const recentFrom = new Date(now.getTime() - RULES.recentDays * 86400000);

    // finished class sessions of the student's class, oldest first, with the student's result
    const sessions = (await db.query(
        `SELECT s.id, s.started_at, sub.id AS subject_id, sub.code, sub.name AS subject, r.status
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         JOIN attendance_sessions s ON s.class_subject_id = cs.id AND s.ended_at IS NOT NULL AND s.started_at <= $2
         LEFT JOIN attendance_records r ON r.session_id = s.id AND r.student_id = cl.student_id
         WHERE cl.student_id = $1
         ORDER BY s.started_at`, [studentId, now]
    )).rows;

    const subjects = {};
    const att = { held: 0, present: 0, recentHeld: 0, recentPresent: 0, earlierHeld: 0, earlierPresent: 0, streak: 0 };
    for (const s of sessions) {
        const present = s.status === "present";
        const sub = (subjects[s.code] ||= { subject_id: s.subject_id, code: s.code, name: s.subject, held: 0, present: 0, tests: [] });
        sub.held++;
        att.held++;
        if (present) { sub.present++; att.present++; }
        if (new Date(s.started_at) >= recentFrom) { att.recentHeld++; if (present) att.recentPresent++; }
        else { att.earlierHeld++; if (present) att.earlierPresent++; }
        // missed in a row (a flagged scan waiting for review is not counted either way)
        if (present) att.streak = 0;
        else if (s.status !== "flagged") att.streak++;
    }
    att.percent = pct(att.present, att.held);
    att.recentPercent = pct(att.recentPresent, att.recentHeld);
    att.earlierPercent = pct(att.earlierPresent, att.earlierHeld);

    // marks as % per subject, oldest test first
    const marks = (await db.query(
        `SELECT sub.id AS subject_id, sub.code, sub.name AS subject, a.name AS test,
                round(m.marks * 100 / a.max_marks)::int AS percent, cs.faculty_id, f.name AS faculty_name
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN subjects sub ON sub.id = cs.subject_id
         LEFT JOIN users f ON f.id = cs.faculty_id
         JOIN assessments a ON a.class_subject_id = cs.id
         JOIN marks m ON m.assessment_id = a.id AND m.student_id = cl.student_id
         WHERE cl.student_id = $1
         ORDER BY a.held_on NULLS LAST, a.created_at`, [studentId]
    )).rows;
    for (const m of marks) {
        const sub = (subjects[m.code] ||= { subject_id: m.subject_id, code: m.code, name: m.subject, held: 0, present: 0, tests: [] });
        sub.tests.push({ test: m.test, percent: m.percent });
        sub.faculty_name = m.faculty_name;
    }
    for (const sub of Object.values(subjects)) {
        sub.attendance = pct(sub.present, sub.held);
        sub.average = sub.tests.length ? Math.round(sub.tests.reduce((a, t) => a + t.percent, 0) / sub.tests.length) : null;
    }

    const flagged = Number((await db.query(
        `SELECT count(*) AS n FROM attendance_attempts
         WHERE student_id = $1 AND result IN ('flagged', 'rejected') AND created_at > $2::timestamptz - interval '14 days'`,
        [studentId, now]
    )).rows[0].n);

    return { attendance: att, subjects: Object.values(subjects), flaggedScans: flagged };
}

// ---------- rules -> alerts ----------

function findProblems(stats) {
    const out = [];
    const a = stats.attendance;

    if (a.held >= RULES.minClassesForAttendance && a.percent < RULES.minAttendance) {
        out.push({
            kind: "low_attendance",
            severity: a.percent < RULES.urgentAttendance ? "urgent" : "concern",
            title: `Attendance ${a.percent}%`,
            reason: `Present in ${a.present} of ${a.held} classes (${a.percent}%), below the ${RULES.minAttendance}% rule.`,
            suggestion: "Talk to the student about why they are missing classes.",
            details: { present: a.present, held: a.held, percent: a.percent },
        });
    }
    if (a.recentHeld >= RULES.minClassesForDrop && a.earlierHeld >= RULES.minClassesForDrop
        && a.earlierPercent - a.recentPercent >= RULES.dropPoints) {
        out.push({
            kind: "attendance_drop",
            severity: "concern",
            title: `Attendance falling: ${a.earlierPercent}% to ${a.recentPercent}%`,
            reason: `Attendance went from ${a.earlierPercent}% to ${a.recentPercent}% in the last ${RULES.recentDays / 7} weeks.`,
            suggestion: "Check in with the student: a sudden drop often has a reason (health, family, transport).",
            details: { before: a.earlierPercent, recent: a.recentPercent },
        });
    }
    if (a.streak >= RULES.streakConcern) {
        out.push({
            kind: "absent_streak",
            severity: a.streak >= RULES.streakUrgent ? "urgent" : "concern",
            title: `Missed ${a.streak} classes in a row`,
            reason: `The student has missed the last ${a.streak} classes without a break.`,
            suggestion: "Contact the student (or their family) soon.",
            details: { streak: a.streak },
        });
    }
    for (const s of stats.subjects) {
        const t = s.tests;
        if (t.length >= 3) {
            const [x, y, z] = t.slice(-3).map((v) => v.percent);
            if (x > y && y > z && x - z >= RULES.marksDropPoints) {
                out.push({
                    kind: "marks_drop", subject_id: s.subject_id, severity: "concern",
                    title: `${s.code} marks falling`,
                    reason: `${s.code} marks fell over the last 3 tests: ${x}%, ${y}%, ${z}%.`,
                    suggestion: `${s.faculty_name || "The subject faculty"} could go through the last test with the student.`,
                    details: { last3: [x, y, z] },
                });
            }
        }
        if (t.length >= 2 && s.average < RULES.lowMarks) {
            out.push({
                kind: "low_marks", subject_id: s.subject_id, severity: "concern",
                title: `${s.code} average ${s.average}%`,
                reason: `Average in ${s.code} is ${s.average}% over ${t.length} tests (below ${RULES.lowMarks}%).`,
                suggestion: "Extra help or a revision plan for this subject.",
                details: { average: s.average, tests: t.length },
            });
        }
    }
    if (stats.flaggedScans >= RULES.flaggedScans) {
        out.push({
            kind: "flagged_scans", severity: "watch",
            title: `${stats.flaggedScans} unusual attendance scans`,
            reason: `${stats.flaggedScans} attendance scans were flagged or rejected in the last 14 days (far away, fake location, or expired QR).`,
            suggestion: "Ask the student about it; it may be a phone problem or someone scanning for them.",
            details: { count: stats.flaggedScans },
        });
    }
    return out;
}

// who should hear about an alert: the mentor, and for a subject problem the subject faculty
async function recipients(studentId, subjectId) {
    const rows = (await db.query(
        `SELECT DISTINCT u.id, u.email, u.name FROM users u
         WHERE u.is_active AND (
            u.id = (SELECT g.mentor_id FROM mentor_group_students mgs JOIN mentor_groups g ON g.id = mgs.group_id WHERE mgs.student_id = $1)
            OR ($2::int IS NOT NULL AND u.id IN (
                SELECT cs.faculty_id FROM class_students cl JOIN class_subjects cs ON cs.class_id = cl.class_id
                WHERE cl.student_id = $1 AND cs.subject_id = $2)))`, [studentId, subjectId || null]
    )).rows;
    return rows;
}

// check every student and save new or changed alerts. Urgent ones are emailed at once.
async function runChecks(now = clock.now()) {
    const students = (await db.query(
        `SELECT u.id, u.name, s.reg_no FROM users u JOIN students s ON s.user_id = u.id
         JOIN class_students cl ON cl.student_id = u.id WHERE u.is_active`
    )).rows;
    let created = 0;
    let updated = 0;

    for (const st of students) {
        const problems = findProblems(await studentStats(st.id, now));
        for (const p of problems) {
            const subjectId = p.subject_id || null;
            const open = (await db.query(
                "SELECT id, severity FROM alerts WHERE student_id = $1 AND kind = $2 AND coalesce(subject_id, 0) = coalesce($3::int, 0) AND status = 'open'",
                [st.id, p.kind, subjectId]
            )).rows[0];

            if (open) {
                await db.query(
                    "UPDATE alerts SET severity = $1, title = $2, reason = $3, suggestion = $4, details = $5, updated_at = $6 WHERE id = $7",
                    [p.severity, p.title, p.reason, p.suggestion, JSON.stringify(p.details), now, open.id]
                );
                updated++;
                if (SEVERITY_RANK[p.severity] > SEVERITY_RANK[open.severity] && p.severity === "urgent") await notifyUrgent(st, p);
                continue;
            }

            // recently handled with the same or higher severity: stay quiet for a while
            const recent = (await db.query(
                `SELECT severity FROM alerts WHERE student_id = $1 AND kind = $2 AND coalesce(subject_id, 0) = coalesce($3::int, 0)
                 AND status <> 'open' AND handled_at > $4::timestamptz - make_interval(days => $5)
                 ORDER BY handled_at DESC LIMIT 1`, [st.id, p.kind, subjectId, now, RULES.quietDays]
            )).rows[0];
            if (recent && SEVERITY_RANK[recent.severity] >= SEVERITY_RANK[p.severity]) continue;

            await db.query(
                `INSERT INTO alerts (student_id, subject_id, kind, severity, title, reason, suggestion, details, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
                [st.id, subjectId, p.kind, p.severity, p.title, p.reason, p.suggestion, JSON.stringify(p.details), now]
            );
            created++;
            if (p.severity === "urgent") await notifyUrgent(st, p);
        }
    }
    return { students: students.length, created, updated };
}

async function notifyUrgent(student, p) {
    for (const r of await recipients(student.id, p.subject_id)) {
        await sendText(r.email, `CampusFlow: urgent - ${student.name} (${student.reg_no})`,
            `${student.name} (${student.reg_no}): ${p.reason}\n\nSuggested next step: ${p.suggestion}\n\nOpen CampusFlow to mark this alert as handled.`);
    }
}

// ---------- summaries ----------

function studentSummaryText(stats) {
    const lines = [];
    const a = stats.attendance;
    const subs = stats.subjects;
    if (a.held) {
        const per = subs.filter((s) => s.held).map((s) => `${s.code} ${s.attendance}%`).join(", ");
        lines.push(`Attendance: ${a.percent}% overall${per ? ` (${per})` : ""}.`);
    }
    const marked = subs.filter((s) => s.average !== null).sort((x, y) => y.average - x.average);
    if (marked.length) {
        const best = marked[0];
        lines.push(`Strongest subject: ${best.code} ${best.name} (${best.average}% average).`);
        const weak = marked.filter((s) => s.average < 60);
        if (weak.length && weak[weak.length - 1] !== best) {
            const w = weak[weak.length - 1];
            lines.push(`Needs work: ${w.code} ${w.name} (${w.average}% average).`);
        }
        for (const s of marked) {
            const t = s.tests;
            if (t.length >= 2) {
                const diff = t[t.length - 1].percent - t[t.length - 2].percent;
                if (Math.abs(diff) >= 10) lines.push(`${s.code} ${diff > 0 ? "went up" : "went down"} from ${t[t.length - 2].percent}% to ${t[t.length - 1].percent}% in the latest test.`);
            }
        }
    }
    const weakest = marked.length ? marked[marked.length - 1] : null;
    let next = "Keep going: attend every class and revise a little each day.";
    if (a.held >= RULES.minClassesForAttendance && a.percent < RULES.minAttendance) next = `Attend every class: you need at least ${RULES.minAttendance}% attendance.`;
    else if (weakest && weakest.average < 60) next = `Revise ${weakest.name}${weakest.faculty_name ? ` and ask ${weakest.faculty_name} about the topics you found hard` : ""}.`;
    lines.push(`Next step: ${next}`);
    if (!a.held && !marked.length) return ["No attendance or marks yet."];
    return lines;
}

// a kind message for the student about their own open alerts (no "risk" words)
function nudgeFor(alert) {
    const d = alert.details || {};
    switch (alert.kind) {
        case "low_attendance": return `Your attendance is ${d.percent}%. Aim for at least ${RULES.minAttendance}% - every class counts.`;
        case "attendance_drop": return `You have been missing more classes lately (${d.before}% before, ${d.recent}% now). Your mentor is here to help if something is wrong.`;
        case "absent_streak": return `You have missed ${d.streak} classes in a row. If something is stopping you, talk to your mentor.`;
        case "marks_drop": return `Your ${alert.code} marks have dipped recently. A quick chat with your faculty can help.`;
        case "low_marks": return `${alert.code} looks hard right now (${d.average}% average). Ask for extra help - it works.`;
        default: return null;
    }
}

// one class-subject: how the class is doing (for the subject faculty)
async function classSummary(classSubjectId) {
    const tests = (await db.query(
        `SELECT a.id, a.name, round(avg(m.marks * 100 / a.max_marks))::int AS average,
                count(m.*)::int AS marked,
                count(*) FILTER (WHERE m.marks * 100 / a.max_marks < $2)::int AS below
         FROM assessments a LEFT JOIN marks m ON m.assessment_id = a.id
         WHERE a.class_subject_id = $1
         GROUP BY a.id ORDER BY a.held_on NULLS LAST, a.created_at`, [classSubjectId, RULES.lowMarks]
    )).rows.filter((t) => t.marked > 0);

    const att = (await db.query(
        `SELECT count(DISTINCT s.id)::int AS held,
                count(r.id) FILTER (WHERE r.status = 'present')::int AS present,
                (SELECT count(*)::int FROM class_subjects cs JOIN class_students cl ON cl.class_id = cs.class_id WHERE cs.id = $1) AS students
         FROM attendance_sessions s LEFT JOIN attendance_records r ON r.session_id = s.id
         WHERE s.class_subject_id = $1 AND s.ended_at IS NOT NULL`, [classSubjectId]
    )).rows[0];

    const lines = [];
    if (att.held) lines.push(`Attendance: ${pct(att.present, att.held * att.students)}% average over ${att.held} classes.`);
    if (tests.length) {
        const last = tests[tests.length - 1];
        lines.push(`${last.name}: class average ${last.average}%, ${last.below} of ${last.marked} students below ${RULES.lowMarks}%.`);
        if (tests.length >= 2) {
            const prev = tests[tests.length - 2];
            const diff = last.average - prev.average;
            if (diff !== 0) lines.push(`Average ${diff > 0 ? "rose" : "fell"} ${Math.abs(diff)} points since ${prev.name} (${prev.average}%).`);
        }
    }
    if (!lines.length) lines.push("No attendance or marks yet.");

    // students who need help in this subject (latest test below the line)
    const needHelp = tests.length ? (await db.query(
        `SELECT u.name, st.reg_no, round(m.marks * 100 / a.max_marks)::int AS percent
         FROM marks m JOIN assessments a ON a.id = m.assessment_id
         JOIN users u ON u.id = m.student_id JOIN students st ON st.user_id = u.id
         WHERE a.id = $1 AND m.marks * 100 / a.max_marks < $2 ORDER BY percent`, [tests[tests.length - 1].id, RULES.lowMarks]
    )).rows : [];

    return { lines, tests, needHelp };
}

// ---------- weekly digest ----------

// Monday 00:00 of this week in the college time zone, as a date string
async function weekStart(now = clock.now()) {
    return (await db.query(
        "SELECT to_char(date_trunc('week', $1::timestamptz AT TIME ZONE $2), 'YYYY-MM-DD') AS d",
        [now, config.collegeTimezone]
    )).rows[0].d;
}

async function attendanceBetween(studentIds, from, to) {
    if (!studentIds.length) return null;
    const r = (await db.query(
        `SELECT count(*)::int AS slots, count(r.id) FILTER (WHERE r.status = 'present')::int AS present
         FROM class_students cl
         JOIN class_subjects cs ON cs.class_id = cl.class_id
         JOIN attendance_sessions s ON s.class_subject_id = cs.id AND s.ended_at IS NOT NULL
              AND s.started_at >= $2 AND s.started_at < $3
         LEFT JOIN attendance_records r ON r.session_id = s.id AND r.student_id = cl.student_id
         WHERE cl.student_id = ANY($1::int[])`, [studentIds, from, to]
    )).rows[0];
    return pct(r.present, r.slots);
}

async function buildDigest(facultyId, now = clock.now()) {
    const week = await weekStart(now);
    const weekFrom = (await db.query("SELECT ($1::date::timestamp AT TIME ZONE $2) AS t", [week, config.collegeTimezone])).rows[0].t;
    const lastWeekFrom = new Date(new Date(weekFrom).getTime() - 7 * 86400000);
    const digest = { week_start: week, groups: [], subjects: [] };

    // mentor part
    const groups = (await db.query(
        `SELECT g.id, g.name, c.name AS class_name FROM mentor_groups g JOIN classes c ON c.id = g.class_id
         WHERE g.mentor_id = $1 ORDER BY c.name, g.name`, [facultyId]
    )).rows;
    for (const g of groups) {
        const students = (await db.query(
            `SELECT u.id, u.name, st.reg_no FROM mentor_group_students mgs JOIN users u ON u.id = mgs.student_id
             JOIN students st ON st.user_id = u.id WHERE mgs.group_id = $1 ORDER BY st.reg_no`, [g.id]
        )).rows;
        const ids = students.map((s) => s.id);
        const thisWeek = await attendanceBetween(ids, weekFrom, now);
        const lastWeek = await attendanceBetween(ids, lastWeekFrom, weekFrom);

        const alerts = (await db.query(
            `SELECT a.id, a.student_id, a.kind, a.severity, a.title, a.reason, a.suggestion, u.name, st.reg_no
             FROM alerts a JOIN users u ON u.id = a.student_id JOIN students st ON st.user_id = u.id
             WHERE a.status = 'open' AND a.student_id = ANY($1::int[])
             ORDER BY CASE a.severity WHEN 'urgent' THEN 3 WHEN 'concern' THEN 2 ELSE 1 END DESC, a.updated_at DESC`, [ids]
        )).rows;
        // top 3 students, each with all their reasons
        const attention = [];
        for (const a of alerts) {
            let entry = attention.find((x) => x.student_id === a.student_id);
            if (!entry) {
                if (attention.length >= 3) continue;
                entry = { student_id: a.student_id, name: a.name, reg_no: a.reg_no, severity: a.severity, reasons: [], suggestion: a.suggestion };
                attention.push(entry);
            }
            entry.reasons.push(a.reason);
        }

        // improving: better attendance this week, or latest test 10+ points higher
        const improving = [];
        for (const s of students) {
            const before = await attendanceBetween([s.id], lastWeekFrom, weekFrom);
            const nowPct = await attendanceBetween([s.id], weekFrom, now);
            const stats = await studentStats(s.id, now);
            const upSubject = stats.subjects.find((x) => x.tests.length >= 2 && x.tests[x.tests.length - 1].percent - x.tests[x.tests.length - 2].percent >= 10);
            if (before !== null && nowPct !== null && nowPct - before >= 15) improving.push(`${s.name}: attendance ${before}% to ${nowPct}%`);
            else if (upSubject) {
                const t = upSubject.tests;
                improving.push(`${s.name}: ${upSubject.code} ${t[t.length - 2].percent}% to ${t[t.length - 1].percent}%`);
            }
        }

        const flagged = Number((await db.query(
            "SELECT count(*) AS n FROM attendance_records WHERE status = 'flagged' AND student_id = ANY($1::int[])", [ids]
        )).rows[0].n);
        const handled = (await db.query(
            `SELECT a.title, a.status, a.handled_note, u.name FROM alerts a JOIN users u ON u.id = a.student_id
             WHERE a.student_id = ANY($1::int[]) AND a.status <> 'open' AND a.handled_at >= $2 ORDER BY a.handled_at DESC`,
            [ids, lastWeekFrom]
        )).rows;

        digest.groups.push({
            name: g.name, class_name: g.class_name, students: students.length,
            attendance_this_week: thisWeek, attendance_last_week: lastWeek,
            attention, improving, flagged_waiting: flagged, open_alerts: alerts.length,
            handled: handled.map((h) => `${h.name}: ${h.title} - ${h.status === "handled" ? "spoke to student" : "not needed"}${h.handled_note ? ` (${h.handled_note})` : ""}`),
        });
    }

    // subject faculty part: a smaller summary per class I teach
    const teaching = (await db.query(
        `SELECT cs.id, c.name AS class_name, sub.code, sub.name AS subject
         FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE cs.faculty_id = $1 ORDER BY c.name, sub.code`, [facultyId]
    )).rows;
    for (const t of teaching) {
        const sum = await classSummary(t.id);
        digest.subjects.push({ class_name: t.class_name, code: t.code, subject: t.subject, lines: sum.lines, need_help: sum.needHelp.map((n) => `${n.name} (${n.percent}%)`) });
    }
    return digest;
}

function digestText(name, d) {
    const out = [`Hello ${name},`, "", `Your CampusFlow weekly summary (week of ${d.week_start}).`, ""];
    for (const g of d.groups) {
        out.push(`== ${g.class_name} - ${g.name} (${g.students} students) ==`);
        out.push(`Attendance: ${g.attendance_this_week ?? "-"}% this week, ${g.attendance_last_week ?? "-"}% last week.`);
        if (g.attention.length) {
            out.push("Needs attention:");
            for (const a of g.attention) out.push(`  - ${a.name} (${a.reg_no}): ${a.reasons.join(" ")} Next step: ${a.suggestion}`);
        } else out.push("Needs attention: nobody this week.");
        if (g.improving.length) out.push(`Improving: ${g.improving.join("; ")}.`);
        if (g.flagged_waiting) out.push(`Flagged scans waiting for review: ${g.flagged_waiting}.`);
        out.push(`Open alerts: ${g.open_alerts}.`);
        if (g.handled.length) out.push(`Done last week: ${g.handled.join("; ")}.`);
        out.push("");
    }
    for (const s of d.subjects) {
        out.push(`-- ${s.class_name} ${s.code} ${s.subject} --`);
        for (const l of s.lines) out.push(l);
        if (s.need_help.length) out.push(`Below ${RULES.lowMarks}% in the latest test: ${s.need_help.join(", ")}.`);
        out.push("");
    }
    out.push("Open CampusFlow to see details and mark alerts as handled.");
    return out.join("\n");
}

// Monday morning: build, save and email the digest for every faculty member who mentors or teaches
async function sendWeeklyDigests(now = clock.now()) {
    const week = await weekStart(now);
    const faculty = (await db.query(
        `SELECT DISTINCT u.id, u.name, u.email FROM users u
         WHERE u.role = 'faculty' AND u.is_active AND (
            EXISTS (SELECT 1 FROM mentor_groups g WHERE g.mentor_id = u.id)
            OR EXISTS (SELECT 1 FROM class_subjects cs WHERE cs.faculty_id = u.id))`
    )).rows;
    let sent = 0;
    for (const f of faculty) {
        const done = (await db.query("SELECT 1 FROM digests WHERE user_id = $1 AND week_start = $2", [f.id, week])).rows[0];
        if (done) continue;
        const d = await buildDigest(f.id, now);
        await db.query("INSERT INTO digests (user_id, week_start, content) VALUES ($1, $2, $3)", [f.id, week, JSON.stringify(d)]);
        await sendText(f.email, `CampusFlow weekly summary (week of ${week})`, digestText(f.name, d));
        sent++;
    }
    return { sent };
}

module.exports = {
    RULES, studentStats, findProblems, runChecks, recipients, studentSummaryText, nudgeFor,
    classSummary, buildDigest, digestText, sendWeeklyDigests, weekStart,
};
