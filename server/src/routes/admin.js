// Admin-only routes. Every route here checks on the server:
// logged in + role is admin + admin has 2FA turned on.
const express = require("express");
const config = require("../config");
const db = require("../db");
const { requireLogin, requireRole, requireAdmin2FA } = require("../middleware");
const { audit } = require("../audit");

const router = express.Router();
router.use(requireLogin, requireRole("admin"), requireAdmin2FA);

// add a student or faculty member
router.post("/users", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim();
    const role = req.body.role;
    const regNo = String(req.body.regNo || "").trim();

    if (!["student", "faculty"].includes(role)) {
        return res.status(400).json({ error: "Role must be student or faculty" });
    }
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!email.endsWith("@" + config.collegeEmailDomain)) {
        return res.status(400).json({ error: `Email must end with @${config.collegeEmailDomain}` });
    }
    if (role === "student" && !regNo) {
        return res.status(400).json({ error: "Register number is required for students" });
    }

    const user = (await db.query(
        "INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING id, email, name, role",
        [email, name, role]
    )).rows[0];

    if (role === "student") {
        await db.query("INSERT INTO students (user_id, reg_no) VALUES ($1, $2)", [user.id, regNo]);
        user.regNo = regNo;
    }

    await audit(req, "user_created", { userId: user.id, role });
    res.status(201).json(user);
});

// list users, optionally only one role: /admin/users?role=student
router.get("/users", async (req, res) => {
    const role = req.query.role || null;
    const users = (await db.query(
        `SELECT u.id, u.email, u.name, u.role, u.is_active, s.reg_no, cl.class_id, c.name AS class_name,
                EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS has_phone
         FROM users u
         LEFT JOIN students s ON s.user_id = u.id
         LEFT JOIN class_students cl ON cl.student_id = u.id
         LEFT JOIN classes c ON c.id = cl.class_id
         WHERE ($1::text IS NULL OR u.role = $1)
         ORDER BY u.role, u.name`,
        [role]
    )).rows;
    res.json(users);
});

// reset a student's or faculty member's phone lock (lost or new phone)
router.delete("/users/:id/device", async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: "User is not valid" });
    const r = await db.query("UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id", [userId]);
    // log the old phone out too
    await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND linked_pc_id IS NULL", [userId]);
    await audit(req, "device_reset", { userId, devices: r.rows.length });
    res.json({ reset: r.rows.length > 0 });
});

module.exports = router;
