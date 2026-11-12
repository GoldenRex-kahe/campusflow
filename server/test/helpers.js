// Shared test setup: an app on a random port with an empty PGlite database.
process.env.NODE_ENV = "test";
process.env.DB_DRIVER = "pglite";
process.env.EMAIL_MODE = "memory";
process.env.COLLEGE_EMAIL_DOMAIN = "college.edu";

const bcrypt = require("bcryptjs");
const { authenticator } = require("otplib");
const db = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const { sentForTests } = require("../src/email");

let server;
let base;

async function start() {
    await migrate({ log: () => {} });
    server = createApp().listen(0);
    base = `http://localhost:${server.address().port}`;
}

async function stop() {
    server.close();
    await db.close();
}

async function call(method, path, { body, token } = {}) {
    const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
}

// an admin with 2FA already on, logged in
async function adminToken() {
    const secret = authenticator.generateSecret();
    await db.query(
        `INSERT INTO users (email, name, role, password_hash, totp_secret, totp_enabled)
         VALUES ('admin@college.edu', 'Admin', 'admin', $1, $2, true)`,
        [await bcrypt.hash("admin password 1", 4), secret]
    );
    const r = await call("POST", "/auth/admin/login", {
        body: { email: "admin@college.edu", password: "admin password 1", totp: authenticator.generate(secret) },
    });
    return r.body.accessToken;
}

// log in a student or faculty member with the email code
async function emailLogin(email) {
    await db.query("UPDATE email_codes SET created_at = now() - interval '2 minutes' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email]);
    await call("POST", "/auth/email/start", { body: { email } });
    const code = sentForTests.filter((m) => m.to === email).pop().code;
    const r = await call("POST", "/auth/email/verify", { body: { email, code } });
    return r.body.accessToken;
}

module.exports = { start, stop, call, adminToken, emailLogin, db, baseUrl: () => base };
