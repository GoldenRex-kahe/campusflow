// Login tokens.
// - access token: short (15 min) signed JWT sent with every request
// - refresh token: long random string, only its hash is saved, used to get a new access token
// A linked PC gets tokens tied to its link (lpc), so unlinking from the phone logs it out at once.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("./config");
const db = require("./db");

function sha256(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function makeAccessToken(user, linkedPcId) {
    const payload = { sub: String(user.id), role: user.role };
    if (linkedPcId) payload.lpc = linkedPcId;
    return jwt.sign(payload, config.jwtSecret, { expiresIn: `${config.accessTokenMinutes}m` });
}

function readAccessToken(token) {
    return jwt.verify(token, config.jwtSecret); // throws if wrong or expired
}

async function issueTokens(user, { linkedPcId = null } = {}) {
    const refreshToken = crypto.randomBytes(32).toString("hex");
    if (linkedPcId) {
        // a linked PC's refresh token ends when the link expires
        await db.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, linked_pc_id)
             SELECT $1, $2, expires_at, id FROM linked_pcs WHERE id = $3`,
            [user.id, sha256(refreshToken), linkedPcId]
        );
    } else {
        await db.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, now() + make_interval(days => $3))`,
            [user.id, sha256(refreshToken), config.refreshTokenDays]
        );
    }
    return { accessToken: makeAccessToken(user, linkedPcId), refreshToken };
}

// swap an old refresh token for new tokens (the old one stops working)
async function rotateRefreshToken(refreshToken) {
    const result = await db.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         RETURNING user_id, linked_pc_id`,
        [sha256(String(refreshToken))]
    );
    if (result.rows.length === 0) return null;
    const { user_id: userId, linked_pc_id: linkedPcId } = result.rows[0];

    if (linkedPcId) {
        const pc = (await db.query(
            "SELECT 1 FROM linked_pcs WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()", [linkedPcId]
        )).rows[0];
        if (!pc) return null;
        await db.query("UPDATE linked_pcs SET last_used_at = now() WHERE id = $1", [linkedPcId]);
    }

    const user = (await db.query("SELECT id, role FROM users WHERE id = $1 AND is_active", [userId])).rows[0];
    if (!user) return null;

    return issueTokens(user, { linkedPcId });
}

async function revokeRefreshToken(refreshToken) {
    await db.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
        [sha256(String(refreshToken))]
    );
}

module.exports = { sha256, issueTokens, readAccessToken, rotateRefreshToken, revokeRefreshToken };
