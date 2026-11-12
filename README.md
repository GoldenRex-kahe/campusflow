# CampusFlow 2.0

Campus management system: secure attendance, marks, mentor alerts. Full plan: `../CampusApp-Plan.md`.

## Status

**Phase 0 done:** database, three roles, secure login.
**Phase 1 done:** classes, faculty assignment, mentor groups, timetable, marks, PC pages.
**Phase 2 done:** mobile app (students and faculty), phone lock, secure QR attendance, PC linking like WhatsApp Web.
**Phase 3 done:** early-warning alerts to mentor and subject faculty, marks summaries, weekly mentor digest (rules and templates; AI writing optional).
**Phase 4 (pilot readiness) done:** attendance appeals, encrypted 2FA secret, one-use 2FA codes, all-or-nothing saves, phone logout ends linked PCs, pilot setup guide in [DEPLOY.md](DEPLOY.md).

| Feature | How it works |
|---|---|
| Student / faculty login | College email, 6-digit code by email (expires in 10 min, 5 tries, one code at a time) |
| Admin login | Email + password + 2FA code (2FA is set up on first login and required) |
| Roles | Checked on the server for every request (`student`, `faculty`, `admin`) |
| Classes | Admin creates classes and adds students (one class per student) |
| Who teaches what | Only admin assigns a faculty member to a subject of a class |
| Mentor groups | Admin splits a class into groups of 15 in one click, picks a mentor, can move students (max 15) |
| Timetable | Admin adds periods; refused if the class, the faculty member or the room is already busy |
| Marks | Faculty create tests (out of N) and enter marks for their own classes only; any wrong mark means nothing is saved; every change is audited |
| Mentor view | Mentors see their 15 students with average % per subject |
| Students (API) | Own timetable, own marks, own mentor (the mobile app comes in Phase 2) |
| Audit log | Logins, user and class changes, timetable changes, every mark change (old and new value) |

**PC pages** (open with the server running):
- `http://localhost:4000/` start page
- `http://localhost:4000/admin.html` admin: users, subjects, classes (students, faculty, mentor groups, timetable)
- `http://localhost:4000/faculty.html` faculty: my classes and marks entry, timetable, mentor group

For now faculty log in on the PC with the email code. Phase 2 replaces this with "link this PC" from the faculty mobile app (like WhatsApp Web).

### Phase 2: how attendance works

1. **Phone lock**: after the first login the app makes a key pair. The private key stays on the phone; the server keeps only the public key. One account = one phone, and one phone cannot be used by two students. Admin can reset a phone (Users tab > Reset phone).
2. **Signed requests**: marking attendance, starting a session and linking a PC are signed by the phone key, after a fingerprint / face / passcode check. Each signature can be used once (no replays) and must be fresh (within 60 seconds).
3. **Faculty starts attendance on the phone, only during a period on today's timetable**. The phone sends its GPS every 10 seconds while the session screen is open.
   - The QR is open for the **first 20 minutes** of the period, then closes by itself.
   - Starting again in the same period **continues the same session** (it counts as one class, not two).
   - After the 20 minutes, the faculty member sends a **reopen request** with a reason. The admin approves or rejects it (admin page > Reopen requests). An approval opens the QR for **10 minutes**, once, on the same day.
   - A session nobody has scanned can be **cancelled** (started by mistake); it then does not count as a class held.
   - Settings in `.env`: `ATTENDANCE_WINDOW_MINUTES` (20), `REOPEN_MINUTES` (10), `COLLEGE_TIMEZONE` (Asia/Kolkata).
4. **Rotating QR**: changes every 20 seconds, shown on the phone or on a linked PC / projector. It pauses if the faculty phone stops sending its location for 30 seconds.
5. **Student scans**: the server checks the QR is fresh, the student is in the class, not already marked, and the distance to the faculty phone:
   - within about 40 m (plus GPS inaccuracy): **present**
   - fake-location app, weak GPS, a bit far, or faculty location missing: **flagged** for the faculty to accept or reject
   - much too far, expired or forged QR, wrong class, closed session: **rejected**
