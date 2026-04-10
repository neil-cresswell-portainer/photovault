/* PhotoVault — iOS Photos experience with token auth */
(function () {
  'use strict';
  const { useState, useEffect, useRef, useCallback, useMemo } = React;
  const API = '';
  const TOKEN_KEY = 'photovault_token';

  // ── TOKEN STORE ───────────────────────────────────────────────────────────
  const TokenStore = {
    get:   () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set:   (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} },
    clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  // ── AUTHED FETCH ──────────────────────────────────────────────────────────
  function authFetch(url, opts = {}) {
    const token = TokenStore.get();
    return fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), 'Authorization': `Bearer ${token}` },
    });
  }

  // Thumbnail URL -- uses query-string token so <img src> works directly
  // (browser handles its own lazy loading + caching, no JS blob overhead)
  function thumbUrl(id) {
    return `${API}/api/thumb/${id}?_t=${encodeURIComponent(TokenStore.get() || '')}`;
  }
  function fileUrl(id) {
    return `${API}/api/file/${id}?_t=${encodeURIComponent(TokenStore.get() || '')}`;
  }

  // ── CONCURRENCY-LIMITED THUMBNAIL LOADER ────────────────────────────────
  // Keeps at most MAX_CONCURRENT image loads in-flight at once.
  // Thumbnails are only requested when they enter the viewport (IntersectionObserver).
  // Over a slow remote connection this prevents the connection from being saturated
  // by hundreds of simultaneous requests, which also blocks UI interactions.
  const MAX_CONCURRENT = 6;
  let activeLoads  = 0;
  const thumbQueue = []; // { el, src, resolve }

  function drainThumbQueue() {
    while (activeLoads < MAX_CONCURRENT && thumbQueue.length > 0) {
      const { el, src, resolve } = thumbQueue.shift();
      if (!el.isConnected) { resolve(false); continue; } // element left DOM while queued
      activeLoads++;
      el.onload = el.onerror = () => { activeLoads--; resolve(true); drainThumbQueue(); };
      el.src = src;
    }
  }

  function queueThumb(el, src) {
    return new Promise(resolve => {
      thumbQueue.push({ el, src, resolve });
      drainThumbQueue();
    });
  }

  // ── REVERSE GEOCODING ─────────────────────────────────────────────────────
  // Nominatim (OpenStreetMap) -- free, no API key, 1 req/sec rate limit.
  // Results cached in sessionStorage so we only geocode once per session.
  const GEO_CACHE_KEY = 'photovault_geo';
  function geoCache() {
    try { return JSON.parse(sessionStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch { return {}; }
  }
  function geoCacheSet(key, val) {
    try {
      const c = geoCache(); c[key] = val;
      sessionStorage.setItem(GEO_CACHE_KEY, JSON.stringify(c));
    } catch {}
  }

  // Queue-based geocoder: max 1 req/sec to respect Nominatim policy
  const geoQueue = [];
  let geoTimer = null;
  function geocode(lat, lng) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const cached = geoCache()[key];
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve) => {
      geoQueue.push({ lat, lng, key, resolve });
      if (!geoTimer) {
        geoTimer = setInterval(() => {
          if (!geoQueue.length) { clearInterval(geoTimer); geoTimer = null; return; }
          const { lat, lng, key, resolve } = geoQueue.shift();
          fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`, {
            headers: { 'Accept-Language': 'en', 'User-Agent': 'PhotoVault/1.0' }
          })
            .then(r => r.json())
            .then(d => {
              const a = d.address || {};
              // Build a readable place name: prefer city/town/village, then county, then country
              const place = a.city || a.town || a.village || a.municipality
                         || a.county || a.state_district || a.state || a.country || key;
              const label = a.country && place !== a.country ? `${place}, ${a.country}` : place;
              geoCacheSet(key, label);
              resolve(label);
            })
            .catch(() => { geoCacheSet(key, key); resolve(key); });
        }, 1100); // 1.1s between requests
      }
    });
  }

  // ── UTILITIES ─────────────────────────────────────────────────────────────
  const fmt = {
    date:  (ts) => new Date(ts).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    month: (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    year:  (ts) => new Date(ts).getFullYear().toString(),
    time:  (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    size:  (b)  => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB',
  };

  function groupBy(items, keyFn) {
    const groups = {};
    for (const item of items) {
      const key = keyFn(item);
      if (!groups[key]) groups[key] = { label: key, ts: item.date, items: [] };
      groups[key].items.push(item);
    }
    return Object.values(groups).sort((a, b) => a.ts - b.ts);
  }

  function buildLocationClusters(items) {
    const withLoc  = items.filter(i => i.lat && i.lng);
    const noLoc    = items.filter(i => !i.lat || !i.lng);
    if (!withLoc.length) return [{ lat: null, lng: null, ts: 0, items }];

    const clusters = [];
    const used = new Set();
    for (let i = 0; i < withLoc.length; i++) {
      if (used.has(i)) continue;
      const cluster = [withLoc[i]]; used.add(i);
      for (let j = i + 1; j < withLoc.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(withLoc[i].lat - withLoc[j].lat) < 0.5 &&
            Math.abs(withLoc[i].lng - withLoc[j].lng) < 0.5) {
          cluster.push(withLoc[j]); used.add(j);
        }
      }
      const clat = cluster.reduce((s, x) => s + x.lat, 0) / cluster.length;
      const clng = cluster.reduce((s, x) => s + x.lng, 0) / cluster.length;
      clusters.push({
        lat: clat, lng: clng,
        ts: Math.min(...cluster.map(x => x.date)),
        items: cluster,
        label: `${clat.toFixed(2)}°, ${clng.toFixed(2)}°`, // placeholder until geocoded
      });
    }
    if (noLoc.length) clusters.push({ lat: null, lng: null, ts: Infinity, label: 'No Location', items: noLoc });
    return clusters.sort((a, b) => a.ts - b.ts);
  }

  // ── LOCK SCREEN ───────────────────────────────────────────────────────────
  function LockScreen({ onUnlock }) {
    const [password, setPassword] = useState('');
    const [error, setError]       = useState('');
    const [loading, setLoading]   = useState(false);
    const [shake, setShake]       = useState(false);
    const inputRef = useRef(null);

    useEffect(() => { setTimeout(() => inputRef.current?.focus(), 300); }, []);

    const submit = async () => {
      if (!password || loading) return;
      setLoading(true); setError('');
      try {
        const r = await fetch(`${API}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const d = await r.json();
        if (r.ok && d.token) { TokenStore.set(d.token); onUnlock(); }
        else {
          setError(d.error || 'Incorrect password');
          setPassword(''); setShake(true);
          setTimeout(() => setShake(false), 600);
        }
      } catch { setError('Cannot reach server'); }
      setLoading(false);
    };

    return React.createElement('div', {
      style: {
        position: 'fixed', inset: 0,
        background: 'linear-gradient(160deg, #0a0a0a 0%, #111 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '0 40px',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }
    },
      React.createElement('div', {
        style: {
          width: 80, height: 80, borderRadius: 20, fontSize: 36, marginBottom: 28,
          background: 'linear-gradient(145deg, #1a1a2e, #16213e)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.08)',
        }
      }, '📸'),
      React.createElement('h1', { style: { color: '#fff', fontSize: 26, fontWeight: 700, marginBottom: 6, letterSpacing: -0.5 } }, 'PhotoVault'),
      React.createElement('p', { style: { color: '#636366', fontSize: 15, marginBottom: 36, textAlign: 'center' } },
        'Enter your password to access your library'),
      React.createElement('div', {
        style: { width: '100%', maxWidth: 320, animation: shake ? 'shake 0.5s ease' : 'none' }
      },
        React.createElement('input', {
          ref: inputRef, type: 'password', placeholder: 'Password', value: password,
          onChange: (e) => { setPassword(e.target.value); setError(''); },
          onKeyDown: (e) => e.key === 'Enter' && submit(),
          autoComplete: 'current-password',
          style: {
            width: '100%', padding: '15px 18px',
            background: 'rgba(255,255,255,0.07)',
            border: error ? '1px solid #ff453a' : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 14, color: '#fff', fontSize: 17, outline: 'none',
            letterSpacing: 2, WebkitAppearance: 'none',
          }
        }),
        error && React.createElement('p', { style: { color: '#ff453a', fontSize: 13, marginTop: 8, textAlign: 'center' } }, error),
        React.createElement('button', {
          onClick: submit, disabled: !password || loading,
          style: {
            width: '100%', marginTop: 12, padding: '15px 0',
            background: password && !loading ? '#1c6ef5' : 'rgba(255,255,255,0.1)',
            border: 'none', borderRadius: 14,
            color: password && !loading ? '#fff' : '#48484a',
            fontSize: 17, fontWeight: 600, WebkitAppearance: 'none',
            cursor: password ? 'pointer' : 'default', transition: 'background 0.2s',
          }
        }, loading ? 'Verifying...' : 'Unlock')
      )
    );
  }

  // ── THUMB ─────────────────────────────────────────────────────────────────
  // IntersectionObserver triggers load only when thumbnail scrolls into view.
  // Actual fetch is queued through the concurrency limiter above.
  function Thumb({ item, onPress, cols }) {
    const [loaded, setLoaded] = useState(false);
    const [error, setError]   = useState(false);
    const imgRef  = useRef(null);
    const size    = `calc(${100 / cols}vw - 1px)`;

    useEffect(() => {
      if (!item.thumb || !imgRef.current) return;
      const img = imgRef.current;
      const src = thumbUrl(item.id);

      // If already cached by browser, it will fire load immediately
      if (img.complete && img.naturalWidth) { setLoaded(true); return; }

      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries[0].isIntersecting) return;
          observer.disconnect();
          queueThumb(img, src).then(() => {
            if (img.naturalWidth) setLoaded(true);
            else setError(true);
          });
        },
        { rootMargin: '300px' } // start loading 300px before entering viewport
      );
      observer.observe(img);
      return () => observer.disconnect();
    }, [item.id]);

    return React.createElement('div', {
      style: {
        width: size, height: size, flexShrink: 0, position: 'relative',
        background: '#1c1c1e', cursor: 'pointer', overflow: 'hidden',
      },
      onClick: () => onPress(item),
    },
      item.thumb && !error
        ? React.createElement('img', {
            ref: imgRef,
            decoding: 'async',
            style: {
              width: '100%', height: '100%', objectFit: 'cover', display: 'block',
              opacity: loaded ? 1 : 0, transition: 'opacity 0.25s',
            }
          })
        : React.createElement('div', {
            style: {
              width: '100%', height: '100%', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#3a3a3c', fontSize: 24,
            }
          }, item.type === 'video' ? '▶' : '■'),
      // shimmer while loading
      item.thumb && !loaded && !error && React.createElement('div', {
        style: { position: 'absolute', inset: 0, background: '#2c2c2e', pointerEvents: 'none' }
      }),
      // video badge
      item.type === 'video' && React.createElement('div', {
        style: {
          position: 'absolute', bottom: 4, left: 6, fontSize: 11, fontWeight: 700,
          color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.9)', pointerEvents: 'none',
        }
      }, '▶')
    );
  }

  // ── VIEWER ────────────────────────────────────────────────────────────────
  function Viewer({ item, items, onClose }) {
    const [idx, setIdx]       = useState(items.findIndex(i => i.id === item.id));
    const touchStart           = useRef(null);
    const current              = items[idx];

    const prev = () => setIdx(i => Math.max(0, i - 1));
    const next = () => setIdx(i => Math.min(items.length - 1, i + 1));

    const onTouchStart = (e) => { touchStart.current = e.touches[0].clientX; };
    const onTouchEnd   = (e) => {
      if (!touchStart.current) return;
      const dx = e.changedTouches[0].clientX - touchStart.current;
      if (Math.abs(dx) > 50) dx < 0 ? next() : prev();
      touchStart.current = null;
    };

    return React.createElement('div', {
      style: {
        position: 'fixed', inset: 0, background: '#000', zIndex: 1000,
        display: 'flex', flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      },
      onTouchStart, onTouchEnd,
    },
      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px' }
      },
        React.createElement('button', {
          onClick: onClose,
          style: { background: 'none', border: 'none', color: '#fff', fontSize: 17, cursor: 'pointer', padding: '4px 0' }
        }, '‹ Back'),
        React.createElement('span', { style: { color: '#8e8e93', fontSize: 13 } }, `${idx + 1} / ${items.length}`),
        React.createElement('div', { style: { width: 60 } })
      ),
      React.createElement('div', {
        style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
      },
        current.type === 'image'
          ? React.createElement('img', {
              key: current.id,
              src: fileUrl(current.id),
              style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
            })
          : React.createElement('video', {
              key: current.id,
              src: fileUrl(current.id),
              controls: true, playsInline: true, autoPlay: true,
              style: { maxWidth: '100%', maxHeight: '100%' }
            })
      ),
      React.createElement('div', { style: { padding: '12px 20px', borderTop: '1px solid #1c1c1e' } },
        React.createElement('div', { style: { color: '#fff', fontSize: 15, fontWeight: 500 } }, fmt.date(current.date)),
        React.createElement('div', { style: { color: '#8e8e93', fontSize: 13, marginTop: 2 } },
          fmt.time(current.date) + ' · ' + fmt.size(current.size)),
        current.lat && React.createElement('div', { style: { color: '#8e8e93', fontSize: 13, marginTop: 2 } },
          `📍 ${current.lat.toFixed(4)}, ${current.lng.toFixed(4)}`)
      )
    );
  }

  // ── SCAN SCREEN ───────────────────────────────────────────────────────────
  function ScanScreen({ onDone, onLogout }) {
    const [status, setStatus]         = useState('idle');
    const [progress, setProgress]     = useState({ done: 0, total: 0 });
    const [dots, setDots]             = useState(0);
    const [error, setError]           = useState(null);
    const [serverInfo, setServerInfo] = useState(null);
    // shouldConnect: set to true to trigger the fetch effect AFTER the
    // component has committed a render showing the progress UI.
    const [shouldConnect, setShouldConnect] = useState(false);
    const [scanMode, setScanMode]           = useState('full'); // 'full' | 'incremental'
    const [toast, setToast]                 = useState(null);   // { added, total }
    const controllerRef = useRef(null);

    // Animate the "Indexing..." dots independently of the fetch state
    useEffect(() => {
      if (status !== 'scanning') return;
      const t = setInterval(() => setDots(d => (d + 1) % 4), 500);
      return () => clearInterval(t);
    }, [status]);

    // Fetch server info + check for an already-running scan on mount
    useEffect(() => {
      authFetch(`${API}/api/status`).then(r => r.json()).then(setServerInfo).catch(() => {});
      authFetch(`${API}/api/scan/status`).then(r => r.json()).then(d => {
        if (d.running) {
          setProgress({ done: d.done, total: d.total });
          setStatus('scanning');
          setShouldConnect(true); // triggers the connect effect below
        }
      }).catch(() => {});
      return () => controllerRef.current?.abort();
    }, []);

    // This effect fires AFTER React has painted the scanning UI,
    // preventing the blank-screen race where onDone() fires before first render.
    useEffect(() => {
      if (!shouldConnect) return;
      setShouldConnect(false);

      const controller = new AbortController();
      controllerRef.current = controller;
      const endpoint = scanMode === 'incremental' ? '/api/scan/incremental' : '/api/scan';

      fetch(`${API}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${TokenStore.get()}` },
        signal: controller.signal,
      }).then(async res => {
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const d = JSON.parse(line.slice(6));
              if (d.type === 'start')    setProgress({ done: d.done || 0, total: d.total || 0 });
              if (d.type === 'progress') setProgress({ done: d.done, total: d.total });
              if (d.type === 'done') {
                if (scanMode === 'incremental') {
                  // Show toast then go to library
                  setToast({ added: d.added || 0, total: d.count || 0 });
                  setTimeout(() => { setToast(null); onDone(); }, 3000);
                } else {
                  onDone();
                }
              }
              if (d.type === 'error')  { setError(d.message); setStatus('error'); }
            } catch {}
          }
        }
      }).catch(e => {
        if (e.name === 'AbortError') return;
        setError('Connection lost. The scan continues on the server — tap Reconnect to re-attach.');
        setStatus('error');
      });
    }, [shouldConnect]);

    // Button handlers
    const startScan = (mode = 'full') => {
      setError(null);
      setProgress({ done: 0, total: 0 });
      setScanMode(mode);
      setStatus('scanning');
      setShouldConnect(true);
    };

    const pct = progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;

    return React.createElement('div', {
      style: {
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 32,
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }
    },
      React.createElement('div', { style: { fontSize: 56, marginBottom: 20 } }, '📸'),
      React.createElement('h1', { style: { fontSize: 24, fontWeight: 700, color: '#fff', marginBottom: 6 } }, 'PhotoVault'),
      serverInfo && React.createElement('p', {
        style: { fontSize: 12, color: '#3a3a3c', marginBottom: 4, textAlign: 'center', wordBreak: 'break-all', maxWidth: 300 }
      }, serverInfo.photosDir),
      serverInfo && !serverInfo.exists && React.createElement('p', {
        style: { fontSize: 13, color: '#ff453a', marginBottom: 16 }
      }, '⚠ Folder not found. Check PHOTOS_DIR.'),

      // Toast notification after incremental scan
      toast && React.createElement('div', {
        style: {
          width: '100%', maxWidth: 280, padding: '14px 16px',
          background: '#1c1c1e', borderRadius: 14, marginBottom: 12,
          textAlign: 'center', border: '1px solid #2c2c2e',
        }
      },
        React.createElement('div', { style: { color: '#fff', fontSize: 16, fontWeight: 600, marginBottom: 2 } },
          toast.added === 0 ? 'Already up to date' : `${toast.added.toLocaleString()} new item${toast.added === 1 ? '' : 's'} added`
        ),
        React.createElement('div', { style: { color: '#48484a', fontSize: 13 } },
          `${toast.total.toLocaleString()} total in library`)
      ),

      serverInfo?.cached && status === 'idle' && React.createElement('button', {
        onClick: onDone,
        style: {
          width: '100%', maxWidth: 280, padding: '14px 0',
          background: '#1c6ef5', borderRadius: 14, border: 'none',
          color: '#fff', fontSize: 17, fontWeight: 600, cursor: 'pointer', marginBottom: 10,
        }
      }, `View Library (${serverInfo.cachedCount.toLocaleString()} items)`),

      serverInfo?.cached && status === 'idle' && React.createElement('button', {
        onClick: () => startScan('incremental'),
        style: {
          width: '100%', maxWidth: 280, padding: '14px 0',
          background: '#2c2c2e', borderRadius: 14, border: 'none',
          color: '#30d158', fontSize: 17, fontWeight: 600, cursor: 'pointer', marginBottom: 10,
        }
      }, '＋ Check for new photos'),

      status === 'idle' && React.createElement('button', {
        onClick: () => startScan('full'),
        style: {
          width: '100%', maxWidth: 280, padding: '14px 0',
          background: serverInfo?.cached ? '#1c1c1e' : '#1c6ef5',
          borderRadius: 14, border: '1px solid #3a3a3c',
          color: serverInfo?.cached ? '#636366' : '#fff',
          fontSize: 15, fontWeight: 500, cursor: 'pointer',
        }
      }, serverInfo?.cached ? 'Full rescan (slow)' : 'Scan Library'),

      status === 'scanning' && React.createElement('div', { style: { width: '100%', maxWidth: 280 } },
        React.createElement('div', { style: { color: '#8e8e93', fontSize: 14, textAlign: 'center', marginBottom: 10 } },
          progress.total
            ? (scanMode === 'incremental' ? 'Checking new files' : 'Indexing') + ` ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} (${pct}%)`
            : (scanMode === 'incremental' ? 'Checking for new files' : 'Indexing') + `${'.'.repeat(dots)}`
        ),
        React.createElement('div', { style: { height: 4, background: '#2c2c2e', borderRadius: 2, overflow: 'hidden' } },
          React.createElement('div', {
            style: {
              height: '100%', background: '#1c6ef5', borderRadius: 2,
              width: progress.total ? `${pct}%` : '40%',
              transition: 'width 0.4s ease',
            }
          })
        ),
        React.createElement('p', {
          style: { color: '#3a3a3c', fontSize: 12, textAlign: 'center', marginTop: 12 }
        }, 'Scan runs on the server — safe to lock your screen')
      ),

      status === 'error' && React.createElement('div', { style: { width: '100%', maxWidth: 280 } },
        React.createElement('p', { style: { color: '#ff453a', fontSize: 13, textAlign: 'center', marginBottom: 12 } }, error),
        React.createElement('button', {
          onClick: () => { setStatus('scanning'); setShouldConnect(true); },
          style: {
            width: '100%', padding: '14px 0', background: '#2c2c2e',
            borderRadius: 14, border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer',
          }
        }, 'Reconnect')
      ),

      React.createElement('button', {
        onClick: onLogout,
        style: { marginTop: 32, background: 'none', border: 'none', color: '#3a3a3c', fontSize: 14, cursor: 'pointer' }
      }, 'Sign out')
    );
  }

  // ── PLACES VIEW ───────────────────────────────────────────────────────────
  // Collapsible location rows. Tap a location to expand/collapse its photos.
  function PlacesView({ media, onItemPress }) {
    const [clusters, setClusters] = useState(() => buildLocationClusters(media));
    const [expanded, setExpanded] = useState(new Set());

    useEffect(() => {
      let cancelled = false;
      clusters.forEach((cluster, idx) => {
        if (!cluster.lat || !cluster.lng) return;
        geocode(cluster.lat, cluster.lng).then(label => {
          if (cancelled) return;
          setClusters(prev => prev.map((c, i) => i === idx ? { ...c, label } : c));
        });
      });
      return () => { cancelled = true; };
    }, []);

    const toggle = (key) => setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

    return React.createElement('div', { style: { paddingBottom: 'env(safe-area-inset-bottom)' } },
      clusters.map(cluster => {
        const key  = cluster.label + cluster.ts;
        const open = expanded.has(key);
        return React.createElement('div', { key },
          // Location row header -- tap to toggle
          React.createElement('div', {
            onClick: () => toggle(key),
            style: {
              padding: '14px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
              cursor: 'pointer',
              borderBottom: '1px solid #1c1c1e',
              userSelect: 'none',
            }
          },
            // Cover thumb
            cluster.items[0] && React.createElement('div', {
              style: {
                width: 52, height: 52, borderRadius: 8, overflow: 'hidden',
                flexShrink: 0, background: '#2c2c2e',
              }
            },
              React.createElement('img', {
                src: thumbUrl(cluster.items[0].id),
                loading: 'lazy',
                style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
              })
            ),
            // Label + count
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
              React.createElement('div', {
                style: { color: '#fff', fontSize: 16, fontWeight: 600,
                         overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
              },
                (cluster.lat ? '📍 ' : '') + cluster.label
              ),
              React.createElement('div', { style: { color: '#48484a', fontSize: 13, marginTop: 2 } },
                cluster.items.length.toLocaleString() + ' item' + (cluster.items.length === 1 ? '' : 's')
              )
            ),
            // Chevron
            React.createElement('div', {
              style: {
                color: '#48484a', fontSize: 14, fontWeight: 600,
                transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
                flexShrink: 0,
              }
            }, '›')
          ),
          // Expandable photo grid
          open && React.createElement('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: '1px', marginBottom: 1 }
          },
            cluster.items.map(item =>
              React.createElement(Thumb, { key: item.id, item, onPress: onItemPress, cols: 3 })
            )
          )
        );
      })
    );
  }

  // ── SCRUBBER ──────────────────────────────────────────────────────────────
  // iOS-style right-edge scrub strip. Touch and drag to jump instantly.
  function Scrubber({ groups, scrollRef, tab }) {
    const [active, setActive]     = useState(false);
    const [label, setLabel]       = useState('');
    const [labelY, setLabelY]     = useState(50);
    const stripRef                = useRef(null);

    // Build scrubber marks: for days tab show years only (less crowded),
    // for months tab show year markers, for years tab show every year.
    const marks = useMemo(() => {
      if (!groups.length) return [];
      if (tab === 'years' || tab === 'months') {
        return groups.map(g => ({ id: g.label, label: g.label.slice(-4) || g.label }));
      }
      // days: one mark per unique year, positioned at first group of that year
      const seen = new Set();
      return groups
        .filter(g => { const y = new Date(g.ts).getFullYear().toString(); if (seen.has(y)) return false; seen.add(y); return true; })
        .map(g => ({ id: g.label, label: new Date(g.ts).getFullYear().toString() }));
    }, [groups, tab]);

    const scrollToGroup = useCallback((clientY) => {
      const strip = stripRef.current;
      const scroll = scrollRef.current;
      if (!strip || !scroll || !marks.length) return;

      const rect   = strip.getBoundingClientRect();
      const pct    = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const idx    = Math.min(marks.length - 1, Math.floor(pct * marks.length));
      const mark   = marks[idx];

      // Find the DOM section and scroll it into view
      const el = scroll.querySelector(`[data-group-id="${CSS.escape(mark.id)}"]`);
      if (el) el.scrollIntoView({ block: 'start' });

      // Position the floating label at touch point (clamped within strip)
      const labelPct = ((idx + 0.5) / marks.length) * 100;
      setLabel(mark.label);
      setLabelY(labelPct);
    }, [marks, scrollRef]);

    const onTouch = useCallback((e) => {
      e.preventDefault(); // prevent scroll passthrough
      setActive(true);
      scrollToGroup(e.touches[0].clientY);
    }, [scrollToGroup]);

    const onTouchMove = useCallback((e) => {
      e.preventDefault();
      scrollToGroup(e.touches[0].clientY);
    }, [scrollToGroup]);

    const onTouchEnd = useCallback(() => {
      setActive(false);
    }, []);

    if (marks.length < 2) return null;

    return React.createElement('div', {
      style: {
        position: 'absolute', right: 0, top: 0, bottom: 0,
        width: 28, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'space-around',
        zIndex: 10, paddingTop: 8, paddingBottom: 8,
        // touch-action none so we get raw touch events
      },
      ref: stripRef,
      onTouchStart: onTouch,
      onTouchMove: onTouchMove,
      onTouchEnd: onTouchEnd,
    },
      // Floating label bubble -- appears while scrubbing
      active && React.createElement('div', {
        style: {
          position: 'absolute',
          top: `${labelY}%`,
          right: 32,
          transform: 'translateY(-50%)',
          background: 'rgba(60,60,67,0.95)',
          color: '#fff',
          fontSize: 15,
          fontWeight: 700,
          padding: '6px 14px',
          borderRadius: 10,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 20,
          boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
        }
      }, label),

      // Year marks along the strip
      marks.map((mark, i) =>
        React.createElement('div', {
          key: mark.id,
          style: {
            fontSize: 9,
            fontWeight: 600,
            color: active ? '#1c6ef5' : 'rgba(255,255,255,0.35)',
            lineHeight: 1,
            userSelect: 'none',
            letterSpacing: -0.3,
            transition: 'color 0.15s',
          }
        }, mark.label)
      )
    );
  }

  // ── SUMMARY VIEW (Years / Months) ────────────────────────────────────────
  // Shows one cover card per group. Tap to drill into that group's full grid.
  // parentLabel + onBack are supplied when shown as level-1 (months within a year).
  function SummaryView({ groups, onDrillDown, parentLabel, onBack }) {
    const COLS = 2;
    return React.createElement('div', { style: { paddingBottom: 'env(safe-area-inset-bottom)', padding: '8px 2px' } },
      // Back button when showing months-within-a-year
      parentLabel && React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px 10px', cursor: 'pointer' },
        onClick: onBack,
      },
        React.createElement('span', { style: { color: '#1c6ef5', fontSize: 17 } }, '‹'),
        React.createElement('span', { style: { color: '#1c6ef5', fontSize: 16 } }, parentLabel)
      ),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '2px' } },
        groups.map(group => {
          const cover = group.items[0];
          const w = `calc(${100 / COLS}% - 1px)`;
          return React.createElement('div', {
            key: group.label,
            onClick: () => onDrillDown(group),
            style: {
              width: w, position: 'relative', cursor: 'pointer',
              aspectRatio: '1 / 1', overflow: 'hidden', background: '#1c1c1e',
            }
          },
            cover && React.createElement('img', {
              src: thumbUrl(cover.id),
              loading: 'lazy',
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
            }),
            // Gradient overlay + label
            React.createElement('div', {
              style: {
                position: 'absolute', inset: 0,
                background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 50%)',
                pointerEvents: 'none',
              }
            }),
            React.createElement('div', {
              style: {
                position: 'absolute', bottom: 10, left: 12, right: 12,
                pointerEvents: 'none',
              }
            },
              React.createElement('div', {
                style: { color: '#fff', fontSize: 17, fontWeight: 700, lineHeight: 1.2 }
              }, group.label),
              React.createElement('div', {
                style: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 }
              }, group.items.length.toLocaleString() + ' items')
            )
          );
        })
      )
    );
  }

  // ── GRID VIEW (Days — full flat grid) ─────────────────────────────────────
  function GridView({ groups, onItemPress, drillLabel, onBack }) {
    return React.createElement('div', { style: { paddingBottom: 'env(safe-area-inset-bottom)' } },
      // Back button shown when drilled into a specific month/year
      drillLabel && React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '10px 16px 4px', cursor: 'pointer',
        },
        onClick: onBack,
      },
        React.createElement('span', { style: { color: '#1c6ef5', fontSize: 17 } }, '‹'),
        React.createElement('span', { style: { color: '#1c6ef5', fontSize: 16 } }, drillLabel)
      ),
      groups.map(group =>
        React.createElement('div', { key: group.label, 'data-group-id': group.label },
          React.createElement('div', {
            style: { padding: '12px 16px 6px', fontSize: 15, fontWeight: 600, color: '#8e8e93' }
          }, group.label),
          React.createElement('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: '1px' }
          },
            group.items.map(item =>
              React.createElement(Thumb, { key: item.id, item, onPress: onItemPress, cols: 3 })
            )
          )
        )
      )
    );
  }

  // ── MAIN APP ──────────────────────────────────────────────────────────────
  function App() {
    const [authState, setAuthState] = useState('checking');
    const [screen, setScreen]       = useState('scan');
    const [media, setMedia]         = useState([]);
    const [viewItem, setViewItem]   = useState(null);
    const [tab, setTab]             = useState('years');
    const [filter, setFilter]       = useState('all'); // all | photos | videos
    const [drillGroup, setDrillGroup]   = useState(null); // year group drilled into
    const [drillMonth, setDrillMonth]   = useState(null); // month group drilled into (second level)
    const scrollRef    = useRef(null);
    const savedScrollY  = useRef(0);  // persists scroll position across viewer open/close

    useEffect(() => {
      const token = TokenStore.get();
      if (!token) { setAuthState('locked'); return; }
      fetch(`${API}/api/status`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => {
          if (r.status === 401) { TokenStore.clear(); setAuthState('locked'); }
          else setAuthState('unlocked');
        })
        .catch(() => { setAuthState(token ? 'unlocked' : 'locked'); });
    }, []);

    const onUnlock  = useCallback(() => setAuthState('unlocked'), []);
    const onLogout  = useCallback(() => {
      TokenStore.clear(); setMedia([]); setScreen('scan'); setAuthState('locked');
    }, []);

    const loadMedia = useCallback(async () => {
      try {
        const r = await authFetch(`${API}/api/media`);
        if (r.status === 401) { onLogout(); return; }
        const d = await r.json();
        if (d.ready) { setMedia(d.items); setScreen('library'); }
        else setScreen('scan');
      } catch { setScreen('scan'); }
    }, []);

    useEffect(() => { if (authState === 'unlocked') loadMedia(); }, [authState]);

    const filteredMedia = useMemo(() => {
      if (filter === 'photos') return media.filter(i => i.type === 'image');
      if (filter === 'videos') return media.filter(i => i.type === 'video');
      return media;
    }, [media, filter]);

    const groups = useMemo(() => {
      if (!filteredMedia.length) return [];
      if (tab === 'years')  return groupBy(filteredMedia, i => fmt.year(i.date));
      if (tab === 'months') return groupBy(filteredMedia, i => fmt.month(i.date));
      // Days: newest first (reverse sort) so scrolling starts at most recent
      if (tab === 'days') return groupBy(filteredMedia, i => fmt.date(i.date)).reverse();
      // places handled by PlacesView separately
      return groupBy(filteredMedia, i => fmt.date(i.date));
    }, [filteredMedia, tab]);

    // Level 1 drill: year → months-within-that-year summary
    const drilledMonths = useMemo(() => {
      if (!drillGroup) return null;
      return groupBy(drillGroup.items, i => fmt.month(i.date));
    }, [drillGroup]);

    // Level 2 drill: month → days-within-that-month grid (newest first)
    const drilledDays = useMemo(() => {
      if (!drillMonth) return null;
      return groupBy(drillMonth.items, i => fmt.date(i.date)).reverse();
    }, [drillMonth]);

    const allItems = useMemo(() => {
      if (tab === 'places') return filteredMedia;
      if (drilledDays)   return drilledDays.flatMap(g => g.items);
      if (drilledMonths) return drilledMonths.flatMap(g => g.items);
      return groups.flatMap(g => g.items);
    }, [groups, drilledMonths, drilledDays, tab, filteredMedia]);

    const openItem = useCallback((item) => {
      // Save current scroll position before entering viewer
      savedScrollY.current = scrollRef.current?.scrollTop || 0;
      setViewItem(item);
      setScreen('viewer');
    }, []);

    // Reset scroll + drill state when filter or tab changes
    useEffect(() => { scrollRef.current?.scrollTo(0, 0); setDrillGroup(null); setDrillMonth(null); }, [filter, tab]);

    // Restore scroll position when returning from viewer
    useEffect(() => {
      if (screen === 'library' && savedScrollY.current > 0) {
        // requestAnimationFrame ensures the scroll container has rendered and has height
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: savedScrollY.current, behavior: 'instant' });
        });
      }
    }, [screen]);

    if (authState === 'checking') {
      return React.createElement('div', {
        style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }
      }, React.createElement('div', { style: { color: '#3a3a3c', fontSize: 28 } }, '⬛'));
    }
    if (authState === 'locked') return React.createElement(LockScreen, { onUnlock });
    if (screen === 'viewer' && viewItem) {
      return React.createElement(Viewer, {
        item: viewItem, items: allItems,
        onClose: () => { setViewItem(null); setScreen('library'); },
      });
    }
    if (screen === 'scan') return React.createElement(ScanScreen, { onDone: loadMedia, onLogout });

    // Library
    return React.createElement('div', {
      style: { height: '100%', display: 'flex', flexDirection: 'column', background: '#000' }
    },
      React.createElement('div', { style: { height: 'env(safe-area-inset-top)', background: '#000' } }),

      React.createElement('div', {
        style: { padding: '8px 16px 0', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }
      },
        React.createElement('h1', { style: { fontSize: 32, fontWeight: 800, color: '#fff', letterSpacing: -0.5 } }, 'Photos'),
        React.createElement('button', {
          onClick: onLogout,
          style: { background: 'none', border: 'none', color: '#636366', fontSize: 14, cursor: 'pointer', paddingBottom: 2 }
        }, 'Lock')
      ),

      React.createElement('div', { style: { display: 'flex', borderBottom: '1px solid #1c1c1e', marginTop: 6 } },
        ['years', 'months', 'days', 'places'].map(t =>
          React.createElement('button', {
            key: t,
            onClick: () => { setTab(t); scrollRef.current?.scrollTo(0, 0); },
            style: {
              flex: 1, padding: '10px 0', background: 'none', border: 'none',
              borderBottom: tab === t ? '2px solid #1c6ef5' : '2px solid transparent',
              color: tab === t ? '#fff' : '#48484a',
              fontSize: 13, fontWeight: tab === t ? 600 : 400,
              cursor: 'pointer', textTransform: 'capitalize', transition: 'color 0.15s',
            }
          }, t)
        )
      ),

      React.createElement('div', {
        style: { display: 'flex', gap: 8, padding: '8px 16px 6px', background: '#000' }
      },
        ['all', 'photos', 'videos'].map(f =>
          React.createElement('button', {
            key: f,
            onClick: () => setFilter(f),
            style: {
              padding: '5px 14px',
              borderRadius: 20,
              border: 'none',
              background: filter === f ? '#fff' : 'rgba(255,255,255,0.1)',
              color: filter === f ? '#000' : '#8e8e93',
              fontSize: 13,
              fontWeight: filter === f ? 600 : 400,
              cursor: 'pointer',
              textTransform: 'capitalize',
              transition: 'background 0.15s, color 0.15s',
            }
          },
            f === 'all'
              ? `All (${media.length.toLocaleString()})`
              : f === 'photos'
                ? `Photos (${media.filter(i => i.type === 'image').length.toLocaleString()})`
                : `Videos (${media.filter(i => i.type === 'video').length.toLocaleString()})`
          )
        )
      ),

      React.createElement('div', {
        style: { flex: 1, position: 'relative', overflow: 'hidden' }
      },
        React.createElement('div', {
          ref: scrollRef,
          style: { height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }
        },
          media.length === 0
            ? React.createElement('div', {
                style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: '#48484a', fontSize: 16 }
              }, 'No media found')
            : tab === 'places'
              ? React.createElement(PlacesView, { media: filteredMedia, onItemPress: openItem })

              // ── YEARS tab ────────────────────────────────────────────────
              // Level 0: year summary cards
              : tab === 'years' && !drillGroup
                ? React.createElement(SummaryView, {
                    groups,
                    onDrillDown: (group) => { setDrillGroup(group); setDrillMonth(null); scrollRef.current?.scrollTo(0, 0); },
                  })
              // Level 1: month summary cards within a year
              : tab === 'years' && drillGroup && !drillMonth
                ? React.createElement(SummaryView, {
                    groups: drilledMonths,
                    parentLabel: drillGroup.label,
                    onBack: () => { setDrillGroup(null); scrollRef.current?.scrollTo(0, 0); },
                    onDrillDown: (month) => { setDrillMonth(month); scrollRef.current?.scrollTo(0, 0); },
                  })
              // Level 2: day grid within a month
              : tab === 'years' && drillGroup && drillMonth
                ? React.createElement(GridView, {
                    groups: drilledDays,
                    onItemPress: openItem,
                    drillLabel: drillMonth.label,
                    onBack: () => { setDrillMonth(null); scrollRef.current?.scrollTo(0, 0); },
                  })

              // ── MONTHS tab ───────────────────────────────────────────────
              // Level 0: month summary cards
              : tab === 'months' && !drillGroup
                ? React.createElement(SummaryView, {
                    groups,
                    onDrillDown: (group) => { setDrillGroup(group); scrollRef.current?.scrollTo(0, 0); },
                  })
              // Level 1: day grid within a month
              : tab === 'months' && drillGroup
                ? React.createElement(GridView, {
                    groups: groupBy(drillGroup.items, i => fmt.date(i.date)).reverse(),
                    onItemPress: openItem,
                    drillLabel: drillGroup.label,
                    onBack: () => { setDrillGroup(null); scrollRef.current?.scrollTo(0, 0); },
                  })

              // ── DAYS tab ─────────────────────────────────────────────────
              : React.createElement(GridView, {
                  groups,
                  onItemPress: openItem,
                })
        ),
        tab !== 'places' && media.length > 0 && (() => {
          // Determine which groups and tab-mode to pass the scrubber
          if (tab === 'years' && drillGroup && drillMonth) {
            return React.createElement(Scrubber, { groups: drilledDays, scrollRef, tab: 'days' });
          }
          if (tab === 'years' && drillGroup && !drillMonth) {
            return React.createElement(Scrubber, { groups: drilledMonths, scrollRef, tab: 'months' });
          }
          if (tab === 'months' && drillGroup) {
            return React.createElement(Scrubber, { groups: groupBy(drillGroup.items, i => fmt.date(i.date)).reverse(), scrollRef, tab: 'days' });
          }
          // Summary views: no scrubber needed (grid is short enough to scroll)
          if ((tab === 'years' || tab === 'months') && !drillGroup) return null;
          return React.createElement(Scrubber, { groups, scrollRef, tab });
        })(),
      ),

      React.createElement('div', { style: { height: 'env(safe-area-inset-bottom)', background: '#000' } })
    );
  }

  // CSS
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      15%  { transform: translateX(-8px); }
      30%  { transform: translateX(8px); }
      45%  { transform: translateX(-6px); }
      60%  { transform: translateX(6px); }
      75%  { transform: translateX(-4px); }
      90%  { transform: translateX(4px); }
    }
    ::-webkit-scrollbar { display: none; }
    * { scrollbar-width: none; }
    input::placeholder { color: #48484a; letter-spacing: 0; }
  `;
  document.head.appendChild(style);

  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
})();
