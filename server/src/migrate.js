// Runs every file in /migrations once, in name order (001_, 002_, ...).
// Already-run files are remembered in the schema_migrations table.
const fs = require("fs");
const path = require("path");
const db = require("./db");

async function migrate({ log = console.log } = {}) {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        run_at timestamptz NOT NULL DEFAULT now()
    )`);

    const done = (await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name);
    const dir = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

    const client = await db.connect();
    for (const file of files) {
        if (done.includes(file)) continue;
        const sql = fs.readFileSync(path.join(dir, file), "utf8");
        await client.exec(`BEGIN;\n${sql}\nCOMMIT;`);
        await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        log(`Migration done: ${file}`);
    }
}

module.exports = { migrate };
