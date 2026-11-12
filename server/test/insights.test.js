// Phase 3 tests: early-warning alerts, who sees them, summaries, weekly digest.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, stop, call, adminToken, emailLogin, db } = require("./helpers");
const { setClock } = require("../src/clock");
const { messagesForTests } = require("../src/email");

// "now" = Thursday 19 Nov 2026, 10:00 India time
const NOW = new Date("2026-11-19T10:00:00+05:30");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);

let admin;
const t = {};

before(async () => {
    await start();
    setClock(NOW);
    admin = await adminToken();
    const add = (body) => call("POST", "/admin/users", { token: admin, body }).then((r) => r.body.id);

    t.py = (await call("POST", "/admin/subjects", { token: admin, body: { code: "PY", name: "Python" } })).body.id;
    t.ma = (await call("POST", "/admin/subjects", { token: admin, body: { code: "MA", name: "Maths" } })).body.id;
    t.f1 = await add({ email: "f1@college.edu", name: "Faculty One", role: "faculty" });
    t.f2 = await add({ email: "f2@college.edu", name: "Faculty Two", role: "faculty" });
    t.f3 = await add({ email: "f3@college.edu", name: "Faculty Three", role: "faculty" });
    t.s1 = await add({ email: "s1@college.edu", name: "Asha", role: "student", regNo: "R1" });
    t.s2 = await add({ email: "s2@college.edu", name: "Ravi", role: "student", regNo: "R2" });
    t.s3 = await add({ email: "s3@college.edu", name: "Meena", role: "student", regNo: "R3" });

    const cls = (await call("POST", "/admin/classes", { token: admin, body: { name: "A" } })).body.id;
    await call("POST", `/admin/classes/${cls}/students`, { token: admin, body: { studentIds: [t.s1, t.s2, t.s3] } });
    t.csPy = (await call("POST", `/admin/classes/${cls}/subjects`, { token: admin, body: { subjectId: t.py, facultyId: t.f1 } })).body.id;
    t.csMa = (await call("POST", `/admin/classes/${cls}/subjects`, { token: admin, body: { subjectId: t.ma, facultyId: t.f2 } })).body.id;
    await call("POST", `/admin/classes/${cls}/mentor-groups/auto`, { token: admin });
    const group = (await call("GET", `/admin/classes/${cls}`, { token: admin })).body.mentorGroups[0].id;
    await call("PATCH", `/admin/mentor-groups/${group}`, { token: admin, body: { mentorId: t.f1 } });

    // 8 Python classes over 6 weeks. Asha came to the first 4, then stopped. Ravi came to all. Meena missed 2 early ones.
    const days = [40, 35, 30, 25, 18, 12, 6, 2];
    for (const [i, d] of days.entries()) {
        const s = (await db.query(
            `INSERT INTO attendance_sessions (class_subject_id, faculty_id, secret, started_at, ended_at)
             VALUES ($1, $2, 'x', $3, $3::timestamptz + interval '10 minutes') RETURNING id`, [t.csPy, t.f1, daysAgo(d)]
        )).rows[0].id;
        const present = [t.s2];
        if (i < 4) present.push(t.s1);
        if (i !== 2 && i !== 3) present.push(t.s3);
        for (const st of present) {
            await db.query("INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1, $2, 'present')", [s, st]);
        }
    }

    // Maths tests (out of 50): Ravi falling 40, 32, 24; Meena low 15, 18; Asha steady 30, 30, 30
    t.f1Token = await emailLogin("f1@college.edu");
    t.f2Token = await emailLogin("f2@college.edu");
    t.f3Token = await emailLogin("f3@college.edu");
    const marks = { T1: [[t.s1, 30], [t.s2, 40], [t.s3, 15]], T2: [[t.s1, 30], [t.s2, 32], [t.s3, 18]], T3: [[t.s1, 30], [t.s2, 24]] };
    for (const [i, name] of ["T1", "T2", "T3"].entries()) {
        const a = (await call("POST", `/faculty/class-subjects/${t.csMa}/assessments`, {
            token: t.f2Token, body: { name, maxMarks: 50, heldOn: `2026-11-0${2 + i * 3}` },
        })).body.id;
        await call("PUT", `/faculty/assessments/${a}/marks`, { token: t.f2Token, body: { marks: marks[name].map(([studentId, m]) => ({ studentId, marks: m })) } });
    }
});

after(async () => { setClock(null); await stop(); });

test("the checks find the right problems", async () => {
    const run = await call("POST", "/insights/run", { token: admin });
    assert.equal(run.status, 200);
    assert.equal(run.body.created, 5);

    const rows = (await db.query(
        "SELECT u.name, a.kind, a.severity FROM alerts a JOIN users u ON u.id = a.student_id ORDER BY u.name, a.kind"
    )).rows.map((r) => `${r.name} ${r.kind} ${r.severity}`);
    assert.deepEqual(rows, [
        "Asha absent_streak concern",
        "Asha attendance_drop concern",
        "Asha low_attendance urgent",
        "Meena low_marks concern",
        "Ravi marks_drop concern",
    ]);

    const reason = (await db.query("SELECT reason FROM alerts WHERE kind = 'marks_drop'")).rows[0].reason;
    assert.equal(reason, "MA marks fell over the last 3 tests: 80%, 64%, 48%.");
});

