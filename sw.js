const CACHE_VERSION = "v1.5";
const CACHE_NAME = `registro-cache-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json"
];

const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";
const TABLA = "Registros Produccion Cervantes";
const TABLA_PATH = encodeURIComponent(TABLA);

const IDB_NAME = "registro-prod";
const IDB_VERSION = 1;
const IDB_STORE = "queue";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll() {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}

function idbDelete(id) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const r = tx.objectStore(IDB_STORE).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

async function postToSupabase(item) {
  const payload = {
    id: item.id,
    legajo: item.legajo,
    opcion: item.opcion,
    descripcion: item.descripcion,
    texto: item.texto || "",
    ts_event: item.ts_event,
    hs_inicio: item.hs_inicio || "",
    matriz: item.matriz || ""
  };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLA_PATH}?on_conflict=id`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(payload)
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function processQueueInBackground() {
  let items;
  try { items = await idbGetAll(); } catch { return; }
  if (!items || !items.length) return;

  let anyFailed = false;
  for (const item of items) {
    try {
      await postToSupabase(item);
      try { await idbDelete(item.id); } catch { /* ignore */ }
    } catch {
      anyFailed = true;
    }
  }
  if (anyFailed) throw new Error("Algunos items quedaron pendientes");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === "navigate" ||
                 (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./")))
    );
  } else {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        });
      })
    );
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "flush-queue") {
    event.waitUntil(processQueueInBackground());
  }
});