6. Every attempt is logged (including rejected and repeated scans). Faculty can mark a student by hand with a reason (logged).

### Link a PC (like WhatsApp Web)

`faculty.html` shows a link QR. In the app: **Link a PC**, scan it. The PC is logged in for up to 12 hours, can be logged out from the phone (Linked PCs), and logs itself out (unlinks) with Log out. The email-code login on the PC is kept as a backup.

### Phase 3: early warning, summaries, weekly digest

The "AI" in the pilot is **rules on the real numbers**, so it is free and every alert says exactly why. Thresholds are at the top of `server/src/insights.js`.

| Alert | When | Sent to |
|---|---|---|
| Low attendance | below 75% after 4+ classes (urgent below 65%) | mentor |
| Attendance falling | 20+ points lower in the last 3 weeks than before | mentor |
| Missed in a row | 3+ classes in a row (urgent at 5) | mentor |
| Marks falling | last 3 tests going down, last one 15+ points below the first | mentor + subject faculty |
| Low marks | average below 40% over 2+ tests | mentor + subject faculty |
| Unusual scans | 3+ flagged or rejected scans in 14 days | mentor |

- Checks run every 15 minutes. One open alert per student and reason (re-checks update it). **Urgent** alerts are emailed at once.
- Faculty mark an alert **Spoke to student** or **Not needed** (with a note); the same alert is not raised again for 14 days unless it gets worse. Nothing ever happens to a student automatically.
- **Students** see a progress summary and kind nudges about their own data only (phone app, My progress).
- **Faculty** see a class summary on each subject's tests page, a summary per mentee (click a student in Mentor group), and the **Alerts** and **Weekly digest** tabs.
- **Weekly digest**: every Monday at 8 AM each mentor and subject faculty member gets an email: attendance this week vs last, top 3 students needing attention with reasons and next steps, students improving, flagged scans waiting, open alerts, and what was done last week. Saved in the `digests` table.
- **Admin > Alerts**: see all open alerts, run the checks or send the digests now.

**Optional AI writing (off by default).** Set in `server/.env`:

```
AI_PROVIDER=claude
ANTHROPIC_API_KEY=your-key
AI_MODEL=claude-opus-5-5
```

Claude then rewrites the summaries in friendlier words. It only receives the summary sentences (numbers and subject names, never student names), it cannot change any decision, results are cached for 24 hours, and if anything fails the plain text is used. `claude-haiku-5-5` is a much cheaper choice. The server-side refusal fallback is turned on for models that support it.

### Phase 4: attendance appeals

- A student not marked present (absent, flagged, or could not scan) can send an **appeal** with a reason within **7 days** of the class (phone app > Missed classes). One appeal per class.
- The subject faculty sees it (PC > Appeals tab, or the phone) and marks the student **present** or **rejects** it with a note the student sees.
- Every appeal and decision is logged.

## Mobile app (Expo)

```
cd mobile
npm install
npx expo start
```

1. Install **Expo Go** on your phone (Play Store / App Store).
2. Phone and PC on the same wifi. Scan the QR that `npx expo start` shows (Android: in Expo Go; iPhone: with the camera).
3. In the app, set **Server address** to `http://<your PC's IP>:4000` (find the IP with `ipconfig`, "IPv4 Address"). Windows may ask to allow Node.js through the firewall: allow it on private networks.
4. Log in with a student or faculty college email that the admin created.

You can put the server address in `mobile/.env` (copy `.env.example`) so it is filled in automatically.



## First-time setup (on your computer or server)

Needs Node.js 20+ and PostgreSQL running.

```
cd server
npm install
npm run db:setup       # asks for your PostgreSQL "postgres" password, creates the database and .env
npm run create-admin   # asks for admin email, name and password
npm start              # API on http://localhost:4000
```

