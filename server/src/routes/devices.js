// Phone lock.
// 1. After the first login, the app makes a key pair. The private key stays on the phone,
//    locked behind fingerprint/face. The server saves only the public key.
// 2. Important requests (mark attendance, start a session, link a PC) are signed with that key.
//    The server checks the signature, so the request must come from the registered phone,
//    and the owner must have just unlocked it with fingerprint/face.
const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const db = require("../db");
const v = require("../validate");
const { requireLogin, requireRole } = require("../middleware");
const { audit } = require("../audit");

const router = express.Router();
const MAX_CLOCK_DIFF_MS = 60 * 1000;

function hashHardwareId(hardwareId) {
    return crypto.createHmac("sha256", config.jwtSecret).update(String(hardwareId)).digest("hex");
}

function publicKeyObject(base64Key) {
    const raw = Buffer.from(base64Key, "base64");
    if (raw.length !== 32) throw new v.BadInput("Phone key is not valid");
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

// the exact text the phone signs
function signedText(method, url, time, rawBody) {
    const bodyHash = crypto.createHash("sha256").update(rawBody || "").digest("hex");
    return `${method}\n${url}\n${time}\n${bodyHash}`;
}

// ---------- Register this phone ----------

router.post("/register", requireLogin, requireRole("student", "faculty"), async (req, res) => {
    const publicKey = v.text(req.body.publicKey, "Phone key", { max: 100 });
    const hardwareId = v.text(req.body.hardwareId, "Phone id", { max: 200 });
    publicKeyObject(publicKey); // checks the key format

    const current = (await db.query(
        "SELECT id, public_key FROM devices WHERE user_id = $1 AND revoked_at IS NULL", [req.user.id]
    )).rows[0];
    if (current) {
        if (current.public_key === publicKey) return res.json({ deviceId: current.id, alreadyRegistered: true });
        await audit(req, "device_register_blocked", { reason: "account locked to another phone" });
        return res.status(409).json({ error: "Your account is locked to another phone. Ask the admin to reset it." });
    }

    // one phone cannot be used by two students
    const hwHash = hashHardwareId(hardwareId);
    if (req.user.role === "student") {
        const other = (await db.query(
            `SELECT 1 FROM devices d JOIN users u ON u.id = d.user_id
             WHERE d.hardware_id_hash = $1 AND d.revoked_at IS NULL AND u.role = 'student' AND u.id <> $2`,
            [hwHash, req.user.id]
        )).rows[0];
        if (other) {
            await audit(req, "device_register_blocked", { reason: "phone used by another student" });
            return res.status(409).json({ error: "This phone is already registered to another student." });
        }
    }

    const row = (await db.query(
        `INSERT INTO devices (user_id, public_key, hardware_id_hash, platform, model)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.user.id, publicKey, hwHash, String(req.body.platform || "").slice(0, 20), String(req.body.model || "").slice(0, 60)]
    )).rows[0];
    await audit(req, "device_registered", { deviceId: row.id, platform: req.body.platform, model: req.body.model });
    res.status(201).json({ deviceId: row.id });
});

router.get("/me", requireLogin, async (req, res) => {
    const d = (await db.query(
        "SELECT id, platform, model, created_at FROM devices WHERE user_id = $1 AND revoked_at IS NULL", [req.user.id]
    )).rows[0];
    res.json(d || null);
});

// ---------- Check a signed request (use after requireLogin) ----------

async function requireDevice(req, res, next) {
    const time = Number(req.get("x-device-time"));
    const signature = req.get("x-device-signature") || "";

    const device = (await db.query(
        "SELECT id, public_key, last_sig_time FROM devices WHERE user_id = $1 AND revoked_at IS NULL", [req.user.id]
    )).rows[0];
    if (!device) return res.status(403).json({ error: "Register this phone first", needDevice: true });

    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > MAX_CLOCK_DIFF_MS) {
        return res.status(401).json({ error: "Phone clock is wrong or the request is too old" });
    }
    if (time <= Number(device.last_sig_time)) {
        return res.status(401).json({ error: "This request was already used" });
    }

    let ok = false;
    try {
        ok = crypto.verify(
            null,
            Buffer.from(signedText(req.method, req.originalUrl, time, req.rawBody)),
            publicKeyObject(device.public_key),
            Buffer.from(signature, "base64")
        );
    } catch {
        ok = false;
    }
    if (!ok) {
        await audit(req, "device_signature_failed", { deviceId: device.id });
        return res.status(401).json({ error: "This request did not come from your registered phone" });
    }

    // remember the time, so the same signed request cannot be sent again
    const updated = await db.query(
        "UPDATE devices SET last_sig_time = $1 WHERE id = $2 AND last_sig_time < $1 RETURNING id", [time, device.id]
    );
    if (updated.rows.length === 0) return res.status(401).json({ error: "This request was already used" });

    req.device = { id: device.id };
    next();
}

module.exports = { router, requireDevice, signedText };
