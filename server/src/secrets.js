// Encrypts secrets before they are saved in the database (for example the admin 2FA secret),
// so a copy of the database alone is not enough to make 2FA codes.
// Key: ENCRYPTION_KEY in .env (long random text). If missing, one is derived from JWT_SECRET.
const crypto = require("crypto");
const config = require("./config");

const PREFIX = "enc:v1:";
const key = crypto.createHash("sha256")
    .update(process.env.ENCRYPTION_KEY || `${config.jwtSecret}:secrets`)
    .digest(); // 32 bytes for AES-256

function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

// also accepts old values saved before encryption existed (plain text)
function decrypt(value) {
    if (!value || !value.startsWith(PREFIX)) return value;
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

const isEncrypted = (value) => !!value && value.startsWith(PREFIX);

module.exports = { encrypt, decrypt, isEncrypted };
