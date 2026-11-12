// Small helpers to check what the browser or app sent us.

class BadInput extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function text(value, label, { max = 200 } = {}) {
    const v = String(value ?? "").trim();
    if (!v) throw new BadInput(`${label} is required`);
    if (v.length > max) throw new BadInput(`${label} is too long`);
    return v;
}

function id(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new BadInput(`${label} is not valid`);
    return n;
}

function number(value, label, { min = -Infinity, max = Infinity } = {}) {
    const n = Number(value);
    if (value === "" || value === null || value === undefined || !Number.isFinite(n)) {
        throw new BadInput(`${label} must be a number`);
    }
    if (n < min || n > max) throw new BadInput(`${label} must be between ${min} and ${max}`);
    return n;
}

// "9:00" or "09:00" -> "09:00"
function time(value, label) {
    const m = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new BadInput(`${label} must look like 09:30`);
    return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function date(value, label) {
    if (value === undefined || value === null || value === "") return null;
    const v = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        throw new BadInput(`${label} must look like 2026-11-30`);
    }
    return v;
}

module.exports = { BadInput, text, id, number, time, date };
