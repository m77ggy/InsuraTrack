'use strict';
// Reminder engine: decides WHO needs a reminder, builds the SMS/email text,
// sends through lib/notify.js and records everything in the notifications table.
const { db } = require('./db');
const notify = require('./notify');

const TZ = 'Asia/Manila';
const REMINDER_DAYS = (process.env.REMINDER_DAYS || '60,30,15,10,5')
  .split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0).sort((a, b) => a - b);
const MAX_DAYS = REMINDER_DAYS[REMINDER_DAYS.length - 1] || 60;
const [WIN_START, WIN_END] = (process.env.SEND_WINDOW || '8-20').split('-').map(Number);

// LTO renewal month is decided by the LAST DIGIT of the plate number.
const LTO_MONTH = { 1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May',
                    6: 'June', 7: 'July', 8: 'August', 9: 'September', 0: 'October' };

function ltoMonth(plate) {
  const digits = String(plate || '').replace(/\D/g, '');
  return digits ? LTO_MONTH[digits[digits.length - 1]] : null;
}
function todayManila() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
function manilaHour() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}
function daysUntil(dateStr, today = todayManila()) {
  return Math.round((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}
function statusOf(days) { return days < 0 ? 'lapsed' : days <= 30 ? 'soon' : 'active'; }
// Which reminder "slot" are we in? (e.g. 12 days left -> the 15-day slot). Catches up on missed days.
function bracketFor(days) { return days < 0 ? null : (REMINDER_DAYS.find((n) => n >= days) ?? null); }

const fmtDate = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n) => (n === 1 ? '' : 's');

function phrase(d) {
  if (d < 0) return `expired ${-d} day${plural(-d)} ago`;
  if (d === 0) return 'expires today';
  if (d === 1) return 'expires tomorrow';
  return `expires in ${d} days`;
}

// ---------- message templates ----------
function smsText({ v, d, lto }) {
  const first = String(v.owner_name).split(/\s+/)[0].slice(0, 15);
  return `InsuraTrack: Hi ${first}, CTPL for ${v.plate_number} ${phrase(d)} (${fmtDate(v.insurance_expiry)}). Renew now to avoid LTO penalties.${lto ? ` LTO month: ${lto}.` : ''}`;
}
function emailSubject({ v, d }) { return `CTPL insurance for ${v.plate_number} ${phrase(d)}`; }
function emailText({ v, d, lto, agent }) {
  return [
    `Hi ${v.owner_name},`, '',
    `Your CTPL insurance for plate ${v.plate_number} ${phrase(d)} (${fmtDate(v.insurance_expiry)}).`,
    lto ? `Your LTO registration month is ${lto}. A valid CTPL is required before the LTO can renew your registration.` : '',
    'Renew early to avoid late penalties and driving an uninsured, unregistered vehicle.',
    agent ? `\nYour CTPL agent: ${agent.name}${agent.mobile ? ` (${agent.mobile})` : ''}` : '',
    '', '- InsuraTrack'
  ].filter((l) => l !== '').join('\n');
}
function emailLogoUrl() {
  const explicit = process.env.EMAIL_LOGO_URL;
  const base = process.env.PUBLIC_BASE_URL;
  if (!explicit && !base) return null;
  let url;
  try { url = explicit ? new URL(explicit) : new URL('logo.png', base.replace(/\/?$/, '/')); }
  catch { throw new Error('Set EMAIL_LOGO_URL or PUBLIC_BASE_URL to a valid public HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('The email logo must use a public HTTPS URL without credentials.');
  return url.href;
}

function emailHtml({ v, d, lto, agent }) {
  const logoUrl = emailLogoUrl();
  const brand = logoUrl
    ? `<img src="${esc(logoUrl)}" width="240" alt="InsuraTrack" style="display:block;width:240px;max-width:100%;height:auto;border:0;color:#6bfbf2;font-size:22px;font-weight:bold;">`
    : '<span style="font-size:22px;font-weight:800;letter-spacing:1px;color:#6bfbf2;">INSURATRACK</span>';
  const urgent = d <= 5;
  const color = d < 0 ? '#d1373f' : urgent ? '#b8860b' : '#0b8f92';
  const row = (k, val) => `<tr><td style="padding:8px 0;color:#6b7390;font-size:13px;">${k}</td><td style="padding:8px 0;font-weight:700;font-size:14px;text-align:right;">${val}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#eef3f8;font-family:Arial,Helvetica,sans-serif;color:#0b1220;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #d9e1ec;">
<tr><td style="background:#070a12;padding:18px 24px;">${brand}</td></tr>
<tr><td style="padding:26px 24px 8px;">
<p style="margin:0 0 6px;font-size:16px;">Hi ${esc(v.owner_name)},</p>
<p style="margin:0 0 18px;font-size:20px;font-weight:700;color:${color};">Your CTPL insurance ${esc(phrase(d))}.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6ebf2;border-bottom:1px solid #e6ebf2;">
${row('Plate number', esc(v.plate_number))}${row('Insurance expiry', esc(fmtDate(v.insurance_expiry)))}${lto ? row('LTO renewal month', esc(lto)) : ''}
</table>
<p style="font-size:14px;line-height:1.6;margin:18px 0;">A valid CTPL is required before the LTO can renew your vehicle registration. Renew early to avoid late penalties and the risk of driving an uninsured, unregistered vehicle.</p>
${agent ? `<p style="font-size:14px;margin:0 0 18px;">Your CTPL agent: <b>${esc(agent.name)}</b>${agent.mobile ? ` &middot; ${esc(agent.mobile)}` : ''}</p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px 22px;color:#8a91a8;font-size:12px;">Sent automatically by InsuraTrack. You are receiving this because your vehicle was registered for renewal reminders.</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------- sending ----------
async function remindVehicle(v, { trigger, bracket = null, today = todayManila() }) {
  const d = daysUntil(v.insurance_expiry, today);
  const manager = db.prepare('SELECT name, role, mobile FROM users WHERE id = ?').get(v.user_id);
  const ctx = { v, d, lto: ltoMonth(v.plate_number), agent: manager && manager.role === 'agent' ? manager : null };
  const results = [];

  const channels = [
    { ch: 'email', on: v.notify_email, to: v.owner_email, missing: 'no email on file' },
    { ch: 'sms', on: v.notify_sms, to: v.owner_mobile, missing: 'no mobile number on file' }
  ];
  for (const { ch, on, to, missing } of channels) {
    if (!on) { results.push({ channel: ch, status: 'skipped', reason: 'channel turned off' }); continue; }
    if (!to) { results.push({ channel: ch, status: 'skipped', reason: missing }); continue; }

    const key = trigger === 'auto' ? `auto:${v.id}:${ch}:${bracket}:${v.insurance_expiry}`
              : trigger === 'bulk' ? `bulk:${v.id}:${ch}:${today}` : null;
    if (key) {
      if (db.prepare("SELECT 1 FROM notifications WHERE dedupe_key = ? AND status != 'failed'").get(key)) {
        results.push({ channel: ch, status: 'skipped', reason: 'already sent' }); continue;
      }
      if (db.prepare("SELECT 1 FROM notifications WHERE dedupe_key = ? AND status = 'failed' AND created_at > datetime('now','-3 hours')").get(key)) {
        results.push({ channel: ch, status: 'skipped', reason: 'recent failure, retrying later' }); continue;
      }
    }

    const subject = ch === 'email' ? emailSubject(ctx) : null;
    const message = ch === 'email' ? emailText(ctx) : smsText(ctx);
    let status, error = null;
    try {
      const r = ch === 'email'
        ? await notify.sendEmail({ to, subject, html: emailHtml(ctx), text: message })
        : await notify.sendSms({ to, message });
      status = r.status;
    } catch (e) { status = 'failed'; error = String(e.message || e).slice(0, 500); }

    try {
      db.prepare(`INSERT INTO notifications
        (vehicle_id, user_id, plate_number, owner_name, channel, recipient, subject, message, days_left, trigger_type, status, error, dedupe_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(v.id, v.user_id, v.plate_number, v.owner_name, ch, to, subject, message, d, trigger, status, error, key);
    } catch (e) { /* duplicate dedupe key from a race: ignore */ }
    results.push({ channel: ch, status, error });
  }
  return results;
}

let busy = false;
/** trigger 'auto': one reminder per slot (60/30/15/10/5). 'bulk': agent blast, once per day per client. */
async function scan(vehicles, { trigger = 'auto' } = {}) {
  if (busy) { const e = new Error('A reminder scan is already running, try again in a moment.'); e.status = 409; throw e; }
  busy = true;
  const summary = { sent: 0, simulated: 0, failed: 0, skipped: 0, vehicles: 0 };
  try {
    const today = todayManila();
    for (const v of vehicles) {
      const d = daysUntil(v.insurance_expiry, today);
      let bracket = null;
      if (trigger === 'auto') { bracket = bracketFor(d); if (bracket === null) continue; }
      else if (d > MAX_DAYS || d < -30) continue;       // bulk: due soon or recently lapsed
      summary.vehicles++;
      for (const r of await remindVehicle(v, { trigger, bracket, today })) summary[r.status]++;
    }
  } finally { busy = false; }
  return summary;
}

function startScheduler() {
  const tick = async () => {
    try {
      const h = manilaHour();
      if (h < WIN_START || h >= WIN_END) return;       // never text people at 3 AM
      const s = await scan(db.prepare('SELECT * FROM vehicles').all(), { trigger: 'auto' });
      if (s.sent + s.simulated + s.failed > 0) console.log('[scheduler]', JSON.stringify(s));
    } catch (e) { console.error('[scheduler] error:', e.message); }
  };
  setTimeout(tick, 5000);                                 // shortly after boot
  setInterval(tick, 30 * 60 * 1000);                      // then every 30 minutes (duplicates are blocked)
}

module.exports = { scan, remindVehicle, startScheduler, daysUntil, statusOf, ltoMonth, todayManila,
                   REMINDER_DAYS, WIN_START, WIN_END, emailHtml };
