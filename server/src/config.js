// All settings come from the .env file (see .env.example).
require("dotenv").config({ quiet: true });

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing setting ${name} in .env (see .env.example)`);
    }
    return value;
}

const isTest = process.env.NODE_ENV === "test";

module.exports = {
    isTest,
    port: Number(process.env.PORT || 4000),

    // "postgres" = real database (DATABASE_URL), "pglite" = embedded database for tests
    dbDriver: process.env.DB_DRIVER || "postgres",
    databaseUrl: process.env.DATABASE_URL,

    jwtSecret: isTest ? "test-secret" : required("JWT_SECRET"),
    accessTokenMinutes: 15,
    refreshTokenDays: 30,

    // only emails like name@<this domain> can be students or faculty
    collegeEmailDomain: (process.env.COLLEGE_EMAIL_DOMAIN || "college.edu").toLowerCase(),

    // "console" prints login codes in the terminal (development),
    // "smtp" sends real emails, "memory" is used by the tests
    emailMode: process.env.EMAIL_MODE || "console",
    smtp: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM,
    },

    appName: "CampusFlow",

    // attendance rules
    collegeTimezone: process.env.COLLEGE_TIMEZONE || "Asia/Kolkata", // timetable times are in this zone
    attendanceWindowMinutes: Number(process.env.ATTENDANCE_WINDOW_MINUTES || 20), // QR open from the start of the period
    reopenMinutes: Number(process.env.REOPEN_MINUTES || 10), // QR open after an approved reopen request
};
