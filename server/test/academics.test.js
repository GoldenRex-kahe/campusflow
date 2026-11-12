// Phase 1 tests: classes, faculty assignment, mentor groups, timetable clashes, marks, who sees what.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, stop, call, adminToken, emailLogin, db } = require("./helpers");

let admin;
const ids = {}; // things created during the tests

before(async () => {
    await start();
    admin = await adminToken();
});
after(stop);

test("admin sets up subjects, faculty, students and a class", async () => {
    ids.py = (await call("POST", "/admin/subjects", { token: admin, body: { code: "py101", name: "Python" } })).body.id;
    ids.ma = (await call("POST", "/admin/subjects", { token: admin, body: { code: "MA101", name: "Maths" } })).body.id;
    const dup = await call("POST", "/admin/subjects", { token: admin, body: { code: "PY101", name: "Again" } });
    assert.equal(dup.status, 409);

    ids.f1 = (await call("POST", "/admin/users", { token: admin, body: { email: "f1@college.edu", name: "Faculty One", role: "faculty" } })).body.id;
    ids.f2 = (await call("POST", "/admin/users", { token: admin, body: { email: "f2@college.edu", name: "Faculty Two", role: "faculty" } })).body.id;

    ids.students = [];
    for (let i = 1; i <= 32; i++) {
        const n = String(i).padStart(3, "0");
        const r = await call("POST", "/admin/users", { token: admin, body: { email: `s${n}@college.edu`, name: `Student ${n}`, role: "student", regNo: `R${n}` } });
        assert.equal(r.status, 201);
        ids.students.push(r.body.id);
    }

    ids.classA = (await call("POST", "/admin/classes", { token: admin, body: { name: "CSE-A" } })).body.id;
    ids.classB = (await call("POST", "/admin/classes", { token: admin, body: { name: "CSE-B" } })).body.id;

    const add = await call("POST", `/admin/classes/${ids.classA}/students`, { token: admin, body: { studentIds: ids.students } });
    assert.equal(add.status, 201);

    // a student cannot be in two classes
    const twice = await call("POST", `/admin/classes/${ids.classB}/students`, { token: admin, body: { studentIds: [ids.students[0]] } });
    assert.equal(twice.status, 409);

    // only faculty can be assigned to teach
    const notFaculty = await call("POST", `/admin/classes/${ids.classA}/subjects`, { token: admin, body: { subjectId: ids.py, facultyId: ids.students[0] } });
    assert.equal(notFaculty.status, 400);

    ids.csPyA = (await call("POST", `/admin/classes/${ids.classA}/subjects`, { token: admin, body: { subjectId: ids.py, facultyId: ids.f1 } })).body.id;
    ids.csMaA = (await call("POST", `/admin/classes/${ids.classA}/subjects`, { token: admin, body: { subjectId: ids.ma, facultyId: ids.f2 } })).body.id;
    ids.csPyB = (await call("POST", `/admin/classes/${ids.classB}/subjects`, { token: admin, body: { subjectId: ids.py, facultyId: ids.f1 } })).body.id;
    ids.csMaB = (await call("POST", `/admin/classes/${ids.classB}/subjects`, { token: admin, body: { subjectId: ids.ma, facultyId: ids.f2 } })).body.id;
});

test("mentor groups: split into 15s, assign mentor, max 15", async () => {
    const auto = await call("POST", `/admin/classes/${ids.classA}/mentor-groups/auto`, { token: admin });
    assert.equal(auto.status, 201);
    assert.equal(auto.body.groups, 3);

    const again = await call("POST", `/admin/classes/${ids.classA}/mentor-groups/auto`, { token: admin });
    assert.equal(again.status, 409);

    const cls = (await call("GET", `/admin/classes/${ids.classA}`, { token: admin })).body;
    assert.deepEqual(cls.mentorGroups.map((g) => g.size), [15, 15, 2]);
    ids.groups = cls.mentorGroups.map((g) => g.id);

    const mentor = await call("PATCH", `/admin/mentor-groups/${ids.groups[0]}`, { token: admin, body: { mentorId: ids.f1 } });
    assert.equal(mentor.status, 200);

    // group 1 is full, so moving a student from group 3 into it is refused
    const lastStudent = ids.students[31];
    const full = await call("POST", `/admin/mentor-groups/${ids.groups[0]}/students`, { token: admin, body: { studentId: lastStudent } });
    assert.equal(full.status, 409);
});

test("timetable refuses clashes of class, faculty and room", async () => {
    const ok = await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: ids.csPyA, day: 1, start: "9:00", end: "10:00", room: "L1" } });
    assert.equal(ok.status, 201);

    const sameClass = await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: ids.csMaA, day: 1, start: "09:30", end: "10:30", room: "L2" } });
    assert.equal(sameClass.status, 409);
    assert.match(sameClass.body.clashes[0], /class is busy/);

    const sameFaculty = await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: ids.csPyB, day: 1, start: "09:30", end: "10:30", room: "L3" } });
    assert.equal(sameFaculty.status, 409);
    assert.match(sameFaculty.body.clashes[0], /Faculty One is busy/);

    const sameRoom = await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: ids.csMaB, day: 1, start: "09:00", end: "09:45", room: "l1" } });
    assert.equal(sameRoom.status, 409);
    assert.match(sameRoom.body.clashes[0], /room L1 is busy/);

    // right after the first period is fine
    const next = await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: ids.csMaA, day: 1, start: "10:00", end: "11:00", room: "L1" } });
    assert.equal(next.status, 201);

    const backwards = await call("POST", "/admin/timetable", { token: admin, body: { classSubjectId: ids.csMaB, day: 2, start: "11:00", end: "10:00", room: "L9" } });
    assert.equal(backwards.status, 400);
});

