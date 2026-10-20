'use strict';
// Demo data for trying the app in SIMULATED mode: `npm run seed`
// Logins:  owner@demo.ph / demo1234   and   agent@demo.ph / demo1234
const { db } = require('./lib/db');
const auth = require('./lib/auth');
const rem = require('./lib/reminders');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0 && !process.argv.includes('--force')) {
  console.log('Database already has users. Run with --force to add the demo accounts anyway.'); process.exit(0);
}
const addDays = (n) => { const d = new Date(`${rem.todayManila()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const user = (name, email, mobile, role) =>
  Number(db.prepare('INSERT INTO users (name,email,mobile,role,password_hash) VALUES (?,?,?,?,?)')
    .run(name, email, mobile, role, auth.hashPassword('demo1234')).lastInsertRowid);
const vehicle = (uid, name, mobile, email, plate, days) =>
  db.prepare('INSERT INTO vehicles (user_id,owner_name,owner_mobile,owner_email,plate_number,insurance_expiry) VALUES (?,?,?,?,?,?)')
    .run(uid, name, mobile, email, plate, addDays(days));

const owner = user('Juan Dela Cruz', 'owner@demo.ph', '09170000001', 'owner');
vehicle(owner, 'Juan Dela Cruz', '09170000001', 'owner@demo.ph', 'NDJ1234', 12);
vehicle(owner, 'Juan Dela Cruz', '09170000001', 'owner@demo.ph', 'ABC5678', 45);
vehicle(owner, 'Juan Dela Cruz', '09170000001', 'owner@demo.ph', 'XYZ4321', -5);

const agent = user('Demo CTPL Agent', 'agent@demo.ph', '09170000002', 'agent');
vehicle(agent, 'Maria Santos', '09170000011', 'maria@example.com', 'NDJ2231', 8);
vehicle(agent, 'Ramon Cruz', '09170000012', 'ramon@example.com', 'DAB9087', 28);
vehicle(agent, 'Liza Fernandez', '09170000013', null, 'TRK5560', 58);
vehicle(agent, 'Ben Aquino', '09170000014', 'ben@example.com', 'CAL7712', 140);
vehicle(agent, 'Carla Mendoza', '09170000015', 'carla@example.com', 'PQR3309', -12);
console.log('Seeded demo accounts: owner@demo.ph and agent@demo.ph (password: demo1234)');
