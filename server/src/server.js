// Start the API:  npm start
const config = require("./config");
const clock = require("./clock");
const db = require("./db");
const { migrate } = require("./migrate");
const { createApp } = require("./app");
const insights = require("./insights");
const ai = require("./ai");

const CHECK_EVERY_MINUTES = 15;
const DIGEST_HOUR = 8; // Monday 8 AM (college time)

// every 15 minutes: look for students who need attention; on Monday morning send the weekly digests
async function backgroundJobs() {
    try {
        const r = await insights.runChecks();
        if (r.created) console.log(`Early warning: ${r.created} new alert(s)`);

        const local = (await db.query(
            "SELECT extract(isodow FROM $1::timestamptz AT TIME ZONE $2)::int AS dow, extract(hour FROM $1::timestamptz AT TIME ZONE $2)::int AS hour",
            [clock.now(), config.collegeTimezone]
        )).rows[0];
        if (local.dow === 1 && local.hour >= DIGEST_HOUR) {
            const d = await insights.sendWeeklyDigests();
            if (d.sent) console.log(`Weekly digest sent to ${d.sent} faculty member(s)`);
        }
    } catch (err) {
        console.error("Background job failed:", err.message);
    }
}

async function main() {
    await migrate(); // make sure the database tables are up to date
    createApp().listen(config.port, () => {
        console.log(`CampusFlow API running on http://localhost:${config.port}`);
        if (config.emailMode === "console") {
            console.log("Email mode: console (login codes and emails are printed here, not sent)");
        }
        console.log(`AI writing: ${ai.enabled() ? "on (" + ai.MODEL + ")" : "off (rules and templates only)"}`);
    });
    setTimeout(backgroundJobs, 10 * 1000);
    setInterval(backgroundJobs, CHECK_EVERY_MINUTES * 60 * 1000);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