Then log in as admin, turn on 2FA (`POST /auth/admin/2fa/setup`, scan the QR with Google Authenticator or similar, then `POST /auth/admin/2fa/enable`).

While developing, `EMAIL_MODE=console` prints login codes in the server terminal. For real use, set `EMAIL_MODE=smtp` and the SMTP settings in `server/.env`.

### Forgot the PostgreSQL password

The `postgres` password is the one chosen when PostgreSQL was installed. To set a new one (Windows, PostgreSQL 18):

1. Open **Notepad as administrator** and open `C:\Program Files\PostgreSQL\18\data\pg_hba.conf`.
2. In the lines starting with `host ... 127.0.0.1/32` and `host ... ::1/128`, change `scram-sha-256` to `trust`. Save.
3. In **PowerShell as administrator**: `Restart-Service postgresql-x64-18`
4. Run `& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost`, then type `\password postgres`, enter a new password twice, then `\q`.
5. Change `trust` back to `scram-sha-256` in the same file, save, and restart the service again (step 3).

While it says `trust`, anyone on this computer can open the database without a password, so do steps 2 to 5 straight away.

## Tests

```
cd server
npm test
```

The tests use an embedded PostgreSQL (PGlite), so they need no database setup.

## API

| Method and path | Who | What |
|---|---|---|
| `POST /auth/email/start` | anyone | `{email}` sends a login code |
| `POST /auth/email/verify` | anyone | `{email, code}` returns tokens |
| `POST /auth/admin/login` | admin | `{email, password, totp}` returns tokens |
| `POST /auth/admin/2fa/setup` | admin | returns a QR for the authenticator app |
| `POST /auth/admin/2fa/enable` | admin | `{code}` turns 2FA on |
| `POST /auth/refresh` | logged in | `{refreshToken}` returns new tokens |
| `POST /auth/logout` | logged in | `{refreshToken}` ends the session |
| `GET /me` | logged in | your account |
| `POST /admin/users` | admin + 2FA | `{email, name, role, regNo}` adds a student or faculty |
| `GET /admin/users?role=` | admin + 2FA | list users |
| `GET, POST /admin/subjects` | admin | list or add subjects |
| `GET, POST /admin/classes`, `GET /admin/classes/:id` | admin | classes and everything about one class |
| `POST /admin/classes/:id/students`, `DELETE .../students/:studentId` | admin | add or remove students |
| `POST /admin/classes/:id/subjects` | admin | `{subjectId, facultyId}` assign who teaches |
| `POST /admin/classes/:id/mentor-groups/auto` | admin | split into groups of 15 |
| `PATCH /admin/mentor-groups/:id`, `POST .../students` | admin | set mentor, move a student |
| `POST /admin/timetable`, `DELETE /admin/timetable/:id` | admin | add a period (clash check) or delete it |
| `GET /faculty/classes`, `GET /faculty/timetable` | faculty | own classes and timetable |
| `GET, POST /faculty/class-subjects/:id/assessments` | faculty (own class) | tests |
| `GET, PUT /faculty/assessments/:id/marks` | faculty (own test) | read or save marks |
| `GET /faculty/mentor-groups` | faculty (mentor) | own mentor groups with averages |
| `GET /student/timetable`, `/student/marks`, `/student/mentor` | student | own data only |
| `GET /student/attendance` | student | own attendance per subject |
| `POST /devices/register`, `GET /devices/me` | student, faculty | lock the account to this phone |
| `DELETE /admin/users/:id/device` | admin | reset a phone |
| `GET /attendance/today` | faculty | today's periods with what can be done now |
| `POST /attendance/sessions` | faculty phone (signed) | `{timetableId, lat, lng, accuracy}` start, continue or reopen |
| `POST /attendance/sessions/:id/cancel` | faculty | delete a session nobody scanned |
| `POST /attendance/requests` | faculty | `{timetableId, reason}` ask to reopen |
| `GET /attendance/requests?status=`, `POST /attendance/requests/:id/decide` | admin + 2FA | list, approve or reject reopen requests |
| `POST /attendance/sessions/:id/location` | faculty phone (signed) | location every 10 s |
| `GET /attendance/open`, `GET /attendance/sessions/:id`, `.../qr` | faculty (phone or PC) | open session, details, current QR |
| `POST /attendance/sessions/:id/stop`, `.../manual`, `POST /attendance/records/:id/decide` | faculty | stop, mark by hand, accept or reject a flagged scan |
| `POST /attendance/mark` | student phone (signed) | scan the QR |
| `POST /link/start`, `GET /link/status/:id` | PC | link QR and waiting for approval |
| `POST /link/approve` | faculty phone (signed) | approve a PC |
| `GET /link/pcs`, `DELETE /link/pcs/:id` | faculty | linked PCs, log one out |
| `GET /insights/student/summary` | student | own progress summary and nudges |
| `GET /insights/alerts`, `POST /insights/alerts/:id/handle` | faculty | alerts for my mentees and subjects; mark handled / not needed |
| `GET /insights/students/:id/summary`, `GET /insights/class-subjects/:id/summary` | faculty (mentor or teacher) | student or class summary |
| `GET /insights/digest` | faculty | this week's digest |
| `POST /insights/run`, `POST /insights/digests/send`, `GET /insights/admin/alerts`, `GET /insights/status` | admin + 2FA | run checks, send digests, all open alerts, settings |
| `GET /appeals/mine`, `POST /appeals` | student | missed classes; send an appeal |
| `GET /appeals?status=`, `POST /appeals/:id/decide` | subject faculty | appeals for my classes; mark present or reject |

