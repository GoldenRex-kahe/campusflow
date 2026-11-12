// Link a PC to the faculty phone, like WhatsApp Web.
// 1. PC asks for a link QR (valid 60 seconds) and keeps asking "has it been approved?".
// 2. Faculty scans it with the phone app; the phone request is signed (fingerprint/face).
// 3. The PC's next check gets its own login, tied to this link. Unlinking from the phone ends it at once.
const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const { rateLimit } = require("express-rate-limit");
const config = require("../config");
const db = require("../db");
const v = require("../validate");
const { sha256, issueTokens } = require("../tokens");
const { requireLogin, requireRole } = require("../middleware");
const { requireDevice } = require("./devices");
const { audit } = require("../audit");

const router = express.Router();
const LINK_SECONDS = 60;
const LINKED_PC_HOURS = 12;

const startLimit = rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false });

// 1. PC: give me a link QR
router.post("/start", startLimit, async (req, res) => {
    const id = crypto.randomBytes(9).toString("base64url");
    const code = crypto.randomBytes(24).toString("base64url");
    const pollSecret = crypto.randomBytes(24).toString("base64url");
    await db.query(
        `INSERT INTO link_requests (id, code_hash, poll_secret_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [id, sha256(code), sha256(pollSecret), LINK_SECONDS]
    );
    const text = `CFLINK.${id}.${code}`;
    res.json({ linkId: id, pollSecret, qr: await QRCode.toDataURL(text, { margin: 1, width: 360 }), expiresIn: LINK_SECONDS });
});

// 1b. PC: has my link been approved? (only the PC knows pollSecret)
router.get("/status/:id", async (req, res) => {
    const r = (await db.query(
        "SELECT id, poll_secret_hash, faculty_id, status, expires_at > now() AS fresh FROM link_requests WHERE id = $1",
        [String(req.params.id)]
    )).rows[0];
    const secret = String(req.get("x-poll-secret") || "");
    if (!r || r.poll_secret_hash !== sha256(secret)) return res.status(404).json({ error: "Unknown link request" });

    if (r.status === "approved") {
        // hand out the PC login once, then the request is used up
        const used = await db.query("UPDATE link_requests SET status = 'used' WHERE id = $1 AND status = 'approved' RETURNING id", [r.id]);
        if (used.rows.length === 0) return res.json({ status: "used" });

        const pc = (await db.query(
            `INSERT INTO linked_pcs (faculty_id, user_agent, ip, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING id`,
            [r.faculty_id, String(req.get("user-agent") || "").slice(0, 200), req.ip, LINKED_PC_HOURS]
        )).rows[0];
        const tokens = await issueTokens({ id: r.faculty_id, role: "faculty" }, { linkedPcId: pc.id });
        await audit(req, "pc_linked", { linkedPcId: pc.id }, r.faculty_id);
        return res.json({ status: "approved", ...tokens });
    }
    if (r.status === "used") return res.json({ status: "used" });
    if (!r.fresh) return res.json({ status: "expired" });
    res.json({ status: "pending" });
});

// 2. faculty phone: approve the PC whose QR I scanned
router.post("/approve", requireLogin, requireRole("faculty"), requireDevice, async (req, res) => {
    const parts = String(req.body.qr || "").split(".");
    if (parts.length !== 3 || parts[0] !== "CFLINK") throw new v.BadInput("This is not a CampusFlow PC link QR");

    const r = await db.query(
        `UPDATE link_requests SET status = 'approved', faculty_id = $1
         WHERE id = $2 AND code_hash = $3 AND status = 'pending' AND expires_at > now() RETURNING id`,
        [req.user.id, parts[1], sha256(parts[2])]
    );
    if (r.rows.length === 0) throw new v.BadInput("This link QR has expired. Refresh the page on the PC and scan again.");
    await audit(req, "pc_link_approved", { linkRequest: parts[1] });
    res.json({ approved: true });
});

// 3. faculty: my linked PCs, and log one out
router.get("/pcs", requireLogin, requireRole("faculty"), async (req, res) => {
    res.json((await db.query(
        `SELECT id, user_agent, ip, created_at, last_used_at, expires_at, (id = $2) AS this_pc
         FROM linked_pcs WHERE faculty_id = $1 AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`, [req.user.id, req.linkedPcId || 0]
    )).rows);
});

router.delete("/pcs/:id", requireLogin, requireRole("faculty"), async (req, res) => {
    const pcId = v.id(req.params.id, "PC");
    const r = await db.query(
        "UPDATE linked_pcs SET revoked_at = now() WHERE id = $1 AND faculty_id = $2 AND revoked_at IS NULL RETURNING id",
        [pcId, req.user.id]
    );
    if (r.rows.length === 0) throw new v.BadInput("PC not found", 404);
    await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE linked_pc_id = $1 AND revoked_at IS NULL", [pcId]);
    await audit(req, "pc_unlinked", { linkedPcId: pcId });
    res.json({ unlinked: true });
});

module.exports = router;
