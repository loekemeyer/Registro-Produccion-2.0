const CACHE_VERSION = "v1.8.58";

const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
const SUPABASE_KEY = "sb_publishable_BqpAgZH6ty-9wft10_YMhw_0rcIPuWT";
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
        "Prefer": "resolution=ignore-duplicates,return=minimal"
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

// Patron Virgilio: el SW NO cachea estaticos. Solo background sync.
// Asi el browser siempre recibe el HTML/CSS/JS fresco desde la red
// (con su propio HTTP cache, no el del SW) y no quedan operarios
// con versiones viejas pegadas en cache cuando hacemos deploy.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Borrar cualquier cache viejo de versiones previas que SI cacheaban
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch {}
    await self.clients.claim();
    // Avisar a paginas abiertas con SW viejo (v1.8.x) para que recarguen
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        try { client.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION }); } catch {}
      }
    } catch {}
  })());
});

// Fetch handler vacio (mismo patron que Virgilio). El browser maneja
// todo via su HTTP cache normal. Algunos navegadores necesitan que
// el SW tenga un handler de fetch para considerarlo "completo".
self.addEventListener("fetch", () => {});

self.addEventListener("sync", (event) => {
  if (event.tag === "flush-queue") {
    event.waitUntil(processQueueInBackground());
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
