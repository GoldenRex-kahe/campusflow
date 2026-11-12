// Admin PC page: login with 2FA, users, subjects, classes (students, faculty, mentor groups, timetable).
import { h, message, DAYS, createApi, formValues, topBar, logo, ampm, timePicker } from "./common.js";

const api = createApi("cf_admin");
const app = document.getElementById("app");

function show(...nodes) {
    app.replaceChildren(...nodes);
}

// ---------- Login and 2FA ----------

function loginView(error) {
    let needCode = false;
    const msg = h("div");
    const codeBox = h("div", { hidden: true },
        h("label", {}, "2FA code from your authenticator app"),
        h("input", { name: "totp", inputMode: "numeric", autocomplete: "one-time-code" }));

    const form = h("form", {
        onsubmit: async (e) => {
            e.preventDefault();
            msg.replaceChildren();
            try {
                const result = await api.post("/auth/admin/login", formValues(form));
                api.save(result);
                if (result.totpSetupRequired) setup2faView();
                else mainView();
            } catch (err) {
                if (err.data && err.data.totpRequired && !needCode) {
                    needCode = true;
                    codeBox.hidden = false;
                    codeBox.querySelector("input").focus();
                    msg.append(message("Enter the 6-digit code from your authenticator app", "ok"));
                } else {
                    msg.append(message(err.message));
                }
            }
        },
    },
        h("label", {}, "Email"), h("input", { name: "email", type: "email", required: true, autocomplete: "username" }),
        h("label", {}, "Password"), h("input", { name: "password", type: "password", required: true, autocomplete: "current-password" }),
        codeBox,
        h("div", { style: "margin-top:16px" }, h("button", { type: "submit" }, "Log in")),
        msg);

    show(topBar("CampusFlow Admin"),
        h("main", {}, h("div", { class: "card login" }, logo(), h("h2", {}, "Admin login"), form, error ? message(error) : null)));
}

