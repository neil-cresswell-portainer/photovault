# PhotoVault

iOS Photos-style web app for your PC photo library. Access it from your iPhone (or any browser) over your local network or the internet. Runs as a Docker container with HTTPS and password protection.

---

## Quick start

### 1. Build the image

```bash
docker build -t photovault .
```

### 2. Run the container

**Linux:**
```bash
docker run -d \
  --name photovault \
  --restart unless-stopped \
  -p 3737:3737 \
  -e 'VAULT_PASSWORD=yourpassword' \
  -v /path/to/your/photos:/photos:ro \
  -v photovault_data:/app/data \
  photovault
```

**Windows PowerShell:**
```powershell
docker run -d `
  --name photovault `
  --restart unless-stopped `
  -p 3737:3737 `
  -e 'VAULT_PASSWORD=yourpassword' `
  -v "C:\Users\YourName\Pictures\iPhoneExport:/photos:ro" `
  -v photovault_data:/app/data `
  photovault
```

> **Password note:** always wrap `-e VAULT_PASSWORD=...` in single quotes. Double quotes cause the shell to interpret special characters like `$` and `!`, which will mangle the password before Docker sees it.

The named volume `photovault_data` persists everything that matters across container restarts and image rebuilds:
- `data/certs/` — TLS certificate, generated once on first run
- `data/cache.json` — media index
- `data/thumbs/` — generated thumbnails

### 3. First start

On the very first run, the server generates a self-signed TLS certificate and stores it in the data volume. This takes a few seconds. You will see this in the logs:

```
Generating self-signed TLS certificate (first run)...
Certificate generated (valid 10 years). Stored in data volume.
```

All subsequent starts reuse the same cert. You will never be prompted to regenerate or reinstall it unless you delete the data volume.

---

## First-time iPhone setup (do once)

The self-signed cert needs to be installed and trusted on your iPhone before Safari will show a clean padlock with no warnings.

1. Open `https://<your-server-ip>:3737/cert/install` in Safari on your iPhone
2. Tap **Download Certificate**
3. Go to **Settings → General → VPN & Device Management** and tap the PhotoVault profile, then tap **Install**
4. Go to **Settings → General → About → Certificate Trust Settings** and enable full trust for PhotoVault
5. Return to `https://<your-server-ip>:3737` — clean padlock, no warnings, permanently

**Add to Home Screen for a native app feel:**
- In Safari, tap the Share button → **Add to Home Screen**
- PhotoVault launches full-screen with no browser chrome, exactly like a native iOS app

---

## Using the app

### Scanning your library

On first connect, tap **Scan Library**. This walks your photos folder, reads EXIF metadata, and generates thumbnails. For a large library (10,000+ photos) this takes time — potentially 15–30 minutes depending on your hardware.

The scan runs entirely on the server. It is safe to lock your phone screen while it runs. If your connection drops, the scan continues in the background. When you reopen the app it will reconnect to the running scan automatically.

### Adding new photos

When you copy new photos into your photos folder, tap the menu icon and choose **Check for new photos**. This is the fast path — it only processes files not already in the index and skips thumbnail regeneration for existing photos. A summary appears when complete: "47 new items added / 10,051 total in library."

Use **Full rescan** only if you have deleted or moved photos and want the index to reflect those removals.

### Browsing

Photos are grouped and browsable by:
- **Years** — one section per calendar year
- **Months** — one section per month
- **Days** — one section per day (default view)
- **Places** — grouped by GPS location, reverse-geocoded to nearest city/town via OpenStreetMap

Use the **All / Photos / Videos** filter pills below the tab bar to narrow the view.

Use the **scrubber strip** on the right edge of the grid to jump to any year instantly. Touch and drag to scrub through the timeline.

Tap any photo or video to view full-screen. Swipe left/right to move between items.

---

## Security

- All API routes require a valid Bearer token (HMAC-SHA256, 30-day expiry)
- The login page loads without a token (required to show the password prompt), but no media is served unauthenticated
- Changing `VAULT_PASSWORD` and restarting immediately invalidates all existing sessions
- Tokens are stored in `localStorage` on the client — no cookies
- The TLS cert covers `localhost`, `127.0.0.1`, and the full `192.168.0.x` / `192.168.1.x` / `10.0.0.x` ranges, so it works on any typical home or office network without a new cert

**For internet access:** port-forward 3737 on your router to your server, or use Cloudflare Tunnel (free, no port forwarding needed, and it provides a real publicly-trusted certificate so no cert installation is needed on clients).

---

## Changing the password

Update `VAULT_PASSWORD` and recreate the container:

```bash
docker stop photovault && docker rm photovault
docker run -d ... -e 'VAULT_PASSWORD=newpassword' ...
```

All existing sessions are immediately invalidated. The data volume (thumbnails, cache, cert) is unaffected.

---

## Running without Docker

```bash
npm install

# Mac/Linux (server auto-generates cert via openssl if found):
VAULT_PASSWORD=yourpassword PHOTOS_DIR=/path/to/photos node server.js

# Windows PowerShell:
$env:VAULT_PASSWORD = 'yourpassword'
$env:PHOTOS_DIR = 'C:\Users\YourName\Pictures'
node server.js
```

If `openssl` is not on your PATH the server falls back to plain HTTP. To generate a cert manually:

```bash
mkdir -p data/certs
openssl req -x509 -newkey rsa:2048 \
  -keyout data/certs/key.pem -out data/certs/cert.pem \
  -days 3650 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
```

---

## Folder structure

```
photovault/
├── Dockerfile
├── server.js           ← Express + HTTPS backend
├── package.json
└── public/
    ├── index.html      ← PWA shell
    ├── app.js          ← React frontend
    ├── manifest.json   ← PWA manifest (home screen icon/name)
    ├── icon-192.png
    └── icon-512.png
```

**Runtime data** (all inside the `photovault_data` named volume at `/app/data`):

| Path | Contents |
|------|----------|
| `data/certs/cert.pem` | TLS certificate (generated once, reused forever) |
| `data/certs/key.pem` | TLS private key |
| `data/cache.json` | Media index (file paths, dates, GPS, thumbnail status) |
| `data/thumbs/` | Generated JPEG thumbnails (400×400) |

**Bind mounts:**

| Mount | Purpose |
|-------|---------|
| `/photos` | Your photos folder (read-only) |
