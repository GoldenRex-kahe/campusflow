// Create the first admin account:  npm run create-admin
// After logging in, the admin must turn on 2FA before using admin features.
const bcrypt = require("bcryptjs");
const db = require("../src/db");
const { migrate } = require("../src/migrate");
const { ask } = require("./ask");

async function main() {
    await migrate();

    const email = (await ask("Admin email: ")).toLowerCase();
    const name = await ask("Admin name: ");
    const password = await ask("Password (at least 12 characters): ", { hidden: true });
    const again = await ask("Type the password again: ", { hidden: true });

    if (!email.includes("@") || !name) throw new Error("Email and name are required");
    if (password.length < 12) throw new Error("Password must be at least 12 characters");
    if (password !== again) throw new Error("Passwords do not match");

    const hash = await bcrypt.hash(password, 12);
    await db.query(
        "INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)",
        [email, name, hash]
    );
    console.log(`Admin ${email} created. Log in, then turn on 2FA.`);
    await db.close();
}

main().catch(async (err) => {
    console.error("Could not create admin:", err.code === "23505" ? "this email already exists" : err.message);
    await db.close();
    process.exit(1);
});
