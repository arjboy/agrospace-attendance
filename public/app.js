// ===========================
// AUTH CHECK — Redirect to login if not authenticated
// ===========================
const AUTH_TOKEN = localStorage.getItem('authToken');
const AUTH_USER = localStorage.getItem('authUser');

(async function checkAuth() {
  if (!AUTH_TOKEN) { window.location.href = '/login.html'; return; }
  try {
    const res = await fetch('/api/auth/check', { headers: { 'x-auth-token': AUTH_TOKEN } });
    const data = await res.json();
    if (!data.loggedIn) { localStorage.clear(); window.location.href = '/login.html'; return; }
    document.getElementById('loggedUser').textContent = '👤 ' + data.username;
  } catch (e) { window.location.href = '/login.html'; }
})();

// Logout
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': AUTH_TOKEN } });
  localStorage.clear();
  window.location.href = '/login.html';
});

// Helper: authenticated fetch
function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['x-auth-token'] = AUTH_TOKEN;
  return fetch(url, options).then(res => {
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login.html'; }
    return res;
  });
}

// ===========================
// FACE DETECTION SETUP
// ===========================
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';

let modelsLoaded = false;
let capturedDescriptor = null;
let kioskStream = null;
let enrollStream = null;
let kioskRunning = false;
let lastMarkedId = null;
let lastMarkedTime = 0;
const COOLDOWN_MS = 10000;

const DETECT_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 416,
  scoreThreshold: 0.3
});

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    stopKioskCamera();
    stopEnrollCamera();
    if (btn.dataset.tab === 'kiosk') startKioskCamera();
    if (btn.dataset.tab === 'enroll') { startEnrollCamera(); loadWorkerList(); }
    if (btn.dataset.tab === 'report') loadTodayReport();
    if (btn.dataset.tab === 'monthly') loadCurrentMonth();
  });
});

// ---------- Model loading ----------
async function loadModels() {
  const s = document.getElementById('kioskStatus');
  s.textContent = 'Loading face models... (first time ~15 sec)';
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    s.textContent = 'Model 1/3 loaded...';
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    s.textContent = 'Model 2/3 loaded...';
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    s.textContent = 'All models loaded ✔ Starting camera...';
    modelsLoaded = true;
    startKioskCamera();
  } catch (err) {
    s.textContent = 'Failed to load face models: ' + err.message;
  }
}
loadModels();

// ---------- Camera helpers ----------
async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
  });
  videoEl.srcObject = stream;
  await new Promise(resolve => {
    videoEl.onloadeddata = resolve;
    if (videoEl.readyState >= 2) resolve();
  });
  return stream;
}
function stopCamera(stream) {
  if (stream) stream.getTracks().forEach(t => t.stop());
}

// ===========================
// KIOSK — Mark Attendance
// ===========================
async function startKioskCamera() {
  if (!modelsLoaded || kioskRunning) return;
  const video = document.getElementById('kioskVideo');
  try {
    document.getElementById('kioskStatus').textContent = 'Starting camera...';
    kioskStream = await startCamera(video);
    document.getElementById('kioskStatus').textContent = 'Camera ready ✔ Look at the camera.';
    kioskRunning = true;
    loadTodaySummary();
    detectLoop();
  } catch (e) {
    document.getElementById('kioskStatus').textContent = 'Camera error: ' + e.message;
  }
}
function stopKioskCamera() { kioskRunning = false; stopCamera(kioskStream); kioskStream = null; }

async function detectLoop() {
  if (!kioskRunning) return;
  const video = document.getElementById('kioskVideo');
  const overlay = document.getElementById('kioskOverlay');
  const statusEl = document.getElementById('kioskStatus');
  try {
    const detection = await faceapi
      .detectSingleFace(video, DETECT_OPTIONS)
      .withFaceLandmarks()
      .withFaceDescriptor();
    const ctx = overlay.getContext('2d');
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (detection) {
      const box = detection.detection.box;
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      statusEl.textContent = `Face detected (${(detection.detection.score * 100).toFixed(0)}%) — matching...`;
      await tryMarkAttendance(Array.from(detection.descriptor));
    } else {
      statusEl.textContent = 'No face detected — move closer, face the camera.';
    }
  } catch (err) { console.error('Detection error:', err); }
  setTimeout(detectLoop, 1000);
}