test("timetable periods can be edited, with the same clash checks", async () => {
    const cls = (await call("GET", `/admin/classes/${ids.classA}`, { token: admin })).body;
    const py = cls.timetable.find((p) => p.code === "PY101");
    const base = { classSubjectId: py.class_subject_id, day: 1, room: "L1" };

    // keeping its own time is not a clash with itself
    const same = await call("PATCH", `/admin/timetable/${py.id}`, { token: admin, body: { ...base, start: "09:00", end: "10:00" } });
    assert.equal(same.status, 200);

    // moving it onto the Maths period (10:00-11:00, same class) is refused, shown in AM/PM
    const clash = await call("PATCH", `/admin/timetable/${py.id}`, { token: admin, body: { ...base, start: "10:30", end: "11:30" } });
    assert.equal(clash.status, 409);
    assert.match(clash.body.clashes[0], /10:00 AM - 11:00 AM MA101/);

    // move it to the afternoon
    const moved = await call("PATCH", `/admin/timetable/${py.id}`, { token: admin, body: { ...base, start: "13:00", end: "14:00", room: "Lab 2" } });
    assert.equal(moved.status, 200);
    const after = (await call("GET", `/admin/classes/${ids.classA}`, { token: admin })).body.timetable.find((p) => p.id === py.id);
    assert.deepEqual([after.start, after.end, after.room], ["13:00", "14:00", "Lab 2"]);

    assert.equal((await call("PATCH", "/admin/timetable/99999", { token: admin, body: { ...base, start: "08:00", end: "09:00" } })).status, 404);
});

test("faculty only see and change their own classes", async () => {
    ids.f1Token = await emailLogin("f1@college.edu");
    ids.f2Token = await emailLogin("f2@college.edu");

    const mine = await call("GET", "/faculty/classes", { token: ids.f1Token });
    assert.deepEqual(mine.body.map((c) => `${c.class_name} ${c.code}`), ["CSE-A PY101", "CSE-B PY101"]);

    const notMine = await call("GET", `/faculty/class-subjects/${ids.csMaA}/assessments`, { token: ids.f1Token });
    assert.equal(notMine.status, 404);

    const tt = await call("GET", "/faculty/timetable", { token: ids.f1Token });
    assert.equal(tt.body.length, 1);

    const noAdmin = await call("GET", "/admin/classes", { token: ids.f1Token });
    assert.equal(noAdmin.status, 403);
});

test("marks: within max, all-or-nothing, changes are audited", async () => {
    const created = await call("POST", `/faculty/class-subjects/${ids.csPyA}/assessments`, {
        token: ids.f1Token, body: { name: "Internal 1", maxMarks: 50, heldOn: "2026-11-20" },
    });
    assert.equal(created.status, 201);
    ids.assess = created.body.id;

    const [s1, s2] = ids.students;
    const tooHigh = await call("PUT", `/faculty/assessments/${ids.assess}/marks`, {
        token: ids.f1Token, body: { marks: [{ studentId: s1, marks: 40 }, { studentId: s2, marks: 51 }] },
    });
    assert.equal(tooHigh.status, 400);
    const none = (await db.query("SELECT count(*)::int AS n FROM marks")).rows[0].n;
    assert.equal(none, 0); // nothing saved

    const saved = await call("PUT", `/faculty/assessments/${ids.assess}/marks`, {
        token: ids.f1Token, body: { marks: [{ studentId: s1, marks: 40 }, { studentId: s2, marks: 35.5 }] },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.changed, 2);

    const update = await call("PUT", `/faculty/assessments/${ids.assess}/marks`, {
        token: ids.f1Token, body: { marks: [{ studentId: s1, marks: 42 }, { studentId: s2, marks: 35.5 }] },
    });
    assert.equal(update.body.changed, 1);

    const list = await call("GET", `/faculty/assessments/${ids.assess}/marks`, { token: ids.f1Token });
    assert.equal(list.body.students.length, 32);
    assert.equal(list.body.students[0].marks, 42);
    assert.equal(list.body.students[2].marks, null);

    // another faculty member cannot read or write these marks
    const other = await call("GET", `/faculty/assessments/${ids.assess}/marks`, { token: ids.f2Token });
    assert.equal(other.status, 404);

    const audit = (await db.query("SELECT details FROM audit_log WHERE action = 'marks_saved' ORDER BY id DESC LIMIT 1")).rows[0];
    const details = typeof audit.details === "string" ? JSON.parse(audit.details) : audit.details;
    assert.deepEqual(details.changes, [{ studentId: s1, from: 40, to: 42 }]);
});

test("mentor sees their group with subject averages", async () => {
    const groups = await call("GET", "/faculty/mentor-groups", { token: ids.f1Token });
    assert.equal(groups.body.length, 1);
    assert.equal(groups.body[0].students.length, 15);
    assert.equal(groups.body[0].students[0].subjects.PY101, 84); // 42 out of 50

    const none = await call("GET", "/faculty/mentor-groups", { token: ids.f2Token });
    assert.deepEqual(none.body, []);
});

test("students see only their own timetable, marks and mentor", async () => {
    const token = await emailLogin("s001@college.edu");

    const tt = await call("GET", "/student/timetable", { token });
    assert.deepEqual(tt.body.map((p) => p.code), ["MA101", "PY101"]); // Python was moved to 1 PM above

    const marks = await call("GET", "/student/marks", { token });
    assert.deepEqual(marks.body, [{ code: "PY101", subject: "Python", assessment: "Internal 1", max_marks: 50, marks: 42 }]);

    const mentor = await call("GET", "/student/mentor", { token });
    assert.equal(mentor.body.mentor_name, "Faculty One");

    const noFaculty = await call("GET", "/faculty/classes", { token });
    assert.equal(noFaculty.status, 403);
});
