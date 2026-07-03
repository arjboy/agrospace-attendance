// ===========================
// AUTH
// ===========================
const AUTH_TOKEN = localStorage.getItem('authToken');
if (!AUTH_TOKEN) { window.location.href = '/login.html'; }
(async () => {
  try {
    const r = await fetch('/api/auth/check', { headers: { 'x-auth-token': AUTH_TOKEN } });
    const d = await r.json();
    if (!d.loggedIn) { localStorage.clear(); window.location.href = '/login.html'; return; }
    document.getElementById('loggedUser').textContent = '👤 ' + d.username;
  } catch (e) { window.location.href = '/login.html'; }
})();

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': AUTH_TOKEN } });
  localStorage.clear();
  window.location.href = '/login.html';
});

function authFetch(url, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers['x-auth-token'] = AUTH_TOKEN;
  return fetch(url, opts).then(r => { if (r.status === 401) { localStorage.clear(); window.location.href = '/login.html'; } return r; });
}

// ===========================
// FACE DETECTION
// ===========================
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
let modelsLoaded = false;
let capturedDescriptor = null;
let kioskRunning = false;
let lastMarkedId = null;
let lastMarkedTime = 0;
const COOLDOWN_MS = 8000;

// Camera state
let kioskStream = null, enrollStream = null;
let kioskFacing = 'environment'; // default back camera for kiosk
let enrollFacing = 'user';       // default front camera for enroll

const DETECT_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 320,     // faster on mobile
  scoreThreshold: 0.3
});

// ===========================
// TABS
// ===========================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    stopKiosk(); stopEnroll();
    if (btn.dataset.tab === 'kiosk') startKiosk();
    if (btn.dataset.tab === 'enroll') { startEnroll(); loadWorkerList(); }
    if (btn.dataset.tab === 'report') loadTodayReport();
    if (btn.dataset.tab === 'monthly') loadCurrentMonth();
  });
});

// ===========================
// CAMERA HELPERS
// ===========================
async function openCamera(videoEl, facing) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }
  });
  videoEl.srcObject = stream;
  // Mirror front camera only
  if (facing === 'user') videoEl.classList.add('front-cam');
  else videoEl.classList.remove('front-cam');
  await new Promise(res => { videoEl.onloadeddata = res; if (videoEl.readyState >= 2) res(); });
  return stream;
}
function closeCamera(stream) { if (stream) stream.getTracks().forEach(t => t.stop()); }

// ===========================
// MODEL LOADING
// ===========================
async function loadModels() {
  const s = document.getElementById('kioskStatus');
  s.textContent = 'Models load ho rahe hain... / Loading models...';
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    s.textContent = 'Model 1/3 ✔';
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    s.textContent = 'Model 2/3 ✔';
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    s.textContent = 'Ready ✔ Camera shuru ho raha hai...';
    modelsLoaded = true;
    startKiosk();
  } catch (err) {
    s.textContent = 'Model load fail: ' + err.message;
  }
}
loadModels();

// ===========================
// KIOSK — MARK ATTENDANCE
// ===========================
async function startKiosk() {
  if (!modelsLoaded || kioskRunning) return;
  const video = document.getElementById('kioskVideo');
  try {
    document.getElementById('kioskStatus').textContent = 'Camera shuru ho raha hai...';
    kioskStream = await openCamera(video, kioskFacing);
    document.getElementById('kioskStatus').textContent = '✔ Camera ready — apna chehra dikhao';
    kioskRunning = true;
    loadTodaySummary();
    kioskDetectLoop();
  } catch (e) {
    document.getElementById('kioskStatus').textContent = 'Camera error: ' + e.message;
  }
}
function stopKiosk() { kioskRunning = false; closeCamera(kioskStream); kioskStream = null; }

// Camera switch — kiosk
document.getElementById('kioskCamSwitch').addEventListener('click', async () => {
  kioskFacing = kioskFacing === 'environment' ? 'user' : 'environment';
  stopKiosk();
  await startKiosk();
});

async function kioskDetectLoop() {
  if (!kioskRunning) return;
  const video = document.getElementById('kioskVideo');
  const overlay = document.getElementById('kioskOverlay');
  try {
    const det = await faceapi.detectSingleFace(video, DETECT_OPTIONS).withFaceLandmarks().withFaceDescriptor();
    const ctx = overlay.getContext('2d');
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (det) {
      const b = det.detection.box;
      ctx.strokeStyle = '#00ff00'; ctx.lineWidth = 3;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      document.getElementById('kioskStatus').textContent = `Chehra dikha (${(det.detection.score*100).toFixed(0)}%) — check ho raha hai...`;
      await markAttendance(Array.from(det.descriptor));
    } else {
      document.getElementById('kioskStatus').textContent = 'Chehra nahi dikha — camera ke paas aao';
    }
  } catch (err) { console.error(err); }
  setTimeout(kioskDetectLoop, 700); // fast loop
}