async function tryMarkAttendance(descriptor) {
  const statusEl = document.getElementById('kioskStatus');
  const resultCard = document.getElementById('kioskResult');
  const now = Date.now();
  if (lastMarkedId && now - lastMarkedTime < COOLDOWN_MS) return;

  try {
    const res = await authFetch('/api/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptor })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'Face not recognized') {
        statusEl.textContent = `Face not recognized (dist: ${data.distance ? data.distance.toFixed(2) : '?'}). Worker enrolled?`;
      } else if (data.error === 'No workers enrolled yet') {
        statusEl.textContent = 'No workers enrolled. Go to Enroll tab first.';
      }
      return;
    }
    lastMarkedId = data.record.employeeId;
    lastMarkedTime = Date.now();
    if (data.alreadyMarked) {
      resultCard.className = 'result-card already';
      resultCard.innerHTML = `<h2>ℹ️ Already Marked</h2><p><strong>${data.message}</strong></p>`;
    } else {
      resultCard.className = 'result-card';
      resultCard.innerHTML = `
        <h2>✅ Attendance Marked!</h2>
        <p><strong>${data.record.name}</strong> (${data.record.employeeId})</p>
        <p>${new Date(data.record.time).toLocaleTimeString('en-IN')}</p>
        <p>Confidence: ${(data.record.confidence * 100).toFixed(0)}%</p>
      `;
      loadTodaySummary();
    }
    resultCard.classList.remove('hidden');
  } catch (e) { statusEl.textContent = 'Network error: ' + e.message; }
}

async function loadTodaySummary() {
  try {
    const res = await authFetch('/api/attendance?date=' + new Date().toISOString().split('T')[0]);
    const data = await res.json();
    document.getElementById('todaySummary').innerHTML = `
      <span class="total">Total: ${data.totalWorkers}</span>
      <span class="present">Present: ${data.totalPresent}</span>
      <span class="absent">Absent: ${data.totalAbsent}</span>
    `;
  } catch (e) { /* ignore */ }
}

// ===========================
// ENROLL
// ===========================
async function startEnrollCamera() {
  if (!modelsLoaded) return;
  const video = document.getElementById('enrollVideo');
  try {
    enrollStream = await startCamera(video);
    document.getElementById('enrollStatus').textContent = 'Camera ready. Click Capture Face.';
  } catch (e) {
    document.getElementById('enrollStatus').textContent = 'Camera error: ' + e.message;
  }
}
function stopEnrollCamera() { stopCamera(enrollStream); enrollStream = null; }

document.getElementById('captureBtn').addEventListener('click', async () => {
  const video = document.getElementById('enrollVideo');
  const overlay = document.getElementById('enrollOverlay');
  const status = document.getElementById('enrollStatus');
  status.textContent = 'Detecting face...';
  try {
    const detection = await faceapi
      .detectSingleFace(video, DETECT_OPTIONS)
      .withFaceLandmarks()
      .withFaceDescriptor();
    const ctx = overlay.getContext('2d');
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!detection) { status.textContent = 'No face detected. Face the camera with good lighting.'; return; }
    const box = detection.detection.box;
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    capturedDescriptor = Array.from(detection.descriptor);
    status.textContent = `Face captured ✔ (${(detection.detection.score * 100).toFixed(0)}%). Fill details and click Enroll.`;
    document.getElementById('enrollSubmit').disabled = false;
  } catch (err) { status.textContent = 'Error: ' + err.message; }
});

document.getElementById('enrollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('enrollStatus');
  const empName = document.getElementById('empName').value.trim();
  if (!capturedDescriptor) { status.textContent = 'Capture face first.'; return; }
  try {
    const res = await authFetch('/api/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: empName, descriptor: capturedDescriptor })
    });
    const data = await res.json();
    if (!res.ok) { status.textContent = 'Error: ' + data.error; return; }
    status.textContent = '✅ ' + data.message;
    document.getElementById('enrollForm').reset();
    capturedDescriptor = null;
    document.getElementById('enrollSubmit').disabled = true;
    loadWorkerList();
  } catch (err) { status.textContent = 'Network error: ' + err.message; }
});

