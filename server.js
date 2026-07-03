const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const WORKERS_FILE = path.join(__dirname, 'data', 'workers.json');
const ATTENDANCE_FILE = path.join(__dirname, 'data', 'attendance.json');

const MATCH_THRESHOLD = 0.5;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
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

// ---- Enroll a new worker ----
app.post('/api/enroll', (req, res) => {
  const { name, employeeId, descriptor } = req.body;
  if (!name || !employeeId || !descriptor || !Array.isArray(descriptor)) {
    return res.status(400).json({ error: 'name, employeeId, and descriptor are required' });
  }
  const workers = loadJSON(WORKERS_FILE);
  if (workers.some(w => w.employeeId === employeeId)) {
    return res.status(409).json({ error: 'Employee ID already enrolled' });
  }
  workers.push({ employeeId, name, descriptor, enrolledAt: new Date().toISOString() });
  saveJSON(WORKERS_FILE, workers);
  res.json({ success: true, message: `${name} enrolled successfully` });
});

// ---- List enrolled workers ----
app.get('/api/workers', (req, res) => {
  const workers = loadJSON(WORKERS_FILE).map(({ employeeId, name, enrolledAt }) => ({
    employeeId, name, enrolledAt
  }));
  res.json(workers);
});

// ---- Delete a worker ----
app.delete('/api/workers/:employeeId', (req, res) => {
  let workers = loadJSON(WORKERS_FILE);
  const before = workers.length;
  workers = workers.filter(w => w.employeeId !== req.params.employeeId);
  saveJSON(WORKERS_FILE, workers);
  res.json({ success: true, removed: before - workers.length });
});

// ---- Mark attendance (CHECK-IN ONLY, once per day) ----
app.post('/api/attendance', (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor)) {
    return res.status(400).json({ error: 'descriptor is required' });
  }

  const workers = loadJSON(WORKERS_FILE);
  if (workers.length === 0) {
    return res.status(404).json({ error: 'No workers enrolled yet' });
  }

  // Find closest match
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

  // Check if already marked today — NO DUPLICATE
  const alreadyMarked = attendance.some(
    r => r.employeeId === best.employeeId && r.date === today
  );

  if (alreadyMarked) {
    return res.json({
      success: true,
      alreadyMarked: true,
      message: `${best.name} already marked present today`,
      record: { employeeId: best.employeeId, name: best.name, date: today }
    });
  }

  // Mark attendance
  const record = {
    employeeId: best.employeeId,
    name: best.name,
    date: today,
    time: new Date().toISOString(),
    type: 'present',
    confidence: (1 - bestDist / MATCH_THRESHOLD).toFixed(2)
  };
  attendance.push(record);
  saveJSON(ATTENDANCE_FILE, attendance);

  res.json({ success: true, alreadyMarked: false, record });
});

// ---- Daily attendance report ----
app.get('/api/attendance', (req, res) => {
  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);
  const { date } = req.query;
  const queryDate = date || todayDate();

  const dayRecords = attendance.filter(r => r.date === queryDate);

  // Build full report: all workers, mark present/absent
  const report = workers.map(w => {
    const record = dayRecords.find(r => r.employeeId === w.employeeId);
    return {
      employeeId: w.employeeId,
      name: w.name,
      date: queryDate,
      status: record ? 'Present' : 'Absent',
      time: record ? record.time : null,
      confidence: record ? record.confidence : null
    };
  });

  const totalWorkers = workers.length;
  const totalPresent = report.filter(r => r.status === 'Present').length;
  const totalAbsent = totalWorkers - totalPresent;

  res.json({ date: queryDate, totalWorkers, totalPresent, totalAbsent, report });
});

// ---- Monthly attendance summary ----
app.get('/api/attendance/monthly', (req, res) => {
  const { month, year } = req.query; // month: 1-12, year: 2024
  if (!month || !year) {
    return res.status(400).json({ error: 'month and year are required (e.g. ?month=7&year=2026)' });
  }

  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);

  const mm = String(month).padStart(2, '0');
  const prefix = `${year}-${mm}`;

  // Get all dates in this month that have any attendance
  const monthRecords = attendance.filter(r => r.date.startsWith(prefix));

  // Count working days (unique dates with at least one record)
  const workingDays = [...new Set(monthRecords.map(r => r.date))].sort();

  // Build per-worker summary
  const summary = workers.map(w => {
    const presentDays = monthRecords.filter(r => r.employeeId === w.employeeId);
    return {
      employeeId: w.employeeId,
      name: w.name,
      totalPresent: presentDays.length,
      totalWorkingDays: workingDays.length,
      presentDates: presentDays.map(r => r.date).sort()
    };
  });

  res.json({
    month: parseInt(month),
    year: parseInt(year),
    workingDays: workingDays.length,
    workingDatesList: workingDays,
    summary
  });
});

// ---- Export daily attendance as CSV ----
app.get('/api/export/daily', (req, res) => {
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

// ---- Export monthly attendance as CSV ----
app.get('/api/export/monthly', (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) {
    return res.status(400).json({ error: 'month and year required' });
  }

  const attendance = loadJSON(ATTENDANCE_FILE);
  const workers = loadJSON(WORKERS_FILE);
  const mm = String(month).padStart(2, '0');
  const prefix = `${year}-${mm}`;
  const monthRecords = attendance.filter(r => r.date.startsWith(prefix));
  const workingDays = [...new Set(monthRecords.map(r => r.date))].sort();

  // Header: Sr No, ID, Name, each date, Total
  let csv = 'Sr No,Employee ID,Name,' + workingDays.join(',') + ',Total Present,Total Days\n';

  workers.forEach((w, i) => {
    const workerRecords = monthRecords.filter(r => r.employeeId === w.employeeId);
    const presentDates = new Set(workerRecords.map(r => r.date));
    const dayCols = workingDays.map(d => presentDates.has(d) ? 'P' : 'A').join(',');
    csv += `${i + 1},${w.employeeId},${w.name},${dayCols},${presentDates.size},${workingDays.length}\n`;
  });

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const filename = `attendance_${monthNames[parseInt(month) - 1]}_${year}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Factory attendance server running on port ${PORT}`);
});
