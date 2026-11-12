// Login routes.
// Students and faculty: email -> 6-digit code by email -> tokens
//   (Phase 2 adds: lock the account to one phone + fingerprint/face)
// Admin: email + password + 2FA code from an authenticator app
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const config = require("../config");
const db = require("../db");
const { sendLoginCode } = require("../email");
const { sha256, issueTokens, rotateRefreshToken, revokeRefreshToken } = require("../tokens");
const { requireLogin, requireRole } = require("../middleware");
const { audit } = require("../audit");
const { encrypt, decrypt, isEncrypted } = require("../secrets");

const router = express.Router();

// accept the code before and after the current one (phone clocks can be up to 30 seconds off)
authenticator.options = { window: 1 };

const CODE_MINUTES = 10;
const MAX_CODE_TRIES = 5;
const RESEND_SECONDS = 60;

// a code is stored as a keyed hash, so a database leak does not reveal it
function hashCode(code) {
    return crypto.createHmac("sha256", config.jwtSecret).update(code).digest("hex");
}

function sameText(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cleanEmail(email) {
    return String(email || "").trim().toLowerCase();
}

// ---------- Students and faculty: email code ----------

router.post("/email/start", async (req, res) => {
    const email = cleanEmail(req.body.email);
    // the answer is the same whether or not the email exists, so nobody can test emails
    const answer = { message: "If this email is registered, a login code has been sent." };

    if (!email.endsWith("@" + config.collegeEmailDomain)) {
        return res.status(400).json({ error: `Use your @${config.collegeEmailDomain} email` });
    }

    const user = (await db.query(
        "SELECT id, email, role FROM users WHERE lower(email) = $1 AND is_active AND role IN ('student', 'faculty')",
        [email]
    )).rows[0];
    if (!user) return res.json(answer);

    // do not send a new code if one was sent less than a minute ago
    const recent = (await db.query(
        `SELECT 1 FROM email_codes WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)`,
        [user.id, RESEND_SECONDS]
    )).rows.length;
    if (recent) return res.json(answer);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    // a new code cancels any older codes that were not used
    await db.query("UPDATE email_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await db.query(
        `INSERT INTO email_codes (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [user.id, hashCode(code), CODE_MINUTES]
    );
    await sendLoginCode(user.email, code);
    await audit(req, "login_code_sent", {}, user.id);
    res.json(answer);
});

router.post("/email/verify", async (req, res) => {
    const email = cleanEmail(req.body.email);
    const code = String(req.body.code || "").trim();
    const wrong = { error: "Wrong or expired code" };

    const user = (await db.query(
        "SELECT id, role FROM users WHERE lower(email) = $1 AND is_active AND role IN ('student', 'faculty')",
        [email]
    )).rows[0];
    if (!user) return res.status(401).json(wrong);

    // only the newest unused, unexpired code counts
    const row = (await db.query(
        `SELECT id, code_hash, attempts FROM email_codes
         WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
    )).rows[0];
    if (!row) return res.status(401).json(wrong);

    if (row.attempts >= MAX_CODE_TRIES) {
        return res.status(429).json({ error: "Too many wrong tries. Ask for a new code." });
    }

    if (!sameText(hashCode(code), row.code_hash)) {
        await db.query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
        await audit(req, "login_code_wrong", {}, user.id);
        return res.status(401).json(wrong);
    }

    // this code is used up, and so is any other code left for this user
    await db.query("UPDATE email_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await audit(req, "login_success", { method: "email_code" }, user.id);
    res.json(await issueTokens(user));
});

// ---------- Admin: password + 2FA ----------

// Check a 2FA code. Each code works only once: the server remembers the last time-step used.
// (Old secrets saved before encryption are encrypted the first time they are used.)
async function useTotp(userId, storedSecret, code) {
    if (!storedSecret || !/^\d{6}$/.test(code)) return false;
    const delta = authenticator.checkDelta(code, decrypt(storedSecret));
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 1000 / 30) + delta;
    const r = await db.query(
        "UPDATE users SET totp_last_step = $1, totp_secret = $3 WHERE id = $2 AND totp_last_step < $1 RETURNING id",
        [step, userId, isEncrypted(storedSecret) ? storedSecret : encrypt(storedSecret)]
    );
    return r.rows.length === 1;
}

