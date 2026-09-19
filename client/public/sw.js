/**
 * Service worker — lets the app open on a weak or missing connection.
 *
 * Spec section 21 asks for "offline-friendly patterns where practical". What
 * is practical here, and what is deliberately not:
 *
 *  - The app itself (HTML, scripts, styles, icons) is cached, so a technician
 *    in a basement with no signal still gets the app, their saved visit draft,
 *    and a clear "could not reach the server" instead of the browser's dinosaur.
 *  - **API responses are never cached.** They hold customer names, phone
 *    numbers and addresses; a phone that is lost or shared must not keep a copy
 *    of them outside the app's own session. It also means a screen can never
 *    show a job's status from yesterday as if it were current.
 *
 * Pages are fetched network-first, so an online user always gets the latest
 * release. Built assets have content hashes in their names and never change,
 * so they are served cache-first.
 *
 * ## A release is kept whole, or not taken at all
 *
 * The stored page and the files it loads must always match. This worker used
 * to store a new page the moment one arrived and delete the previous release's
 * files straight away — before the new release's scripts had downloaded. A
 * phone that picked up an update on one bar of signal and then lost it opened
 * to a white screen: the stored page named scripts that were never saved, and
 * the ones that had worked were gone.
 *
 * So a new page is stored only once every file it can load is in the cache —
 * the files the page names, and every file those name in turn, which includes
 * each portal's lazily loaded screens. Until then the previous release stays
 * whole and is what opens offline. Only after the new page is stored are files
 * it no longer references removed.
 *
 * The cost, stated plainly: a new release downloads every portal's screens
 * once, in the background — not only the portal this phone uses. The worker
 * cannot tell which portal that is, and guessing wrong is the white screen
 * again. Compressed, that is tens of kilobytes per release; a single visit
 * photo is several hundred.
 *
 * Registered only in production builds (see main.tsx).
 */
const CACHE = 'cooler-crm-shell-v1';
/* Files outside a release: stored once, never pruned. */
const STATIC = ['/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];
/* Every route serves the same single-page HTML, so one copy stands in for all. */
const PAGE = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(CACHE)
        .then((cache) => Promise.all(STATIC.map((url) => cache.add(url).catch(() => undefined)))),
      /* The page that registered this worker loaded before the worker existed,
         so none of it is stored yet. Best effort: if the connection fails, the
         next page load tries again. */
      fetch(PAGE)
        .then((response) => (isPage(response) ? adopt(response) : undefined))
        .catch(() => undefined),
    ]),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isPage(response) {
  return response.ok && (response.headers.get('content-type') ?? '').includes('text/html');
}

/**
 * Whether a response is a file worth storing.
 *
 * A server that answers unknown paths with the app's HTML (a common
 * single-page setup) would otherwise have that HTML stored under a script's
 * name, and the script would then fail offline in a way no retry could fix.
 */
function isAsset(response) {
  return response.ok && !(response.headers.get('content-type') ?? '').includes('text/html');
}

/* ---- Downloads ----------------------------------------------------------- */

/**
 * One network download per file, however many callers want it.
 *
 * The page asks for a new release's scripts at the same moment this worker
 * sets about storing them; on mobile data, fetching each one twice would
 * double the wait.
 */
const inflight = new Map();

function download(path) {
  let pending = inflight.get(path);
  if (!pending) {
    pending = fetch(path)
      .then(async (response) => {
        if (isAsset(response)) {
          const cache = await caches.open(CACHE);
          await cache.put(path, response.clone());
        }
        return response;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  /* Everyone gets their own copy; the original body is never read. */
  return pending.then((response) => response.clone());
}

/**
 * The stored copy of a file, downloading it first if needed.
 *
 * Throws when the file cannot be had right now — no connection, a server
 * error — which stops the release being taken. The one exception is a
 * reference found inside another file (`required` false) that the server says
 * does not exist: that is text which looked like a file name, not a file the
 * app loads, and waiting for it would freeze the offline copy for good.
 * Returns null for those.
 */
async function stored(path, required) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(path);
  if (hit) return hit;

  const response = await download(path);
  if (isAsset(response)) return response;

  const missing = response.status === 404 || response.status === 410 || response.ok;
  if (!required && missing) return null;
  throw new Error(`${path} could not be stored (${response.status})`);
}

/* ---- Releases ------------------------------------------------------------ */

/**
 * Built-file references inside HTML, scripts and styles.
 *
 * Vite writes them in three forms: "/assets/x.js" in the page, "assets/x.js"
 * in a script's preload list, and "./x.js" in a script's imports. Each must be
 * quoted (or inside `url(...)`), so ordinary text that happens to mention a
 * file is not taken for one.
 */
const REFERENCE =
  /["'`(]((?:\.\/|\/?assets\/)[\w.-]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|svg|gif|webp|avif|ico))(?=["'`)?#])/g;

function referencesIn(text, base) {
  const found = new Set();
  for (const [, reference] of text.matchAll(REFERENCE)) {
    /* "./x.js" is relative to the file it appears in; "assets/x.js" to the
       site root, where Vite resolves its preload list. */
    const url = reference.startsWith('.')
      ? new URL(reference, base)
      : new URL(`/${reference.replace(/^\//, '')}`, base);
    if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
      found.add(url.pathname);
    }
  }
  return found;
}

/**
 * Stores every file a page can load, following references file by file.
 *
 * One file at a time: the page is downloading what it needs right now over the
 * same weak connection, and this should not crowd it out.
 */
async function gather(html) {
  const needed = new Set();
  /* The files the page names are required outright. */
  const queue = [...referencesIn(html, `${self.location.origin}/`)].map((path) => ({
    path,
    required: true,
  }));

  while (queue.length > 0) {
    const { path, required } = queue.shift();
    if (needed.has(path)) continue;
    needed.add(path);

    const file = await stored(path, required);
    if (file && /\.(?:m?js|css)$/.test(path)) {
      for (const reference of referencesIn(await file.text(), `${self.location.origin}${path}`)) {
        if (!needed.has(reference)) queue.push({ path: reference, required: false });
      }
    }
  }

  return needed;
}

/**
 * Makes a page the one that opens offline — once all of its files are stored.
 *
 * Runs one at a time: two tabs loading two different releases must not have
 * one prune the files the other has just stored.
 */
let adopting = Promise.resolve();

function adopt(response) {
  const run = adopting.then(() => adoptNow(response));
  /* A failure leaves the previous release in place; the next page load tries again. */
  adopting = run.catch(() => undefined);
  return adopting;
}

async function adoptNow(response) {
  const html = await response.clone().text();

  /* Throws if any file cannot be stored, and then nothing below runs. Also
     run for a page identical to the stored one, which repairs a cache left
     incomplete by the older version of this worker. */
  const needed = await gather(html);

  const cache = await caches.open(CACHE);
  const current = await cache.match(PAGE);
  if (!current || (await current.text()) !== html) {
    await cache.put(PAGE, response);
  }

  for (const request of await cache.keys()) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/assets/') && !needed.has(pathname)) {
      await cache.delete(request);
    }
  }
}

/* ---- Requests ------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  /* Fonts and anything else off-origin: the browser's own caching applies. */
  if (url.origin !== self.location.origin) return;
  /* Never cached — see above. */
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isPage(response)) event.waitUntil(adopt(response.clone()));
          return response;
        })
        .catch(async () => (await caches.match(PAGE)) ?? Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(url.pathname).then((cached) => cached ?? download(url.pathname)),
    );
  }
});
