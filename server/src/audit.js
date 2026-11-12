// Saves important actions (logins, new users, changes) to the audit_log table.
const db = require("./db");

async function audit(req, action, details = {}, actorUserId = null) {
    const actor = actorUserId ?? (req.user ? req.user.id : null);
    await db.query(
        "INSERT INTO audit_log (actor_user_id, action, details, ip) VALUES ($1, $2, $3, $4)",
        [actor, action, JSON.stringify(details), req.ip]
    );
}

module.exports = { audit };
