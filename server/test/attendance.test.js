// Phase 2 tests: phone lock, QR attendance, faculty review, PC linking.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const nacl = require("tweetnacl");
const { start, stop, call, adminToken, emailLogin, db } = require("./helpers");
const { makeQrText, qrWindow } = require("../src/routes/attendance");
const { setClock } = require("../src/clock");

// Monday 16 Nov 2026 (times are India time, UTC+5:30)
const at = (hhmm) => new Date(`2026-11-16T${hhmm}:00+05:30`);

const BASE_LAT = 11.0168; // classroom
const BASE_LNG = 76.9558;
const metresNorth = (m) => BASE_LAT + m / 111320;

let admin;
const t = {};       // tokens
const phones = {};  // key pairs
let lastTime = Date.now();

function newPhone() {
    return nacl.sign.keyPair();
}

// send a request signed by a phone, exactly like the app does
async function signed(method, path, body, token, phone, { time } = {}) {
    lastTime = Math.max(lastTime + 1, Date.now());
    const ts = time ?? lastTime;
    const raw = body ? JSON.stringify(body) : "";
    const text = `${method}\n${path}\n${ts}\n${crypto.createHash("sha256").update(raw).digest("hex")}`;
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(text), phone.secretKey)).toString("base64");
    const res = await fetch(globalThis.__base + path, {
        method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "X-Device-Time": String(ts), "X-Device-Signature": sig },
        body: body ? raw : undefined,
    });
    return { status: res.status, body: await res.json() };
}

async function register(token, phone, hardwareId) {
    return call("POST", "/devices/register", {
        token, body: { publicKey: Buffer.from(phone.publicKey).toString("base64"), hardwareId, platform: "android", model: "Test" },
    });
}

async function currentQr(sessionId, window = qrWindow()) {
    const s = (await db.query("SELECT id, secret FROM attendance_sessions WHERE id = $1", [sessionId])).rows[0];
    return makeQrText(s, window);
}

before(async () => {
    await start();
    globalThis.__base = require("./helpers").baseUrl();

    admin = await adminToken();
    const py = (await call("POST", "/admin/subjects", { token: admin, body: { code: "PY", name: "Python" } })).body.id;
    await call("POST", "/admin/users", { token: admin, body: { email: "f1@college.edu", name: "Faculty One", role: "faculty" } });
    await call("POST", "/admin/users", { token: admin, body: { email: "f2@college.edu", name: "Faculty Two", role: "faculty" } });
    const f1 = (await db.query("SELECT id FROM users WHERE email = 'f1@college.edu'")).rows[0].id;
    const ids = [];
    for (let i = 1; i <= 7; i++) {
        ids.push((await call("POST", "/admin/users", { token: admin, body: { email: `s${i}@college.edu`, name: `Student ${i}`, role: "student", regNo: `R${i}` } })).body.id);
    }
    const a = (await call("POST", "/admin/classes", { token: admin, body: { name: "A" } })).body.id;
    const b = (await call("POST", "/admin/classes", { token: admin, body: { name: "B" } })).body.id;
    await call("POST", `/admin/classes/${a}/students`, { token: admin, body: { studentIds: ids.slice(0, 6) } });
    await call("POST", `/admin/classes/${b}/students`, { token: admin, body: { studentIds: [ids[6]] } });
    t.cs = (await call("POST", `/admin/classes/${a}/subjects`, { token: admin, body: { subjectId: py, facultyId: f1 } })).body.id;
    // Monday 9:00-10:00 and 11:00-12:00, Tuesday 9:00-10:00
    t.tt = (await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: t.cs, day: 1, start: "09:00", end: "10:00", room: "L1" } })).body.id;
    t.tt2 = (await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: t.cs, day: 1, start: "11:00", end: "12:00", room: "L1" } })).body.id;
    t.tt3 = (await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: t.cs, day: 2, start: "09:00", end: "10:00", room: "L1" } })).body.id;
    setClock(at("09:05"));
    t.ids = ids;

    for (const who of ["f1", "f2", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]) t[who] = await emailLogin(`${who}@college.edu`);
});
after(async () => { setClock(null); await stop(); });