async function markAttendance(descriptor) {
  const now = Date.now();
  if (lastMarkedId && now - lastMarkedTime < COOLDOWN_MS) return;

  try {
    const res = await authFetch('/api/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptor })
    });
    const data = await res.json();
    const card = document.getElementById('kioskResult');

    if (!res.ok) {
      if (data.error === 'Face not recognized') {
        document.getElementById('kioskStatus').textContent = 'Pehchaan nahi hua — kya yeh worker registered hai?';
      } else if (data.error === 'No workers enrolled') {
        document.getElementById('kioskStatus').textContent = 'Koi worker registered nahi — pehle Enroll karo';
      }
      return;
    }

    lastMarkedId = data.record.employeeId;
    lastMarkedTime = Date.now();

    if (data.type === 'check-in') {
      card.className = 'result-card checkin';
      card.innerHTML = `
        <h2>✅ CHECK IN</h2>
        <p><strong>${data.record.name}</strong></p>
        <p>🕐 ${new Date(data.record.time).toLocaleTimeString('en-IN')}</p>
        <p style="font-size:14px;color:#666">Shift shuru! / Shift started</p>
      `;
      loadTodaySummary();
    } else if (data.type === 'check-out') {
      card.className = 'result-card checkout';
      card.innerHTML = `
        <h2>👋 CHECK OUT</h2>
        <p><strong>${data.record.name}</strong></p>
        <p>🕐 In: ${new Date(data.record.checkIn).toLocaleTimeString('en-IN')} → Out: ${new Date(data.record.checkOut).toLocaleTimeString('en-IN')}</p>
        <p style="font-size:18px;font-weight:700;color:#856404">⏱ ${data.record.hoursWorked} hours worked</p>
      `;
      loadTodaySummary();
    } else if (data.type === 'done') {
      card.className = 'result-card done';
      card.innerHTML = `
        <h2>ℹ️ Already Done</h2>
        <p><strong>${data.message}</strong></p>
        <p style="font-size:14px">Aaj ka check-in aur check-out ho chuka hai</p>
      `;
    }
    card.classList.remove('hidden');
  } catch (e) {
    document.getElementById('kioskStatus').textContent = 'Network error: ' + e.message;
  }
}

async function loadTodaySummary() {
  try {
    const r = await authFetch('/api/attendance?date=' + new Date().toISOString().split('T')[0]);
    const d = await r.json();
    document.getElementById('todaySummary').innerHTML = `
      <span class="total">Total: ${d.totalWorkers}</span>
      <span class="present">Present: ${d.totalPresent}</span>
      <span class="absent">Absent: ${d.totalAbsent}</span>
    `;
  } catch (e) {}
}

// ===========================
// ENROLL
// ===========================
async function startEnroll() {
  if (!modelsLoaded) return;
  try {
    enrollStream = await openCamera(document.getElementById('enrollVideo'), enrollFacing);
    document.getElementById('enrollStatus').textContent = 'Camera ready — Photo Lo button dabao';
  } catch (e) {
    document.getElementById('enrollStatus').textContent = 'Camera error: ' + e.message;
  }
}
function stopEnroll() { closeCamera(enrollStream); enrollStream = null; }

// Camera switch — enroll
document.getElementById('enrollCamSwitch').addEventListener('click', async () => {
  enrollFacing = enrollFacing === 'user' ? 'environment' : 'user';
  stopEnroll();
  await startEnroll();
});

document.getElementById('captureBtn').addEventListener('click', async () => {
  const video = document.getElementById('enrollVideo');
  const overlay = document.getElementById('enrollOverlay');
  const status = document.getElementById('enrollStatus');
  status.textContent = 'Chehra dhundh rahe hain... / Detecting...';
  try {
    const det = await faceapi.detectSingleFace(video, DETECT_OPTIONS).withFaceLandmarks().withFaceDescriptor();
    const ctx = overlay.getContext('2d');
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!det) { status.textContent = 'Chehra nahi mila — seedha camera ke saamne aao, roshni mein'; return; }
    const b = det.detection.box;
    ctx.strokeStyle = '#00ff00'; ctx.lineWidth = 3;
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    capturedDescriptor = Array.from(det.descriptor);
    status.textContent = `✔ Photo le li (${(det.detection.score*100).toFixed(0)}%) — ab Register karo`;
    document.getElementById('enrollSubmit').disabled = false;
  } catch (err) { status.textContent = 'Error: ' + err.message; }
});

document.getElementById('enrollSubmit').addEventListener('click', async () => {
  const status = document.getElementById('enrollStatus');
  const name = document.getElementById('empName').value.trim();
  if (!name) { status.textContent = 'Naam likho pehle / Enter name first'; return; }
  if (!capturedDescriptor) { status.textContent = 'Pehle photo lo / Capture face first'; return; }
  try {
    const r = await authFetch('/api/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, descriptor: capturedDescriptor })
    });
    const d = await r.json();
    if (!r.ok) { status.textContent = 'Error: ' + d.error; return; }
    status.textContent = '✅ ' + d.message;
    document.getElementById('empName').value = '';
    capturedDescriptor = null;
    document.getElementById('enrollSubmit').disabled = true;
    loadWorkerList();
  } catch (e) { status.textContent = 'Network error: ' + e.message; }
});

