/*
  sw.js — Service Worker
  ----------------------
  A "service worker" is a script the browser runs in the background, separate
  from any tab. Its main job here is to cache our app files so that:

    1. The app loads instantly on subsequent visits (everything from local cache).
    2. The app works even with no internet connection — important for "we are
       fully mobile" use, e.g. on a plane, in a hotel, on a campsite.

  Note: the service worker can NOT make Firebase work offline by itself. Firebase
  has its own offline cache that we enable in sync.js. This service worker only
  caches the static files (HTML, CSS, JS, manifest).

  How it works:
    - On install: download our files into a named cache.
    - On fetch: try the cache first; if missing, hit the network.
    - On activate: delete old caches so updates take effect.

  When you change the app, bump CACHE_VERSION below and the old cache gets
  cleared the next time the user loads the app.
*/

const CACHE_VERSION = 'v1';
const CACHE_NAME = `scategories-${CACHE_VERSION}`;

// Files to cache. We list them explicitly rather than caching everything so
// we know exactly what's in there. If you add a new JS file, add it here too.
const FILES_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './firebase-config.js',
  './js/categories.js',
  './js/state.js',
  './js/ui.js',
  './js/sync.js',
  './js/game.js',
  './js/judging.js',
  './js/app.js',
];

// `install` fires when a new version of this SW is registered.
// We pre-populate the cache here.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  // Don't wait for the user to close all tabs — activate immediately.
  self.skipWaiting();
});

// `activate` fires once the new SW takes over. We use it to delete old caches
// from previous versions so they don't waste storage.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  // Take control of any pages that were already open.
  self.clients.claim();
});

// `fetch` fires for every network request the page makes (HTML, JS, images,
// even Firebase calls). We use a "cache first, fall back to network" strategy
// for our own files, and pass everything else (Firebase, CDN) straight through.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept GET requests for our own origin. Firebase needs to talk to
  // its servers without us interfering.
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // If we have it cached, serve from cache. Otherwise fetch from the
      // network and quietly add it to the cache for next time.
      return (
        cached ||
        fetch(event.request)
          .then((response) => {
            // Only cache successful responses.
            if (response && response.status === 200) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => cached) // If both cache and network fail, return undefined.
      );
    })
  );
});