test("phone lock: register, one phone per account, one phone per student, admin reset", async () => {
    phones.s1 = newPhone();
    assert.equal((await register(t.s1, phones.s1, "hw-1")).status, 201);
    assert.equal((await register(t.s1, phones.s1, "hw-1")).body.alreadyRegistered, true);

    const other = newPhone();
    const second = await register(t.s1, other, "hw-9");
    assert.equal(second.status, 409); // account already locked to a phone

    phones.s2 = newPhone();
    const samePhone = await register(t.s2, phones.s2, "hw-1");
    assert.equal(samePhone.status, 409); // this phone belongs to student 1
    assert.equal((await register(t.s2, phones.s2, "hw-2")).status, 201);

    // admin resets student 2's phone: old phone logged out, a new phone can register
    const reset = await call("DELETE", `/admin/users/${t.ids[1]}/device`, { token: admin });
    assert.equal(reset.body.reset, true);
    t.s2 = await emailLogin("s2@college.edu");
    phones.s2 = newPhone();
    assert.equal((await register(t.s2, phones.s2, "hw-2b")).status, 201);

    for (const [who, hw] of [["s3", "hw-3"], ["s4", "hw-4"], ["s5", "hw-5"], ["s6", "hw-6"], ["s7", "hw-7"], ["f1", "hw-f1"], ["f2", "hw-f2"]]) {
        phones[who] = newPhone();
        assert.equal((await register(t[who], phones[who], hw)).status, 201);
    }
});

