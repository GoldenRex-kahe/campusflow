// Checks done on the SERVER for every protected request:
// 1. requireLogin: is there a valid access token, and is the user still active?
// 2. requireRole: is this user allowed (for example only "admin")?
const db = require("./db");
const { readAccessToken } = require("./tokens");

async function requireLogin(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Please log in" });

    let payload;
    try {
        payload = readAccessToken(token);
    } catch {
        return res.status(401).json({ error: "Login expired, please log in again" });
    }

    const user = (await db.query(
        "SELECT id, email, name, role, totp_enabled FROM users WHERE id = $1 AND is_active",
        [Number(payload.sub)]
    )).rows[0];
    if (!user) return res.status(401).json({ error: "Account not found or disabled" });

    // a linked PC stops working the moment it is unlinked or its link expires
    if (payload.lpc) {
        const pc = (await db.query(
            "SELECT 1 FROM linked_pcs WHERE id = $1 AND faculty_id = $2 AND revoked_at IS NULL AND expires_at > now()",
            [payload.lpc, user.id]
        )).rows[0];
        if (!pc) return res.status(401).json({ error: "This PC was unlinked. Link it again from your phone." });
        req.linkedPcId = payload.lpc;
    }

    req.user = user;
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: "You are not allowed to do this" });
        }
        next();
    };
}

// admins must turn on 2FA before they can use admin features
function requireAdmin2FA(req, res, next) {
    if (req.user.role === "admin" && !req.user.totp_enabled) {
        return res.status(403).json({ error: "Turn on 2FA first (POST /auth/admin/2fa/setup)" });
    }
    next();
}

module.exports = { requireLogin, requireRole, requireAdmin2FA };
