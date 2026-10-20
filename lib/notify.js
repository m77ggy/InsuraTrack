'use strict';
// Email + SMS providers. Each provider is one HTTPS call, no SDKs needed.
// With provider "console" nothing is sent: the message is logged and marked "simulated".

const emailProvider = () => (process.env.EMAIL_PROVIDER || 'console').toLowerCase();
const smsProvider = () => (process.env.SMS_PROVIDER || 'console').toLowerCase();

async function httpJson(url, options, label) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} responded ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function sendEmail({ to, subject, html, text }) {
  const provider = emailProvider();
  if (provider === 'console') {
    console.log(`[email:simulated] to=${to} | ${subject}`);
    return { status: 'simulated' };
  }
  const from = process.env.EMAIL_FROM;
  const fromName = process.env.EMAIL_FROM_NAME || 'InsuraTrack';
  if (!from) throw new Error('EMAIL_FROM is not set');

  if (provider === 'brevo') {
    if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is not set');
    await httpJson('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: fromName, email: from }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
    }, 'Brevo');
    return { status: 'sent' };
  }
  if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
    await httpJson('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, html, text })
    }, 'Resend');
    return { status: 'sent' };
  }
  throw new Error(`Unknown EMAIL_PROVIDER "${provider}"`);
}

async function sendSms({ to, message }) {
  const provider = smsProvider();
  if (provider === 'console') {
    console.log(`[sms:simulated] to=${to} | ${message}`);
    return { status: 'simulated' };
  }
  if (provider === 'semaphore') {
    if (!process.env.SEMAPHORE_API_KEY) throw new Error('SEMAPHORE_API_KEY is not set');
    const params = { apikey: process.env.SEMAPHORE_API_KEY, number: to, message };
    if (process.env.SEMAPHORE_SENDER) params.sendername = process.env.SEMAPHORE_SENDER;
    await httpJson('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    }, 'Semaphore');
    return { status: 'sent' };
  }
  throw new Error(`Unknown SMS_PROVIDER "${provider}"`);
}

function providerStatus() {
  return {
    email: { provider: emailProvider(), live: emailProvider() !== 'console' },
    sms: { provider: smsProvider(), live: smsProvider() !== 'console' }
  };
}

module.exports = { sendEmail, sendSms, providerStatus };
