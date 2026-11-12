// Faculty PC page: link with the phone (like WhatsApp Web), attendance QR display,
// marks entry, timetable, mentor group.
import { h, message, DAYS, createApi, formValues, topBar, logo, ampm } from "./common.js";

const api = createApi("cf_faculty");
const app = document.getElementById("app");

// repeating timers of the current screen (stopped when the screen changes)
let timers = [];
function every(ms, fn) {
    fn();
    timers.push(setInterval(fn, ms));
}

function show(...nodes) {
    timers.forEach(clearInterval);
    timers = [];
    app.replaceChildren(...nodes);
}

// ---------- Login: link this PC with the phone ----------

async function loginView(error) {
    const msg = h("div");
    const qrBox = h("div", {}, h("p", { class: "muted" }, "Loading..."));
    let emailCard;

    const linkCard = h("div", {},
        h("h2", {}, "Link this PC"),
        h("ol", { class: "steps" },
            h("li", {}, "Open the CampusFlow app on your phone"),
            h("li", {}, "Tap Link a PC"),
            h("li", {}, "Scan this QR code")),
        qrBox,
        h("p", { class: "muted" }, "The code changes every minute. A linked PC stays logged in for up to 12 hours, and you can log it out from your phone at any time."),
        h("button", { class: "back", onclick: () => { linkCard.hidden = true; emailCard.hidden = false; } }, "Can't use the app? Log in with an email code"));

    emailCard = emailLogin(msg);
    emailCard.hidden = true;

    show(topBar("CampusFlow Faculty"),
        h("main", {}, h("div", { class: "card login" }, logo(), linkCard, emailCard, msg, error ? message(error) : null)));

    // a new link QR every 55 seconds; check every 2 seconds if the phone approved it
    let link = null;
    async function newLink() {
        try {
            link = await api.post("/link/start");
            qrBox.replaceChildren(h("img", { class: "qr", src: link.qr, alt: "Scan with the CampusFlow app" }));
        } catch (err) {
            qrBox.replaceChildren(message(err.message));
        }
    }
    async function checkLink() {
        if (!link || linkCard.hidden) return;
        const res = await fetch(`/link/status/${link.linkId}`, { headers: { "X-Poll-Secret": link.pollSecret } });
        const data = await res.json().catch(() => ({}));
        if (data.status === "approved") {
            api.save({ accessToken: data.accessToken, refreshToken: data.refreshToken });
            mainView();
        } else if (data.status === "expired") {
            await newLink();
        }
    }
    await newLink();
    timers.push(setInterval(newLink, 55 * 1000));
    timers.push(setInterval(checkLink, 2000));
}