test("an urgent alert is emailed to the mentor at once", async () => {
    const urgent = messagesForTests.filter((m) => m.subject.includes("urgent"));
    assert.equal(urgent.length, 1);
    assert.equal(urgent[0].to, "f1@college.edu");
    assert.match(urgent[0].text, /Present in 4 of 8 classes \(50%\)/);
});

test("running the checks again does not duplicate alerts", async () => {
    const again = await call("POST", "/insights/run", { token: admin });
    assert.equal(again.body.created, 0);
    assert.equal(again.body.updated, 5);
});

test("mentor sees all their students' alerts, subject faculty only their subject, others nothing", async () => {
    const f1 = await call("GET", "/insights/alerts", { token: t.f1Token });
    assert.equal(f1.body.length, 5);
    assert.equal(f1.body[0].severity, "urgent"); // most serious first

    const f2 = await call("GET", "/insights/alerts", { token: t.f2Token });
    assert.deepEqual(f2.body.map((a) => a.kind).sort(), ["low_marks", "marks_drop"]);
    assert.equal(f2.body[0].as_mentor, false);

    const f3 = await call("GET", "/insights/alerts", { token: t.f3Token });
    assert.deepEqual(f3.body, []);
});

test("an alert can be marked handled, and is not raised again soon", async () => {
    const meena = (await call("GET", "/insights/alerts", { token: t.f2Token })).body.find((a) => a.kind === "low_marks");

    const stranger = await call("POST", `/insights/alerts/${meena.id}/handle`, { token: t.f3Token, body: { status: "handled" } });
    assert.equal(stranger.status, 404);

    const done = await call("POST", `/insights/alerts/${meena.id}/handle`, { token: t.f2Token, body: { status: "not_needed", note: "Was ill, will retake" } });
    assert.equal(done.status, 200);

    const run = await call("POST", "/insights/run", { token: admin });
    assert.equal(run.body.created, 0); // quiet for 14 days
    assert.equal((await call("GET", "/insights/alerts", { token: t.f1Token })).body.length, 4);
});

test("students get a summary and kind nudges about their own data", async () => {
    const s1 = await emailLogin("s1@college.edu");
    const mine = await call("GET", "/insights/student/summary", { token: s1 });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.by, "rules");
    assert.match(mine.body.lines[0], /Attendance: 50% overall/);
    assert.ok(mine.body.nudges.some((n) => n.startsWith("Your attendance is 50%")));
    assert.match(mine.body.lines[mine.body.lines.length - 1], /Next step: Attend every class/);

    const s2 = await emailLogin("s2@college.edu");
    const ravi = await call("GET", "/insights/student/summary", { token: s2 });
    assert.ok(ravi.body.lines.includes("MA went down from 64% to 48% in the latest test."));

    assert.equal((await call("GET", "/insights/alerts", { token: s1 })).status, 403);
});

test("faculty summaries respect who teaches whom", async () => {
    const cls = await call("GET", `/insights/class-subjects/${t.csMa}/summary`, { token: t.f2Token });
    assert.equal(cls.status, 200);
    assert.equal(cls.body.tests.length, 3);
    assert.match(cls.body.lines.join(" "), /T3: class average 54%/);
    assert.equal((await call("GET", `/insights/class-subjects/${t.csMa}/summary`, { token: t.f1Token })).status, 404);

    assert.equal((await call("GET", `/insights/students/${t.s1}/summary`, { token: t.f2Token })).status, 200);
    assert.equal((await call("GET", `/insights/students/${t.s1}/summary`, { token: t.f3Token })).status, 404);
});

test("weekly digest: needs attention first, improving, handled items, subject part", async () => {
    const d = (await call("GET", "/insights/digest", { token: t.f1Token })).body;
    assert.equal(d.week_start, "2026-11-16");
    const g = d.groups[0];
    assert.equal(g.students, 3);
    assert.equal(g.attention[0].name, "Asha");
    assert.equal(g.attention[0].reasons.length, 3);
    assert.equal(g.open_alerts, 4);
    assert.ok(g.handled.some((h) => h.includes("Meena") && h.includes("not needed")));
    assert.equal(d.subjects[0].code, "PY");

    const f3 = (await call("GET", "/insights/digest", { token: t.f3Token })).body;
    assert.deepEqual([f3.groups.length, f3.subjects.length], [0, 0]);
});

test("Monday digests are emailed once per week", async () => {
    const first = await call("POST", "/insights/digests/send", { token: admin });
    assert.equal(first.body.sent, 2); // f1 (mentor + teaches) and f2 (teaches); f3 has nothing
    const second = await call("POST", "/insights/digests/send", { token: admin });
    assert.equal(second.body.sent, 0);
    const mail = messagesForTests.find((m) => m.to === "f1@college.edu" && m.subject.includes("weekly summary"));
    assert.match(mail.text, /Needs attention:\n  - Asha \(R1\)/);
});
