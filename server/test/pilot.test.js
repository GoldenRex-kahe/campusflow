// Phase 4 tests: attendance appeals, all-or-nothing saves, phone logout ends linked PCs.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, stop, call, adminToken, emailLogin, db } = require("./helpers");
const { setClock } = require("../src/clock");
const { issueTokens } = require("../src/tokens");
const { sentForTests } = require("../src/email");

const NOW = new Date("2026-11-19T10:00:00+05:30");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);

let admin;
const t = {};

async function session(dAgo, { open = false } = {}) {
    return (await db.query(
        `INSERT INTO attendance_sessions (class_subject_id, faculty_id, secret, started_at, ended_at)
         VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
        [t.cs, t.f1, daysAgo(dAgo), open ? null : new Date(daysAgo(dAgo).getTime() + 600000)]
    )).rows[0].id;
}

before(async () => {
    await start();
    setClock(NOW);
    admin = await adminToken();
    const add = (body) => call("POST", "/admin/users", { token: admin, body }).then((r) => r.body.id);
    const py = (await call("POST", "/admin/subjects", { token: admin, body: { code: "PY", name: "Python" } })).body.id;
    t.f1 = await add({ email: "f1@college.edu", name: "Faculty One", role: "faculty" });
    t.f2 = await add({ email: "f2@college.edu", name: "Faculty Two", role: "faculty" });
    t.s1 = await add({ email: "s1@college.edu", name: "Asha", role: "student", regNo: "R1" });
    t.s2 = await add({ email: "s2@college.edu", name: "Ravi", role: "student", regNo: "R2" });
    t.s3 = await add({ email: "s3@college.edu", name: "Meena", role: "student", regNo: "R3" });
    t.cls = (await call("POST", "/admin/classes", { token: admin, body: { name: "A" } })).body.id;
    await call("POST", `/admin/classes/${t.cls}/students`, { token: admin, body: { studentIds: [t.s1, t.s2] } });
    t.cs = (await call("POST", `/admin/classes/${t.cls}/subjects`, { token: admin, body: { subjectId: py, facultyId: t.f1 } })).body.id;

    t.recent = await session(2);   // Asha absent, Ravi present
    t.other = await session(3);    // Asha absent
    t.old = await session(10);     // too old to appeal
    t.open = await session(0, { open: true });
    await db.query("INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1, $2, 'present')", [t.recent, t.s2]);

    t.s1Token = await emailLogin("s1@college.edu");
    t.s2Token = await emailLogin("s2@college.edu");
    t.f1Token = await emailLogin("f1@college.edu");
    t.f2Token = await emailLogin("f2@college.edu");
});

after(async () => { setClock(null); await stop(); });

test("students see missed classes and which they can still appeal", async () => {
    const mine = await call("GET", "/appeals/mine", { token: t.s1Token });
    const byId = Object.fromEntries(mine.body.map((m) => [m.session_id, m]));
    assert.equal(byId[t.recent].can_appeal, true);
    assert.equal(byId[t.old].can_appeal, false);
    assert.equal(byId[t.open], undefined); // still open: scan instead
    assert.equal(byId[t.recent].status, "absent");
});

test("appeal rules: recent, finished, not already present, one per class, with a reason", async () => {
    const appeal = (token, sessionId, reason) => call("POST", "/appeals", { token, body: { sessionId, reason } });
    assert.equal((await appeal(t.s1Token, t.old, "late")).status, 409);
    assert.equal((await appeal(t.s1Token, t.open, "x")).status, 409);
    assert.equal((await appeal(t.s2Token, t.recent, "x")).status, 409); // already present
    assert.equal((await appeal(t.s1Token, t.recent, "")).status, 400);

    const ok = await appeal(t.s1Token, t.recent, "My phone battery died, I was in class");
    assert.equal(ok.status, 201);
    t.appeal = ok.body.id;
    assert.equal((await appeal(t.s1Token, t.recent, "again")).status, 409);
});

test("only the subject faculty can decide; approving marks the student present", async () => {
    assert.deepEqual((await call("GET", "/appeals", { token: t.f2Token })).body, []);
    assert.equal((await call("POST", `/appeals/${t.appeal}/decide`, { token: t.f2Token, body: { approve: true } })).status, 404);

    const list = await call("GET", "/appeals", { token: t.f1Token });
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].reason, "My phone battery died, I was in class");

    const approve = await call("POST", `/appeals/${t.appeal}/decide`, { token: t.f1Token, body: { approve: true } });
    assert.equal(approve.status, 200);
    const record = (await db.query("SELECT status, reason FROM attendance_records WHERE session_id = $1 AND student_id = $2", [t.recent, t.s1])).rows[0];
    assert.equal(record.status, "present");
    assert.match(record.reason, /^Appeal approved/);

    assert.equal((await call("POST", `/appeals/${t.appeal}/decide`, { token: t.f1Token, body: { approve: false } })).status, 404);
});

test("a rejected appeal shows the faculty note to the student", async () => {
    const a = await call("POST", "/appeals", { token: t.s1Token, body: { sessionId: t.other, reason: "Bus was late" } });
    await call("POST", `/appeals/${a.body.id}/decide`, { token: t.f1Token, body: { approve: false, note: "Class had started 30 minutes earlier" } });
    const mine = (await call("GET", "/appeals/mine", { token: t.s1Token })).body.find((m) => m.session_id === t.other);
    assert.deepEqual([mine.appeal_status, mine.appeal_note, mine.status], ["rejected", "Class had started 30 minutes earlier", "absent"]);
});

test("multi-step saves are all-or-nothing", async () => {
    // the same student twice: the second insert fails, so nothing is saved
    const r = await call("POST", `/admin/classes/${t.cls}/students`, { token: admin, body: { studentIds: [t.s3, t.s3] } });
    assert.equal(r.status, 409);
    const inClass = (await db.query("SELECT count(*)::int AS n FROM class_students WHERE student_id = $1", [t.s3])).rows[0].n;
    assert.equal(inClass, 0);
});

test("logging out on the faculty phone also logs out linked PCs", async () => {
    // a full phone login (to get its refresh token)
    await db.query("UPDATE email_codes SET created_at = now() - interval '2 minutes'");
    await call("POST", "/auth/email/start", { body: { email: "f1@college.edu" } });
    const code = sentForTests.filter((m) => m.to === "f1@college.edu").pop().code;
    const phone = (await call("POST", "/auth/email/verify", { body: { email: "f1@college.edu", code } })).body;

    const pc = (await db.query("INSERT INTO linked_pcs (faculty_id, expires_at) VALUES ($1, now() + interval '12 hours') RETURNING id", [t.f1])).rows[0].id;
    const pcTokens = await issueTokens({ id: t.f1, role: "faculty" }, { linkedPcId: pc });
    assert.equal((await call("GET", "/me", { token: pcTokens.accessToken })).status, 200);

    await call("POST", "/auth/logout", { body: { refreshToken: phone.refreshToken } });
    assert.equal((await call("GET", "/me", { token: pcTokens.accessToken })).status, 401);
    assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: pcTokens.refreshToken } })).status, 401);
});