// backup: email code login
function emailLogin(msg) {
    let email = "";
    const codeForm = h("form", {
        hidden: true,
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                api.save(await api.post("/auth/email/verify", { email, code: formValues(codeForm).code }));
                mainView();
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("label", {}, "6-digit code from your email"),
        h("input", { name: "code", inputMode: "numeric", required: true, autocomplete: "one-time-code" }),
        h("div", { style: "margin-top:16px" }, h("button", { type: "submit" }, "Log in")));

    const emailForm = h("form", {
        onsubmit: async (e) => {
            e.preventDefault();
            email = formValues(emailForm).email;
            try {
                const r = await api.post("/auth/email/start", { email });
                emailForm.hidden = true;
                codeForm.hidden = false;
                codeForm.querySelector("input").focus();
                msg.replaceChildren(message(r.message, "ok"));
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("label", {}, "College email"),
        h("input", { name: "email", type: "email", required: true, autocomplete: "username" }),
        h("div", { style: "margin-top:16px" }, h("button", { type: "submit" }, "Send login code")));

    return h("div", {}, h("h2", {}, "Faculty login with email"), emailForm, codeForm,
        h("button", { class: "back", style: "margin-top:12px", onclick: () => loginView() }, "Back to linking with the phone"));
}

// log out: a linked PC also unlinks itself
async function logout() {
    try {
        const pcs = await api.get("/link/pcs");
        const mine = pcs.find((p) => p.this_pc);
        if (mine) await api.del(`/link/pcs/${mine.id}`);
    } catch {
        // already logged out
    }
    await api.logout();
    loginView();
}

// ---------- Layout ----------

const tabs = [
    ["Attendance", attendanceTab],
    ["My classes", classesTab],
    ["Timetable", timetableTab],
    ["Mentor group", mentorTab],
    ["Alerts", alertsTab],
    ["Appeals", appealsTab],
    ["Weekly digest", digestTab],
];

async function mainView(tabName = "Attendance") {
    let me;
    try {
        me = await api.get("/me");
        if (me.role !== "faculty") throw new Error();
    } catch {
        await api.logout();
        return loginView();
    }
    const content = h("main");
    show(topBar("CampusFlow Faculty", me.name, h("button", { class: "small", onclick: logout }, "Log out")),
        h("nav", {}, tabs.map(([name]) => h("button", { class: name === tabName ? "active" : "", onclick: () => mainView(name) }, name))),
        content);
    try {
        await tabs.find(([name]) => name === tabName)[1](content);
    } catch (err) {
        if (err.status === 401) return loginView(err.message);
        content.append(message(err.message));
    }
}

// ---------- Attendance: show the QR of the session started on the phone ----------

async function attendanceTab(content) {
    const open = await api.get("/attendance/open");
    if (!open) {
        content.append(h("div", { class: "card" }, h("h2", {}, "Attendance"),
            h("p", {}, "Start attendance from the CampusFlow app on your phone. The QR code will appear here automatically, ready for the projector."),
            h("p", { class: "muted" }, "Keep your phone on the session screen: the QR uses your phone's location to check that students are in the room.")));
        // look every 3 seconds for a session started on the phone
        timers.push(setInterval(async () => {
            const s = await api.get("/attendance/open").catch(() => null);
            if (s) mainView("Attendance");
        }, 3000));
        return;
    }

    const qrBox = h("div", { class: "bigqr" });
    const timerText = h("p", { class: "muted center" });
    const countText = h("h3", { class: "center" });
    const review = h("div");

    content.append(
        h("div", { class: "card" },
            h("h2", { class: "center" }, `${open.class_name} - ${open.code} ${open.subject}`),
            h("p", { class: "center" }, "Students: open CampusFlow and tap Scan attendance"),
            qrBox, timerText, countText,
            h("div", { class: "center" }, h("button", {
                class: "danger",
                onclick: async () => {
                    if (!confirm("Stop attendance for this class?")) return;
                    await api.post(`/attendance/sessions/${open.id}/stop`);
                    mainView("Attendance");
                },
            }, "Stop attendance"))),
        review);

    every(3000, async () => {
        const q = await api.get(`/attendance/sessions/${open.id}/qr`).catch(() => null);
        if (!q || q.ended) return mainView("Attendance");
        if (q.paused) {
            qrBox.replaceChildren(message(q.reason));
            timerText.textContent = "";
        } else {
            const img = qrBox.querySelector("img") || h("img", { alt: "Attendance QR" });
            img.src = q.qr;
            qrBox.replaceChildren(img);
            const closes = q.closesIn === null || q.closesIn === undefined ? "" : `   |   QR closes in ${Math.floor(q.closesIn / 60)}:${String(q.closesIn % 60).padStart(2, "0")}`;
            timerText.textContent = `New code in ${q.validFor} s${closes}`;
        }
    });

    every(4000, async () => {
        const s = await api.get(`/attendance/sessions/${open.id}`).catch(() => null);
        if (!s) return;
        countText.textContent = `Present: ${s.counts.present} / ${s.counts.total}` + (s.counts.flagged ? `   Needs review: ${s.counts.flagged}` : "");
        review.replaceChildren(reviewCard(s));
    });
}

function reviewCard(s) {
    const flagged = s.students.filter((x) => x.status === "flagged");
    const missing = s.students.filter((x) => !x.status);
    const decide = (recordId, status) => api.post(`/attendance/records/${recordId}/decide`, { status }).catch((e) => alert(e.message));
    const byHand = async (student) => {
        const reason = prompt(`Mark ${student.name} present by hand. Reason (for example: phone not working):`);
        if (!reason) return;
        await api.post(`/attendance/sessions/${s.id}/manual`, { studentId: student.student_id, reason }).catch((e) => alert(e.message));
    };

    return h("div", { class: "grid2" },
        h("div", { class: "card" }, h("h2", {}, `Needs review (${flagged.length})`),
            flagged.length === 0 ? h("p", { class: "muted" }, "Nothing to review.") :
                h("table", {}, flagged.map((x) => h("tr", {},
                    h("td", {}, `${x.reg_no} ${x.name}`, h("div", { class: "muted" }, x.reason || "")),
                    h("td", {}, h("button", { class: "small", onclick: () => decide(x.record_id, "present") }, "Accept"), " ",
                        h("button", { class: "small danger", onclick: () => decide(x.record_id, "absent") }, "Reject")))))),
        h("div", { class: "card" }, h("h2", {}, `Not scanned yet (${missing.length})`),
            missing.length === 0 ? h("p", { class: "muted" }, "Everyone has scanned.") :
                h("table", {}, missing.map((x) => h("tr", {},
                    h("td", {}, `${x.reg_no} ${x.name}`),
                    h("td", {}, h("button", { class: "small secondary", onclick: () => byHand(x) }, "Mark by hand")))))));
}

// ---------- My classes -> assessments -> marks ----------

async function classesTab(content) {
    const classes = await api.get("/faculty/classes");
    content.append(h("div", { class: "card" }, h("h2", {}, "Classes you teach"),
        classes.length === 0
            ? h("p", { class: "muted" }, "The admin has not assigned any classes to you yet.")
            : h("table", {}, h("tr", {}, h("th", {}, "Class"), h("th", {}, "Subject"), h("th", {}, "Students")),
                classes.map((c) => h("tr", { class: "clickable", onclick: () => assessmentsView(content, c) },
                    h("td", {}, c.class_name), h("td", {}, `${c.code} ${c.subject}`), h("td", {}, c.students))))));
}

async function assessmentsView(content, cls) {
    const list = await api.get(`/faculty/class-subjects/${cls.id}/assessments`);
    const msg = h("div");
    const form = h("form", {
        class: "row",
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                await api.post(`/faculty/class-subjects/${cls.id}/assessments`, formValues(form));
                assessmentsView(content, cls);
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("div", {}, h("label", {}, "Name"), h("input", { name: "name", required: true, placeholder: "Internal 1" })),
        h("div", {}, h("label", {}, "Out of"), h("input", { name: "maxMarks", type: "number", min: 1, required: true, placeholder: "50" })),
        h("div", {}, h("label", {}, "Date"), h("input", { name: "heldOn", type: "date" })),
        h("button", { type: "submit" }, "Add test"));

    const summary = await api.get(`/insights/class-subjects/${cls.id}/summary`).catch(() => null);
    content.replaceChildren(
        h("button", { class: "back", onclick: () => mainView("My classes") }, "< My classes"),
        summary ? h("div", { class: "card insight" }, h("h2", {}, "How the class is doing"),
            h("p", {}, summary.text),
            summary.needHelp.length ? h("p", { class: "muted" }, `Below 40% in the latest test: ${summary.needHelp.map((n) => `${n.name} (${n.percent}%)`).join(", ")}`) : null,
            byLine(summary.by)) : null,
        h("div", { class: "card" }, h("h2", {}, `${cls.class_name} - ${cls.code} ${cls.subject}`),
            h("h3", {}, "Add a test or exam"), form, msg,
            h("h3", {}, "Tests"),
            list.length === 0 ? h("p", { class: "muted" }, "No tests yet.") :
                h("table", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Out of"), h("th", {}, "Date")),
                    list.map((a) => h("tr", { class: "clickable", onclick: () => marksView(content, cls, a.id) },
                        h("td", {}, a.name), h("td", {}, a.max_marks), h("td", {}, a.held_on || ""))))));
}

async function marksView(content, cls, assessmentId) {
    const { assessment, students } = await api.get(`/faculty/assessments/${assessmentId}/marks`);
    const msg = h("div");
    const inputs = students.map((s) => h("input", {
        type: "number", min: 0, max: assessment.max_marks, step: "0.5",
        value: s.marks ?? "", "data-student": s.student_id,
    }));

    const save = h("button", {
        onclick: async () => {
            // only send boxes that have a number in them
            const marks = inputs.filter((i) => i.value !== "").map((i) => ({ studentId: Number(i.dataset.student), marks: Number(i.value) }));
            if (marks.length === 0) return msg.replaceChildren(message("Type at least one mark"));
            try {
                const r = await api.put(`/faculty/assessments/${assessmentId}/marks`, { marks });
                msg.replaceChildren(message(`Saved ${r.saved} marks (${r.changed} changed)`, "ok"));
            } catch (err) {
                msg.replaceChildren(message(err.message + ". Nothing was saved."));
            }
        },
    }, "Save marks");

    content.replaceChildren(
        h("button", { class: "back", onclick: () => assessmentsView(content, cls) }, `< ${cls.class_name} ${cls.code}`),
        h("div", { class: "card" }, h("h2", {}, `${assessment.name} (out of ${assessment.max_marks})`),
            h("p", { class: "muted" }, "Leave a box empty if the mark is not ready. If any mark is wrong (too high), nothing is saved."),
            h("table", {}, h("tr", {}, h("th", {}, "Register no."), h("th", {}, "Name"), h("th", {}, "Marks")),
                students.map((s, i) => h("tr", {}, h("td", {}, s.reg_no), h("td", {}, s.name), h("td", {}, inputs[i])))),
            h("div", { style: "margin-top:14px" }, save), msg));
}

// ---------- Timetable ----------

async function timetableTab(content) {
    const periods = await api.get("/faculty/timetable");
    content.append(h("div", { class: "card" }, h("h2", {}, "My weekly timetable"),
        periods.length === 0 ? h("p", { class: "muted" }, "No periods yet.") :
            h("table", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "Time"), h("th", {}, "Class"), h("th", {}, "Subject"), h("th", {}, "Room")),
                periods.map((p) => h("tr", {}, h("td", {}, DAYS[p.day]), h("td", {}, `${ampm(p.start)} - ${ampm(p.end)}`),
                    h("td", {}, p.class_name), h("td", {}, `${p.code} ${p.subject}`), h("td", {}, p.room))))));
}

// ---------- Mentor group ----------

async function mentorTab(content) {
    const groups = await api.get("/faculty/mentor-groups");
    if (groups.length === 0) {
        content.append(h("div", { class: "card" }, h("h2", {}, "Mentor group"), h("p", { class: "muted" }, "You are not a mentor of any group yet.")));
        return;
    }
    for (const g of groups) {
        const codes = [...new Set(g.students.flatMap((s) => Object.keys(s.subjects)))].sort();
        content.append(h("div", { class: "card" }, h("h2", {}, `${g.class_name} - ${g.name}`),
            h("p", { class: "muted" }, "Average % of all tests so far, per subject. Click a student for a summary."),
            h("table", {},
                h("tr", {}, h("th", {}, "Register no."), h("th", {}, "Name"), codes.map((c) => h("th", {}, c))),
                g.students.map((s) => {
                    const row = h("tr", { class: "clickable" }, h("td", {}, s.reg_no), h("td", {}, s.name),
                        codes.map((c) => h("td", {}, s.subjects[c] === undefined ? "-" : `${s.subjects[c]}%`)));
                    row.addEventListener("click", () => toggleSummary(row, s.id, 2 + codes.length));
                    return row;
                }))));
    }
}

async function toggleSummary(row, studentId, columns) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains("summary-row")) return next.remove();
    const cell = h("td", { colSpan: columns }, h("span", { class: "muted" }, "Loading..."));
    row.after(h("tr", { class: "summary-row" }, cell));
    try {
        const s = await api.get(`/insights/students/${studentId}/summary`);
        cell.replaceChildren(h("p", {}, s.text), byLine(s.by));
    } catch (err) {
        cell.replaceChildren(message(err.message));
    }
}

// small note saying how a summary was made
function byLine(by) {
    return h("p", { class: "muted small" }, by === "ai" ? "Written by AI from the numbers." : "Made from attendance and marks.");
}

// ---------- Alerts (early warning) ----------

const SEVERITY = { urgent: "Urgent", concern: "Concern", watch: "Watch" };

async function alertsTab(content) {
    const alerts = await api.get("/insights/alerts");
    const msg = h("div");

    async function handle(a, status) {
        const note = prompt(status === "handled" ? "What did you do? (optional, for example: spoke to the student)" : "Why is it not needed? (optional)", "");
        if (note === null) return;
        try {
            await api.post(`/insights/alerts/${a.id}/handle`, { status, note });
            mainView("Alerts");
        } catch (err) {
            msg.replaceChildren(message(err.message));
        }
    }

    content.append(h("div", { class: "card" }, h("h2", {}, `Students who may need help (${alerts.length})`),
        h("p", { class: "muted" }, "Found automatically from attendance and marks. Each alert says why. You decide what to do: nothing happens to the student automatically."),
        msg,
        alerts.length === 0 ? h("p", { class: "muted" }, "No open alerts. Good news.") :
            h("table", {}, h("tr", {}, h("th", {}, "Student"), h("th", {}, "Why"), h("th", {}, "Suggested next step"), h("th", {}, "")),
                alerts.map((a) => h("tr", {},
                    h("td", {}, h("span", { class: `badge ${a.severity}` }, SEVERITY[a.severity]), " ", `${a.reg_no} ${a.name}`,
                        h("div", { class: "muted" }, a.as_mentor ? "Your mentee" : `Your subject ${a.code}`)),
                    h("td", {}, h("strong", {}, a.title), h("div", {}, a.reason)),
                    h("td", {}, a.suggestion || ""),
                    h("td", { class: "actions" },
                        h("button", { class: "small", onclick: () => handle(a, "handled") }, "Spoke to student"), " ",
                        h("button", { class: "small secondary", onclick: () => handle(a, "not_needed") }, "Not needed")))))));
}

// ---------- Attendance appeals ----------

async function appealsTab(content) {
    const [pending, approved, rejected] = await Promise.all([
        api.get("/appeals?status=pending"), api.get("/appeals?status=approved"), api.get("/appeals?status=rejected"),
    ]);
    const msg = h("div");

    async function decide(a, approve) {
        const note = approve ? "" : prompt("Reason for rejecting (the student will see it):", "");
        if (note === null) return;
        try {
            await api.post(`/appeals/${a.id}/decide`, { approve, note });
            mainView("Appeals");
        } catch (err) {
            msg.replaceChildren(message(err.message));
        }
    }

    const when = (d) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const row = (a, actions) => h("tr", {},
        h("td", {}, `${a.reg_no} ${a.name}`, h("div", { class: "muted" }, `${a.class_name} - ${a.code}`)),
        h("td", {}, when(a.started_at), h("div", { class: "muted" }, `Marked: ${a.marked}${a.record_reason ? ` (${a.record_reason})` : ""}`)),
        h("td", {}, a.reason, a.note ? h("div", { class: "muted" }, `Your note: ${a.note}`) : null),
        h("td", { class: "actions" }, actions));

    content.append(
        h("div", { class: "card" }, h("h2", {}, `Appeals waiting (${pending.length})`),
            h("p", { class: "muted" }, "Students can ask to be marked present within 7 days of a class. Approving marks them present; every decision is logged."),
            msg,
            pending.length === 0 ? h("p", { class: "muted" }, "No appeals waiting.") :
                h("table", {}, h("tr", {}, h("th", {}, "Student"), h("th", {}, "Class"), h("th", {}, "Reason"), h("th", {}, "")),
                    pending.map((a) => row(a, [
                        h("button", { class: "small", onclick: () => decide(a, true) }, "Mark present"), " ",
                        h("button", { class: "small danger", onclick: () => decide(a, false) }, "Reject")])))),
        h("div", { class: "card" }, h("h2", {}, "Recently decided"),
            approved.length + rejected.length === 0 ? h("p", { class: "muted" }, "Nothing yet.") :
                h("table", {}, h("tr", {}, h("th", {}, "Student"), h("th", {}, "Class"), h("th", {}, "Reason"), h("th", {}, "Result")),
                    [...approved, ...rejected].slice(0, 30).map((a) => row(a, a.status === "approved" ? "Marked present" : "Rejected")))));
}

// ---------- Weekly digest ----------

async function digestTab(content) {
    const d = await api.get("/insights/digest");
    content.append(h("div", { class: "card" }, h("h2", {}, `Weekly summary - week of ${d.week_start}`),
        h("p", { class: "muted" }, "This is emailed to you every Monday morning, built from this week's attendance, marks and alerts.")));

    if (!d.groups.length && !d.subjects.length) {
        content.append(h("div", { class: "card" }, h("p", { class: "muted" }, "Nothing yet: you have no mentor group or classes.")));
        return;
    }
    for (const g of d.groups) {
        content.append(h("div", { class: "card" }, h("h2", {}, `${g.class_name} - ${g.name} (${g.students} students)`),
            h("p", {}, `Attendance: ${g.attendance_this_week ?? "-"}% this week, ${g.attendance_last_week ?? "-"}% last week.`),
            h("h3", {}, "Needs attention"),
            g.attention.length === 0 ? h("p", { class: "muted" }, "Nobody this week.") :
                h("table", {}, g.attention.map((a) => h("tr", {},
                    h("td", {}, h("span", { class: `badge ${a.severity}` }, SEVERITY[a.severity]), " ", `${a.reg_no} ${a.name}`),
                    h("td", {}, a.reasons.join(" "), h("div", { class: "muted" }, `Next step: ${a.suggestion}`))))),
            h("h3", {}, "Improving"),
            g.improving.length ? h("ul", {}, g.improving.map((x) => h("li", {}, x))) : h("p", { class: "muted" }, "No big changes this week."),
            h("p", {}, `Flagged scans waiting for review: ${g.flagged_waiting}. Open alerts: ${g.open_alerts}.`),
            g.handled.length ? [h("h3", {}, "Done last week"), h("ul", {}, g.handled.map((x) => h("li", {}, x)))] : null));
    }
    for (const s of d.subjects) {
        content.append(h("div", { class: "card" }, h("h2", {}, `${s.class_name} - ${s.code} ${s.subject}`),
            s.lines.map((l) => h("p", {}, l)),
            s.need_help.length ? h("p", { class: "muted" }, `Below 40% in the latest test: ${s.need_help.join(", ")}`) : null));
    }
}

// ---------- Start ----------
if (api.loggedIn()) mainView();
else loginView();