async function setup2faView() {
    const msg = h("div");
    let data;
    try {
        data = await api.post("/auth/admin/2fa/setup");
    } catch (err) {
        return loginView(err.message);
    }
    const form = h("form", {
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                await api.post("/auth/admin/2fa/enable", formValues(form));
                mainView();
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("label", {}, "6-digit code shown in the app"),
        h("input", { name: "code", inputMode: "numeric", required: true, autocomplete: "one-time-code" }),
        h("div", { style: "margin-top:16px" }, h("button", { type: "submit" }, "Turn on 2FA")),
        msg);

    show(topBar("CampusFlow Admin"),
        h("main", {}, h("div", { class: "card login" }, logo(),
            h("h2", {}, "Turn on 2FA (required)"),
            h("p", {}, "Scan this QR with Google Authenticator, Microsoft Authenticator or a similar app, then type the code it shows."),
            h("img", { class: "qr", src: data.qr, alt: "2FA QR code" }),
            form)));
}

// ---------- Main layout with tabs ----------

const tabs = [
    ["Users", usersTab],
    ["Subjects", subjectsTab],
    ["Classes", classesTab],
    ["Reopen requests", requestsTab],
    ["Alerts", alertsTab],
];

async function mainView(tabName = "Users") {
    let me;
    try {
        me = await api.get("/me");
    } catch {
        return loginView();
    }
    const content = h("main");
    const nav = h("nav", {}, tabs.map(([name, fn]) =>
        h("button", { class: name === tabName ? "active" : "", onclick: () => mainView(name) }, name)));

    show(topBar("CampusFlow Admin", me.name,
            h("button", { class: "small", onclick: async () => { await api.logout(); loginView(); } }, "Log out")),
        nav, content);

    const fn = tabs.find(([name]) => name === tabName)[1];
    try {
        await fn(content);
    } catch (err) {
        if (err.status === 401) return loginView("Please log in again");
        if (err.status === 403) return setup2faView();
        content.append(message(err.message));
    }
}

// ---------- Users ----------

async function usersTab(content) {
    const users = (await api.get("/admin/users")).filter((u) => u.role !== "admin");
    const msg = h("div");
    const regNo = h("div", {}, h("label", {}, "Register number"), h("input", { name: "regNo" }));

    const form = h("form", {
        class: "row",
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                await api.post("/admin/users", formValues(form));
                mainView("Users");
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("div", {}, h("label", {}, "Role"), h("select", {
            name: "role",
            onchange: (e) => { regNo.hidden = e.target.value !== "student"; },
        }, h("option", { value: "student" }, "Student"), h("option", { value: "faculty" }, "Faculty"))),
        h("div", {}, h("label", {}, "Full name"), h("input", { name: "name", required: true })),
        h("div", {}, h("label", {}, "College email"), h("input", { name: "email", type: "email", required: true })),
        regNo,
        h("button", { type: "submit" }, "Add"));

    content.append(
        h("div", { class: "card" }, h("h2", {}, "Add a student or faculty member"), form, msg),
        h("div", { class: "card" }, h("h2", {}, `People (${users.length})`),
            h("table", {},
                h("tr", {}, h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Role"), h("th", {}, "Register no."), h("th", {}, "Class"), h("th", {}, "Phone")),
                users.map((u) => h("tr", {},
                    h("td", {}, u.name), h("td", {}, u.email), h("td", {}, u.role),
                    h("td", {}, u.reg_no || ""), h("td", {}, u.class_name || ""),
                    h("td", {}, u.has_phone ? h("button", {
                        class: "small danger",
                        onclick: async () => {
                            if (!confirm(`Reset the phone of ${u.name}? They will be logged out and can register a new phone.`)) return;
                            await api.del(`/admin/users/${u.id}/device`);
                            mainView("Users");
                        },
                    }, "Reset phone") : h("span", { class: "muted" }, "Not registered")))))));
}

// ---------- Subjects ----------

async function subjectsTab(content) {
    const subjects = await api.get("/admin/subjects");
    const msg = h("div");
    const form = h("form", {
        class: "row",
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                await api.post("/admin/subjects", formValues(form));
                mainView("Subjects");
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("div", {}, h("label", {}, "Code"), h("input", { name: "code", required: true, placeholder: "CS201" })),
        h("div", {}, h("label", {}, "Name"), h("input", { name: "name", required: true, placeholder: "Data Structures" })),
        h("button", { type: "submit" }, "Add subject"));

    content.append(
        h("div", { class: "card" }, h("h2", {}, "Add a subject"), form, msg),
        h("div", { class: "card" }, h("h2", {}, "Subjects"),
            h("table", {}, h("tr", {}, h("th", {}, "Code"), h("th", {}, "Name")),
                subjects.map((s) => h("tr", {}, h("td", {}, s.code), h("td", {}, s.name))))));
}

// ---------- Classes ----------

async function classesTab(content) {
    const classes = await api.get("/admin/classes");
    const msg = h("div");
    const form = h("form", {
        class: "row",
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                await api.post("/admin/classes", formValues(form));
                mainView("Classes");
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("div", {}, h("label", {}, "Class name"), h("input", { name: "name", required: true, placeholder: "CSE-A 2nd year" })),
        h("button", { type: "submit" }, "Create class"));

    content.append(
        h("div", { class: "card" }, h("h2", {}, "Create a class"), form, msg),
        h("div", { class: "card" }, h("h2", {}, "Classes"), h("p", { class: "muted" }, "Click a class to manage it."),
            h("table", {}, h("tr", {}, h("th", {}, "Class"), h("th", {}, "Students")),
                classes.map((c) => h("tr", { class: "clickable", onclick: () => classView(content, c.id) },
                    h("td", {}, c.name), h("td", {}, c.students))))));
}

async function classView(content, classId) {
    const [cls, allStudents, faculty, subjects] = await Promise.all([
        api.get(`/admin/classes/${classId}`),
        api.get("/admin/users?role=student"),
        api.get("/admin/users?role=faculty"),
        api.get("/admin/subjects"),
    ]);
    const reload = () => classView(content, classId);
    const groupName = Object.fromEntries(cls.mentorGroups.map((g) => [g.id, g.name]));

    content.replaceChildren(
        h("button", { class: "back", onclick: () => mainView("Classes") }, "< All classes"),
        h("div", { class: "card" }, h("h2", {}, cls.name),
            h("p", { class: "muted" }, `${cls.students.length} students, ${cls.subjects.length} subjects, ${cls.mentorGroups.length} mentor groups`)),
        studentsCard(cls, allStudents, groupName, reload),
        subjectsCard(cls, subjects, faculty, reload),
        mentorCard(cls, faculty, reload),
        timetableCard(cls, reload));
}

function studentsCard(cls, allStudents, groupName, reload) {
    const msg = h("div");
    const free = allStudents.filter((s) => !s.class_id);
    const picker = h("select", { multiple: true, size: Math.min(8, Math.max(3, free.length)) },
        free.map((s) => h("option", { value: s.id }, `${s.reg_no} - ${s.name}`)));

    const add = h("div", {},
        h("label", {}, `Students without a class (${free.length}). Hold Ctrl to choose many.`),
        picker,
        h("div", { style: "margin-top:10px" }, h("button", {
            onclick: async () => {
                const studentIds = [...picker.selectedOptions].map((o) => Number(o.value));
                try {
                    await api.post(`/admin/classes/${cls.id}/students`, { studentIds });
                    reload();
                } catch (err) {
                    msg.replaceChildren(message(err.message));
                }
            },
        }, "Add to class")), msg);

    // move a student to another mentor group
    function groupSelect(student) {
        if (cls.mentorGroups.length === 0) return "";
        const sel = h("select", {
            onchange: async (e) => {
                try {
                    await api.post(`/admin/mentor-groups/${e.target.value}/students`, { studentId: student.id });
                    reload();
                } catch (err) {
                    msg.replaceChildren(message(err.message));
                    e.target.value = student.group_id || "";
                }
            },
        }, h("option", { value: "" }, "-"), cls.mentorGroups.map((g) => h("option", { value: g.id }, g.name)));
        sel.value = student.group_id || "";
        return sel;
    }

    return h("div", { class: "card" }, h("h2", {}, "Students"),
        free.length ? add : h("p", { class: "muted" }, "Every student already has a class. Add new students in the Users tab."),
        h("table", {},
            h("tr", {}, h("th", {}, "Register no."), h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Mentor group"), h("th", {}, "")),
            cls.students.map((s) => h("tr", {},
                h("td", {}, s.reg_no), h("td", {}, s.name), h("td", {}, s.email), h("td", {}, groupSelect(s)),
                h("td", {}, h("button", {
                    class: "small danger",
                    onclick: async () => {
                        if (!confirm(`Remove ${s.name} from ${cls.name}?`)) return;
                        await api.del(`/admin/classes/${cls.id}/students/${s.id}`);
                        reload();
                    },
                }, "Remove"))))));
}

function subjectsCard(cls, subjects, faculty, reload) {
    const msg = h("div");
    const form = h("form", {
        class: "row",
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                await api.post(`/admin/classes/${cls.id}/subjects`, formValues(form));
                reload();
            } catch (err) {
                msg.replaceChildren(message(err.message));
            }
        },
    },
        h("div", {}, h("label", {}, "Subject"), h("select", { name: "subjectId", required: true },
            subjects.map((s) => h("option", { value: s.id }, `${s.code} ${s.name}`)))),
        h("div", {}, h("label", {}, "Taught by"), h("select", { name: "facultyId", required: true },
            faculty.map((f) => h("option", { value: f.id }, f.name)))),
        h("button", { type: "submit" }, "Assign"));

    return h("div", { class: "card" }, h("h2", {}, "Subjects and faculty"),
        subjects.length && faculty.length ? form : h("p", { class: "muted" }, "Add subjects and faculty first."),
        h("p", { class: "muted" }, "Assigning a subject again changes its faculty."),
        msg,
        h("table", {}, h("tr", {}, h("th", {}, "Subject"), h("th", {}, "Faculty")),
            cls.subjects.map((s) => h("tr", {}, h("td", {}, `${s.code} ${s.name}`), h("td", {}, s.faculty_name || "Not assigned")))));
}

function mentorCard(cls, faculty, reload) {
    const msg = h("div");
    if (cls.mentorGroups.length === 0) {
        return h("div", { class: "card" }, h("h2", {}, "Mentor groups"),
            h("p", {}, `Split the ${cls.students.length} students into groups of 15 (by register number).`),
            h("button", {
                disabled: cls.students.length === 0,
                onclick: async () => {
                    try {
                        await api.post(`/admin/classes/${cls.id}/mentor-groups/auto`);
                        reload();
                    } catch (err) {
                        msg.replaceChildren(message(err.message));
                    }
                },
            }, "Create mentor groups"), msg);
    }

    function mentorSelect(group) {
        const sel = h("select", {
            onchange: async (e) => {
                try {
                    await api.patch(`/admin/mentor-groups/${group.id}`, { mentorId: e.target.value || null });
                    msg.replaceChildren(message(`Mentor saved for ${group.name}`, "ok"));
                } catch (err) {
                    msg.replaceChildren(message(err.message));
                }
            },
        }, h("option", { value: "" }, "Choose mentor"), faculty.map((f) => h("option", { value: f.id }, f.name)));
        sel.value = group.mentor_id || "";
        return sel;
    }

    return h("div", { class: "card" }, h("h2", {}, "Mentor groups"),
        h("p", { class: "muted" }, "Up to 15 students per group. Move a student with the 'Mentor group' column above."),
        h("table", {}, h("tr", {}, h("th", {}, "Group"), h("th", {}, "Students"), h("th", {}, "Mentor")),
            cls.mentorGroups.map((g) => h("tr", {}, h("td", {}, g.name), h("td", {}, `${g.size} / 15`), h("td", {}, mentorSelect(g))))),
        msg);
}

function timetableCard(cls, reload) {
    const msg = h("div");
    let editingId = null; // the period being edited, or null when adding

    const subject = h("select", { name: "classSubjectId", required: true },
        cls.subjects.map((s) => h("option", { value: s.id }, `${s.code} (${s.faculty_name || "no faculty"})`)));
    const day = h("select", { name: "day" }, [1, 2, 3, 4, 5, 6].map((d) => h("option", { value: d }, DAYS[d])));
    const startTime = timePicker("start", "09:00");
    const endTime = timePicker("end", "10:00");
    const room = h("input", { name: "room", required: true, placeholder: "Lab 1" });
    const submit = h("button", { type: "submit" }, "Add period");
    const cancel = h("button", { type: "button", class: "secondary", hidden: true, onclick: () => stopEditing() }, "Cancel");
    const title = h("h3", {}, "Add a period");

    function startEditing(t) {
        editingId = t.id;
        subject.value = t.class_subject_id;
        day.value = t.day;
        startTime.set(t.start);
        endTime.set(t.end);
        room.value = t.room;
        title.textContent = `Edit period: ${DAYS[t.day]} ${ampm(t.start)} ${t.code}`;
        submit.textContent = "Save changes";
        cancel.hidden = false;
        msg.replaceChildren();
        form.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function stopEditing() {
        editingId = null;
        title.textContent = "Add a period";
        submit.textContent = "Add period";
        cancel.hidden = true;
        form.reset();
        startTime.set("09:00");
        endTime.set("10:00");
        msg.replaceChildren();
    }

    const form = h("form", {
        class: "row",
        onsubmit: async (e) => {
            e.preventDefault();
            try {
                if (editingId) await api.patch(`/admin/timetable/${editingId}`, formValues(form));
                else await api.post("/admin/timetable", formValues(form));
                reload();
            } catch (err) {
                msg.replaceChildren(message(err.message, "error", (err.data && err.data.clashes) || []));
            }
        },
    },
        h("div", {}, h("label", {}, "Subject"), subject),
        h("div", {}, h("label", {}, "Day"), day),
        h("div", {}, h("label", {}, "Start"), startTime.el),
        h("div", {}, h("label", {}, "End"), endTime.el),
        h("div", {}, h("label", {}, "Room"), room),
        submit, cancel);

    return h("div", { class: "card" }, h("h2", {}, "Timetable"),
        cls.subjects.length ? [title, form] : h("p", { class: "muted" }, "Assign subjects first."),
        h("p", { class: "muted" }, "A period is refused if the class, the faculty member or the room is already busy at that time."),
        msg,
        h("table", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "Time"), h("th", {}, "Subject"), h("th", {}, "Faculty"), h("th", {}, "Room"), h("th", {}, "")),
            cls.timetable.map((t) => h("tr", {},
                h("td", {}, DAYS[t.day]), h("td", {}, `${ampm(t.start)} - ${ampm(t.end)}`), h("td", {}, `${t.code} ${t.subject}`),
                h("td", {}, t.faculty_name || ""), h("td", {}, t.room),
                h("td", { class: "actions" },
                    h("button", { class: "small secondary", onclick: () => startEditing(t) }, "Edit"), " ",
                    h("button", {
                        class: "small danger",
                        onclick: async () => {
                            if (!confirm(`Delete ${DAYS[t.day]} ${ampm(t.start)} ${t.code}?`)) return;
                            await api.del(`/admin/timetable/${t.id}`);
                            reload();
                        },
                    }, "Delete"))))));
}

// ---------- Reopen requests (attendance after the 20-minute window) ----------

async function requestsTab(content) {
    const [pending, approved, rejected] = await Promise.all([
        api.get("/attendance/requests?status=pending"),
        api.get("/attendance/requests?status=approved"),
        api.get("/attendance/requests?status=rejected"),
    ]);
    const msg = h("div");

    async function decide(r, approve) {
        const note = approve ? "" : prompt("Reason for rejecting (shown to the faculty member):", "") ?? null;
        if (note === null) return;
        try {
            await api.post(`/attendance/requests/${r.id}/decide`, { approve, note });
            mainView("Reopen requests");
        } catch (err) {
            msg.replaceChildren(message(err.message));
        }
    }

    const row = (r, actions) => h("tr", {},
        h("td", {}, r.session_date, h("div", { class: "muted" }, `${ampm(r.start)} - ${ampm(r.end)}, ${r.room}`)),
        h("td", {}, `${r.class_name} - ${r.code}`, h("div", { class: "muted" }, r.subject)),
        h("td", {}, r.faculty_name),
        h("td", {}, r.reason, r.note ? h("div", { class: "muted" }, `Note: ${r.note}`) : null),
        h("td", {}, actions));

    content.append(
        h("div", { class: "card" }, h("h2", {}, `Waiting for approval (${pending.length})`),
            h("p", { class: "muted" }, "Faculty can take attendance in the first 20 minutes of a period. To open the QR again later the same day, they send a request here. Approving opens the QR for 10 minutes, once."),
            msg,
            pending.length === 0 ? h("p", { class: "muted" }, "No requests.") :
                h("table", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Class"), h("th", {}, "Faculty"), h("th", {}, "Reason"), h("th", {}, "")),
                    pending.map((r) => row(r, [
                        h("button", { class: "small", onclick: () => decide(r, true) }, "Approve"), " ",
                        h("button", { class: "small danger", onclick: () => decide(r, false) }, "Reject")])))),
        h("div", { class: "card" }, h("h2", {}, "Recently decided"),
            approved.length + rejected.length === 0 ? h("p", { class: "muted" }, "Nothing yet.") :
                h("table", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Class"), h("th", {}, "Faculty"), h("th", {}, "Reason"), h("th", {}, "Result")),
                    [...approved, ...rejected].slice(0, 30).map((r) => row(r, r.status === "approved" ? "Approved" : "Rejected")))));
}

// ---------- Early-warning alerts (whole college) ----------

const SEVERITY = { urgent: "Urgent", concern: "Concern", watch: "Watch" };

async function alertsTab(content) {
    const [status, alerts] = await Promise.all([api.get("/insights/status"), api.get("/insights/admin/alerts")]);
    const msg = h("div");
    const r = status.rules;

    async function run(path, label) {
        msg.replaceChildren(message("Working...", "ok"));
        try {
            const out = await api.post(path);
            msg.replaceChildren(message(`${label}: ${JSON.stringify(out)}`, "ok"));
        } catch (err) {
            msg.replaceChildren(message(err.message));
        }
    }

    content.append(
        h("div", { class: "card" }, h("h2", {}, "Early warning"),
            h("p", {}, `Checks run by themselves every 15 minutes. Weekly digests are emailed on Monday at 8 AM. AI writing: ${status.ai}.`),
            h("p", { class: "muted" }, `Rules: attendance below ${r.minAttendance}% (urgent below ${r.urgentAttendance}%), a drop of ${r.dropPoints}+ points in ${r.recentDays / 7} weeks, ${r.streakConcern}+ classes missed in a row, marks falling over 3 tests, average below ${r.lowMarks}%, ${r.flaggedScans}+ unusual scans in 14 days.`),
            h("div", { class: "row" },
                h("button", { onclick: async () => { await run("/insights/run", "Checked"); mainView("Alerts"); } }, "Run checks now"),
                h("button", { class: "secondary", onclick: () => run("/insights/digests/send", "Digests") }, "Send this week's digests now")),
            msg),
        h("div", { class: "card" }, h("h2", {}, `Open alerts (${alerts.length})`),
            h("p", { class: "muted" }, "Mentors and subject faculty see and handle these in their own Alerts tab."),
            alerts.length === 0 ? h("p", { class: "muted" }, "No open alerts.") :
                h("table", {}, h("tr", {}, h("th", {}, "Student"), h("th", {}, "Class"), h("th", {}, "Why"), h("th", {}, "Mentor")),
                    alerts.map((a) => h("tr", {},
                        h("td", {}, h("span", { class: `badge ${a.severity}` }, SEVERITY[a.severity]), " ", `${a.reg_no} ${a.name}`),
                        h("td", {}, a.class_name || ""),
                        h("td", {}, h("strong", {}, a.title), h("div", { class: "muted" }, a.reason)),
                        h("td", {}, a.mentor_name || "No mentor"))))));
}

// ---------- Start ----------
if (api.loggedIn()) mainView();
else loginView();
