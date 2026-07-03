const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const WORKERS_FILE = path.join(__dirname, 'data', 'workers.json');
const ATTENDANCE_FILE = path.join(__dirname, 'data', 'attendance.json');

const MATCH_THRESHOLD = 0.5;

// ============================================
// LOGIN CREDENTIALS — CHANGE THESE
// ============================================
const ADMIN_USERS = [
  { username: 'admin', password: 'factory@123' },
  { username: 'arth', password: 'arth@123' }
];
// ============================================

// Active sessions (in-memory, cleared on server restart)
const sessions = new Map();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

function loadJSON(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return []; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

// ---- Auth middleware ----
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  const session = sessions.get(token);
  session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  next();
}

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ---- Login (unprotected) ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = ADMIN_USERS.find(
    u => u.username === username && u.password === password
  );
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
  });
  res.json({ success: true, token, username: user.username });
});

// ---- Check if logged in ----
app.get('/api/auth/check', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions.has(token)) {
    return res.json({ loggedIn: false });
  }
  const session = sessions.get(token);
  res.json({ loggedIn: true, username: session.username });
});

// ---- Logout ----
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ---- Serve login page (unprotected) ----
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---- Serve static files with auth check ----
// login.html, style.css, and JS files are always accessible
// index.html requires auth (checked client-side via JS)
app.use(express.static(path.join(__dirname, 'public')));

// ---- ALL API routes below require auth ----

app.post('/api/enroll', requireAuth, (req, res) => {
  const { name, descriptor } = req.body;
  if (!name || !descriptor || !Array.isArray(descriptor)) {
    return res.status(400).json({ error: 'name and descriptor are required' });
  }
  const workers = loadJSON(WORKERS_FILE);
  // Auto-generate Employee ID: EMP001, EMP002, etc.
  let maxNum = 0;
  workers.forEach(w => {
    const match = w.employeeId.match(/^EMP(\d+)$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
  });
  const employeeId = 'EMP' + String(maxNum + 1).padStart(3, '0');
  workers.push({ employeeId, name, descriptor, enrolledAt: new Date().toISOString() });
  saveJSON(WORKERS_FILE, workers);
  res.json({ success: true, message: `${name} enrolled as ${employeeId}`, employeeId });
});

app.get('/api/workers', requireAuth, (req, res) => {
  const workers = loadJSON(WORKERS_FILE).map(({ employeeId, name, enrolledAt }) => ({
    employeeId, name, enrolledAt
  }));
  res.json(workers);
});

app.delete('/api/workers/:employeeId', requireAuth, (req, res) => {
  let workers = loadJSON(WORKERS_FILE);
  const before = workers.length;
  workers = workers.filter(w => w.employeeId !== req.params.employeeId);
  saveJSON(WORKERS_FILE, workers);
  res.json({ success: true, removed: before - workers.length });
});

app.post('/api/attendance', requireAuth, (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor)) {
    return res.status(400).json({ error: 'descriptor is required' });
  }
  const workers = loadJSON(WORKERS_FILE);
  if (workers.length === 0) {
    return res.status(404).json({ error: 'No workers enrolled yet' });
  }
  let best = null;
  let bestDist = Infinity;
  for (const w of workers) {
    const dist = euclideanDistance(w.descriptor, descriptor);
    if (dist < bestDist) { bestDist = dist; best = w; }
  }
  if (!best || bestDist > MATCH_THRESHOLD) {
    return res.status(404).json({ error: 'Face not recognized', distance: bestDist });
  }
  const attendance = loadJSON(ATTENDANCE_FILE);
  const today = todayDate();
  const alreadyMarked = attendance.some(
    r => r.employeeId === best.employeeId && r.date === today
  );
  if (alreadyMarked) {
    return res.json({
      success: true, alreadyMarked: true,
      message: `${best.name} already marked present today`,
      record: { employeeId: best.employeeId, name: best.name, date: today }
    });
  }
  const record = {
    employeeId: best.employeeId, name: best.name, date: today,
    time: new Date().toISOString(), type: 'present',
    confidence: (1 - bestDist / MATCH_THRESHOLD).toFixed(2)
  };
  attendance.push(record);
  saveJSON(ATTENDANCE_FILE, attendance);
  res.json({ success: true, alreadyMarked: false, record });
});

app.get('/api/attendance', requireAuth, (req, res) => {
  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);
  const { date } = req.query;
  const queryDate = date || todayDate();
  const dayRecords = attendance.filter(r => r.date === queryDate);
  const report = workers.map(w => {
    const record = dayRecords.find(r => r.employeeId === w.employeeId);
    return {
      employeeId: w.employeeId, name: w.name, date: queryDate,
      status: record ? 'Present' : 'Absent',
      time: record ? record.time : null,
      confidence: record ? record.confidence : null
    };
  });
  const totalWorkers = workers.length;
  const totalPresent = report.filter(r => r.status === 'Present').length;
  res.json({ date: queryDate, totalWorkers, totalPresent, totalAbsent: totalWorkers - totalPresent, report });
});

app.get('/api/attendance/monthly', requireAuth, (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: 'month and year required' });
  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);
  const mm = String(month).padStart(2, '0');
  const prefix = `${year}-${mm}`;
  const monthRecords = attendance.filter(r => r.date.startsWith(prefix));
  const workingDays = [...new Set(monthRecords.map(r => r.date))].sort();
  const summary = workers.map(w => {
    const presentDays = monthRecords.filter(r => r.employeeId === w.employeeId);
    return {
      employeeId: w.employeeId, name: w.name,
      totalPresent: presentDays.length, totalWorkingDays: workingDays.length,
      presentDates: presentDays.map(r => r.date).sort()
    };
  });
  res.json({ month: parseInt(month), year: parseInt(year), workingDays: workingDays.length, workingDatesList: workingDays, summary });
});

app.get('/api/export/daily', requireAuth, (req, res) => {
  const { date } = req.query;
  const queryDate = date || todayDate();
  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);
  const dayRecords = attendance.filter(r => r.date === queryDate);
  let csv = 'Sr No,Employee ID,Name,Status,Date,Time\n';
  workers.forEach((w, i) => {
    const record = dayRecords.find(r => r.employeeId === w.employeeId);
    const status = record ? 'Present' : 'Absent';
    const time = record ? new Date(record.time).toLocaleTimeString('en-IN') : '-';
    csv += `${i + 1},${w.employeeId},${w.name},${status},${queryDate},${time}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=attendance_${queryDate}.csv`);
  res.send(csv);
});

app.get('/api/export/monthly', requireAuth, (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: 'month and year required' });
  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);
  const mm = String(month).padStart(2, '0');
  const prefix = `${year}-${mm}`;
  const monthRecords = attendance.filter(r => r.date.startsWith(prefix));
  const workingDays = [...new Set(monthRecords.map(r => r.date))].sort();
  let csv = 'Sr No,Employee ID,Name,' + workingDays.join(',') + ',Total Present,Total Days\n';
  workers.forEach((w, i) => {
    const presentDates = new Set(monthRecords.filter(r => r.employeeId === w.employeeId).map(r => r.date));
    const dayCols = workingDays.map(d => presentDates.has(d) ? 'P' : 'A').join(',');
    csv += `${i + 1},${w.employeeId},${w.name},${dayCols},${presentDates.size},${workingDays.length}\n`;
  });
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=attendance_${monthNames[parseInt(month)-1]}_${year}.csv`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Factory attendance server running on port ${PORT}`);
  console.log('Default login — username: admin, password: factory@123');
});