Signed requests carry `X-Device-Time` and `X-Device-Signature` (Ed25519 over `METHOD
PATH
TIME
SHA256(body)`).

Send the access token as `Authorization: Bearer <token>`.

## Folders

```
server/
  src/
    config.js       settings from .env
    db.js           database connection (PostgreSQL, or PGlite in tests)
    migrate.js      runs migrations/*.sql once each
    tokens.js       access and refresh tokens
    email.js        sends login codes
    audit.js        writes the audit log
    middleware.js   login and role checks
    routes/auth.js  login routes
    routes/admin.js admin routes (users)
    routes/admin-academics.js  admin: subjects, classes, groups, timetable
    routes/faculty.js          faculty: marks, timetable, mentor group
    routes/student.js          student: own data
    routes/devices.js          phone lock and signature check
    routes/attendance.js       QR attendance
    routes/link.js             link a PC
    routes/insights.js         alerts, summaries, digest
    routes/appeals.js          attendance appeals
    secrets.js                 encrypts secrets saved in the database
    insights.js                the early-warning rules, summaries and digest builder
    ai.js                      optional Claude rewriting (off by default)
    clock.js                   current time (tests can fix it)
    validate.js     input checks
    app.js          builds the app
    server.js       starts the app
  migrations/       database tables
  scripts/          db:setup and create-admin
  web/              PC pages (admin.html, faculty.html, css, js)
mobile/             Expo app for students and faculty (App.js, src/)
  test/             automated tests
```

## Known gaps to fix in later phases

- **Expo Go limits (pilot):** the fingerprint check is done by the app, and Face ID is not available in Expo Go on iPhone (it falls back to the passcode). A custom app build (with the app store release) can make the phone's secure chip enforce the fingerprint for the key.
- If the app is deleted and installed again, its key is lost and the admin must reset the phone.
- The PC QR display checks for updates every few seconds (polling) instead of a live WebSocket connection.
- "Link this PC for this class only" is not built yet (logging out on the phone does log out all linked PCs).
- Phones on mobile data need the server on a public HTTPS address (for example Cloudflare Tunnel) instead of the PC's wifi IP.
- HTTPS is not built into the server: put it behind Cloudflare Tunnel before real users (see [DEPLOY.md](DEPLOY.md)).