test("signed requests: wrong key, old time, replay and changed body are refused", async () => {
    const body = { timetableId: t.tt, lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 };

    const unsigned = await call("POST", "/attendance/sessions", { token: t.f1, body });
    assert.equal(unsigned.status, 401);

    const wrongKey = await signed("POST", "/attendance/sessions", body, t.f1, newPhone());
    assert.equal(wrongKey.status, 401);

    const old = await signed("POST", "/attendance/sessions", body, t.f1, phones.f1, { time: Date.now() - 5 * 60 * 1000 });
    assert.equal(old.status, 401);

    // a signature made for one body does not work with another body
    lastTime = Math.max(lastTime + 1, Date.now());
    const ts = lastTime;
    const text = `POST\n/attendance/sessions\n${ts}\n${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(text), phones.f1.secretKey)).toString("base64");
    const changed = await fetch(globalThis.__base + "/attendance/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + t.f1, "X-Device-Time": String(ts), "X-Device-Signature": sig },
        body: JSON.stringify({ ...body, lat: 0 }),
    });
    assert.equal(changed.status, 401);
});

test("faculty starts attendance only for their own class on today's timetable", async () => {
    const body = { timetableId: t.tt, lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 };
    const notMine = await signed("POST", "/attendance/sessions", body, t.f2, phones.f2);
    assert.equal(notMine.status, 409);

    const tuesday = await signed("POST", "/attendance/sessions", { ...body, timetableId: t.tt3 }, t.f1, phones.f1);
    assert.equal(tuesday.status, 409);
    assert.match(tuesday.body.error, /not on your timetable today/);

    const started = await signed("POST", "/attendance/sessions", body, t.f1, phones.f1);
    assert.equal(started.status, 201);
    t.session = started.body.id;

    // starting again in the same period continues the same session
    const again = await signed("POST", "/attendance/sessions", body, t.f1, phones.f1);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, t.session);
    assert.equal(again.body.continued, true);

    const qr = await call("GET", `/attendance/sessions/${t.session}/qr`, { token: t.f1 });
    assert.equal(qr.body.paused, false);
    assert.ok(qr.body.qr.startsWith("data:image/png"));

    const otherFaculty = await call("GET", `/attendance/sessions/${t.session}/qr`, { token: t.f2 });
    assert.equal(otherFaculty.status, 404);
});

test("student scans: near = present, far = rejected, fake GPS and weak GPS = flagged", async () => {
    const qr = await currentQr(t.session);
    const mark = (who, extra) => signed("POST", "/attendance/mark", { qr, lat: metresNorth(10), lng: BASE_LNG, accuracy: 10, mocked: false, ...extra }, t[who], phones[who]);

    const near = await mark("s1");
    assert.equal(near.body.result, "present");

    const twice = await mark("s1");
    assert.equal(twice.body.reason, "You already scanned for this class");

    const far = await mark("s2", { lat: metresNorth(2000) });
    assert.equal(far.status, 400);
    assert.equal(far.body.result, "rejected");

    const fake = await mark("s3", { mocked: true });
    assert.equal(fake.body.result, "flagged");

    const weak = await mark("s4", { accuracy: 150 });
    assert.equal(weak.body.result, "flagged");

    const notInClass = await mark("s7");
    assert.equal(notInClass.body.result, "rejected");

    // the phone must be the registered one
    const wrongPhone = await signed("POST", "/attendance/mark", { qr, lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 }, t.s5, newPhone());
    assert.equal(wrongPhone.status, 401);

    const attempts = (await db.query("SELECT count(*)::int AS n FROM attendance_attempts")).rows[0].n;
    assert.equal(attempts, 6); // every attempt that reached the checks is logged, including rejected ones
});

test("old or forged QR codes are refused", async () => {
    const old = await currentQr(t.session, qrWindow() - 2);
    const r1 = await signed("POST", "/attendance/mark", { qr: old, lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 }, t.s5, phones.s5);
    assert.match(r1.body.reason, /expired/);

    const forged = `CF1.${t.session}.${qrWindow()}.AAAAAAAAAAAAAAAAAAAAAA`;
    const r2 = await signed("POST", "/attendance/mark", { qr: forged, lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 }, t.s5, phones.s5);
    assert.equal(r2.body.result, "rejected");
});

test("if the faculty phone stops sending location, the QR pauses and scans are flagged", async () => {
    await db.query("UPDATE attendance_sessions SET last_location_at = now() - interval '2 minutes' WHERE id = $1", [t.session]);
    const qr = await call("GET", `/attendance/sessions/${t.session}/qr`, { token: t.f1 });
    assert.equal(qr.body.paused, true);

    const scan = await signed("POST", "/attendance/mark", { qr: await currentQr(t.session), lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 }, t.s5, phones.s5);
    assert.equal(scan.body.result, "flagged");

    const loc = await signed("POST", `/attendance/sessions/${t.session}/location`, { lat: BASE_LAT, lng: BASE_LNG, accuracy: 8 }, t.f1, phones.f1);
    assert.equal(loc.status, 200);
    const back = await call("GET", `/attendance/sessions/${t.session}/qr`, { token: t.f1 });
    assert.equal(back.body.paused, false);
});

test("faculty reviews flagged scans, marks by hand, and stops the session", async () => {
    const before = await call("GET", `/attendance/sessions/${t.session}`, { token: t.f1 });
    assert.deepEqual(before.body.counts, { total: 6, present: 1, flagged: 3 });

    const s3 = before.body.students.find((s) => s.reg_no === "R3");
    const decide = await call("POST", `/attendance/records/${s3.record_id}/decide`, { token: t.f1, body: { status: "present" } });
    assert.equal(decide.status, 200);

    const notYours = await call("POST", `/attendance/records/${s3.record_id}/decide`, { token: t.f2, body: { status: "absent" } });
    assert.equal(notYours.status, 404);

    const noReason = await call("POST", `/attendance/sessions/${t.session}/manual`, { token: t.f1, body: { studentId: t.ids[5] } });
    assert.equal(noReason.status, 400);
    const manual = await call("POST", `/attendance/sessions/${t.session}/manual`, { token: t.f1, body: { studentId: t.ids[5], reason: "Phone battery dead" } });
    assert.equal(manual.status, 200);

    const after = await call("GET", `/attendance/sessions/${t.session}`, { token: t.f1 });
    assert.deepEqual(after.body.counts, { total: 6, present: 3, flagged: 2 });

    assert.equal((await call("POST", `/attendance/sessions/${t.session}/stop`, { token: t.f1 })).status, 200);
    const late = await signed("POST", "/attendance/mark", { qr: await currentQr(t.session), lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 }, t.s2, phones.s2);
    assert.match(late.body.reason, /closed/);

    const mine = await call("GET", "/student/attendance", { token: t.s1 });
    assert.deepEqual(mine.body, [{ code: "PY", subject: "Python", held: 1, present: 1, waiting_review: 0 }]);
});

test("link a PC like WhatsApp Web, then unlink it from the phone", async () => {
    const startLink = await call("POST", "/link/start");
    assert.equal(startLink.status, 200);
    const { linkId, pollSecret } = startLink.body;
    const status = (secret) => fetch(`${globalThis.__base}/link/status/${linkId}`, { headers: { "X-Poll-Secret": secret } }).then(async (r) => ({ status: r.status, body: await r.json() }));

    assert.equal((await status("wrong")).status, 404);
    assert.equal((await status(pollSecret)).body.status, "pending");

    // the real code is only inside the QR image, so the test sets a known code to "scan"
    const known = crypto.randomBytes(24).toString("base64url");
    await db.query("UPDATE link_requests SET code_hash = $1 WHERE id = $2", [crypto.createHash("sha256").update(known).digest("hex"), linkId]);
    const qrText = `CFLINK.${linkId}.${known}`;

    const student = await signed("POST", "/link/approve", { qr: qrText }, t.s1, phones.s1);
    assert.equal(student.status, 403);
    const unsigned = await call("POST", "/link/approve", { token: t.f1, body: { qr: qrText } });
    assert.equal(unsigned.status, 401);

    const approve = await signed("POST", "/link/approve", { qr: qrText }, t.f1, phones.f1);
    assert.equal(approve.status, 200);

    const got = await status(pollSecret);
    assert.equal(got.body.status, "approved");
    const pcToken = got.body.accessToken;
    assert.equal((await status(pollSecret)).body.status, "used"); // handed out only once

    assert.equal((await call("GET", "/faculty/classes", { token: pcToken })).status, 200);

    const pcs = await call("GET", "/link/pcs", { token: t.f1 });
    assert.equal(pcs.body.length, 1);
    const unlink = await call("DELETE", `/link/pcs/${pcs.body[0].id}`, { token: t.f1 });
    assert.equal(unlink.status, 200);

    assert.equal((await call("GET", "/faculty/classes", { token: pcToken })).status, 401);
    assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: got.body.refreshToken } })).status, 401);
});

test("an expired link QR cannot be approved", async () => {
    const { linkId } = (await call("POST", "/link/start")).body;
    const known = crypto.randomBytes(24).toString("base64url");
    await db.query("UPDATE link_requests SET code_hash = $1, expires_at = now() - interval '1 second' WHERE id = $2",
        [crypto.createHash("sha256").update(known).digest("hex"), linkId]);
    const r = await signed("POST", "/link/approve", { qr: `CFLINK.${linkId}.${known}` }, t.f1, phones.f1);
    assert.equal(r.status, 400);
});

// ---------- timetable window, cancel, reopen requests ----------

const startBody = (timetableId) => ({ timetableId, lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 });

test("stopping and starting again in the same period continues the same class", async () => {
    const again = await signed("POST", "/attendance/sessions", startBody(t.tt), t.f1, phones.f1);
    assert.equal(again.body.id, t.session); // same session, not a new class
    await call("POST", `/attendance/sessions/${t.session}/stop`, { token: t.f1 });

    const mine = await call("GET", "/student/attendance", { token: t.s1 });
    assert.equal(mine.body[0].held, 1);
});

test("attendance opens only when the period starts", async () => {
    setClock(at("10:55"));
    const early = await signed("POST", "/attendance/sessions", startBody(t.tt2), t.f1, phones.f1);
    assert.equal(early.status, 409);
    assert.match(early.body.error, /starts at 11:00/);

    const today = await call("GET", "/attendance/today", { token: t.f1 });
    assert.equal(today.body.find((p) => p.timetable_id === t.tt2).state, "upcoming");
});

test("a session nobody scanned can be cancelled and does not count", async () => {
    setClock(at("11:05"));
    const s = await signed("POST", "/attendance/sessions", startBody(t.tt2), t.f1, phones.f1);
    assert.equal(s.status, 201);
    const cancel = await call("POST", `/attendance/sessions/${s.body.id}/cancel`, { token: t.f1 });
    assert.equal(cancel.body.cancelled, true);

    const mine = await call("GET", "/student/attendance", { token: t.s1 });
    assert.equal(mine.body[0].held, 1);

    // the first session has scans, so it cannot be cancelled
    const used = await call("POST", `/attendance/sessions/${t.session}/cancel`, { token: t.f1 });
    assert.equal(used.status, 409);
});

test("the QR closes by itself 20 minutes after the period starts", async () => {
    setClock(at("11:06"));
    const s = await signed("POST", "/attendance/sessions", startBody(t.tt2), t.f1, phones.f1);
    assert.equal(s.status, 201);
    t.session2 = s.body.id;
    const qr = await call("GET", `/attendance/sessions/${t.session2}/qr`, { token: t.f1 });
    assert.ok(qr.body.closesIn > 800 && qr.body.closesIn <= 840); // about 14 minutes left

    setClock(at("11:21"));
    const closed = await call("GET", `/attendance/sessions/${t.session2}/qr`, { token: t.f1 });
    assert.equal(closed.body.ended, true);

    const scan = await signed("POST", "/attendance/mark", { qr: await currentQr(t.session2), lat: BASE_LAT, lng: BASE_LNG, accuracy: 10 }, t.s1, phones.s1);
    assert.match(scan.body.reason, /closed/);

    const late = await signed("POST", "/attendance/sessions", startBody(t.tt2), t.f1, phones.f1);
    assert.equal(late.status, 409);
    assert.equal(late.body.needReopen, true);
});

test("reopening needs a request approved by the admin, for 10 minutes", async () => {
    const noReason = await call("POST", "/attendance/requests", { token: t.f1, body: { timetableId: t.tt2 } });
    assert.equal(noReason.status, 400);

    const req1 = await call("POST", "/attendance/requests", { token: t.f1, body: { timetableId: t.tt2, reason: "Projector was not working" } });
    assert.equal(req1.status, 201);
    const twice = await call("POST", "/attendance/requests", { token: t.f1, body: { timetableId: t.tt2, reason: "again" } });
    assert.equal(twice.status, 409);

    let today = await call("GET", "/attendance/today", { token: t.f1 });
    assert.equal(today.body.find((p) => p.timetable_id === t.tt2).state, "request_pending");

    // faculty cannot approve their own request; the admin can
    assert.equal((await call("POST", `/attendance/requests/${req1.body.id}/decide`, { token: t.f1, body: { approve: true } })).status, 403);
    const list = await call("GET", "/attendance/requests", { token: admin });
    assert.equal(list.body[0].reason, "Projector was not working");
    assert.equal((await call("POST", `/attendance/requests/${req1.body.id}/decide`, { token: admin, body: { approve: true } })).status, 200);

    today = await call("GET", "/attendance/today", { token: t.f1 });
    assert.equal(today.body.find((p) => p.timetable_id === t.tt2).state, "reopen_approved");

    const reopened = await signed("POST", "/attendance/sessions", startBody(t.tt2), t.f1, phones.f1);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.id, t.session2); // same class session, opened again
    const qr = await call("GET", `/attendance/sessions/${t.session2}/qr`, { token: t.f1 });
    assert.ok(qr.body.closesIn > 570 && qr.body.closesIn <= 600);

    // the approval is used up: after stopping, another request is needed
    await call("POST", `/attendance/sessions/${t.session2}/stop`, { token: t.f1 });
    const again = await signed("POST", "/attendance/sessions", startBody(t.tt2), t.f1, phones.f1);
    assert.equal(again.body.needReopen, true);

    // a rejected request leaves the QR closed
    const req2 = await call("POST", "/attendance/requests", { token: t.f1, body: { timetableId: t.tt2, reason: "One more time" } });
    await call("POST", `/attendance/requests/${req2.body.id}/decide`, { token: admin, body: { approve: false, note: "Please mark by hand" } });
    today = await call("GET", "/attendance/today", { token: t.f1 });
    const p = today.body.find((x) => x.timetable_id === t.tt2);
    assert.equal(p.state, "closed");
    assert.equal(p.request.note, "Please mark by hand");
});