// used when the email is unknown, so a wrong email takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

router.post("/admin/login", async (req, res) => {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const wrong = { error: "Wrong email or password" };

    const user = (await db.query(
        "SELECT id, role, password_hash, totp_secret, totp_enabled FROM users WHERE lower(email) = $1 AND is_active AND role = 'admin'",
        [email]
    )).rows[0];

    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !passwordOk) {
        await audit(req, "admin_login_failed", { email }, null);
        return res.status(401).json(wrong);
    }

    if (user.totp_enabled) {
        const totp = String(req.body.totp || "").trim();
        if (!totp) return res.status(401).json({ error: "Enter the 2FA code", totpRequired: true });
        if (!(await useTotp(user.id, user.totp_secret, totp))) {
            await audit(req, "admin_login_failed", { reason: "2fa" }, user.id);
            return res.status(401).json({ error: "Wrong or already used 2FA code. Wait for the next code.", totpRequired: true });
        }
    }

    await audit(req, "login_success", { method: "admin_password" }, user.id);
    const tokens = await issueTokens(user);
    res.json({ ...tokens, totpSetupRequired: !user.totp_enabled });
});

// step 1: create a 2FA secret and show it as a QR for an authenticator app
router.post("/admin/2fa/setup", requireLogin, requireRole("admin"), async (req, res) => {
    if (req.user.totp_enabled) return res.status(400).json({ error: "2FA is already on" });

    const secret = authenticator.generateSecret();
    await db.query("UPDATE users SET totp_secret = $1 WHERE id = $2", [encrypt(secret), req.user.id]); // saved encrypted

    const otpauthUrl = authenticator.keyuri(req.user.email, config.appName, secret);
    res.json({ otpauthUrl, qr: await QRCode.toDataURL(otpauthUrl) });
});

// step 2: prove the app works by sending one code, then 2FA is on
router.post("/admin/2fa/enable", requireLogin, requireRole("admin"), async (req, res) => {
    const user = (await db.query("SELECT totp_secret FROM users WHERE id = $1", [req.user.id])).rows[0];
    const code = String(req.body.code || "").trim();

    if (!(await useTotp(req.user.id, user.totp_secret, code))) {
        return res.status(400).json({ error: "Wrong code. Scan the QR again and try." });
    }
    await db.query("UPDATE users SET totp_enabled = true WHERE id = $1", [req.user.id]);
    await audit(req, "admin_2fa_enabled");
    res.json({ message: "2FA is on" });
});

// ---------- For everyone ----------

router.post("/refresh", async (req, res) => {
    const tokens = await rotateRefreshToken(req.body.refreshToken);
    if (!tokens) return res.status(401).json({ error: "Please log in again" });
    res.json(tokens);
});

router.post("/logout", async (req, res) => {
    // a faculty member logging out on the phone also logs out every PC linked to it
    const row = (await db.query(
        `SELECT rt.user_id, rt.linked_pc_id, u.role FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL`, [sha256(String(req.body.refreshToken))]
    )).rows[0];
    await revokeRefreshToken(req.body.refreshToken);
    if (row && row.role === "faculty" && !row.linked_pc_id) {
        const pcs = await db.query(
            "UPDATE linked_pcs SET revoked_at = now() WHERE faculty_id = $1 AND revoked_at IS NULL RETURNING id", [row.user_id]
        );
        if (pcs.rows.length) {
            await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE linked_pc_id = ANY($1::int[]) AND revoked_at IS NULL",
                [pcs.rows.map((p) => p.id)]);
            await audit(req, "pcs_logged_out_with_phone", { count: pcs.rows.length }, row.user_id);
        }
    }
    res.json({ message: "Logged out" });
});

module.exports = router;
