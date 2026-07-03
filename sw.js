/* Family Hub service worker: offline shell + Web Push. */
'use strict';

const CACHE = 'hub-v8'; // bump on every deploy to invalidate old files
const SHELL = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// network-first for shell files (so deploys show up), cache fallback offline
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request);
      const cache = await caches.open(CACHE);
      cache.put(event.request, fresh.clone());
      return fresh;
    } catch {
      return (await caches.match(event.request)) ?? Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  const payload = event.data?.json() ?? { title: 'Family Hub', body: '' };
  const isSos = !!payload.data?.sos_id;
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    data: payload.data ?? {},
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: isSos ? `sos-${payload.data.sos_id}` : undefined,
    requireInteraction: isSos, // SOS stays on screen until dismissed
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clientList.length) return clientList[0].focus();
    return self.clients.openWindow('./');
  })());
});
