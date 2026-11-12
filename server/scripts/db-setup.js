// One-time setup:  npm run db:setup
// Creates a "campusflow" database user and database in your PostgreSQL,
// and writes the settings to .env (with new random secrets).
// You type the PostgreSQL admin ("postgres") password; it is not saved anywhere.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { ask } = require("./ask");

const ENV_FILE = path.join(__dirname, "..", ".env");

function readEnv() {
    const values = {};
    if (fs.existsSync(ENV_FILE)) {
        for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
            const match = line.match(/^([A-Z_]+)=(.*)$/);
            if (match) values[match[1]] = match[2];
        }
    }
    return values;
}

function writeEnv(values) {
    const text = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    fs.writeFileSync(ENV_FILE, text);
}

async function main() {
    console.log("CampusFlow database setup\n");
    const host = (await ask("PostgreSQL host [localhost]: ")) || "localhost";
    const port = (await ask("PostgreSQL port [5432]: ")) || "5432";
    const adminUser = (await ask("PostgreSQL admin username [postgres]: ")) || "postgres";
    const adminPassword = await ask(`Password of the PostgreSQL "${adminUser}" user: `, { hidden: true });

    const env = readEnv();
    const dbPassword = crypto.randomBytes(24).toString("hex"); // only letters and numbers

    const admin = new Client({ host, port: Number(port), user: adminUser, password: adminPassword, database: "postgres" });
    try {
        await admin.connect();
    } catch (err) {
        if (err.code === "28P01") {
            throw new Error(`Wrong password for "${adminUser}". Nothing was changed. See README "Forgot the PostgreSQL password".`);
        }
        throw err;
    }

    const roleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'campusflow'")).rows.length > 0;
    if (roleExists) {
        await admin.query(`ALTER ROLE campusflow WITH LOGIN PASSWORD '${dbPassword}'`);
        console.log('Database user "campusflow" already existed: new password set.');
    } else {
        await admin.query(`CREATE ROLE campusflow WITH LOGIN PASSWORD '${dbPassword}'`);
        console.log('Created database user "campusflow".');
    }

    const dbExists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = 'campusflow'")).rows.length > 0;
    if (!dbExists) {
        await admin.query("CREATE DATABASE campusflow OWNER campusflow");
        console.log('Created database "campusflow".');
    } else {
        console.log('Database "campusflow" already exists, kept as it is.');
    }
    await admin.end();

    const domain = (await ask(`College email domain [${env.COLLEGE_EMAIL_DOMAIN || "college.edu"}]: `))
        || env.COLLEGE_EMAIL_DOMAIN || "college.edu";

    writeEnv({
        PORT: env.PORT || "4000",
        DB_DRIVER: "postgres",
        DATABASE_URL: `postgres://campusflow:${dbPassword}@${host}:${port}/campusflow`,
        JWT_SECRET: env.JWT_SECRET || crypto.randomBytes(48).toString("hex"),
        COLLEGE_EMAIL_DOMAIN: domain.replace(/^@/, "").toLowerCase(),
        EMAIL_MODE: env.EMAIL_MODE || "console",
        SMTP_HOST: env.SMTP_HOST || "",
        SMTP_PORT: env.SMTP_PORT || "587",
        SMTP_USER: env.SMTP_USER || "",
        SMTP_PASS: env.SMTP_PASS || "",
        SMTP_FROM: env.SMTP_FROM || "",
    });

    console.log("\nSaved settings to server/.env (keep this file private, it is not committed to git).");
    console.log("Next: npm run create-admin");
}

main().catch((err) => {
    console.error("Setup failed:", err.message);
    process.exit(1);
});
