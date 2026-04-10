const express    = require('express');
const https      = require('https');
const http       = require('http');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const sharp      = require('sharp');
const ExifReader = require('exifreader');
const ffprobe    = require('@ffprobe-installer/ffprobe');
const { execFile }   = require('child_process');
const { promisify }  = require('util');
const execFileAsync  = promisify(execFile);
const os             = require('os');
const crypto         = require('crypto');

const app  = express();
const PORT = parseInt(process.env.PORT || '3737', 10);

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(__dirname, 'photos');
// DATA_DIR holds both the cache index and thumbnails.
// Mount this as a named volume so both survive container recreation:
//   -v photovault_data:/app/data
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const THUMB_DIR  = path.join(DATA_DIR, 'thumbs');
const CERT_DIR   = path.join(DATA_DIR, 'certs');  // persisted in the data volume
const CERT_FILE  = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE   = path.join(CERT_DIR, 'key.pem');

// ── AUTH ──────────────────────────────────────────────────────────────────────
const VAULT_PASSWORD = process.env.VAULT_PASSWORD;
if (!VAULT_PASSWORD) {
  console.error('\n❌  VAULT_PASSWORD is not set. Examples:');
  console.error('    Docker             : -e VAULT_PASSWORD=yourpassword');
  console.error('    Windows PowerShell : $env:VAULT_PASSWORD = "yourpassword"; node server.js');
  console.error('    Windows CMD        : set VAULT_PASSWORD=yourpassword && node server.js');
  console.error('    Mac / Linux        : VAULT_PASSWORD=yourpassword node server.js\n');
  process.exit(1);
}

const TOKEN_SECRET = crypto.createHmac('sha256', 'photovault-v1').update(VAULT_PASSWORD).digest('hex');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload  = token.slice(0, dot);
  const sig      = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  try {
    const eBuf = Buffer.from(expected, 'base64url');
    const sBuf = Buffer.from(sig, 'base64url');
    if (eBuf.length !== sBuf.length || !crypto.timingSafeEqual(eBuf, sBuf)) return false;
    const { ts } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() - ts < TOKEN_TTL_MS;
  } catch { return false; }
}

// ── SCAN STATE (for resume) ──────────────────────────────────────────────────
let scanState = { running: false, done: 0, total: 0 };

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query._t || null;
  if (verifyToken(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });
if (!fs.existsSync(CERT_DIR))  fs.mkdirSync(CERT_DIR,  { recursive: true });

// ── HTTP → HTTPS REDIRECT (port 80 → PORT) ───────────────────────────────────
// Only active inside Docker where we also listen on 80
if (process.env.REDIRECT_HTTP === '1') {
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:.*$/, '');
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(80, '0.0.0.0', () => console.log('   HTTP redirect  : port 80 → HTTPS'));
}

// ── PUBLIC: cert download (so iPhone can install & trust it) ─────────────────
// GET /cert          → downloads cert.pem  (install on iPhone via Safari)
// GET /cert/install  → mobile-friendly install page
app.get('/cert', (req, res) => {
  if (!fs.existsSync(CERT_FILE)) return res.status(404).send('No cert found');
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="photovault-ca.pem"');
  res.sendFile(CERT_FILE);
});

