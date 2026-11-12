# CampusFlow pilot setup guide

For running the pilot with one real class on your own server, for free. Do the steps in order.

## 1. Before any real student data

- [ ] College approval **in writing**, and one named person who owns the data.
- [ ] A short privacy notice for students: what is collected (attendance, marks, location only at the moment of scanning, phone model), why, who can see it, how long it is kept. Students agree to it before using the app.
- [ ] Decide how long data is kept after the pilot, and who can delete it.

## 2. The server

On the PC or server that will run CampusFlow (needs Node.js 20+ and PostgreSQL):

```
cd campusflow-app/server
npm install
npm run db:setup
npm run create-admin
```

Then edit `server/.env`:

| Setting | For the pilot |
|---|---|
| `EMAIL_MODE` | `smtp` (real emails) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | the college email account that sends login codes and digests (ask the college IT team) |
| `COLLEGE_EMAIL_DOMAIN` | the part after `@` in student emails |
| `TRUST_PROXY` | `1` (when using Cloudflare Tunnel, step 3) |
| `ENCRYPTION_KEY` | optional long random text. **Set it before the admin turns on 2FA, and never change it** (or `JWT_SECRET`) afterwards, or saved 2FA secrets cannot be read. |

**Keep `.env` private.** Never email it or put it in git.

Start it:

```
npm start
```

To keep it running after a restart of the PC, use pm2:

```
npm install -g pm2
pm2 start src/server.js --name campusflow
pm2 save
```

## 3. HTTPS address with Cloudflare Tunnel (free)

Phones on mobile data cannot reach your PC's wifi address, and real use needs HTTPS. Cloudflare Tunnel gives the server a public HTTPS address without opening ports on your network. (`cloudflared` is already installed on this PC.)

**Quick test** (the address changes every time you run it):

```
cloudflared tunnel --url http://localhost:4000
```

It prints an address like `https://something.trycloudflare.com`. Put that in the app's **Server address**, and open `<that address>/admin.html` on the PC.

**Permanent address** (needs a domain added to a free Cloudflare account, for example `campusflow.yourcollege.in`):

```
cloudflared tunnel login
cloudflared tunnel create campusflow
cloudflared tunnel route dns campusflow campusflow.yourcollege.in
cloudflared tunnel run --url http://localhost:4000 campusflow
```

To run it as a Windows service: `cloudflared service install` (see Cloudflare's "Run as a service" docs for the config file).

## 4. Daily backups

1. Create the folder `D:\campusflow-backups` (or any drive that is not the system drive).
2. Save the database password once, so backups run without asking: create the file `%APPDATA%\postgresql\pgpass.conf` with one line (the password is the one in `DATABASE_URL` in `.env`):
   ```
   localhost:5432:campusflow:campusflow:PASSWORD_FROM_ENV
   ```
3. In **Task Scheduler**, create a daily task that runs:
   ```
   "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U campusflow -h localhost -F c -f "D:\campusflow-backups\campusflow.dump" campusflow
   ```
4. Once, **test a restore** into a spare database, so you know the backup works:
   ```
   "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres -h localhost campusflow_restore_test
   "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -U postgres -h localhost -d campusflow_restore_test "D:\campusflow-backups\campusflow.dump"
   ```
   Copy the backup file somewhere else weekly (a pen drive or the college drive).

## 5. Set up the pilot class (admin page)

1. Log in at `/admin.html`, turn on 2FA.
2. **Users**: add the faculty and the students (college emails and register numbers).
3. **Subjects**, then **Classes**: create the class, add students, assign who teaches each subject.
4. **Mentor groups**: one click splits into groups of 15; choose a mentor for each.
5. **Timetable**: add every period (with AM/PM). Attendance only works during these periods.

## 6. Install the app

- Students and faculty install **Expo Go**, then open the CampusFlow link (from `npx expo start` in `mobile/`), and enter the server address from step 3.
- Each person logs in once with their college email. Their account is locked to that phone; the admin can reset it (Users > Reset phone).
- Faculty: practice once before the first class: start attendance in the first 20 minutes, link the classroom PC (open `/faculty.html` on the PC and scan its QR from the app).

A short 30-minute session with the faculty before the first day saves a lot of confusion.

## 7. During the pilot (2 to 4 weeks)

Watch these each week (admin page and faculty Alerts):

| What | Why |
|---|---|
| How many scans are **flagged** | lots of flags in one room usually means weak GPS there; the distance rule may need to be wider for that room |
| **Appeals** and **reopen requests** | many of them means the 20-minute window or the app is causing trouble |
| Alerts marked **Not needed** | the alert rules may be too strict |
| Students who could not install or log in | phone or email problems to fix before adding more classes |

Ask faculty and a few students for feedback at the end of week 1 and week 3.

## 8. Known limits in the pilot

- Expo Go is for testing; a proper app-store release comes after the pilot (it also makes the fingerprint lock hardware-backed and enables Face ID on iPhone).
- If a student deletes and reinstalls the app, the admin must reset their phone.
- The "AI" is rules and templates unless `AI_PROVIDER=claude` is set (paid).
- GPS cannot tell floors apart; the rotating QR covers this, but test it in your rooms.