async function loadWorkerList() {
  const list = document.getElementById('workerList');
  list.innerHTML = '';
  try {
    const res = await authFetch('/api/workers');
    const workers = await res.json();
    document.getElementById('workerCount').textContent = workers.length;
    if (workers.length === 0) { list.innerHTML = '<li>No workers enrolled yet.</li>'; return; }
    workers.forEach(w => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${w.name} (${w.employeeId})</span>`;
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Remove';
      delBtn.onclick = async () => {
        if (confirm(`Remove ${w.name}?`)) {
          await authFetch(`/api/workers/${w.employeeId}`, { method: 'DELETE' });
          loadWorkerList();
        }
      };
      li.appendChild(delBtn);
      list.appendChild(li);
    });
  } catch (e) { /* ignore */ }
}

// ===========================
// DAILY REPORT
// ===========================
document.getElementById('loadReport').addEventListener('click', () => {
  loadDailyReport(document.getElementById('reportDate').value);
});
document.getElementById('todayReport').addEventListener('click', loadTodayReport);
document.getElementById('exportDaily').addEventListener('click', () => {
  const date = document.getElementById('reportDate').value;
  if (!date) { alert('Select a date first'); return; }
  // Open export with auth token as query param
  window.open(`/api/export/daily?date=${date}&token=${AUTH_TOKEN}`, '_blank');
});

function loadTodayReport() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('reportDate').value = today;
  loadDailyReport(today);
}

async function loadDailyReport(date) {
  if (!date) { alert('Please select a date.'); return; }
  const tbody = document.querySelector('#reportTable tbody');
  tbody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
  try {
    const res = await authFetch(`/api/attendance?date=${date}`);
    const data = await res.json();
    document.getElementById('dailySummary').innerHTML = `
      <span>📅 ${formatDate(data.date)}</span>
      <span class="total">Total: ${data.totalWorkers}</span>
      <span class="present">✅ Present: ${data.totalPresent}</span>
      <span class="absent">❌ Absent: ${data.totalAbsent}</span>
    `;
    tbody.innerHTML = '';
    if (data.report.length === 0) { tbody.innerHTML = '<tr><td colspan="5">No workers enrolled.</td></tr>'; return; }
    data.report.sort((a, b) => {
      if (a.status === 'Present' && b.status === 'Absent') return -1;
      if (a.status === 'Absent' && b.status === 'Present') return 1;
      return a.name.localeCompare(b.name);
    });
    data.report.forEach((r, i) => {
      const tr = document.createElement('tr');
      const badgeClass = r.status === 'Present' ? 'badge-present' : 'badge-absent';
      const time = r.time ? new Date(r.time).toLocaleTimeString('en-IN') : '—';
      tr.innerHTML = `
        <td>${i + 1}</td><td>${r.employeeId}</td><td>${r.name}</td>
        <td><span class="badge ${badgeClass}">${r.status}</span></td><td>${time}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">Error: ${e.message}</td></tr>`; }
}

// ===========================
// MONTHLY REPORT
// ===========================
document.getElementById('loadMonthly').addEventListener('click', loadMonthlyReport);
document.getElementById('exportMonthly').addEventListener('click', () => {
  const month = document.getElementById('monthSelect').value;
  const year = document.getElementById('yearSelect').value;
  window.open(`/api/export/monthly?month=${month}&year=${year}&token=${AUTH_TOKEN}`, '_blank');
});

function loadCurrentMonth() {
  const now = new Date();
  document.getElementById('monthSelect').value = now.getMonth() + 1;
  document.getElementById('yearSelect').value = now.getFullYear();
  loadMonthlyReport();
}

async function loadMonthlyReport() {
  const month = document.getElementById('monthSelect').value;
  const year = document.getElementById('yearSelect').value;
  const tbody = document.querySelector('#monthlyTable tbody');
  tbody.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
  try {
    const res = await authFetch(`/api/attendance/monthly?month=${month}&year=${year}`);
    const data = await res.json();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    document.getElementById('monthlySummary').innerHTML = `
      <span>📊 ${monthNames[data.month - 1]} ${data.year}</span>
      <span class="total">Working Days: ${data.workingDays}</span>
      <span class="total">Workers: ${data.summary.length}</span>
    `;
    tbody.innerHTML = '';
    if (data.summary.length === 0) { tbody.innerHTML = '<tr><td colspan="6">No workers enrolled.</td></tr>'; return; }
    data.summary.sort((a, b) => b.totalPresent - a.totalPresent);
    data.summary.forEach((w, i) => {
      const pct = data.workingDays > 0 ? ((w.totalPresent / data.workingDays) * 100).toFixed(0) : '0';
      const pctColor = pct >= 90 ? '#155724' : pct >= 75 ? '#856404' : '#721c24';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td><td>${w.employeeId}</td><td>${w.name}</td>
        <td><strong>${w.totalPresent}</strong></td><td>${w.totalWorkingDays}</td>
        <td style="color:${pctColor};font-weight:600;">${pct}%</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { tbody.innerHTML = `<tr><td colspan="6">Error: ${e.message}</td></tr>`; }
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