async function loadWorkerList() {
  const list = document.getElementById('workerList');
  list.innerHTML = '';
  try {
    const r = await authFetch('/api/workers');
    const workers = await r.json();
    document.getElementById('workerCount').textContent = workers.length;
    if (!workers.length) { list.innerHTML = '<li>Koi worker registered nahi hai</li>'; return; }
    workers.forEach(w => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${w.name} (${w.employeeId})</span>`;
      const del = document.createElement('button');
      del.textContent = '✕ Remove';
      del.onclick = async () => {
        if (confirm(`${w.name} ko hatana hai?`)) {
          await authFetch(`/api/workers/${w.employeeId}`, { method: 'DELETE' });
          loadWorkerList();
        }
      };
      li.appendChild(del);
      list.appendChild(li);
    });
  } catch (e) {}
}

// ===========================
// DAILY REPORT
// ===========================
document.getElementById('loadReport').addEventListener('click', () => loadDailyReport(document.getElementById('reportDate').value));
document.getElementById('todayReport').addEventListener('click', loadTodayReport);
document.getElementById('exportDaily').addEventListener('click', () => {
  const d = document.getElementById('reportDate').value;
  if (!d) { alert('Date select karo'); return; }
  window.open(`/api/export/daily?date=${d}&token=${AUTH_TOKEN}`, '_blank');
});

function loadTodayReport() {
  const t = new Date().toISOString().split('T')[0];
  document.getElementById('reportDate').value = t;
  loadDailyReport(t);
}

async function loadDailyReport(date) {
  if (!date) { alert('Date select karo'); return; }
  const tbody = document.querySelector('#reportTable tbody');
  tbody.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
  try {
    const r = await authFetch(`/api/attendance?date=${date}`);
    const d = await r.json();
    document.getElementById('dailySummary').innerHTML = `
      <span>📅 ${formatDate(d.date)}</span>
      <span class="total">Total: ${d.totalWorkers}</span>
      <span class="present">✅ ${d.totalPresent}</span>
      <span class="absent">❌ ${d.totalAbsent}</span>
    `;
    tbody.innerHTML = '';
    if (!d.report.length) { tbody.innerHTML = '<tr><td colspan="6">No data</td></tr>'; return; }
    d.report.sort((a, b) => {
      const order = { 'Complete': 0, 'Checked In': 1, 'Absent': 2 };
      return (order[a.status] || 2) - (order[b.status] || 2) || a.name.localeCompare(b.name);
    });
    d.report.forEach((r, i) => {
      const bc = r.status === 'Complete' ? 'badge-complete' : r.status === 'Checked In' ? 'badge-checkedin' : 'badge-absent';
      const cin = r.checkIn ? new Date(r.checkIn).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
      const cout = r.checkOut ? new Date(r.checkOut).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
      const hrs = r.hoursWorked ? parseFloat(r.hoursWorked).toFixed(1) : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i+1}</td><td>${r.name}</td><td><span class="badge ${bc}">${r.status}</span></td><td>${cin}</td><td>${cout}</td><td>${hrs}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { tbody.innerHTML = `<tr><td colspan="6">Error: ${e.message}</td></tr>`; }
}

// ===========================
// MONTHLY REPORT
// ===========================
document.getElementById('loadMonthly').addEventListener('click', loadMonthlyReport);
document.getElementById('exportMonthly').addEventListener('click', () => {
  window.open(`/api/export/monthly?month=${document.getElementById('monthSelect').value}&year=${document.getElementById('yearSelect').value}&token=${AUTH_TOKEN}`, '_blank');
});
function loadCurrentMonth() {
  const n = new Date();
  document.getElementById('monthSelect').value = n.getMonth() + 1;
  document.getElementById('yearSelect').value = n.getFullYear();
  loadMonthlyReport();
}
async function loadMonthlyReport() {
  const month = document.getElementById('monthSelect').value;
  const year = document.getElementById('yearSelect').value;
  const tbody = document.querySelector('#monthlyTable tbody');
  tbody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
  try {
    const r = await authFetch(`/api/attendance/monthly?month=${month}&year=${year}`);
    const d = await r.json();
    const mn = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    document.getElementById('monthlySummary').innerHTML = `
      <span>📊 ${mn[d.month-1]} ${d.year}</span>
      <span class="total">Working Days: ${d.workingDays}</span>
    `;
    tbody.innerHTML = '';
    if (!d.summary.length) { tbody.innerHTML = '<tr><td colspan="5">No data</td></tr>'; return; }
    d.summary.sort((a, b) => b.totalPresent - a.totalPresent);
    d.summary.forEach((w, i) => {
      const pct = d.workingDays > 0 ? Math.round((w.totalPresent / d.workingDays) * 100) : 0;
      const color = pct >= 90 ? '#155724' : pct >= 75 ? '#856404' : '#dc3545';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i+1}</td><td>${w.name}</td><td><strong>${w.totalPresent}</strong>/${d.workingDays}</td>
        <td>${w.totalHours}h</td><td style="color:${color};font-weight:700">${pct}%</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">Error: ${e.message}</td></tr>`; }
}

function formatDate(s) {
  return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
