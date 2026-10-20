# InsuraTrack

Automated **SMS and email** reminder system for motor vehicle (CTPL) insurance, aligned with the LTO registration schedule.

**Stack:** Node.js (no npm packages needed), SQLite database, plain HTML/CSS/JS front end.
**Requires:** Node.js 22.5 or newer (`node -v`).

## Quick start

```bash
cd insuratrack
npm run seed      # optional: demo accounts and sample vehicles
npm start         # then open http://localhost:3000
```

Demo logins (after `npm run seed`): `owner@demo.ph` or `agent@demo.ph`, password `demo1234`.
Or just click **Create account**.

Out of the box the app runs in **simulated mode**: every SMS and email is logged in the
Notifications tab (and the server console) but nothing is actually sent. The database is
created automatically at `data/insuratrack.db`; uploaded documents are stored in `data/uploads/`.

## Going live: real emails and SMS

Copy `.env.example` to `.env`, fill it in, and restart the server.

### Email (pick one)

| Provider | Why | Settings |
|---|---|---|
| **Brevo** | Free 300 emails/day; works with a single verified sender address (no domain needed) | `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY=...`, `EMAIL_FROM=you@gmail.com` (verify it in Brevo first) |
| **Resend** | Simple; needs your own verified domain to email other people | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=...`, `EMAIL_FROM=reminders@yourdomain.com` |

### SMS (Philippines)

**Semaphore:** `SMS_PROVIDER=semaphore`, `SEMAPHORE_API_KEY=...` (optional `SEMAPHORE_SENDER`).
SMS messages are kept under 160 characters to use one credit each. Use real numbers only in live mode:
the seed data contains fake numbers.

Adding another provider (Twilio, etc.) is one function in `lib/notify.js`.

## How the reminder engine works

- The server checks every vehicle **every 30 minutes** (and at startup) and only sends between
  `SEND_WINDOW` hours (default 8:00 to 20:00 Manila time), so nobody is texted at 3 AM.
- Reminder slots come from `REMINDER_DAYS` (default **60, 30, 15, 10, 5** days before expiry).
  A policy gets **one reminder per slot per channel**. If a policy is added with 12 days left, it
  gets the 15-day slot reminder straight away, and the 10-day and 5-day ones later.
- Duplicates are impossible: every send is recorded in the `notifications` table with a unique key.
  Failed sends are retried (not more than once every 3 hours) and shown with the error.
- **LTO Plate Synchronizer:** the last digit of the plate gives the LTO renewal month
  (1 = January ... 9 = September, 0 = October), shown in the UI and included in every message.
- **Agents** get a *Send Bulk Reminders* button: it messages every client who is due within the
  window or lapsed in the last 30 days, at most once per day per client.
- Each vehicle has SMS and email switches; a channel is skipped if the contact detail is missing.

## Project structure

```
server.js          HTTP server + REST API + static file serving
seed.js            demo data
lib/db.js          SQLite schema (users, vehicles, documents, notifications)
lib/auth.js        scrypt password hashing + signed login tokens
lib/notify.js      email (Brevo/Resend) and SMS (Semaphore) providers
lib/reminders.js   reminder engine, message templates, scheduler
public/index.html  the whole front end (talks to /api/*)
.env.example       configuration template
```

## Database tables

`users` (owner or agent accounts) · `vehicles` (client, plate, expiry, channel switches, managed by a user) ·
`documents` (COC / OR-CR metadata, files on disk) · `notifications` (every SMS/email: status, error, trigger).

## API (all JSON, `Authorization: Bearer <token>` except auth/config)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | create account / sign in |
| GET | `/api/me`, `/api/config` | current user / provider and reminder settings |
| GET, POST | `/api/vehicles` | list / add |
| PUT, DELETE | `/api/vehicles/:id` | edit / delete |
| POST | `/api/vehicles/:id/remind` | send a reminder to this client now |
| POST | `/api/vehicles/:id/documents` | upload to the vault |
| GET, DELETE | `/api/documents/:id/file`, `/api/documents/:id` | view / remove |
| GET, DELETE | `/api/notifications` | dispatch log |
| POST | `/api/reminders/run` | run the scan for my vehicles now |
| POST | `/api/reminders/bulk` | agent bulk reminder (agents only) |

## Deploying

The app needs a server that keeps its disk (`data/` holds the database and uploads):
a small VPS, or Render / Railway / Fly.io **with a persistent volume** mounted at `data/`
(or set `DATA_DIR`). Do not use hosts with an ephemeral filesystem. Set the environment variables
in the host's dashboard instead of a `.env` file, serve over HTTPS, and back up `data/` regularly.

## Security notes

- Set `AGENT_SIGNUP_CODE` so only real agents can register as agents.
- Passwords are hashed with scrypt; login attempts are rate limited; uploads are verified by file signature;
  users can only access their own vehicles and documents.
- The login token is stored in the browser's localStorage. For a production system, move it to an
  httpOnly cookie and add CSRF protection.
- Philippine data privacy (RA 10173): tell clients how their contact details are used and get their consent
  before enabling reminders.

## Moving to PostgreSQL or MySQL later

All SQL lives in `lib/db.js`, `lib/reminders.js`, `server.js` and `seed.js`, using simple standard statements.
Swap the `node:sqlite` calls for a `pg` or `mysql2` client (and make the handlers `async`) to move to a hosted database.

## Branded reminder emails

Set `PUBLIC_BASE_URL=https://your-deployed-site.example` to show the included
`public/logo.png` in reminder emails sent through either Brevo or Resend.
Alternatively, set `EMAIL_LOGO_URL` to a public HTTPS image URL; it takes precedence.
Restart the server after changing configuration. No credentials should be included
in these URLs. The image must be accessible without signing in. If neither value
is set, emails retain a text wordmark. Email clients may block remote images until
the recipient allows them; the image includes an InsuraTrack text alternative.
