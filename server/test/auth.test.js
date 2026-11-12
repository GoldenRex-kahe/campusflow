// Tests for Phase 0: login, 2FA, roles. Run with: npm test
// They use PGlite (PostgreSQL inside Node), so no database setup is needed.
process.env.NODE_ENV = "test";
process.env.DB_DRIVER = "pglite";
process.env.EMAIL_MODE = "memory";
process.env.COLLEGE_EMAIL_DOMAIN = "college.edu";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { authenticator } = require("otplib");
const db = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const { sentForTests } = require("../src/email");

let server;
let base;

async function call(method, path, { body, token } = {}) {
    const res = await fetch(base + path, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
}

function lastCodeFor(email) {
    const found = sentForTests.filter((m) => m.to === email);
    return found.length ? found[found.length - 1].code : null;
}

// pretend the last code was sent long ago, so a new one can be requested
async function ageCodes(email) {
    await db.query(
        "UPDATE email_codes SET created_at = now() - interval '2 minutes' WHERE user_id = (SELECT id FROM users WHERE email = $1)",
        [email]
    );
}

let adminToken;

before(async () => {
    await migrate({ log: () => {} });
    const hash = await bcrypt.hash("correct horse battery", 4);
    await db.query(
        "INSERT INTO users (email, name, role, password_hash) VALUES ('admin@college.edu', 'Admin', 'admin', $1)",
        [hash]
    );
    server = createApp().listen(0);
    base = `http://localhost:${server.address().port}`;
});

after(async () => {
    server.close();
    await db.close();
});

test("admin: wrong password is rejected", async () => {
    const r = await call("POST", "/auth/admin/login", { body: { email: "admin@college.edu", password: "nope" } });
    assert.equal(r.status, 401);
});

test("admin: must turn on 2FA before admin features work", async () => {
    const login = await call("POST", "/auth/admin/login", { body: { email: "admin@college.edu", password: "correct horse battery" } });
    assert.equal(login.status, 200);
    assert.equal(login.body.totpSetupRequired, true);

    const blocked = await call("GET", "/admin/users", { token: login.body.accessToken });
    assert.equal(blocked.status, 403);

    const setup = await call("POST", "/auth/admin/2fa/setup", { token: login.body.accessToken });
    assert.equal(setup.status, 200);
    assert.ok(setup.body.qr.startsWith("data:image/png"));
    const secret = new URL(setup.body.otpauthUrl).searchParams.get("secret");

    const badEnable = await call("POST", "/auth/admin/2fa/enable", { token: login.body.accessToken, body: { code: "000000" } });
    assert.equal(badEnable.status, 400);

    const firstCode = authenticator.generate(secret);
    const enable = await call("POST", "/auth/admin/2fa/enable", {
        token: login.body.accessToken, body: { code: firstCode },
    });
    assert.equal(enable.status, 200);

    // the secret is stored encrypted, never as plain text
    const stored = (await db.query("SELECT totp_secret FROM users WHERE email = 'admin@college.edu'")).rows[0].totp_secret;
    assert.ok(stored.startsWith("enc:v1:"));
    assert.ok(!stored.includes(secret));

    // a code can be used only once
    const reused = await call("POST", "/auth/admin/login", {
        body: { email: "admin@college.edu", password: "correct horse battery", totp: firstCode },
    });
    assert.equal(reused.status, 401);

    // now login needs the 2FA code
    const noCode = await call("POST", "/auth/admin/login", { body: { email: "admin@college.edu", password: "correct horse battery" } });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.totpRequired, true);

    const wrongCode = await call("POST", "/auth/admin/login", {
        body: { email: "admin@college.edu", password: "correct horse battery", totp: "123456" },
    });
    assert.equal(wrongCode.status, 401);

    // the next code (30 seconds later) works
    const nextCode = authenticator.clone({ epoch: Date.now() + 30000 }).generate(secret);
    const ok = await call("POST", "/auth/admin/login", {
        body: { email: "admin@college.edu", password: "correct horse battery", totp: nextCode },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.totpSetupRequired, false);
    adminToken = ok.body.accessToken;
});

test("admin: adds students and faculty with checks", async () => {
    const wrongDomain = await call("POST", "/admin/users", {
        token: adminToken, body: { email: "asha@gmail.com", name: "Asha", role: "student", regNo: "101" },
    });
    assert.equal(wrongDomain.status, 400);

    const noRegNo = await call("POST", "/admin/users", {
        token: adminToken, body: { email: "asha@college.edu", name: "Asha", role: "student" },
    });
    assert.equal(noRegNo.status, 400);

    const badRole = await call("POST", "/admin/users", {
        token: adminToken, body: { email: "x@college.edu", name: "X", role: "admin" },
    });
    assert.equal(badRole.status, 400);

    const student = await call("POST", "/admin/users", {
        token: adminToken, body: { email: "Asha@College.edu", name: "Asha", role: "student", regNo: "101" },
    });
    assert.equal(student.status, 201);
    assert.equal(student.body.email, "asha@college.edu");

    const duplicate = await call("POST", "/admin/users", {
        token: adminToken, body: { email: "asha@college.edu", name: "Asha 2", role: "student", regNo: "999" },
    });
    assert.equal(duplicate.status, 409);

    const faculty = await call("POST", "/admin/users", {
        token: adminToken, body: { email: "ravi.sir@college.edu", name: "Ravi", role: "faculty" },
    });
    assert.equal(faculty.status, 201);

    const list = await call("GET", "/admin/users?role=student", { token: adminToken });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((u) => u.reg_no), ["101"]);
});

