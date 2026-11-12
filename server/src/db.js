// One small wrapper so the rest of the code just calls db.query(sql, params).
// Real use: PostgreSQL through the "pg" package.
// Tests: PGlite, a real PostgreSQL that runs inside Node, so tests need no setup.
const config = require("./config");

let client = null;

async function connect() {
    if (client) return client;

    if (config.dbDriver === "pglite") {
        const { PGlite } = await import("@electric-sql/pglite");
        const pglite = new PGlite(); // in memory, empty every time
        client = {
            query: (sql, params) => pglite.query(sql, params),
            exec: (sql) => pglite.exec(sql),
            close: () => pglite.close(),
            transaction: (fn) => pglite.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
        };
    } else {
        const { Pool } = require("pg");
        if (!config.databaseUrl) {
            throw new Error("Missing DATABASE_URL in .env (run: npm run db:setup)");
        }
        const pool = new Pool({ connectionString: config.databaseUrl });
        client = {
            query: (sql, params) => pool.query(sql, params),
            exec: (sql) => pool.query(sql),
            close: () => pool.end(),
            async transaction(fn) {
                const conn = await pool.connect();
                try {
                    await conn.query("BEGIN");
                    const result = await fn({ query: (sql, params) => conn.query(sql, params) });
                    await conn.query("COMMIT");
                    return result;
                } catch (err) {
                    await conn.query("ROLLBACK");
                    throw err;
                } finally {
                    conn.release();
                }
            },
        };
    }
    return client;
}

async function query(sql, params = []) {
    const c = await connect();
    return c.query(sql, params);
}

// Run several queries as one: if any fails, none of them is saved.
// Inside fn use only tx.query (not db.query), and write the audit log after it finishes.
async function transaction(fn) {
    const c = await connect();
    return c.transaction(fn);
}

async function close() {
    if (client) {
        await client.close();
        client = null;
    }
}

module.exports = { connect, query, transaction, close };
