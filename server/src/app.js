// Builds the Express app (server.js starts it, the tests start it too).
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const config = require("./config");
const db = require("./db");
const { requireLogin } = require("./middleware");
const { BadInput } = require("./validate");

function createApp() {
    const app = express();

    // behind a proxy (for example Cloudflare Tunnel) this makes req.ip the real visitor IP
    if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));

    app.use(helmet());                       // safe HTTP headers
    // keep the exact request text too: phone signatures are checked against it
    app.use(express.json({ limit: "100kb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));

    // slow down people guessing codes or passwords
    const loginLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: config.isTest ? 1000 : 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many tries, wait 15 minutes" },
    });

    app.get("/health", (req, res) => res.json({ ok: true }));

    app.use("/auth", loginLimit, require("./routes/auth"));
    app.use("/admin", require("./routes/admin"));
    app.use("/admin", require("./routes/admin-academics"));
    app.use("/faculty", require("./routes/faculty"));
    app.use("/student", require("./routes/student"));
    app.use("/devices", require("./routes/devices").router);
    app.use("/attendance", require("./routes/attendance").router);
    app.use("/link", require("./routes/link"));
    app.use("/insights", require("./routes/insights"));
    app.use("/appeals", require("./routes/appeals"));

    // PC pages (admin and faculty) from the /web folder
    app.use(express.static(path.join(__dirname, "..", "web")));

    // who am I?
    app.get("/me", requireLogin, async (req, res) => {
        const me = { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role };
        if (me.role === "student") {
            const s = (await db.query("SELECT reg_no FROM students WHERE user_id = $1", [me.id])).rows[0];
            me.regNo = s ? s.reg_no : null;
        }
        res.json(me);
    });

    app.use((req, res) => res.status(404).json({ error: "Not found" }));

    // any unexpected error: log it, but never show details to the user
    app.use((err, req, res, next) => {
        if (err instanceof BadInput) {
            return res.status(err.status).json({ error: err.message });
        }
        if (err.code === "23503") {
            return res.status(400).json({ error: "Something you chose does not exist" });
        }
        if (err.code === "23505") {
            return res.status(409).json({ error: "This already exists (same email, register number, code or name)" });
        }
        if (err.type === "entity.parse.failed") {
            return res.status(400).json({ error: "Invalid JSON" });
        }
        console.error(err);
        res.status(500).json({ error: "Something went wrong" });
    });

    return app;
}

module.exports = { createApp };