test("email login: unknown email gets the same answer and no code", async () => {
    const r = await call("POST", "/auth/email/start", { body: { email: "nobody@college.edu" } });
    assert.equal(r.status, 200);
    assert.equal(lastCodeFor("nobody@college.edu"), null);

    const outside = await call("POST", "/auth/email/start", { body: { email: "asha@gmail.com" } });
    assert.equal(outside.status, 400);
});

test("email login: admins cannot use the email code login", async () => {
    await call("POST", "/auth/email/start", { body: { email: "admin@college.edu" } });
    assert.equal(lastCodeFor("admin@college.edu"), null);
});

test("email login: 5 wrong codes lock that code", async () => {
    await call("POST", "/auth/email/start", { body: { email: "asha@college.edu" } });
    const code = lastCodeFor("asha@college.edu");
    assert.match(code, /^\d{6}$/);

    // asking again within a minute does not send a second code
    await call("POST", "/auth/email/start", { body: { email: "asha@college.edu" } });
    assert.equal(sentForTests.filter((m) => m.to === "asha@college.edu").length, 1);

    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
        const r = await call("POST", "/auth/email/verify", { body: { email: "asha@college.edu", code: wrong } });
        assert.equal(r.status, 401);
    }
    const locked = await call("POST", "/auth/email/verify", { body: { email: "asha@college.edu", code } });
    assert.equal(locked.status, 429);
});

test("email login: correct code logs in, works once, gives student role", async () => {
    await ageCodes("asha@college.edu");
    await call("POST", "/auth/email/start", { body: { email: "asha@college.edu" } });
    const code = lastCodeFor("asha@college.edu");

    const login = await call("POST", "/auth/email/verify", { body: { email: "ASHA@college.edu", code } });
    assert.equal(login.status, 200);
    assert.ok(login.body.accessToken && login.body.refreshToken);

    const again = await call("POST", "/auth/email/verify", { body: { email: "asha@college.edu", code } });
    assert.equal(again.status, 401);

    const me = await call("GET", "/me", { token: login.body.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, "student");
    assert.equal(me.body.regNo, "101");

    // a student cannot use admin routes
    const admin = await call("GET", "/admin/users", { token: login.body.accessToken });
    assert.equal(admin.status, 403);

    // refresh gives new tokens, and the old refresh token stops working
    const refreshed = await call("POST", "/auth/refresh", { body: { refreshToken: login.body.refreshToken } });
    assert.equal(refreshed.status, 200);
    const reused = await call("POST", "/auth/refresh", { body: { refreshToken: login.body.refreshToken } });
    assert.equal(reused.status, 401);

    // logout ends the session
    await call("POST", "/auth/logout", { body: { refreshToken: refreshed.body.refreshToken } });
    const afterLogout = await call("POST", "/auth/refresh", { body: { refreshToken: refreshed.body.refreshToken } });
    assert.equal(afterLogout.status, 401);
});

test("disabled accounts and bad tokens are rejected", async () => {
    const noToken = await call("GET", "/me");
    assert.equal(noToken.status, 401);

    const fake = await call("GET", "/me", { token: "not.a.token" });
    assert.equal(fake.status, 401);

    await ageCodes("ravi.sir@college.edu");
    await call("POST", "/auth/email/start", { body: { email: "ravi.sir@college.edu" } });
    const login = await call("POST", "/auth/email/verify", {
        body: { email: "ravi.sir@college.edu", code: lastCodeFor("ravi.sir@college.edu") },
    });
    assert.equal(login.status, 200);

    await db.query("UPDATE users SET is_active = false WHERE email = 'ravi.sir@college.edu'");
    const me = await call("GET", "/me", { token: login.body.accessToken });
    assert.equal(me.status, 401);
});

test("every login is written to the audit log", async () => {
    const rows = (await db.query("SELECT action FROM audit_log")).rows.map((r) => r.action);
    assert.ok(rows.includes("login_success"));
    assert.ok(rows.includes("admin_login_failed"));
    assert.ok(rows.includes("user_created"));
    assert.ok(rows.includes("admin_2fa_enabled"));
});
