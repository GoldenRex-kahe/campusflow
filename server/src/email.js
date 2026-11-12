// Sends emails: login codes, urgent alerts and weekly digests.
// console mode: prints them in the server terminal (for development only)
// memory mode: keeps them in a list so the tests can read them
// smtp mode: sends real emails (college email account or any SMTP)
const nodemailer = require("nodemailer");
const config = require("./config");

const sentForTests = [];      // login codes
const messagesForTests = [];  // other emails
let transport = null;

async function deliver(to, subject, text) {
    if (!transport) {
        transport = nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            auth: { user: config.smtp.user, pass: config.smtp.pass },
        });
    }
    await transport.sendMail({ from: config.smtp.from, to, subject, text });
}

async function sendLoginCode(to, code) {
    const text = `Your ${config.appName} login code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`;
    if (config.emailMode === "memory") return void sentForTests.push({ to, code });
    if (config.emailMode === "console") return void console.log(`[DEV EMAIL] to ${to}: login code ${code}`);
    await deliver(to, `${config.appName} login code`, text);
}

// any other email (alerts, digests). A failed email is logged but never breaks the caller.
async function sendText(to, subject, text) {
    if (config.emailMode === "memory") return void messagesForTests.push({ to, subject, text });
    if (config.emailMode === "console") return void console.log(`[DEV EMAIL] to ${to}: ${subject}\n${text}\n`);
    try {
        await deliver(to, subject, text);
    } catch (err) {
        console.error(`Email to ${to} failed: ${err.message}`);
    }
}

module.exports = { sendLoginCode, sendText, sentForTests, messagesForTests };
