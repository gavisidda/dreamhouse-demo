// ═══════════════════════════════════════════════════════════
//  DREAM HOUSE — Service Worker  v1.0
//  Provides: offline cache, background sync, push notifications
// ═══════════════════════════════════════════════════════════

const APP_VERSION   = 'dream-house-v1.2';
const STATIC_CACHE  = APP_VERSION + '-static';
const DYNAMIC_CACHE = APP_VERSION + '-dynamic';

// Files to pre-cache on install (app shell)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Google Fonts (cached on first load)
];

// Firebase & CDN hosts to cache dynamically (not pre-cache)
const CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
];

// ── INSTALL ── pre-cache app shell ────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Pre-cache partial failure (ok):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ── clean old caches ──────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
            .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ── network-first for Firebase, cache-first for static ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET, chrome-extension, and Firebase Auth/Firestore API calls
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;
  // Let Firebase SDK calls go straight to network
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('firebase.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com')) return;

  // CDN fonts/scripts: stale-while-revalidate
  if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(
      caches.open(DYNAMIC_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          const fetched = fetch(event.request).then(res => {
            cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // App shell: cache-first, fallback to network, fallback to index.html
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        return caches.open(STATIC_CACHE).then(cache => {
          cache.put(event.request, res.clone());
          return res;
        });
      }).catch(() => caches.match('./index.html'));
    })
  );
});

// ── BACKGROUND SYNC ── queue offline saves ─────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-entries') {
    event.waitUntil(syncPendingEntries());
  }
  if (event.tag === 'sync-banks') {
    event.waitUntil(syncPendingBanks());
  }
});

async function syncPendingEntries() {
  // Notify all clients to retry pending saves
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'SYNC_ENTRIES' }));
}
async function syncPendingBanks() {
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'SYNC_BANKS' }));
}

// ── PUSH NOTIFICATIONS ─────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Dream House', body: 'You have a new update', icon: './icons/icon-192.png' };
  try { data = { ...data, ...event.data.json() }; } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon || './icons/icon-192.png',
      badge:   './icons/icon-72.png',
      tag:     data.tag || 'dh-notification',
      renotify: true,
      vibrate: [200, 100, 200],
      data:    { url: data.url || './' },
      actions: [
        { action: 'open',    title: '📋 Open App' },
        { action: 'dismiss', title: '✕ Dismiss'   }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
      const url = event.notification.data?.url || './';
      if (all.length) { all[0].focus(); all[0].navigate(url); }
      else clients.openWindow(url);
    })
  );
});

// ── PERIODIC BACKGROUND SYNC ───────────────────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'daily-summary') {
    event.waitUntil(sendDailySummary());
  }
});
async function sendDailySummary() {
  // Clients will handle this by reading from Firestore
  const cls = await self.clients.matchAll();
  cls.forEach(c => c.postMessage({ type: 'DAILY_SUMMARY' }));
}

// ── MESSAGE HANDLER ────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});

console.log('[SW] Dream House Service Worker', APP_VERSION, 'loaded');