app.get('/cert/install', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Install Certificate</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #000; color: #fff;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh; padding: 32px 24px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    p  { color: #8e8e93; font-size: 15px; text-align: center; margin-bottom: 24px; line-height: 1.5; }
    .step { width: 100%; max-width: 340px; background: #1c1c1e; border-radius: 14px;
            padding: 16px 18px; margin-bottom: 10px; display: flex; align-items: flex-start; gap: 14px; }
    .num  { background: #1c6ef5; color: #fff; border-radius: 50%; width: 26px; height: 26px;
            display: flex; align-items: center; justify-content: center;
            font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
    .step p { color: #fff; text-align: left; margin: 0; font-size: 14px; }
    a.btn { display: block; width: 100%; max-width: 340px; margin-top: 16px; padding: 15px;
            background: #1c6ef5; border-radius: 14px; text-align: center;
            color: #fff; font-size: 17px; font-weight: 600; text-decoration: none; }
    .warn { color: #ff9f0a; font-size: 13px; margin-top: 12px; text-align: center; max-width: 320px; }
  </style>
</head>
<body>
  <div style="font-size:52px;margin-bottom:20px">🔒</div>
  <h1>Trust PhotoVault</h1>
  <p>Install this certificate once so Safari shows a secure connection with no warnings.</p>

  <div class="step"><div class="num">1</div><p>Tap the button below to download the certificate profile</p></div>
  <div class="step"><div class="num">2</div><p>Go to <strong>Settings → General → VPN &amp; Device Management</strong> and tap the PhotoVault profile</p></div>
  <div class="step"><div class="num">3</div><p>Tap <strong>Install</strong> and enter your iPhone passcode</p></div>
  <div class="step"><div class="num">4</div><p>Go to <strong>Settings → General → About → Certificate Trust Settings</strong> and enable full trust for PhotoVault</p></div>
  <div class="step"><div class="num">5</div><p>Return to <strong>https://${host}</strong> — no more warnings</p></div>

  <a class="btn" href="/cert">Download Certificate</a>
  <p class="warn">⚠ Only install certificates from sources you trust. This cert was generated by your own PhotoVault server.</p>
</body>
</html>`);
});

// ── AUTH ENDPOINT (public) ────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const maxLen = Math.max(password.length, VAULT_PASSWORD.length, 1);
  const a = Buffer.alloc(maxLen); Buffer.from(password).copy(a);
  const b = Buffer.alloc(maxLen); Buffer.from(VAULT_PASSWORD).copy(b);
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: makeToken() });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v']);

function walkDir(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, results);
    else {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) results.push({ full, ext, type: 'image' });
      else if (VIDEO_EXT.has(ext)) results.push({ full, ext, type: 'video' });
    }
  }
  return results;
}

function parseDMSToDecimal(dms, ref) {
  if (!dms || !dms.value) return null;
  const [d, m, s] = dms.value;
  let dec = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return dec;
}

async function getImageMeta(filePath) {
  try {
    const buf  = fs.readFileSync(filePath);
    const tags = ExifReader.load(buf, { expanded: true });
    let date = null, lat = null, lng = null;

    const dt = tags?.exif?.DateTimeOriginal?.description
            || tags?.exif?.DateTime?.description
            || tags?.iptc?.['Date Created']?.description;
    if (dt) {
      const clean = dt.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
      date = new Date(clean).getTime();
      if (isNaN(date)) date = null;
    }

    if (tags?.gps) { lat = tags.gps.Latitude ?? null; lng = tags.gps.Longitude ?? null; }
    if (!lat && tags?.exif?.GPSLatitude) {
      lat = parseDMSToDecimal(tags.exif.GPSLatitude, tags.exif.GPSLatitudeRef?.value?.[0]);
      lng = parseDMSToDecimal(tags.exif.GPSLongitude, tags.exif.GPSLongitudeRef?.value?.[0]);
    }

    return { date, lat, lng };
  } catch { return { date: null, lat: null, lng: null }; }
}

async function getVideoMeta(filePath) {
  try {
    const { stdout } = await execFileAsync(ffprobe.path,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 10000 });
    const data = JSON.parse(stdout);
    const tags = data?.format?.tags || {};

    let date = null;
    const raw = tags.creation_time || tags['com.apple.quicktime.creationdate'];
    if (raw) { date = new Date(raw).getTime(); if (isNaN(date)) date = null; }

    let lat = null, lng = null;
    const loc = tags.location || tags['com.apple.quicktime.location.ISO6709'];
    if (loc) {
      const m = loc.match(/([+-]\d+\.?\d*)([+-]\d+\.?\d*)/);
      if (m) { lat = parseFloat(m[1]); lng = parseFloat(m[2]); }
    }

    return { date, lat, lng, duration: parseFloat(data?.format?.duration) || null };
  } catch { return { date: null, lat: null, lng: null, duration: null }; }
}

async function buildThumb(filePath, thumbPath, type) {
  if (type === 'image') {
    await sharp(filePath)
      .rotate()
      .resize(400, 400, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 75 })
      .toFile(thumbPath);
  } else {
    await execFileAsync(
      ffprobe.path.replace(/ffprobe(\.exe)?$/, (_, ext) => 'ffmpeg' + (ext || '')),
      ['-y', '-ss', '1', '-i', filePath, '-vframes', '1',
       '-vf', 'scale=400:400:force_original_aspect_ratio=increase,crop=400:400', thumbPath],
      { timeout: 15000 }
    ).catch(async () => {
      await execFileAsync('ffmpeg',
        ['-y', '-ss', '1', '-i', filePath, '-vframes', '1',
         '-vf', 'scale=400:400:force_original_aspect_ratio=increase,crop=400:400', thumbPath],
        { timeout: 15000 });
    });
  }
}

// ── CACHE ──────────────────────────────────────────────────────────────────────
let mediaCache = null;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) mediaCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch { mediaCache = null; }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(mediaCache)); } catch {}
}

async function scanAndBuild(progressCb) {
  const files = walkDir(PHOTOS_DIR);
  const total = files.length;
  const items = [];
  let done = 0;
  scanState = { running: true, done: 0, total };

  for (const { full, type } of files) {
    const id        = Buffer.from(full).toString('base64url');
    const thumbPath = path.join(THUMB_DIR, id + '.jpg');
    const stat      = fs.statSync(full);
    let thumbOk     = fs.existsSync(thumbPath);
    let meta        = { date: null, lat: null, lng: null };

    if (type === 'image') meta = await getImageMeta(full);
    else meta = await getVideoMeta(full);

    if (!thumbOk) {
      try { await buildThumb(full, thumbPath, type); thumbOk = true; } catch {}
    }

    items.push({
      id, type, path: full,
      rel:  path.relative(PHOTOS_DIR, full),
      date: meta.date || stat.mtimeMs,
      lat:  meta.lat, lng: meta.lng,
      thumb: thumbOk, size: stat.size,
    });

    done++;
    scanState.done = done;
    if (progressCb) progressCb(done, total);
  }

  items.sort((a, b) => a.date - b.date);
  mediaCache = { scannedAt: Date.now(), items };
  scanState = { running: false, done, total };
  saveCache();
  return mediaCache;
}

// ── INCREMENTAL SCAN ──────────────────────────────────────────────────────────
// Only processes files not already in the cache index.
// Files with an existing cache entry AND an existing thumbnail are skipped entirely.
// New files are merged in and the combined list re-sorted by date.
async function scanAndBuildIncremental(progressCb) {
  if (!mediaCache) loadCache();

  // Build a set of already-indexed file paths for O(1) lookup
  const existing = new Map((mediaCache?.items || []).map(i => [i.path, i]));

  const allFiles = walkDir(PHOTOS_DIR);

  // Separate into known (skip) and new (process)
  const newFiles = allFiles.filter(({ full }) => {
    const entry = existing.get(full);
    if (!entry) return true; // brand new file
    const thumbPath = path.join(THUMB_DIR, entry.id + '.jpg');
    if (!fs.existsSync(thumbPath)) return true; // entry exists but thumb missing -- reprocess
    return false;
  });

  const total    = newFiles.length;
  const newItems = [];
  let done = 0;
  scanState = { running: true, done: 0, total };

  for (const { full, type } of newFiles) {
    const id        = Buffer.from(full).toString('base64url');
    const thumbPath = path.join(THUMB_DIR, id + '.jpg');
    const stat      = fs.statSync(full);
    let thumbOk     = fs.existsSync(thumbPath);
    let meta        = { date: null, lat: null, lng: null };

    if (type === 'image') meta = await getImageMeta(full);
    else meta = await getVideoMeta(full);

    if (!thumbOk) {
      try { await buildThumb(full, thumbPath, type); thumbOk = true; } catch {}
    }

    newItems.push({
      id, type, path: full,
      rel:  path.relative(PHOTOS_DIR, full),
      date: meta.date || stat.mtimeMs,
      lat:  meta.lat, lng: meta.lng,
      thumb: thumbOk, size: stat.size,
    });

    done++;
    scanState.done = done;
    if (progressCb) progressCb(done, total, newItems.length);
  }

  // Also prune entries for files that no longer exist on disk
  const existingValid = (mediaCache?.items || []).filter(i => fs.existsSync(i.path));
  const merged = [...existingValid, ...newItems];
  merged.sort((a, b) => a.date - b.date);

  mediaCache = { scannedAt: Date.now(), items: merged };
  scanState  = { running: false, done, total };
  saveCache();
  return { added: newItems.length, removed: (mediaCache?.items?.length || 0) - existingValid.length, total: merged.length };
}

// ── PROTECTED API ─────────────────────────────────────────────────────────────

// Scan status -- client polls this on reconnect to check if scan is still running
app.get('/api/scan/status', requireAuth, (req, res) => {
  res.json({
    running: scanState.running,
    done: scanState.done,
    total: scanState.total,
    cached: !!mediaCache,
    cachedCount: mediaCache?.items?.length || 0,
  });
});

app.get('/api/scan/incremental', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (scanState.running) {
    send({ type: 'start', resume: true, done: scanState.done, total: scanState.total });
    const interval = setInterval(() => {
      send({ type: 'progress', done: scanState.done, total: scanState.total });
      if (!scanState.running) {
        clearInterval(interval);
        if (mediaCache) send({ type: 'done', count: mediaCache.items.length, added: 0 });
        res.end();
      }
    }, 1000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  send({ type: 'start' });
  try {
    const result = await scanAndBuildIncremental(
      (done, total) => send({ type: 'progress', done, total })
    );
    send({ type: 'done', count: mediaCache.items.length, added: result.added, removed: result.removed });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

app.get('/api/scan', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // If a scan is already running, attach to it as a progress observer
  if (scanState.running) {
    send({ type: 'start', resume: true, done: scanState.done, total: scanState.total });
    // Poll scanState and stream progress until done
    const interval = setInterval(() => {
      send({ type: 'progress', done: scanState.done, total: scanState.total });
      if (!scanState.running) {
        clearInterval(interval);
        if (mediaCache) send({ type: 'done', count: mediaCache.items.length });
        res.end();
      }
    }, 1000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  mediaCache = null;
  send({ type: 'start' });
  try {
    await scanAndBuild((done, total) => send({ type: 'progress', done, total }));
    send({ type: 'done', count: mediaCache.items.length });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

app.get('/api/media', requireAuth, async (req, res) => {
  if (!mediaCache) { loadCache(); if (!mediaCache) return res.json({ ready: false }); }
  const items = mediaCache.items.map(({ id, type, rel, date, lat, lng, thumb, size }) =>
    ({ id, type, rel, date, lat, lng, thumb, size }));
  res.json({ ready: true, count: items.length, scannedAt: mediaCache.scannedAt, items });
});

app.get('/api/thumb/:id', requireAuth, (req, res) => {
  const thumbPath = path.join(THUMB_DIR, req.params.id + '.jpg');
  if (fs.existsSync(thumbPath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(thumbPath);
  } else {
    res.status(404).send('Not found');
  }
});

app.get('/api/file/:id', requireAuth, (req, res) => {
  if (!mediaCache) return res.status(404).send('Not scanned');
  const item = mediaCache.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).send('Not found');
  res.sendFile(item.path);
});

app.get('/api/status', requireAuth, (req, res) => {
  loadCache();
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
  res.json({
    photosDir: PHOTOS_DIR, exists: fs.existsSync(PHOTOS_DIR),
    cached: !!mediaCache, cachedCount: mediaCache?.items?.length || 0,
    scannedAt: mediaCache?.scannedAt || null,
    serverIPs: ips, port: PORT,
  });
});

// ── STATIC FRONTEND ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── TLS / START ───────────────────────────────────────────────────────────────

// Generate a self-signed cert using Node's built-in crypto (no openssl binary needed).
// Called once on first start; cert lives in DATA_DIR/certs and persists in the volume.
async function generateCert() {
  console.log('   Generating self-signed TLS certificate (first run)...');
  const { generateKeyPairSync, createSign } = crypto;

  // Generate RSA key pair
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  // Build a minimal self-signed X.509 cert using the forge-free approach:
  // spawn openssl if available, otherwise use the selfsigned npm package.
  // We try openssl first (always present in the Docker image), then fall back.
  const sans = [
    'DNS:localhost', 'DNS:photovault.local',
    'IP:127.0.0.1',
    // Common home/office subnet ranges
    ...[...Array(254)].map((_, i) => `IP:192.168.1.${i + 1}`),
    ...[...Array(60)].map((_, i)  => `IP:192.168.0.${i + 100}`),
    ...[...Array(10)].map((_, i)  => `IP:10.0.0.${i + 1}`),
    ...[...Array(5)].map((_, i)   => `IP:172.16.0.${i + 1}`),
  ].join(',');

  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', KEY_FILE,
    '-out',    CERT_FILE,
    '-days',   '3650',
    '-nodes',
    '-subj',   '/CN=PhotoVault/O=PhotoVault/C=US',
    '-addext', `subjectAltName=${sans}`,
  ], { timeout: 30000 });

  console.log('   Certificate generated (valid 10 years). Stored in data volume.');
}

async function startServer() {
  // Generate cert if not already present in the data volume
  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    try {
      await generateCert();
    } catch (e) {
      console.warn(`\n⚠  Could not generate TLS cert (${e.message})`);
      console.warn('   Falling back to HTTP. Install openssl to enable HTTPS.\n');
      http.createServer(app).listen(PORT, '0.0.0.0', () => printBanner('http'));
      return;
    }
  }

  const tlsOptions = {
    key:  fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  };
  https.createServer(tlsOptions, app).listen(PORT, '0.0.0.0', () => printBanner('https'));
}

function printBanner(scheme) {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);

  console.log(`\n📸 PhotoVault`);
  console.log(`   Protocol         : ${scheme.toUpperCase()}`);
  ips.forEach(ip => console.log(`   Local address    : ${scheme}://${ip}:${PORT}`));
  console.log(`   Photos directory : ${PHOTOS_DIR}`);
  console.log(`   Data directory   : ${DATA_DIR}`);
  console.log(`   Password         : set (${VAULT_PASSWORD.length} chars)`);
  if (scheme === 'https') {
    ips.forEach(ip => console.log(`   Cert install     : ${scheme}://${ip}:${PORT}/cert/install`));
    console.log(`   Cert location    : ${CERT_FILE}`);
  }
  if (mediaCache) console.log(`   Cache            : ${mediaCache.items.length} items loaded`);
  else console.log(`   Cache            : none -- tap "Scan Library" in the app`);
  console.log();
}

// Load cache before starting the server so the first /api/status request
// always returns the correct cached state rather than a false "not scanned".
loadCache();
startServer();
