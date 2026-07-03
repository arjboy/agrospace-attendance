const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const MATCH_THRESHOLD = 0.5;
const MIN_SHIFT_HOURS = 1;     // minimum hours before check-out allowed
const HOURLY_RATE = 50;        // ₹50 per hour per worker

const ADMIN_USERS = [
  { username: 'admin', password: 'factory@123' },
  { username: 'arth', password: 'arth@123' }
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      employee_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      descriptor DOUBLE PRECISION[] NOT NULL,
      enrolled_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      name TEXT NOT NULL,
      date DATE NOT NULL,
      check_in TIMESTAMPTZ,
      check_out TIMESTAMPTZ,
      hours_worked NUMERIC(5,2),
      UNIQUE(employee_id, date)
    )
  `);
  console.log('Database tables ready ✔');
}

const sessions = new Map();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
function todayDate() { return new Date().toISOString().split('T')[0]; }

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  sessions.get(token).expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) { if (now > s.expiresAt) sessions.delete(t); }
}, 3600000);

// Auth
app.post('/api/login', (req, res) => {
  const user = ADMIN_USERS.find(u => u.username === req.body.username && u.password === req.body.password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, createdAt: Date.now(), expiresAt: Date.now() + 86400000 });
  res.json({ success: true, token, username: user.username });
});
app.get('/api/auth/check', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions.has(token)) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: sessions.get(token).username });
});
app.post('/api/logout', (req, res) => {
  if (req.headers['x-auth-token']) sessions.delete(req.headers['x-auth-token']);
  res.json({ success: true });
});
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Enroll (with DUPLICATE FACE CHECK) ----
app.post('/api/enroll', requireAuth, async (req, res) => {
  try {
    const { name, descriptor } = req.body;
    if (!name || !descriptor || !Array.isArray(descriptor))
      return res.status(400).json({ error: 'name and descriptor required' });

    // Check if this face already exists
    const existing = await pool.query('SELECT employee_id, name, descriptor FROM workers');
    for (const w of existing.rows) {
      const dist = euclideanDistance(w.descriptor, descriptor);
      if (dist < MATCH_THRESHOLD) {
        return res.status(409).json({
          error: `This face is already registered as "${w.name}" (${w.employee_id}). Delete that entry first to re-register.`,
          matchedWorker: { employeeId: w.employee_id, name: w.name }
        });
      }
    }

    // Auto-generate employee ID
    const result = await pool.query("SELECT employee_id FROM workers WHERE employee_id LIKE 'EMP%' ORDER BY employee_id DESC LIMIT 1");
    let maxNum = 0;
    if (result.rows.length > 0) {
      const m = result.rows[0].employee_id.match(/^EMP(\d+)$/);
      if (m) maxNum = parseInt(m[1]);
    }
    const eid = 'EMP' + String(maxNum + 1).padStart(3, '0');

    await pool.query('INSERT INTO workers (employee_id, name, descriptor) VALUES ($1, $2, $3)', [eid, name, descriptor]);
    res.json({ success: true, message: `${name} enrolled as ${eid}`, employeeId: eid });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already enrolled' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/workers', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT employee_id, name, enrolled_at FROM workers ORDER BY employee_id');
  res.json(r.rows.map(w => ({ employeeId: w.employee_id, name: w.name, enrolledAt: w.enrolled_at })));
});

app.delete('/api/workers/:eid', requireAuth, async (req, res) => {
  const r = await pool.query('DELETE FROM workers WHERE employee_id = $1', [req.params.eid]);
  res.json({ success: true, removed: r.rowCount });
});

// ---- Mark attendance (with MIN SHIFT GAP) ----
app.post('/api/attendance', requireAuth, async (req, res) => {
  try {
    const { descriptor } = req.body;
    if (!descriptor || !Array.isArray(descriptor))
      return res.status(400).json({ error: 'descriptor required' });

    const wr = await pool.query('SELECT employee_id, name, descriptor FROM workers');
    if (wr.rows.length === 0) return res.status(404).json({ error: 'No workers enrolled' });

    let best = null, bestDist = Infinity;
    for (const w of wr.rows) {
      const d = euclideanDistance(w.descriptor, descriptor);
      if (d < bestDist) { bestDist = d; best = w; }
    }
    if (!best || bestDist > MATCH_THRESHOLD)
      return res.status(404).json({ error: 'Face not recognized', distance: bestDist });

    const today = todayDate();
    const existing = await pool.query(
      'SELECT check_in, check_out FROM attendance WHERE employee_id = $1 AND date = $2',
      [best.employee_id, today]
    );

    if (existing.rows.length === 0) {
      // CHECK IN
      await pool.query(
        'INSERT INTO attendance (employee_id, name, date, check_in) VALUES ($1, $2, $3, NOW())',
        [best.employee_id, best.name, today]
      );
      const tr = await pool.query('SELECT check_in FROM attendance WHERE employee_id=$1 AND date=$2', [best.employee_id, today]);
      return res.json({
        success: true, type: 'check-in',
        record: { employeeId: best.employee_id, name: best.name, date: today, time: tr.rows[0].check_in }
      });
    }

    const rec = existing.rows[0];

    if (rec.check_in && !rec.check_out) {
      // Check minimum shift time before allowing check-out
      const checkInTime = new Date(rec.check_in).getTime();
      const now = Date.now();
      const hoursSinceCheckIn = (now - checkInTime) / (1000 * 60 * 60);

      if (hoursSinceCheckIn < MIN_SHIFT_HOURS) {
        const minsLeft = Math.ceil((MIN_SHIFT_HOURS * 60) - (hoursSinceCheckIn * 60));
        return res.json({
          success: true, type: 'too-early',
          message: `${best.name} checked in ${Math.floor(hoursSinceCheckIn * 60)} min ago. Check-out allowed after ${MIN_SHIFT_HOURS} hour. ${minsLeft} min remaining.`,
          record: { employeeId: best.employee_id, name: best.name, date: today }
        });
      }

      // CHECK OUT
      await pool.query(
        `UPDATE attendance SET check_out = NOW(),
         hours_worked = ROUND(EXTRACT(EPOCH FROM (NOW() - check_in)) / 3600.0, 2)
         WHERE employee_id = $1 AND date = $2`,
        [best.employee_id, today]
      );
      const tr = await pool.query(
        'SELECT check_in, check_out, hours_worked FROM attendance WHERE employee_id=$1 AND date=$2',
        [best.employee_id, today]
      );
      const r = tr.rows[0];
      const payment = (parseFloat(r.hours_worked) * HOURLY_RATE).toFixed(0);
      return res.json({
        success: true, type: 'check-out',
        record: {
          employeeId: best.employee_id, name: best.name, date: today,
          checkIn: r.check_in, checkOut: r.check_out,
          hoursWorked: r.hours_worked, payment: payment
        }
      });
    }

    // Already done
    return res.json({
      success: true, type: 'done',
      message: `${best.name} already checked in and out today`,
      record: { employeeId: best.employee_id, name: best.name, date: today }
    });

  } catch (err) {
    console.error('Attendance error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Daily report
app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const qd = req.query.date || todayDate();
    const workers = await pool.query('SELECT employee_id, name FROM workers ORDER BY employee_id');
    const att = await pool.query('SELECT employee_id, check_in, check_out, hours_worked FROM attendance WHERE date=$1', [qd]);
    const map = {}; att.rows.forEach(r => { map[r.employee_id] = r; });

    let totalPayment = 0;
    const report = workers.rows.map(w => {
      const a = map[w.employee_id];
      let status = 'Absent';
      if (a && a.check_in && a.check_out) status = 'Complete';
      else if (a && a.check_in) status = 'Checked In';
      const hrs = a && a.hours_worked ? parseFloat(a.hours_worked) : 0;
      const pay = Math.round(hrs * HOURLY_RATE);
      if (hrs > 0) totalPayment += pay;
      return {
        employeeId: w.employee_id, name: w.name, date: qd, status,
        checkIn: a ? a.check_in : null, checkOut: a ? a.check_out : null,
        hoursWorked: a ? a.hours_worked : null,
        payment: pay
      };
    });
    const present = report.filter(r => r.status !== 'Absent').length;
    res.json({
      date: qd, totalWorkers: workers.rows.length,
      totalPresent: present, totalAbsent: workers.rows.length - present,
      totalPayment, hourlyRate: HOURLY_RATE, report
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Monthly report
app.get('/api/attendance/monthly', requireAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return res.status(400).json({ error: 'month and year required' });
    const workers = await pool.query('SELECT employee_id, name FROM workers ORDER BY employee_id');
    const att = await pool.query(
      "SELECT employee_id, date, hours_worked FROM attendance WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2",
      [month, year]
    );
    const workingDays = [...new Set(att.rows.map(r => r.date.toISOString().split('T')[0]))].sort();
    let grandTotalPayment = 0;
    const summary = workers.rows.map(w => {
      const days = att.rows.filter(r => r.employee_id === w.employee_id);
      const totalHours = days.reduce((s, d) => s + (parseFloat(d.hours_worked) || 0), 0);
      const totalPay = Math.round(totalHours * HOURLY_RATE);
      grandTotalPayment += totalPay;
      return {
        employeeId: w.employee_id, name: w.name,
        totalPresent: days.length, totalWorkingDays: workingDays.length,
        totalHours: Math.round(totalHours * 100) / 100,
        totalPayment: totalPay,
        presentDates: days.map(r => r.date.toISOString().split('T')[0]).sort()
      };
    });
    res.json({
      month: parseInt(month), year: parseInt(year),
      workingDays: workingDays.length, workingDatesList: workingDays,
      hourlyRate: HOURLY_RATE, grandTotalPayment, summary
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Export daily XLSX
app.get('/api/export/daily', requireAuth, async (req, res) => {
  try {
    const qd = req.query.date || todayDate();
    const workers = await pool.query('SELECT employee_id, name FROM workers ORDER BY employee_id');
    const att = await pool.query('SELECT employee_id, check_in, check_out, hours_worked FROM attendance WHERE date=$1', [qd]);
    const map = {}; att.rows.forEach(r => { map[r.employee_id] = r; });

    let totalPay = 0;
    const rows = workers.rows.map((w, i) => {
      const a = map[w.employee_id];
      let status = 'Absent';
      if (a && a.check_in && a.check_out) status = 'Complete';
      else if (a && a.check_in) status = 'Checked In';
      const hrs = a && a.hours_worked ? parseFloat(a.hours_worked) : 0;
      const pay = Math.round(hrs * HOURLY_RATE);
      totalPay += pay;
      return {
        'Sr No': i + 1, 'Employee ID': w.employee_id, 'Name': w.name, 'Status': status,
        'Date': qd,
        'Check In': a && a.check_in ? new Date(a.check_in).toLocaleTimeString('en-IN') : '-',
        'Check Out': a && a.check_out ? new Date(a.check_out).toLocaleTimeString('en-IN') : '-',
        'Hours': hrs > 0 ? hrs.toFixed(1) : '-',
        'Payment (₹)': pay > 0 ? pay : '-'
      };
    });
    // Add total row
    rows.push({ 'Sr No': '', 'Employee ID': '', 'Name': 'TOTAL', 'Status': '', 'Date': '', 'Check In': '', 'Check Out': '', 'Hours': '', 'Payment (₹)': totalPay });

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 },{ wch: 14 },{ wch: 22 },{ wch: 12 },{ wch: 14 },{ wch: 14 },{ wch: 14 },{ wch: 8 },{ wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${qd}.xlsx`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Export monthly XLSX
app.get('/api/export/monthly', requireAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return res.status(400).json({ error: 'month and year required' });
    const workers = await pool.query('SELECT employee_id, name FROM workers ORDER BY employee_id');
    const att = await pool.query(
      "SELECT employee_id, date, hours_worked FROM attendance WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2",
      [month, year]
    );
    const workingDays = [...new Set(att.rows.map(r => r.date.toISOString().split('T')[0]))].sort();
    let grandTotal = 0;
    const rows = workers.rows.map((w, i) => {
      const days = att.rows.filter(r => r.employee_id === w.employee_id);
      const presentDates = new Set(days.map(r => r.date.toISOString().split('T')[0]));
      const totalHours = days.reduce((s, d) => s + (parseFloat(d.hours_worked) || 0), 0);
      const pay = Math.round(totalHours * HOURLY_RATE);
      grandTotal += pay;
      const row = { 'Sr No': i + 1, 'Employee ID': w.employee_id, 'Name': w.name };
      workingDays.forEach(d => { row[d] = presentDates.has(d) ? 'P' : 'A'; });
      row['Days'] = presentDates.size;
      row['Hours'] = totalHours.toFixed(1);
      row['Payment (₹)'] = pay;
      row['%'] = workingDays.length > 0 ? Math.round((presentDates.size / workingDays.length) * 100) + '%' : '0%';
      return row;
    });
    rows.push({ 'Sr No': '', 'Employee ID': '', 'Name': 'GRAND TOTAL', 'Days': '', 'Hours': '', 'Payment (₹)': grandTotal, '%': '' });

    const ws = XLSX.utils.json_to_sheet(rows);
    const cols = [{ wch: 6 },{ wch: 14 },{ wch: 22 }];
    workingDays.forEach(() => cols.push({ wch: 12 }));
    cols.push({ wch: 8 },{ wch: 8 },{ wch: 12 },{ wch: 8 });
    ws['!cols'] = cols;
    const wb = XLSX.utils.book_new();
    const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    XLSX.utils.book_append_sheet(wb, ws, `${mn[parseInt(month)-1]} ${year}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${mn[parseInt(month)-1]}_${year}.xlsx`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Factory attendance server running on port ${PORT}`);
    console.log(`Rate: ₹${HOURLY_RATE}/hour | Min shift: ${MIN_SHIFT_HOURS} hour`);
    console.log('Login: admin / factory@123');
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
