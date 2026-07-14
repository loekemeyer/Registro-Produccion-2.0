document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  /* ================= SUPABASE ================= */
  const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
  const SUPABASE_KEY = "sb_publishable_BqpAgZH6ty-9wft10_YMhw_0rcIPuWT";
  const TABLA_REGISTROS = "Registros Produccion Cervantes";

  // (v1.8.43) Forzar SIEMPRE rol anon: la app no tiene login. Ignoramos cualquier
  // sesion "authenticated" que pueda haber dejado otra app del mismo dominio
  // (loekemeyer.github.io) bajo la storageKey compartida del proyecto Supabase.
  // persistSession:false + storageKey propia => esta app nunca hereda esa sesion.
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "prodcerv_anon_only"
    }
  });

  /* ================= WHATSAPP ALERTA ================= */
  const EDGE_FN_URL = SUPABASE_URL + "/functions/v1/send-whatsapp";

  function _getPlantillaActiva() {
    return localStorage.getItem("wa_plantilla_activa") || "problemas_en_matriz_reducido";
  }

  async function enviarAlertaWA(datos) {
    const plantilla = _getPlantillaActiva();
    let parametros;

    if (plantilla === "problema_en_matriz_completo") {
      parametros = [
        datos.problema || "",
        datos.matriz || "",
        datos.descripcion || "",
        datos.operario || "",
        datos.horaEvento || ""
      ];
    } else {
      parametros = [
        datos.problema || "",
        datos.matriz || "",
        datos.descripcion || "",
        datos.horaEvento || ""
      ];
    }

    try {
      await fetch(EDGE_FN_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          parametros,
          plantilla,
          idioma: "es_AR"
        })
      });
    } catch (err) {
      console.error("Error enviando alerta WhatsApp:", err);
    }
  }

  /* ================= CACHE EMPLEADOS/MATRICES ================= */
  let empleadosMap = new Map();
  let matricesMap = new Map();
  let stockMap = new Map();          // (v1.8.40) N_Matriz -> fila de UnixCajon_Stock (excluye 501 y tipo E)
  let balancinesList = [];           // (v1.8.53) filas de Balancines (Num, Tipo, Activo, Matriz)
  let _nombreMatrizOverride = null;
  let _varianteYaElegida = false;
  let _lastPreviewMatriz = null;     // (v1.8.40) ultima matriz consultada en preview de E

  async function cargarCatalogos() {
    const [empRes, matRes, stockRes, balRes] = await Promise.all([
      sb.from("Empleados").select("*"),
      sb.from("Matrices").select("*"),
      sb.from("UnixCajon_Stock_Registro_Prod_Cerv").select("*"),
      sb.from("Balancines").select("*")
    ]);
    if (empRes.data) {
      empRes.data.forEach(e => {
        const leg = String(e.Legajo || "").trim();
        if (leg) empleadosMap.set(leg, e);
      });
    }
    if (matRes.data) {
      matRes.data.forEach(m => {
        const nm = String(m.N_Matriz || "").trim();
        if (nm) matricesMap.set(nm, m);
      });
    }
    if (stockRes.data) {
      stockRes.data.forEach(r => {
        const nm = String(r.N_Matriz || "").trim();
        if (nm) stockMap.set(nm, r);
      });
    }
    if (balRes.data) {
      // (v1.8.56) Num es alfanumerico (ej. 23A): orden natural (2 < 10 < 23A).
      balancinesList = balRes.data.slice().sort((a, b) =>
        String(a.Num).localeCompare(String(b.Num), "es", { numeric: true }));
    }
  }

  // (v1.8.53) Balancines activos (para el selector de "Cambiar Matriz").
  function balancinesActivos() {
    return balancinesList.filter(b => b && b.Activo !== false);
  }

  /* ----- Asignar matriz a un balancin (RPC SECURITY DEFINER) + cola de reintento ----- */
  function readBalancinQueue() {
    try { return JSON.parse(localStorage.getItem(LS_BALANCIN_QUEUE) || "[]"); }
    catch { return []; }
  }
  function writeBalancinQueue(arr) { localStorage.setItem(LS_BALANCIN_QUEUE, JSON.stringify(arr || [])); }

  // Pone la matriz en el balancin destino y la libera de cualquier otro (una matriz =
  // un balancin). Actualiza la copia local optimista; si el RPC falla, encola reintento.
  async function asignarMatrizBalancin(balancin, matriz) {
    const bal = String(balancin || "").trim();   // (v1.8.56) Num alfanumerico
    const nm = String(matriz || "").trim();
    // Update local optimista
    balancinesList.forEach(b => { if (String(b.Matriz || "") === nm) b.Matriz = null; });
    const target = balancinesList.find(b => String(b.Num) === bal);
    if (target) target.Matriz = nm;
    const call = { p_balancin: bal, p_matriz: nm };
    try {
      const { error } = await sb.rpc("asignar_matriz_balancin", call);
      if (error) throw error;
      return true;
    } catch (e) {
      const q = readBalancinQueue();
      q.push(call); writeBalancinQueue(q);
      return false;
    }
  }

  async function flushBalancinQueue() {
    const q = readBalancinQueue();
    if (!q.length) return;
    const restantes = [];
    for (const call of q) {
      try { const { error } = await sb.rpc("asignar_matriz_balancin", call); if (error) throw error; }
      catch { restantes.push(call); }
    }
    writeBalancinQueue(restantes);
  }

  /* ================= STOCK DE CAJON (UnixCajon) — v1.8.40 ================= */
  // El control de cajon (faltan X / uni_actual) esta activo solo si la matriz
  // esta en el stock y tiene Uni_X_Cajon > 0. 501 y Tipo_Matriz=E NO estan en
  // la tabla, por lo que stockActivo() devuelve false (se comportan como antes).
  function stockRow(matriz) {
    return stockMap.get(String(matriz || "").trim()) || null;
  }
  function stockActivo(matriz) {
    const nm = String(matriz || "").trim();
    if (!nm || nm === "501") return false;
    const r = stockMap.get(nm);
    return !!(r && Number(r.Uni_X_Cajon) > 0);
  }
  // Unidades que faltan para completar el cajon actual de esa matriz.
  function faltanteCajon(matriz) {
    const r = stockRow(matriz);
    if (!r) return null;
    const max = Number(r.Uni_X_Cajon) || 0;
    if (max <= 0) return null;
    const act = Number(r.Uni_Actual) || 0;
    return Math.max(max - act, 0);
  }
  // (v1.8.49) Una matriz es "alimentador" si Tipo_Matriz = 'A' (columna de la tabla Matrices).
  function esAlimentador(matriz) {
    const m = matricesMap.get(String(matriz || "").trim());
    return String(m?.Tipo_Matriz || "").trim().toUpperCase() === "A";
  }
  // Re-lee el stock de UNA matriz desde Supabase (es compartido, puede haber cambiado).
  async function refreshStockMatriz(matriz) {
    const nm = String(matriz || "").trim();
    if (!nm) return null;
    try {
      const { data, error } = await sb
        .from("UnixCajon_Stock_Registro_Prod_Cerv")
        .select("*").eq("N_Matriz", nm).maybeSingle();
      if (!error && data) stockMap.set(nm, data);
      return data || null;
    } catch { return null; }
  }

  /* ----- Cola de reintento para el RPC de stock (idempotente via p_evento_id) ----- */
  function readStockQueue() {
    try { return JSON.parse(localStorage.getItem(LS_STOCK_QUEUE) || "[]"); }
    catch { return []; }
  }
  function writeStockQueue(arr) { localStorage.setItem(LS_STOCK_QUEUE, JSON.stringify(arr || [])); }

  // Registra las unidades de un cajon en el stock compartido (RPC SECURITY DEFINER).
  // Idempotente por p_evento_id (= id del cajon). Si falla (sin red), encola reintento.
  async function registrarUnidadesStock(matriz, cantidad, completar, legajo, eventoId) {
    const call = {
      p_n_matriz: String(matriz || "").trim(),
      p_cantidad: Number(cantidad) || 0,
      p_completar: !!completar,
      p_legajo: String(legajo || ""),
      p_evento_id: eventoId
    };
    try {
      const { data, error } = await sb.rpc("registrar_unidades", call);
      if (error) throw error;
      if (data && data[0]) {
        const r = stockMap.get(call.p_n_matriz);
        if (r) { r.Uni_Actual = data[0].uni_actual; stockMap.set(call.p_n_matriz, r); }
      }
      return true;
    } catch (e) {
      const q = readStockQueue();
      if (!q.some(x => x.p_evento_id === eventoId)) { q.push(call); writeStockQueue(q); }
      return false;
    }
  }

  // Reintenta los RPC de stock pendientes. Seguro: el RPC es idempotente.
  async function flushStockQueue() {
    const q = readStockQueue();
    if (!q.length) return;
    const restantes = [];
    for (const call of q) {
      try {
        const { error } = await sb.rpc("registrar_unidades", call);
        if (error) throw error;
      } catch { restantes.push(call); }
    }
    writeStockQueue(restantes);
  }

  /* ================= TIEMPO ================= */
  function isoNow() {
    // Precision de milisegundos: la columna ts_event en Supabase es timestamptz(6)
    // y aceptaba ms, pero antes redondeabamos a segundos perdiendo orden cuando
    // varios eventos cierran al mismo segundo (ej: close-TM + FJ en Terminar Dia).
    return new Date().toISOString();
  }

  function formatDateTimeAR(iso) {
    try {
      return new Date(iso).toLocaleString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour12: false   // (v1.8.30) forzar 24h para evitar "04:18" ambiguo sin AM/PM
      });
    } catch { return ""; }
  }

  function dayKeyAR() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === "year")?.value || "0000";
    const m = parts.find(p => p.type === "month")?.value || "00";
    const d = parts.find(p => p.type === "day")?.value || "00";
    return `${y}-${m}-${d}`;
  }

  function nowMinutesAR() {
    const parts = new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date());
    return Number(parts.find(p => p.type === "hour")?.value || 0) * 60 +
           Number(parts.find(p => p.type === "minute")?.value || 0);
  }

  function isMatrix501(state) {
    return String(state?.lastMatrix?.texto || "").trim() === "501";
  }

  function normalizeToComma(value) {
    return String(value || "").trim().replace(/\./g, ",");
  }

  function hashId(uuid) {
    if (!uuid) return null;
    const hex = String(uuid).replace(/-/g, "").slice(0, 15);
    return parseInt(hex, 16) || null;
  }

  /* ================= VERSION (unica fuente de verdad) ================= */
  const LOCAL_VERSION = "v1.8.58";

  /* ================= KEYS STORAGE ================= */
  const APP_TAG = "_Cervantes";
  const VERSION = "_v2_supa";
  const MAX_DAY_HISTORY = 700;
  const LS_PREFIX = `prod_state${APP_TAG}${VERSION}`;
  const LS_QUEUE = `prod_queue${APP_TAG}${VERSION}`;
  const LS_STOCK_QUEUE = `prod_stockq${APP_TAG}${VERSION}`;
  const LS_BALANCIN_QUEUE = `prod_balq${APP_TAG}${VERSION}`;   // (v1.8.53) reintento asignar matriz->balancin
  const DAY_GUARD_KEY = `prod_day_guard${APP_TAG}${VERSION}`;

  /* ================= UUID ================= */
  function uuidv4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  /* ================= ESTADO POR LEGAJO ================= */
  function stateKeyFor(legajo) {
    return `${LS_PREFIX}::${dayKeyAR()}::${String(legajo).trim()}`;
  }

  function freshState() {
    return {
      lastMatrix: null, lastCajon: null, lastDowntime: null,
      last2: [], lateArrivalSent: false, lateArrivalDiscarded: false,
      matrixNeedsC: false, pcDone: false,
      cajonContinuado: null,        // si el operario continuo cajon del dia anterior, info aca
      continuacionConsultada: false, // flag para no preguntar 2 veces en el mismo dia
      pendingRM: null                // (v1.8.47) flujo Rotura Matriz a medias (persiste F5)
    };
  }

  function readState(legajo) {
    try {
      const raw = localStorage.getItem(stateKeyFor(legajo));
      if (!raw) return freshState();
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object") return freshState();
      s.last2 = Array.isArray(s.last2) ? s.last2 : [];
      s.lastMatrix = s.lastMatrix || null;
      s.lastCajon = s.lastCajon || null;
      s.lastDowntime = s.lastDowntime || null;
      s.matrixNeedsC = !!s.matrixNeedsC;
      s.tdCajonPending = s.tdCajonPending || null;
      s.cajonContinuado = s.cajonContinuado || null;
      s.continuacionConsultada = !!s.continuacionConsultada;
      s.tdCargaPreviaListo = !!s.tdCargaPreviaListo;
      s.tdCargaPreviaInfo = s.tdCargaPreviaInfo || null;
      s.pendingRM = s.pendingRM || null;
      return s;
    } catch { return freshState(); }
  }

  function writeState(legajo, state) {
    localStorage.setItem(stateKeyFor(legajo), JSON.stringify(state));
  }

  function updateHistoryItem(legajo, eventId, patch) {
    const s = readState(legajo);
    const idx = s.last2.findIndex(x => x && x.id === eventId);
    if (idx === -1) return;
    s.last2[idx] = { ...s.last2[idx], ...patch };
    writeState(legajo, s);
  }

  /* ================= RESET DIARIO (retiene N dias calendario) ================= */
  const today = dayKeyAR();

  // (v1.8.34) Retener ULTIMOS N DIAS CALENDARIO (incluyendo sabados/domingos/feriados).
  // Antes solo retenia laborables: si operario trabajaba sabado con matriz abierta,
  // el lunes el cleanup borraba el state y se perdia la continuacion.
  // 14 dias calendario = ~10 laborables + 4 fin de semana (cubre vacaciones cortas).
  function getLastNDays(n) {
    const days = new Set();
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    for (let i = 0; i < n; i++) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      days.add(`${y}-${m}-${dd}`);
      d.setDate(d.getDate() - 1);
    }
    return days;
  }

  const lastDay = localStorage.getItem(DAY_GUARD_KEY);
  if (lastDay && lastDay !== today) {
    const keepDays = getLastNDays(14);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX + "::")) continue;
      const parts = k.split("::");
      if (!keepDays.has(parts[1])) localStorage.removeItem(k);
    }
  }
  localStorage.setItem(DAY_GUARD_KEY, today);

  /* ================= COLA ================= */
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]"); }
    catch { return []; }
  }
  function writeQueue(arr) { localStorage.setItem(LS_QUEUE, JSON.stringify(arr)); }

  /* ================= IDB ESPEJO PARA BACKGROUND SYNC ================= */
  const IDB_NAME = "registro-prod";
  const IDB_VERSION = 1;
  const IDB_STORE = "queue";
  let _dbPromise = null;

  function idbOpen() {
    if (_dbPromise) return _dbPromise;
    if (!("indexedDB" in window)) {
      _dbPromise = Promise.reject(new Error("IDB not available"));
      return _dbPromise;
    }
    _dbPromise = new Promise((resolve, reject) => {
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
    return _dbPromise;
  }

  function idbPut(item) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const r = tx.objectStore(IDB_STORE).put(item);
      r.onsuccess = () => resolve();
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

  function idbGetAll() {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const r = tx.objectStore(IDB_STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    }));
  }

  // Reconcilia localStorage con IDB: items en LS que faltan en IDB = el SW ya los envio en background.
  // Los marca sent y los saca de la cola de localStorage para evitar loop de reintentos.
  async function reconcileQueueWithIDB() {
    let idbItems;
    try { idbItems = await idbGetAll(); } catch { return; }
    const idbIds = new Set(idbItems.map(x => x.id));
    const lsQueue = readQueue();
    if (!lsQueue.length) return;
    const stillQueued = [];
    let recovered = 0;
    for (const item of lsQueue) {
      if (idbIds.has(item.id)) {
        stillQueued.push(item);
      } else {
        if (item.legajo && item.id) {
          try { updateHistoryItem(item.legajo, item.id, { status: "sent", sentAt: isoNow() }); } catch {}
        }
        recovered++;
      }
    }
    if (recovered > 0) {
      writeQueue(stillQueued);
      console.log("[reconcile] " + recovered + " items ya enviados por SW, removidos de cola LS");
    }
  }

  async function migrateQueueToIDB() {
    const q = readQueue();
    if (!q.length) return;
    for (const item of q) {
      try { await idbPut(item); } catch { /* ignore */ }
    }
  }

  async function registerBackgroundSync() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && "sync" in reg) {
        await reg.sync.register("flush-queue");
      }
    } catch { /* not supported, ignore */ }
  }

  function updateSyncBadge() {
    const badge = document.getElementById("syncBadge");
    if (!badge) return;
    const q = readQueue();
    const failed = q.filter(x => (x.__tries || 0) > 0).length;
    if (q.length === 0) {
      badge.textContent = `${LOCAL_VERSION} ✓`;
      badge.style.background = "#f0fdf4";
      badge.style.color = "#166534";
      badge.style.borderColor = "#bbf7d0";
    } else if (failed > 0) {
      badge.textContent = `${LOCAL_VERSION} ⚠ ${q.length}`;
      badge.style.background = "#fef2f2";
      badge.style.color = "#991b1b";
      badge.style.borderColor = "#fecaca";
    } else {
      badge.textContent = `${LOCAL_VERSION} ⏳ ${q.length}`;
      badge.style.background = "#fffbeb";
      badge.style.color = "#92400e";
      badge.style.borderColor = "#fde68a";
    }
  }

  function enqueue(payload) {
    const item = { ...payload, __tries: 0, __queuedAt: isoNow() };
    const q = readQueue();
    q.push(item);
    writeQueue(q);
    idbPut(item).catch(() => {});
    registerBackgroundSync();

    const leg = String(payload.legajo || "").trim();
    if (leg) {
      const s = readState(leg);
      s.last2.unshift({
        id: payload.id, legajo: payload.legajo, opcion: payload.opcion,
        descripcion: payload.descripcion, texto: payload.texto || "",
        ts: payload.ts_event, hsInicio: payload.hs_inicio || "",
        matriz: payload.matriz || "", status: "queued", tries: 0
      });
      s.last2 = s.last2.slice(0, MAX_DAY_HISTORY);
      writeState(leg, s);
    }
    updateSyncBadge();
  }

  /* ================= ENVIO A SUPABASE ================= */
  const SEND_TIMEOUT_MS = 15000;

  async function withTimeout(promise, ms, errMsg) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errMsg)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  function logErrorToSupabase(item, err) {
    try {
      sb.from("Auditoria_Produccion").insert({
        legajo:          String(item.legajo || ""),
        accion:          "ERROR_ENVIO",
        id_registro:     item.id ? String(item.id) : null,
        opcion_original: item.opcion || null,
        desc_original:   item.descripcion || null,
        texto_original:  item.texto || null,
        ts_evento:       item.ts_event || null,
        texto_nuevo:     `Intento ${item.__tries || 1}: ${String(err.message || err).slice(0, 400)}`
      }).then(() => {}, () => {});
    } catch { /* fire and forget */ }
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

    const result = await withTimeout(
      sb.from(TABLA_REGISTROS).upsert(payload, { onConflict: "id", ignoreDuplicates: true }),
      SEND_TIMEOUT_MS,
      `Timeout ${SEND_TIMEOUT_MS / 1000}s al enviar a Supabase`
    );
    if (result.error) throw new Error(result.error.message);

    // Procesar espejo SIEMPRE - es idempotente via upsert con onConflict ID_Ejecucion.
    // El check anterior wasInserted (data.length > 0) fallaba porque .select() con
    // ignoreDuplicates puede devolver [] aun cuando se inserto, perdiendo cajones del 29/04.
    procesarParaEspejo(item).catch(err => {
      console.error("Error procesando espejo en background:", err.message || err);
    });
  }

  /* ================= PROCESAMIENTO (replica n8n) ================= */
  function parseISOtoAR(iso) {
    if (!iso) return null;
    try {
      let normalized = String(iso).trim().replace(/\s(\d{2}:\d{2})/, "T$1");
      return new Date(normalized);
    } catch { return null; }
  }

  function diffSeconds(isoStart, isoEnd) {
    const normalize = (s) => {
      if (!s) return null;
      try {
        s = String(s).trim().replace(/\s(\d{2}:\d{2})/, "T$1");
        return new Date(s);
      } catch (e) {
        console.error("Error parseando fecha:", s, e);
        return null;
      }
    };
    const a = normalize(isoStart);
    const b = normalize(isoEnd);
    if (!a || !b) {
      console.warn("DEBUG diffSeconds: No se pudo parsear", { isoStart, isoEnd, a, b });
      return 0;
    }
    const diff = Math.abs(Math.round((b - a) / 1000));
    return diff;
  }

  function toAR(iso) {
    if (!iso) return null;
    try { return new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })); }
    catch { return null; }
  }

  function timeFromISO(iso) {
    const d = toAR(iso);
    if (!d) return null;
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  }

  function dateFromISO(iso) {
    const d = toAR(iso);
    if (!d) return { dia: 0, mes: 0, quincena: 1, anio: 0 };
    const dia = d.getDate();
    const mes = d.getMonth() + 1;
    const anio = d.getFullYear();
    return { dia, mes, quincena: dia > 15 ? 2 : 1, anio };
  }

  function rangoFechaAR(anio, mes, dia) {
    const pad = (n) => String(n).padStart(2, "0");
    const ini = `${anio}-${pad(mes)}-${pad(dia)}T00:00:00-03:00`;
    const finDate = new Date(ini);
    finDate.setDate(finDate.getDate() + 1);
    return { ini, fin: finDate.toISOString() };
  }

  async function buscarTiemposMuertos(legajo, hsInicio, horaFin, fecha) {
    const dateInfo = dateFromISO(fecha);
    if (!dateInfo.dia || !dateInfo.mes || !dateInfo.anio) return 0;

    const hiTime = timeFromISO(hsInicio);
    const hfTime = timeFromISO(horaFin);
    if (!hiTime || !hfTime) return 0;

    const rango = rangoFechaAR(dateInfo.anio, dateInfo.mes, dateInfo.dia);
    try {
      const { data } = await sb.from("db_n8n_espejo")
        .select("Segundos_Tiempo_Muerto, Hora_Inicio, Hora_Fin")
        .eq("Legajo", legajo)
        .eq("Dia", dateInfo.dia)
        .eq("Mes", dateInfo.mes)
        .eq("Uni", 0)
        .gte("Fecha", rango.ini)
        .lt("Fecha", rango.fin)
        .is("Eliminar", null);

      if (!data || !data.length) return 0;
      return data.reduce((acc, r) => {
        if (r.Hora_Inicio >= hiTime && r.Hora_Fin <= hfTime) {
          return acc + Number(r.Segundos_Tiempo_Muerto || 0);
        }
        return acc;
      }, 0);
    } catch { return 0; }
  }

  /* ================= RECALCULAR CAJONES AFECTADOS POR CAMBIO DE TM ================= */
  async function recalcularCajonesDelDia(legajo, dia, mes, anio) {
    if (!anio) return;
    const rango = rangoFechaAR(anio, mes, dia);
    try {
      const { data: cajones } = await sb.from("db_n8n_espejo")
        .select("ID_Ejecucion, Hora_Inicio, Hora_Fin, Uni, Segundos_Trabajados, Tiempo_Historico")
        .eq("Legajo", legajo)
        .eq("Dia", dia)
        .eq("Mes", mes)
        .gt("Uni", 0)
        .gte("Fecha", rango.ini)
        .lt("Fecha", rango.fin)
        .is("Eliminar", null);

      if (!cajones || !cajones.length) return;

      const { data: tiemposMuertos } = await sb.from("db_n8n_espejo")
        .select("Hora_Inicio, Hora_Fin, Segundos_Tiempo_Muerto")
        .eq("Legajo", legajo)
        .eq("Dia", dia)
        .eq("Mes", mes)
        .eq("Uni", 0)
        .gte("Fecha", rango.ini)
        .lt("Fecha", rango.fin)
        .is("Eliminar", null);

      const tms = tiemposMuertos || [];

      const toSeconds = (hms) => {
        if (!hms) return 0;
        const [h, m, s] = hms.split(":").map(Number);
        return h * 3600 + m * 60 + (s || 0);
      };

      for (const cajon of cajones) {
        if (!cajon.ID_Ejecucion || !cajon.Hora_Inicio || !cajon.Hora_Fin) continue;

        const segTM = tms.reduce((acc, tm) => {
          if (!tm.Hora_Inicio || !tm.Hora_Fin) return acc;
          if (tm.Hora_Inicio >= cajon.Hora_Inicio && tm.Hora_Fin <= cajon.Hora_Fin) {
            return acc + Number(tm.Segundos_Tiempo_Muerto || 0);
          }
          return acc;
        }, 0);

        const segBruto = Math.max(1, toSeconds(cajon.Hora_Fin) - toSeconds(cajon.Hora_Inicio));
        const segNeto = Math.max(1, segBruto - segTM);

        const uni = Number(cajon.Uni || 0);
        const tProm = Number(cajon.Tiempo_Historico || 0);
        const segHist = tProm * uni;
        const tiempoToma = uni > 0 ? Math.round((segNeto / uni) * 100) / 100 : 0;
        const premio = segHist > 0 ? Math.round(((-(segNeto / segHist) + 1) * 10) * 100) / 100 : 0;

        const { error } = await sb.from("db_n8n_espejo").update({
          Segundos_Tiempo_Muerto: segTM,
          Segundos_Trabajados:    segNeto,
          Tiempo_Toma:            tiempoToma,
          Premio:                 premio
        }).eq("ID_Ejecucion", cajon.ID_Ejecucion);
        if (error) {
          console.warn("Error actualizando cajon en espejo:", error.message);
          // Continuar: recálculo es importante pero no crítico
        }
      }
    } catch (err) {
      console.error("Error recalculando cajones del dia:", err);
    }
  }

  async function procesarParaEspejo(item) {
    try {
      const op = String(item.opcion || "").toUpperCase();
      const legajo = String(item.legajo || "").trim();
      const emp = empleadosMap.get(legajo);
      const nombreEmpleado = emp?.Empleado || "";

      const esCajon = op === "C";
      const esTM = !esCajon && item.hs_inicio && isDowntime(op);
      // (v1.8.47) RM vuelve como evento puntual (no es TM). PM sigue siendo TM (se espeja
      // como tiempo muerto al cerrar). RM, RD y LT se espejan como evento puntual.
      const esRM_PM_RD_LT = ["RM", "RD", "LT"].includes(op);

      if (!esCajon && !esTM && !esRM_PM_RD_LT) return;

      const matNum = String(item.matriz || "").trim();
      const matInfo = matricesMap.get(matNum);
      const nombreMatriz = matInfo?.Matriz || "";
      const tiempoPromedio = Number(matInfo?.Tiempo_Historico || 0);

      // FIX Bug 501: reemplazar coma por punto antes de Number()
      const uni = esCajon ? Number(String(item.texto || 0).replace(",", ".")) : 0;
      const tsEvent = item.ts_event;
      let hsInicio = item.hs_inicio || tsEvent;

      if (!item.hs_inicio) {
        console.warn("DEBUG: hsInicio vacio para matriz", matNum, "usando tsEvent");
      }

      // CONTINUACION CAJON CROSS-DIA: si viene cajon_continuado en payload, sumar seg de ayer
      const cont = (esCajon && item.cajon_continuado) ? item.cajon_continuado : null;
      let segTrabajados;
      if (cont) {
        // (tsActivacion -> tsEvent) hoy + segPostAyer ya calculado (tsInicioCajon -> hora_salida_ayer)
        const segHoy = Math.max(1, diffSeconds(cont.tsActivacion || hsInicio, tsEvent));
        segTrabajados = segHoy + Number(cont.segPostAyer || 0);
      } else {
        segTrabajados = diffSeconds(hsInicio, tsEvent);
        if (segTrabajados <= 0) segTrabajados = 1;
      }
      const dateInfo = dateFromISO(tsEvent);
      // Para continuacion: Hora_Inicio refleja el inicio real del caj (ts del lastMatrix/lastCajon de ayer)
      const horaInicio = cont && cont.tsInicioCajon
        ? timeFromISO(cont.tsInicioCajon)
        : timeFromISO(hsInicio);
      const horaFin = timeFromISO(tsEvent);

      let segTiempoMuerto = 0;
      let segTrabajadosNeto = segTrabajados;
      let premio = 0;
      let tiempoToma = 0;
      let anularTiempo = false;

      if (esCajon) {
        if (cont) {
          // TM solo del segmento de hoy (entre tsActivacion y tsEvent)
          segTiempoMuerto = await buscarTiemposMuertos(legajo, cont.tsActivacion || hsInicio, tsEvent, tsEvent);
        } else {
          segTiempoMuerto = await buscarTiemposMuertos(legajo, hsInicio, tsEvent, tsEvent);
        }
        segTrabajadosNeto = segTrabajados - segTiempoMuerto;

        if (uni > 0 && tiempoPromedio > 0) {
          tiempoToma = Math.round((segTrabajadosNeto / uni) * 100) / 100;
          premio = Math.round(((-(segTrabajadosNeto / uni / tiempoPromedio) + 1) * 10) * 100) / 100;
        }
      } else if (esTM) {
        segTiempoMuerto = segTrabajados;
        segTrabajadosNeto = segTrabajados;
        anularTiempo = false;
      } else if (esRM_PM_RD_LT) {
        anularTiempo = false;
      }

      const destinoCM = op === "CM" ? String(item.texto || item.matriz || "").trim() : "";
      const nombreBase = esCajon ? (item.nombreOverride || nombreMatriz) : "";
      const row = {
        Fecha: tsEvent,
        Legajo: legajo,
        // nombreOverride para variantes (ej: Mat 10 recta/curva)
        // Si es continuacion cross-dia, prefijo [CONT] para auditar facil
        Nombre_Matriz: esCajon
          ? (cont ? `[CONT] ${nombreBase}`.trim() : nombreBase)
          : (op === "CM" && destinoCM
              ? `Cambiar Matriz a ${destinoCM}`
              : (esRM_PM_RD_LT ? `${op} ${matNum}` : item.descripcion)),
        Matriz: esCajon ? matNum : (esRM_PM_RD_LT ? matNum : op),
        Uni: uni,
        Premio: premio,
        Tiempo_Toma: uni === 0 ? 0 : tiempoToma,
        Tiempo_Historico: tiempoPromedio,
        Nombre_Empleado: nombreEmpleado,
        Hora_Inicio: horaInicio,
        Hora_Fin: horaFin,
        // (v1.8.35) Nuevas columnas timestamptz con DIA+hora. Mantienen Hora_Inicio/Hora_Fin
        // para no romper modulos viejos. Cajon continuado: Fecha_Inicio es del dia anterior.
        Fecha_Inicio: cont && cont.tsInicioCajon ? cont.tsInicioCajon : (hsInicio || tsEvent),
        Fecha_Fin:    tsEvent,
        Anular_Tiempo: anularTiempo,
        Segundos_Historico: tiempoPromedio * uni,
        Segundos_Trabajados: esTM ? segTrabajados : segTrabajadosNeto,
        Segundos_Tiempo_Muerto: esTM ? segTrabajados : segTiempoMuerto,
        Dia: dateInfo.dia,
        Mes: dateInfo.mes,
        Quincena: dateInfo.quincena
      };

      row.ID_Ejecucion = item.id ? hashId(item.id) : null;

      // Upsert idempotente DO NOTHING: si ya existe (re-procesamiento), no rompe ni dispara policy UPDATE de RLS.
      const { error } = await sb.from("db_n8n_espejo").upsert(row, { onConflict: "ID_Ejecucion", ignoreDuplicates: true });
      if (error) {
        console.warn("Error upsertando en db_n8n_espejo:", error.message);
        // No bloquear: solo loguear y continuar
      }
      if (esTM && dateInfo.dia && dateInfo.mes) {
        await recalcularCajonesDelDia(legajo, dateInfo.dia, dateInfo.mes, dateInfo.anio);
      }
    } catch (err) {
      console.error("Error procesando para espejo:", err);
      // No relanzar: se ejecuta en background y no debe bloquear
    }
  }

  let isFlushing = false;

  async function flushQueue() {
    if (isFlushing) return;
    isFlushing = true;
    let didWork = false;
    try {
      let q = readQueue();
      if (!q.length) return;

      const batch = q.slice(0, 20);
      for (const item of batch) {
        didWork = true;
        try {
          await postToSupabase(item);
          updateHistoryItem(item.legajo, item.id, { status: "sent", sentAt: isoNow() });
          q = readQueue();
          const idx = q.findIndex(x => x.id === item.id);
          if (idx !== -1) { q.splice(idx, 1); writeQueue(q); }
          idbDelete(item.id).catch(() => {});
        } catch (err) {
          item.__tries = (item.__tries || 0) + 1;
          updateHistoryItem(item.legajo, item.id, {
            status: "failed", failedAt: isoNow(),
            tries: item.__tries, lastError: String(err.message || err)
          });
          if (item.__tries === 1 || item.__tries % 5 === 0) {
            logErrorToSupabase(item, err);
          }
          const idx = q.findIndex(x => x.id === item.id);
          if (idx !== -1) { q[idx] = item; writeQueue(q); }
          idbPut(item).catch(() => {});
        }
      }
    } finally {
      isFlushing = false;
      updateSyncBadge();
      if (didWork) {
        renderSummary();
        renderPending();
      }
    }
  }

  /* ================= ELEMENTOS ================= */
  const $ = (id) => document.getElementById(id);
  const legajoScreen = $("legajoScreen");
  const optionsScreen = $("optionsScreen");
  const legajoInput = $("legajoInput");
  const btnContinuar = $("btnContinuar");
  const btnBackTop = $("btnBackTop");
  const btnBackLabel = $("btnBackLabel");
  const row1 = $("row1"); const row2 = $("row2"); const row3 = $("row3"); const row4 = $("row4");
  const selectedArea = $("selectedArea");
  const selectedBox = $("selectedBox");
  const selectedDesc = $("selectedDesc");
  const inputArea = $("inputArea");
  const inputLabel = $("inputLabel");
  const textInput = $("textInput");
  const btnResetSelection = $("btnResetSelection");
  const btnEnviar = $("btnEnviar");
  const errorEl = $("error");
  const daySummary = $("daySummary");
  const matrizInfo = $("matrizInfo");
  const pendingSection = $("pendingSection");
  const pendingList = $("pendingList");

  /* ================= SELECTOR VARIANTE MATRIZ ================= */
  function mostrarSelectorVariante(pregunta, opciones, ocultarCancelar) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center";

      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff;border-radius:20px;padding:32px 28px;max-width:480px;width:92%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)";

      const titulo = document.createElement("p");
      titulo.style.cssText = "font-size:28px;font-weight:800;margin:0 0 24px;line-height:1.25";
      titulo.textContent = pregunta;
      modal.appendChild(titulo);

      opciones.forEach((op) => {
        const btn = document.createElement("button");
        btn.textContent = op.label;
        btn.style.cssText = "display:block;width:100%;padding:24px;margin-bottom:14px;border:1px solid #c9d1d9;border-radius:14px;font-size:25px;font-weight:800;cursor:pointer;background:#f8f9fa";
        // FIX: resolve el objeto completo, no solo op.matriz
        btn.onclick = () => { overlay.remove(); resolve(op); };
        modal.appendChild(btn);
      });

      if (!ocultarCancelar) {
        const btnCancel = document.createElement("button");
        btnCancel.textContent = "Cancelar";
        btnCancel.style.cssText = "display:block;width:100%;padding:14px;border:none;background:transparent;color:#888;font-size:16px;cursor:pointer;margin-top:6px";
        btnCancel.onclick = () => { overlay.remove(); resolve(null); };
        modal.appendChild(btnCancel);
      }

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    });
  }

  /* ================= OPCIONES ================= */
  const OPTIONS = [
    { code: "E", desc: "Empece Matriz", row: 1, input: { show: true, label: "Ingresar numero", placeholder: "Ejemplo: 110", validate: /^[0-9]+$/ } },
    { code: "C", desc: "Cajon", row: 1, input: { show: true, label: "Ingresar numero", placeholder: "Ejemplo: 1500", validate: /^[0-9]+$/ } },
    { code: "PB", desc: "Pare Bano", row: 2, input: { show: false } },
    { code: "BC", desc: "Busque Cajon", row: 2, input: { show: false } },
    { code: "MOV", desc: "Movimiento", row: 2, input: { show: false } },
    { code: "LIMP", desc: "Limpieza", row: 2, input: { show: false } },
    { code: "Perm", desc: "Permiso", row: 2, input: { show: false } },
    { code: "AL", desc: "Ayuda Logistica", row: 3, input: { show: false } },
    { code: "PR", desc: "Pare Carga Rollo", row: 3, input: { show: false } },
    { code: "PC", desc: "Pare Comida", row: 3, input: { show: false } },
    { code: "RD", desc: "Rollo Fleje Doblado", row: 3, input: { show: false } },
    { code: "MOV P", desc: "Movimiento Piedra", row: 3, input: { show: false } },
    { code: "CM", desc: "Cambiar Matriz", row: 4, input: { show: true, label: "Numero matriz nueva", placeholder: "Ej: 110", validate: /^[0-9]+$/ } },
    { code: "PM", desc: "Pare Matriz", row: 4, input: { show: false } },
    { code: "RM", desc: "Rotura Matriz", row: 4, input: { show: false } },
    { code: "REM", desc: "Reparando Matriz", row: 4, input: { show: false } },
    { code: "PCM", desc: "Pare Consulta Matriz", row: 4, input: { show: false } },
    // (v1.8.54) Botones de matriceria. TRM: 1er toque pide matriz, 2do cierra (tiempo
    // muerto). TL: tiempo muerto simple. Ambos SIN alerta.
    { code: "TRM", desc: "Trabajando en Matriz", row: 1, input: { show: true, label: "Numero matriz", placeholder: "Ej: 110", validate: /^[0-9]+$/ } },
    { code: "TL", desc: "Taller", row: 1, input: { show: false } }
  ];

  // (v1.8.47) PM (Pare Matriz) es TIEMPO MUERTO (abre/cierra, mide duracion).
  // RM (Rotura Matriz) NO es tiempo muerto: dispara el flujo cajon+CM (ver ejecutarFlujoRM);
  // el tiempo de la rotura lo mide PCM (Pare Consulta Matriz), no RM.
  const NON_DOWNTIME = new Set(["E", "C", "RM", "RD", "LT"]);
  const isDowntime = (op) => !NON_DOWNTIME.has(op);
  const sameDowntime = (a, b) => a && b && a.opcion === b.opcion && (a.texto || "") === (b.texto || "");

  /* ================= CAPACIDADES POR OPERARIO (v1.8.54) ================= */
  // Botones que ve un operario NORMAL (no matriceria). MOV/MOV P, CM, PR, RD se
  // resuelven aparte segun capacidades. REM/TRM/TL son solo de matriceria.
  const NORMAL_BASE = new Set(["E", "C", "PB", "BC", "LIMP", "Perm", "AL", "PC", "PM", "RM", "PCM"]);
  function capsDe(legajo) {
    const e = empleadosMap.get(String(legajo || "").trim()) || {};
    const alimentador = e.es_alimentador === true;
    return {
      matriceria: e.es_matriceria === true,
      piedra: e.es_piedra === true,
      alimentador: alimentador,
      cm: e.ve_cm === true || alimentador,   // alimentador implica CM
      pr_rd: alimentador,                     // PR + RD = rol Alimentador
      trm: e.ve_trm === true,
      tl: e.ve_tl === true,
      rem: e.ve_rem === true
    };
  }
  function puedeCM(legajo) { return capsDe(legajo).cm; }
  // ¿Se muestra este boton para estas capacidades?
  function botonVisible(code, caps) {
    if (caps.matriceria) {
      if (code === "TRM") return caps.trm;
      if (code === "TL") return caps.tl;
      if (code === "CM") return caps.cm;
      if (code === "REM") return caps.rem;
      return false; // matriceria no ve los botones normales
    }
    if (code === "MOV") return !caps.piedra;
    if (code === "MOV P") return caps.piedra;
    if (code === "CM") return caps.cm;
    if (code === "PR" || code === "RD") return caps.pr_rd;
    if (code === "TRM" || code === "TL" || code === "REM") return false;
    return NORMAL_BASE.has(code);
  }

  let selected = null;

  function legajoKey() { return String(legajoInput.value || "").trim(); }

  /* ================= UI ================= */
  function renderSummary() {
    const leg = legajoKey();
    if (!leg) { daySummary.className = "history-empty"; daySummary.innerText = "Ingresa tu legajo para ver el resumen"; return; }

    const s = readState(leg);
    const badge = (st) => {
      if (st === "sent") return '<span style="padding:2px 8px;border-radius:999px;background:#e8fff0;color:#0b6b2c;font-weight:800;font-size:12px;">ENVIADO</span>';
      if (st === "queued") return '<span style="padding:2px 8px;border-radius:999px;background:#fff7e6;color:#8a5a00;font-weight:800;font-size:12px;">PENDIENTE</span>';
      if (st === "failed") return '<span style="padding:2px 8px;border-radius:999px;background:#ffecec;color:#9b1c1c;font-weight:800;font-size:12px;">ERROR</span>';
      return '';
    };

    const prevScrollable = daySummary.querySelector(".t2");
    const prevScroll = prevScrollable ? prevScrollable.scrollTop : 0;

    if (!s.last2.length) {
      daySummary.className = ""; daySummary.innerHTML = '<div class="day-item"><div class="t1">Historial del dia</div><div class="t2">Sin registros</div></div>';
      return;
    }

    daySummary.className = "";
    daySummary.innerHTML = `
      <div class="day-item">
        <div class="t1">Historial del dia (${s.last2.length})</div>
        <div class="t2" style="max-height:360px;overflow:auto;">
          ${s.last2.map((it, idx) => {
            const isFJ = it.opcion === "FJ";
            const showTexto = !isFJ && it.texto;
            return `
            <div style="margin-top:10px;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,.08);" data-hist-idx="${idx}">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <span style="font-weight:900;font-size:34px;">${it.opcion}${showTexto ? `: ${it.texto}` : ""}</span>
                ${badge(it.status)}
                ${isFJ ? "" : `<span class="hist-btn hist-edit" data-idx="${idx}" title="Editar">&#9998;</span>`}
                ${isFJ ? "" : `<span class="hist-btn hist-del" data-idx="${idx}" title="Eliminar">&#128465;</span>`}
              </div>
              ${it.ts ? `<div style="color:#555;">Evento: ${formatDateTimeAR(it.ts)}</div>` : ""}
              ${it.sentAt ? `<div style="color:#0b6b2c;">Enviado: ${formatDateTimeAR(it.sentAt)}</div>` : ""}
              ${it.lastError ? `<div style="color:#9b1c1c;font-size:12px;">${it.lastError}</div>` : ""}
            </div>
          `;
          }).join("")}
        </div>
      </div>`;

    const newScrollable = daySummary.querySelector(".t2");
    if (newScrollable && prevScroll) newScrollable.scrollTop = prevScroll;

    daySummary.querySelectorAll(".hist-edit").forEach(btn => {
      btn.addEventListener("click", () => editHistItem(leg, parseInt(btn.dataset.idx)));
    });
    daySummary.querySelectorAll(".hist-del").forEach(btn => {
      btn.addEventListener("click", () => deleteHistItem(leg, parseInt(btn.dataset.idx)));
    });
  }

  /* ================= EDITAR / ELIMINAR HISTORIAL ================= */
  async function deleteHistItem(leg, idx) {
    if (!confirm("Eliminar este registro?")) return;
    const s = readState(leg);
    const item = s.last2[idx];
    if (!item) return;

    const opUpper = String(item.opcion || "").toUpperCase();
    const eraUnTM = item.hsInicio && isDowntime(opUpper);
    const tsParaDia = item.ts_event || item.ts;

    // Auditoria: registrar eliminacion
    try {
      await sb.from("Auditoria_Produccion").insert({
        legajo:          String(leg),
        accion:          "ELIMINAR",
        id_registro:     item.id ? String(item.id) : null,
        opcion_original: item.opcion || null,
        desc_original:   item.descripcion || null,
        texto_original:  item.texto || null,
        ts_evento:       item.ts_event || item.ts || null
      });
    } catch (err) { console.error("Error auditoria eliminar:", err); }

    try {
      if (item.id) {
        await sb.from(TABLA_REGISTROS).delete().eq("id", item.id);
        await sb.from("db_n8n_espejo").delete().eq("ID_Ejecucion", hashId(item.id));
      }
    } catch (err) { console.error("Error eliminando de Supabase:", err); }

    s.last2.splice(idx, 1);

    if (opUpper === "E") {
      if (s.lastMatrix && s.lastMatrix.texto === (item.texto || "")) {
        s.lastMatrix = null;
        s.matrixNeedsC = false;
      }
    } else if (opUpper === "C") {
      s.matrixNeedsC = true;
      const prevCajon = s.last2.find(x => String(x.opcion || "").toUpperCase() === "C");
      s.lastCajon = prevCajon ? { opcion: prevCajon.opcion, texto: prevCajon.texto || "", ts: prevCajon.ts } : null;
    }

    writeState(leg, s);

    const q = readQueue().filter(x => x.id !== item.id);
    writeQueue(q);
    if (item.id) idbDelete(item.id).catch(() => {});

    if (eraUnTM && tsParaDia) {
      const dateInfo = dateFromISO(tsParaDia);
      if (dateInfo.dia && dateInfo.mes) {
        await recalcularCajonesDelDia(leg, dateInfo.dia, dateInfo.mes, dateInfo.anio);
      }
    }

    renderSummary();
    renderPending();
  }

  /* ================= MODAL EDICION ================= */
  const editModal = document.getElementById("editModal");
  const editCodeEl = document.getElementById("editCode");
  const editTextoEl = document.getElementById("editTexto");
  const editTextoWrap = document.getElementById("editTextoWrap");
  const editTsEl = document.getElementById("editTs");
  const editStatusEl = document.getElementById("editStatus");
  const editCancelBtn = document.getElementById("editCancel");
  const editSaveBtn = document.getElementById("editSave");

  let editingLeg = null;
  let editingIdx = null;

  OPTIONS.forEach(o => {
    const opt = document.createElement("option");
    opt.value = o.code;
    opt.textContent = `${o.code} - ${o.desc}`;
    editCodeEl.appendChild(opt);
  });

  editCodeEl.addEventListener("change", () => {
    const opt = OPTIONS.find(o => o.code === editCodeEl.value);
    editTextoWrap.style.display = opt?.input?.show ? "" : "none";
    if (!opt?.input?.show) editTextoEl.value = "";
  });

  editCancelBtn.addEventListener("click", () => {
    editModal.classList.add("hidden");
    editingLeg = null; editingIdx = null;
  });

  editSaveBtn.addEventListener("click", async () => {
    if (editingLeg === null || editingIdx === null) return;
    const s = readState(editingLeg);
    const item = s.last2[editingIdx];
    if (!item) return;

    const code = editCodeEl.value;
    const opt = OPTIONS.find(o => o.code === code);
    if (!opt) return;
    const texto = opt.input?.show ? editTextoEl.value.trim() : "";

    // Auditoria: registrar edicion
    const huboCambio = item.opcion !== code || item.texto !== texto;
    if (huboCambio) {
      try {
        await sb.from("Auditoria_Produccion").insert({
          legajo:          String(editingLeg),
          accion:          "EDITAR",
          id_registro:     item.id ? String(item.id) : null,
          opcion_original: item.opcion || null,
          desc_original:   item.descripcion || null,
          texto_original:  item.texto || null,
          ts_evento:       item.ts_event || item.ts || null,
          opcion_nueva:    code,
          desc_nueva:      opt.desc,
          texto_nuevo:     texto || null
        });
      } catch (err) { console.error("Error auditoria editar:", err); }
    }

    item.opcion = code;
    item.descripcion = opt.desc;
    item.texto = texto;
    writeState(editingLeg, s);

    try {
      if (item.id) {
        await sb.from(TABLA_REGISTROS).update({
          opcion: code,
          descripcion: opt.desc,
          texto: texto
        }).eq("id", item.id);

        const idEjec = hashId(item.id);
        if (idEjec) {
          const toSec = (hms) => {
            if (!hms) return 0;
            const [h, m, s] = hms.split(":").map(Number);
            return h * 3600 + m * 60 + (s || 0);
          };

          const { data: existente } = await sb.from("db_n8n_espejo")
            .select("*")
            .eq("ID_Ejecucion", idEjec).limit(1);
          const filaExiste = existente && existente.length > 0;
          const fila = filaExiste ? existente[0] : null;

          if (code === "C" && texto) {
            const uni = Number(String(texto).replace(",", ".")) || 0;
            const matNum = String(item.matriz || "").trim();
            const matInfo = matricesMap.get(matNum);
            const tProm = Number(matInfo?.Tiempo_Historico || 0);
            const segHist = tProm * uni;

            const horaInicio = fila?.Hora_Inicio || timeFromISO(item.hsInicio || item.ts);
            const horaFin = fila?.Hora_Fin || timeFromISO(item.ts);
            const diRef = dateFromISO(item.ts);
            const dia = fila?.Dia || diRef.dia;
            const mes = fila?.Mes || diRef.mes;
            const anio = diRef.anio;

            const segBruto = Math.max(1, toSec(horaFin) - toSec(horaInicio));

            const rangoEdit = anio ? rangoFechaAR(anio, mes, dia) : null;
            let queryTms = sb.from("db_n8n_espejo")
              .select("Hora_Inicio, Hora_Fin, Segundos_Tiempo_Muerto")
              .eq("Legajo", item.legajo)
              .eq("Dia", dia)
              .eq("Mes", mes)
              .eq("Uni", 0)
              .is("Eliminar", null);
            if (rangoEdit) {
              queryTms = queryTms.gte("Fecha", rangoEdit.ini).lt("Fecha", rangoEdit.fin);
            }
            const { data: tms } = await queryTms;

            const segTM = (tms || []).reduce((acc, tm) => {
              if (!tm.Hora_Inicio || !tm.Hora_Fin) return acc;
              if (tm.Hora_Inicio >= horaInicio && tm.Hora_Fin <= horaFin) {
                return acc + Number(tm.Segundos_Tiempo_Muerto || 0);
              }
              return acc;
            }, 0);

            const segNeto = Math.max(1, segBruto - segTM);
            const premio = segHist > 0 ? Math.round(((-(segNeto / segHist) + 1) * 10) * 100) / 100 : 0;

            const cajonData = {
              Uni: uni,
              Matriz: matNum,
              Nombre_Matriz: matInfo?.Matriz || "",
              Segundos_Historico: segHist,
              Segundos_Trabajados: segNeto,
              Segundos_Tiempo_Muerto: segTM,
              Premio: premio,
              Tiempo_Historico: tProm,
              Tiempo_Toma: uni > 0 ? Math.round((segNeto / uni) * 100) / 100 : 0
            };

            if (filaExiste) {
              await sb.from("db_n8n_espejo").update(cajonData).eq("ID_Ejecucion", idEjec);
            } else {
              const emp = empleadosMap.get(String(item.legajo || "").trim());
              await sb.from("db_n8n_espejo").insert({
                ...cajonData,
                ID_Ejecucion: idEjec,
                Fecha: item.ts,
                Legajo: item.legajo,
                Nombre_Empleado: emp?.Empleado || "",
                Hora_Inicio: horaInicio,
                Hora_Fin: horaFin,
                Dia: dia,
                Mes: mes,
                Quincena: dia > 15 ? 2 : 1,
                Anular_Tiempo: false
              });
            }
          } else if (isDowntime(code) && item.hsInicio) {
            const horaInicio = timeFromISO(item.hsInicio || item.ts);
            const horaFin = timeFromISO(item.ts);
            const segTrabajados = Math.max(1, toSec(horaFin) - toSec(horaInicio));
            const dateInfo = dateFromISO(item.ts);

            const destinoCM = code === "CM" ? String(item.texto || item.matriz || "").trim() : "";
            const tmData = {
              Matriz: code,
              Nombre_Matriz: code === "CM" && destinoCM ? `Cambiar Matriz a ${destinoCM}` : opt.desc,
              Uni: 0,
              Premio: 0,
              Tiempo_Toma: 0,
              Tiempo_Historico: 0,
              Segundos_Historico: 0,
              Segundos_Trabajados: segTrabajados,
              Segundos_Tiempo_Muerto: segTrabajados
            };

            if (filaExiste) {
              await sb.from("db_n8n_espejo").update(tmData).eq("ID_Ejecucion", idEjec);
            } else {
              const emp = empleadosMap.get(String(item.legajo || "").trim());
              await sb.from("db_n8n_espejo").insert({
                ...tmData,
                ID_Ejecucion: idEjec,
                Fecha: item.ts,
                Legajo: item.legajo,
                Nombre_Empleado: emp?.Empleado || "",
                Hora_Inicio: horaInicio,
                Hora_Fin: horaFin,
                Dia: dateInfo.dia,
                Mes: dateInfo.mes,
                Quincena: dateInfo.dia > 15 ? 2 : 1,
                Anular_Tiempo: false
              });
            }
          } else if (filaExiste) {
            await sb.from("db_n8n_espejo").delete().eq("ID_Ejecucion", idEjec);
          }
        }
      }
    } catch (err) { console.error("Error actualizando Supabase:", err); }

    const opAnterior = String(s.last2[editingIdx]?.opcion || item.opcion || "").toUpperCase();
    const eraOesTM = (isDowntime(opAnterior) && item.hsInicio) ||
                     (isDowntime(code) && item.hsInicio);
    if (eraOesTM) {
      const tsParaDia = item.ts_event || item.ts;
      if (tsParaDia) {
        const dateInfo = dateFromISO(tsParaDia);
        if (dateInfo.dia && dateInfo.mes) {
          await recalcularCajonesDelDia(editingLeg, dateInfo.dia, dateInfo.mes, dateInfo.anio);
        }
      }
    }

    if (code === "E" && texto) {
      const st = readState(editingLeg);
      st.lastMatrix = { opcion: "E", texto: texto, ts: item.ts || item.ts_event };
      st.matrixNeedsC = true;
      writeState(editingLeg, st);
    }

    const q = readQueue();
    const qItem = q.find(x => x.id === item.id);
    if (qItem) {
      qItem.opcion = code; qItem.descripcion = opt.desc; qItem.texto = texto;
      writeQueue(q);
      idbPut(qItem).catch(() => {});
    }

    editModal.classList.add("hidden");
    editingLeg = null; editingIdx = null;
    renderSummary();
  });

  function editHistItem(leg, idx) {
    const s = readState(leg);
    const item = s.last2[idx];
    if (!item) return;

    editingLeg = leg;
    editingIdx = idx;

    editCodeEl.value = item.opcion;
    const opt = OPTIONS.find(o => o.code === item.opcion);
    editTextoWrap.style.display = opt?.input?.show ? "" : "none";
    editTextoEl.value = item.texto || "";
    editTsEl.value = item.ts ? formatDateTimeAR(item.ts) : "";
    editStatusEl.value = item.status === "sent" ? "Enviado" : item.status === "queued" ? "Pendiente" : item.status || "";

    editModal.classList.remove("hidden");
  }

  function renderPending() {
    const leg = legajoKey();
    const q = readQueue().filter(it => String(it.legajo || "").trim() === leg);
    if (!q.length) { pendingSection.classList.add("hidden"); pendingList.innerHTML = ""; return; }
    pendingSection.classList.remove("hidden");
    pendingList.innerHTML = q.map(it => `
      <div style="padding:10px;border:1px solid rgba(0,0,0,.08);border-radius:12px;margin-top:8px;">
        <div style="font-weight:900;font-size:22px;">${it.opcion}${it.texto ? `: ${it.texto}` : ""}</div>
        <span style="padding:2px 8px;border-radius:999px;background:#fff7e6;color:#8a5a00;font-weight:800;font-size:12px;">PENDIENTE</span>
        ${it.__tries ? `<span style="font-size:12px;color:#666;"> intentos: ${it.__tries}</span>` : ""}
      </div>
    `).join("");
  }

  function renderMatrizInfo() {
    if (!selected || selected.code !== "C") { matrizInfo.classList.add("hidden"); return; }
    const s = readState(legajoKey());
    matrizInfo.classList.remove("hidden");
    if (!s.lastMatrix?.texto) {
      matrizInfo.innerHTML = 'No hay matriz registrada hoy.<br><small>Envia primero "E (Empece Matriz)"</small>';
      return;
    }
    const varianteLabel = s.lastMatrix.nombreOverride ? `<br><small style="color:#1e6bd6;font-weight:700;">${s.lastMatrix.nombreOverride}</small>` : "";
    matrizInfo.innerHTML = `Matriz en uso: <span style="font-size:22px;">${s.lastMatrix.texto}</span>${varianteLabel}
      <small>Ultima matriz: ${s.lastMatrix.ts ? formatDateTimeAR(s.lastMatrix.ts) : ""}</small>`;
    // (v1.8.40) Faltante para completar el cajon (stock compartido)
    const mtx = s.lastMatrix.texto;
    if (stockActivo(mtx)) {
      const falta = faltanteCajon(mtx);
      const act = Number(stockRow(mtx)?.Uni_Actual) || 0;
      matrizInfo.innerHTML += `<div class="cajon-faltante" style="margin-top:8px;padding:8px;border-radius:8px;background:#eff6ff;color:#1e3a8a;font-weight:800;">Faltan ${falta} unidades para completar el cajón${act > 0 ? ` <small style="font-weight:500;">(ya hay ${act})</small>` : ""}</div>`;
    }
  }

  // (v1.8.40) Muestra "faltan X" mientras el operario tipea el numero de matriz en E.
  function previewFaltanteMatrizE() {
    if (!selected || selected.code !== "E") return;
    const nm = String(textInput.value || "").trim();
    if (nm && stockActivo(nm)) {
      const falta = faltanteCajon(nm);
      const act = Number(stockRow(nm)?.Uni_Actual) || 0;
      matrizInfo.classList.remove("hidden");
      matrizInfo.innerHTML = `Matriz <b>${escapeHtml(nm)}</b>: faltan <b>${falta}</b> unidades para completar el cajón` +
        (act > 0 ? ` <small>(ya hay ${act})</small>` : "");
      if (_lastPreviewMatriz !== nm) {
        _lastPreviewMatriz = nm;
        refreshStockMatriz(nm).then(() => { if (selected && selected.code === "E") previewFaltanteMatrizE(); });
      }
    } else {
      matrizInfo.classList.add("hidden");
    }
  }

  /* ================= OPCIONES RENDER ================= */
  function renderOptions() {
    row1.innerHTML = ""; row2.innerHTML = ""; row3.innerHTML = ""; row4.innerHTML = "";
    const leg = legajoKey();
    const state = leg ? readState(leg) : null;
    const pending = state?.lastDowntime || null;
    const caps = capsDe(leg);   // (v1.8.54) capacidades del operario

    OPTIONS.forEach(o => {
      // (v1.8.54) Mostrar solo los botones que el operario tiene permitidos (resto ocultos).
      if (!botonVisible(o.code, caps)) return;
      const d = document.createElement("div");
      d.className = "box";
      d.dataset.code = o.code;
      d.innerHTML = `<div class="box-title">${o.code}</div><div class="box-desc">${o.desc}</div>`;

      const allowedPending = !pending || o.code === pending.opcion;
      const allowedMatrix = o.code !== "E" || !state?.matrixNeedsC;
      // C deshabilitado si no hay matriz activa (sin sentido cerrar caj sin matriz abierta)
      const allowedC = o.code !== "C" || !!state?.lastMatrix;

      if (!allowedPending || !allowedMatrix || !allowedC) {
        d.style.opacity = "0.35"; d.style.pointerEvents = "none"; d.style.filter = "grayscale(100%)";
      } else {
        // (v1.8.31) Si hay boton Continuar Cajon visible y el operario aprieta OTRA cosa,
        // mostrar modal advertencia + pedir codigo logistica (151515) antes de proceder.
        d.addEventListener("click", () => {
          // (v1.8.53) Cambiar Matriz (apertura) -> modal matriz + balancin. El cierre de
          // un tiempo muerto de CM sigue por el flujo normal (selectOption / cmCerrando).
          const proceder = () => {
            const st = readState(legajoKey());
            if (o.code === "CM" && !(st && st.lastDowntime && st.lastDowntime.opcion === "CM")) {
              abrirCambiarMatriz();
            } else {
              selectOption(o, d);
            }
          };
          if (hayContinuarPendiente()) {
            mostrarAdvertenciaIgnorarContinuar(proceder);
            return;
          }
          proceder();
        });
      }

      // (v1.8.55) E/C arriba (row1); el resto de los botones visibles van todos a row2,
      // que se acomoda solo. Asi no quedan huecos al ocultar botones por capacidades.
      const target = (o.code === "E" || o.code === "C") ? row1 : row2;
      target.appendChild(d);
    });

    // (v1.8.26) Inyectar boton "Continuar Cajon" en row1 (a la derecha de C) si hay matriz pendiente de ayer
    inyectarBotonContinuarEnRow1();

    // (v1.8.55) Reflow: cada fila usada llena el ancho con su cantidad real de botones
    // (hasta 5 columnas); las filas vacias se ocultan. Evita columnas/huecos vacios.
    row3.style.display = "none";
    row4.style.display = "none";
    [row1, row2].forEach(r => {
      const n = r.childElementCount;
      if (n === 0) { r.style.display = "none"; return; }
      r.style.display = "";
      r.style.gridTemplateColumns = `repeat(${Math.min(n, 5)}, minmax(0, 1fr))`;
    });

    if (!pending && state?.matrixNeedsC) {
      errorEl.style.color = "#b26a00";
      errorEl.innerText = "Para iniciar una nueva matriz (E), primero termina la cantidad de la matriz en curso.";
    }
  }

  /* ================= NAVEGACION ================= */
  function goToOptions() {
    const leg = legajoKey();
    if (!leg) { alert("Ingresa el numero de legajo"); return; }

    if (!empleadosMap.has(leg)) {
      alert("Legajo no encontrado. Verifica el numero.");
      return;
    }

    legajoScreen.classList.add("hidden");
    optionsScreen.classList.remove("hidden");
    renderOptions();
    renderMatrizInfo();

    // (v1.8.47) Si quedo un flujo Rotura Matriz a medias (ej: se actualizo con F5),
    // retomarlo: reexige la cantidad si no se cargo, o reabre Cambiar Matriz.
    resumirFlujoRMSiHace(leg);
  }

  function backToLegajo() {
    optionsScreen.classList.add("hidden");
    legajoScreen.classList.remove("hidden");
    selected = null;
    renderSummary();
  }

  /* ================= SELECCION ================= */
  function selectOption(opt, elBox) {
    selected = opt;
    document.querySelectorAll(".box.selected").forEach(x => x.classList.remove("selected"));
    if (elBox) elBox.classList.add("selected");

    selectedArea.classList.remove("hidden");
    selectedBox.innerText = opt.code;
    selectedDesc.innerText = opt.desc;
    errorEl.innerText = "";
    textInput.value = "";

    // CM / TRM: 2da pulsacion cierra el TM, no pide input (v1.8.54: incluye TRM)
    const stateSel = readState(legajoKey());
    const cmCerrando = (opt.code === "CM" || opt.code === "TRM") && stateSel?.lastDowntime?.opcion === opt.code;

    if (opt.input.show && !cmCerrando) {
      inputArea.classList.remove("hidden");
      inputLabel.innerText = opt.input.label;
      textInput.placeholder = opt.input.placeholder;
    } else {
      inputArea.classList.add("hidden");
      if (cmCerrando) textInput.value = stateSel.lastDowntime.texto || "";
    }

    // (v1.8.40) Checkbox "cajon completo" + preview de faltante de cajon
    const chkWrap = document.getElementById("cajonCompletoWrap");
    const chk = document.getElementById("cajonCompletoChk");
    if (chk) chk.checked = false;
    if (chkWrap) chkWrap.classList.add("hidden");
    textInput.oninput = null;
    _lastPreviewMatriz = null;

    if (opt.code === "E") {
      // mostrar "faltan X" en vivo segun la matriz que va tipeando
      textInput.oninput = previewFaltanteMatrizE;
      previewFaltanteMatrizE();
    } else if (opt.code === "C") {
      const mtx = stateSel?.lastMatrix?.texto;
      if (mtx && stockActivo(mtx)) {
        if (chkWrap) chkWrap.classList.remove("hidden");
        // refrescar el stock compartido y re-renderizar el faltante
        refreshStockMatriz(mtx).then(() => {
          if (selected && selected.code === "C") renderMatrizInfo();
        });
      }
    }

    renderMatrizInfo();
  }

  function resetSelection() {
    const state = readState(legajoKey());
    if (state?.lastDowntime) return;
    selected = null;
    selectedArea.classList.add("hidden");
    errorEl.innerText = "";
    matrizInfo.classList.add("hidden");
    document.querySelectorAll(".box.selected").forEach(x => x.classList.remove("selected"));
  }

  /* ================= CONTINUACION DE CAJON CROSS-DIA ================= */
  // Convierte time "HH:MM:SS" + fecha date a Date object (zona AR)
  function timeStrToDate(timeStr, fechaDate) {
    if (!timeStr || !fechaDate) return null;
    const [h, m, s] = timeStr.split(":").map(Number);
    const d = new Date(fechaDate);
    d.setHours(h || 0, m || 0, s || 0, 0);
    return d;
  }

  // Devuelve YYYY-MM-DD de ayer en zona AR
  function dayKeyARYesterday() {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Busca state guardado en localStorage de un dia anterior del mismo legajo
  // que tenga una matriz abierta sin cerrar (E sin C posterior = matrixNeedsC=true).
  // Retorna { dia, state } del dia mas reciente que cumpla, o null.
  // NO consulta Supabase. Aprovecha que el cleanup retiene 10 dias laborables.
  function getStateAnteriorConMatrizAbierta(legajo) {
    const legStr = String(legajo).trim();
    const todayStr = dayKeyAR();
    let mejor = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX + "::")) continue;
      const parts = k.split("::");
      if (parts.length < 3) continue;
      const dia = parts[1];
      const leg = parts[2];
      if (leg !== legStr || dia === todayStr) continue;
      try {
        const s = JSON.parse(localStorage.getItem(k));
        if (!s || !s.lastMatrix?.texto || !s.matrixNeedsC) continue;
        if (!mejor || dia > mejor.dia) mejor = { dia, state: s };
      } catch { /* skip */ }
    }
    return mejor;
  }

  // Evalua si mostrar el banner "Continuar Cajon" para el legajo dado.
  // Condiciones: state dia anterior tiene matriz abierta (matrixNeedsC=true) Y
  // operario eligio "voy a seguir manana" en TD (terminoConContinuacion=true).
  // Devuelve info para usar en el banner, o null.
  function evaluarBannerContinuar(legajo) {
    const state = readState(legajo);
    // Si ya hay caj activo hoy o ya se descarto el banner -> no mostrar
    if (state.lastMatrix || state.lastCajon) return null;
    if (state.continuacionConsultada) return null;

    const emp = empleadosMap.get(legajo);
    if (!emp || !emp.hora_salida) return null;

    const anterior = getStateAnteriorConMatrizAbierta(legajo);
    if (!anterior) return null;
    // Solo si ayer en TD eligio "voy a seguir manana"
    if (!anterior.state.terminoConContinuacion) return null;

    const lastMatrix = anterior.state.lastMatrix;
    const lastCajon  = anterior.state.lastCajon;
    const matriz = String(lastMatrix.texto || "").trim();
    if (!matriz) return null;
    const nombreMatriz = lastMatrix.nombreOverride ||
      matricesMap.get(matriz)?.Matriz || "";

    // tsInicioCajon = el ts MAS RECIENTE entre lastMatrix y lastCajon ayer.
    // Si lastCajon es null, usar lastMatrix.ts.
    const tsLM = lastMatrix.ts || "";
    const tsLC = lastCajon?.ts || "";
    let tsInicioCajon = tsLM;
    if (tsLC && tsLC > tsLM) tsInicioCajon = tsLC;
    if (!tsInicioCajon) return null;

    // Calcular segPostAyer = hora_salida_ayer - tsInicioCajon
    const fechaAyer = new Date(anterior.dia + "T00:00:00-03:00");
    const dHorSal = timeStrToDate(emp.hora_salida, fechaAyer);
    const dInicio = new Date(tsInicioCajon);
    if (isNaN(dHorSal) || isNaN(dInicio)) return null;
    const segPostAyer = Math.max(0, Math.floor((dHorSal - dInicio) / 1000));

    return {
      legajo,
      matriz,
      nombreMatriz,
      fechaAyer: anterior.dia,
      tsInicioCajon,
      segPostAyer,
      horaSalidaAyer: emp.hora_salida,
      horaEntradaHoy: emp.hora_entrada || "08:30:00"
    };
  }

  // (v1.8.33) Inyecta dinamicamente el boton "Continuar Matriz" ENTRE E y C.
  // Llamada desde renderOptions() despues de pintar E/C.
  function inyectarBotonContinuarEnRow1() {
    const row1 = document.getElementById("row1");
    if (!row1) return;
    // Volver a row-2 por default
    row1.classList.remove("row-3");
    row1.classList.add("row-2");
    const leg = legajoKey();
    if (!leg) return;
    const info = evaluarBannerContinuar(leg);
    if (!info) return;
    // Hay matriz pendiente: agregar boton ENTRE E y C
    const d = document.createElement("div");
    d.className = "box box-cont";
    d.id = "btnContinuarCajonRow1";
    const min = Math.round(info.segPostAyer / 60);
    d.innerHTML =
      `<div class="box-title">&#9889; Continuar Matriz</div>` +
      `<div class="box-desc">Mat ${info.matriz} &mdash; ayer ${min} min</div>`;
    d.dataset.legajo = info.legajo;
    d.dataset.matriz = info.matriz;
    d.dataset.nombreMatriz = info.nombreMatriz;
    d.dataset.fechaAyer = info.fechaAyer;
    d.dataset.tsInicioCajon = info.tsInicioCajon;
    d.dataset.segPostAyer = String(info.segPostAyer);
    d.dataset.horaSalidaAyer = info.horaSalidaAyer;
    d.dataset.horaEntradaHoy = info.horaEntradaHoy;
    d.addEventListener("click", handleClickBotonContinuar);
    // Insertar antes del segundo hijo (C). Row1 actual: [E, C] -> queda [E, Cont, C]
    const cBox = row1.querySelector('.box[data-code="C"]');
    if (cBox) {
      row1.insertBefore(d, cBox);
    } else {
      row1.appendChild(d);
    }
    // Cambiar grid a 3 cols
    row1.classList.remove("row-2");
    row1.classList.add("row-3");
  }

  // (v1.8.31) True si actualmente hay un boton "Continuar Cajon" pendiente en row1.
  function hayContinuarPendiente() {
    const leg = legajoKey();
    if (!leg) return false;
    return !!evaluarBannerContinuar(leg);
  }

  // (v1.8.31) Muestra modal de advertencia cuando el operario aprieta otra opcion
  // teniendo el banner Continuar visible. Pide codigo de logistica (151515).
  // Si el codigo es correcto -> ejecuta el callback (la opcion que apreto).
  // Si cancela / codigo mal -> no hace nada.
  const CODIGO_LOGISTICA_IGNORAR_CONT = "151515";
  function mostrarAdvertenciaIgnorarContinuar(onConfirm) {
    let modal = document.getElementById("advIgnorarContModal");
    if (!modal) {
      // Construir el modal si no existe
      modal = document.createElement("div");
      modal.id = "advIgnorarContModal";
      modal.className = "adv-cont-modal hidden";
      modal.innerHTML =
        '<div class="adv-cont-card">' +
        '  <div class="adv-cont-header">&#9888; Caj&oacute;n pendiente de continuar</div>' +
        '  <div class="adv-cont-body">' +
        '    <p>Ten&eacute;s un caj&oacute;n pendiente del d&iacute;a anterior.</p>' +
        '    <p>Si segu&iacute;s con otra opci&oacute;n, <b>perd&eacute;s la posibilidad de continuar el caj&oacute;n</b> (no va a aparecer m&aacute;s el bot&oacute;n).</p>' +
        '    <p><b>Avis&aacute; a Log&iacute;stica</b> antes de seguir. Te van a dar un c&oacute;digo:</p>' +
        '    <input type="text" id="advIgnorarContCodigo" inputmode="numeric" placeholder="C&oacute;digo de Log&iacute;stica" autocomplete="off">' +
        '    <div class="adv-cont-fb" id="advIgnorarContFb"></div>' +
        '  </div>' +
        '  <div class="adv-cont-footer">' +
        '    <button type="button" class="adv-cont-cancel" id="advIgnorarContCancel">Cancelar</button>' +
        '    <button type="button" class="adv-cont-ok" id="advIgnorarContOk">Continuar con otra opci&oacute;n</button>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(modal);
    }
    const input = modal.querySelector("#advIgnorarContCodigo");
    const fb = modal.querySelector("#advIgnorarContFb");
    const btnCancel = modal.querySelector("#advIgnorarContCancel");
    const btnOk = modal.querySelector("#advIgnorarContOk");
    if (input) input.value = "";
    if (fb) fb.innerText = "";

    function cerrar() { modal.classList.add("hidden"); }
    function handleCancel() { cerrar(); cleanup(); }
    function handleOk() {
      const cod = (input?.value || "").trim();
      if (cod !== CODIGO_LOGISTICA_IGNORAR_CONT) {
        if (fb) { fb.style.color = "#b91c1c"; fb.innerText = "Código incorrecto. Pedile el código a Logística."; }
        return;
      }
      // Codigo OK -> marcar continuacionConsultada=true para que el boton ya no aparezca
      const leg = legajoKey();
      if (leg) {
        const s = readState(leg);
        s.continuacionConsultada = true;
        writeState(leg, s);
      }
      cerrar();
      cleanup();
      // Ejecutar la accion original (la opcion que apreto)
      if (typeof onConfirm === "function") onConfirm();
      // Re-renderizar para que desaparezca el boton Continuar
      renderOptions();
    }
    function cleanup() {
      btnCancel?.removeEventListener("click", handleCancel);
      btnOk?.removeEventListener("click", handleOk);
    }
    btnCancel?.addEventListener("click", handleCancel);
    btnOk?.addEventListener("click", handleOk);
    modal.classList.remove("hidden");
    setTimeout(() => input?.focus(), 50);
  }

  // Handler del click en el boton "Continuar Cajon".
  // Setea state.cajonContinuado + lastMatrix/lastCajon como si fuera continuacion activa.
  function handleClickBotonContinuar(e) {
    const el = e?.currentTarget || document.getElementById("btnContinuarCajonRow1");
    if (!el) return;
    const leg = el.dataset.legajo;
    const matriz = el.dataset.matriz;
    const nombreMatriz = el.dataset.nombreMatriz || "";
    const fechaAyer = el.dataset.fechaAyer;
    const tsInicioCajon = el.dataset.tsInicioCajon;
    const segPostAyer = Number(el.dataset.segPostAyer || 0);

    const s = readState(leg);
    const tsActivacion = isoNow();
    s.lastMatrix = { opcion: "E", texto: matriz, ts: tsActivacion, nombreOverride: nombreMatriz || null };
    s.lastCajon  = { opcion: "C", texto: matriz, ts: tsActivacion };
    s.matrixNeedsC = true;
    s.continuacionConsultada = true;
    s.cajonContinuado = {
      matriz,
      nombreMatriz,
      fechaAyer,
      tsInicioCajon,
      segPostAyer,
      tsActivacion,
      horaEntradaHoy: el.dataset.horaEntradaHoy || "08:30:00"
    };
    writeState(leg, s);

    // (v1.8.36) Encolar Llegada Tarde si entra despues de hora_entrada.
    // maybeSendLateArrival ya valida que sea primer evento del dia + hora > 08:30.
    // Como ya seteamos lastMatrix/lastCajon antes, el "isFirst" check fallaria.
    // Workaround: llamar antes de setear state? No, queremos que cuente como llegada tarde.
    // Mejor: encolar el LT directamente aqui si corresponde.
    try {
      const day = dayKeyAR();
      const horaEntrada = el.dataset.horaEntradaHoy || "08:30:00";
      const horaEntradaIso = `${day}T${horaEntrada.length === 5 ? horaEntrada + ':00' : horaEntrada}-03:00`;
      const ahora = new Date(tsActivacion);
      const dEntrada = new Date(horaEntradaIso);
      if (!isNaN(dEntrada) && ahora > dEntrada) {
        const segTarde = Math.floor((ahora - dEntrada) / 1000);
        if (segTarde >= 60) {
          const ltPayload = {
            id: uuidv4(), legajo: leg, opcion: "LT", descripcion: "Llegada Tarde",
            texto: "", ts_event: tsActivacion, hs_inicio: horaEntradaIso, matriz: ""
          };
          // Marcar para que maybeSendLateArrival no lo duplique despues
          const s2 = readState(leg);
          s2.lateArrivalSent = true;
          writeState(leg, s2);
          updateStateAfterSend(leg, ltPayload);
          enqueue(ltPayload);
        }
      }
    } catch (e) { console.warn("LT continuar error:", e); }

    renderOptions();      // re-render: el boton desaparecera (continuacionConsultada=true)
    renderMatrizInfo();

    const eEl = document.getElementById("error");
    if (eEl) {
      eEl.style.color = "#16a34a";
      eEl.innerText = `Continuando Matriz ${matriz}. Apreta C cuando termines el cajon.`;
      setTimeout(() => { if (eEl.innerText.startsWith("Continuando")) eEl.innerText = ""; }, 8000);
    }
  }

  /* ================= LOGICA DE ESTADO ================= */
  function computeHsInicio(state) {
    if (state.lastCajon?.ts) return state.lastCajon.ts;
    if (state.lastMatrix?.ts) return state.lastMatrix.ts;
    console.log("DEBUG: No se encontro hs_inicio en state", state);
    return "";
  }

  function updateStateAfterSend(legajo, payload) {
    const s = readState(legajo);

    if (payload.opcion === "E") {
      if (s.lastMatrix && s.lastMatrix.texto !== payload.texto) s.lastCajon = null;
      s.lastMatrix = { opcion: payload.opcion, texto: payload.texto || "", ts: payload.ts_event, nombreOverride: payload.nombreOverride || null };
      s.lastDowntime = null;
      s.matrixNeedsC = true;
      writeState(legajo, s); return;
    }
    if (payload.opcion === "C") {
      s.lastCajon = { opcion: payload.opcion, texto: payload.texto || "", ts: payload.ts_event };
      s.lastDowntime = null;
      s.matrixNeedsC = false;
      // Cerrar continuacion: ya se envio el C que completa el cajon de ayer
      if (s.cajonContinuado) s.cajonContinuado = null;
      writeState(legajo, s); return;
    }
    if (["RM", "RD"].includes(payload.opcion)) {
      s.lastDowntime = null;
      writeState(legajo, s); return;
    }
    // (v1.8.47) PM cae aca (tiempo muerto): 1er envio abre, 2do cierra. RM salio arriba.
    if (isDowntime(payload.opcion)) {
      const item = { opcion: payload.opcion, texto: payload.texto || "", ts: payload.ts_event };
      if (!s.lastDowntime) s.lastDowntime = item;
      else if (sameDowntime(s.lastDowntime, payload)) s.lastDowntime = null;
      else s.lastDowntime = item;
      writeState(legajo, s); return;
    }
    writeState(legajo, s);
  }

  /* ================= LLEGADA TARDE ================= */
  function maybeSendLateArrival(legajo) {
    const s = readState(legajo);
    const isFirst = !s.last2.length && !s.lastMatrix && !s.lastCajon && !s.lastDowntime;
    if (!isFirst || s.lateArrivalSent || s.lateArrivalDiscarded) return;

    const nowMin = nowMinutesAR();
    if (nowMin <= 8 * 60 + 30) {
      s.lateArrivalDiscarded = true;
      writeState(legajo, s); return;
    }

    const day = dayKeyAR();
    const payload = {
      id: uuidv4(), legajo, opcion: "LT", descripcion: "Llegada Tarde",
      texto: "", ts_event: isoNow(), hs_inicio: `${day}T08:30:00-03:00`, matriz: ""
    };
    s.lateArrivalSent = true;
    writeState(legajo, s);
    updateStateAfterSend(legajo, payload);
    enqueue(payload);
  }

  /* ================= ENVIAR ================= */
  async function sendFast() {
    if (!selected) return;
    const legajo = legajoKey();
    if (!legajo) { alert("Ingresa el numero de legajo"); return; }

    maybeSendLateArrival(legajo);

    let texto = String(textInput.value || "").trim();
    const stateBefore = readState(legajo);

    // (v1.8.47) RM (Rotura Matriz) NO es un envio normal ni un tiempo muerto: dispara
    // el flujo cantidad -> cerrar cajon -> marcar rotura -> Cambiar Matriz.
    if (selected.code === "RM") {
      await ejecutarFlujoRM(legajo);
      return;
    }

    // (v1.8.47) PCM: al CERRAR la consulta (2do toque) abre el popup Rota / no Rota.
    if (selected.code === "PCM" && stateBefore.lastDowntime && stateBefore.lastDowntime.opcion === "PCM") {
      await manejarCierrePCM(legajo);
      return;
    }

    if (selected.input.show) {
      let ok;
      if (selected.code === "C" && isMatrix501(stateBefore)) {
        ok = /^\d+(?:[.,]\d+)?$/.test(texto);
      } else {
        ok = /^[0-9]+$/.test(texto);
      }
      if (!ok) {
        errorEl.style.color = "red";
        errorEl.innerText = (selected.code === "C" && isMatrix501(stateBefore))
          ? "Para matriz 501: usar coma o punto (ej: 12,5)" : "Solo se permiten numeros enteros";
        return;
      }
    }

    if (selected.code === "E") {
      if (stateBefore.matrixNeedsC) {
        alert("Antes de iniciar una nueva matriz (E), envia al menos 1 Cajon (C).");
        return;
      }
      if (!matricesMap.has(texto)) {
        alert(`La matriz ${texto} no existe. Verifica el numero.`);
        return;
      }
      // matrices con variante: al iniciar E se elige el tipo (cambia el codigo de matriz)
      const MATRICES_CON_VARIANTE = {
        "12": {
          pregunta: "Doblado Mango Plano - Selecciona el tipo:",
          opciones: [
            { label: "Loke (LK)",   matriz: "12"  },
            { label: "Sin Marca",   matriz: "12B" },
            { label: "Chef",        matriz: "12C" },
          ],
        },
        "10": {
          pregunta: "Matriz 10 - Selecciona el tipo de cuchilla:",
          opciones: [
            { label: "Varilla c/ Cuchilla Recta",  matriz: "10", nombre: "Varilla c/ Cuchilla Recta (HF11)" },
            { label: "Varilla c/ Cuchilla Curva",   matriz: "10B", nombre: "Varilla c/ Cuchilla Curva (HF15)" },
          ],
        },
        // Matriz 28 (Corte Cuerpo Uña): el cuerpo va a Cromar (JF5) o a Pintar (JF2).
        // El operario escribe 28 y elige; Cromar registra el codigo interno 28B.
        "28": {
          pregunta: "Corte Cuerpo Uña - ¿Para Cromar o Pintar?",
          opciones: [
            { label: "Pintar (JF2)", matriz: "28",  nombre: "Corte Cuerpo Uña p/Pintar (JF2)" },
            { label: "Cromar (JF5)", matriz: "28B", nombre: "Corte Cuerpo Uña p/Cromar (JF5)" },
          ],
        },
        "39": {
          pregunta: "Matriz 39 - Selecciona el tipo:",
          opciones: [
            { label: "Cpo Sacacorcho CON Marca", matriz: "39", nombre: "Cerrado Cuerpo Sacacorcho (Con Marca)" },
            { label: "Cpo Sacacorcho SIN Marca", matriz: "39B", nombre: "Cerrado Cuerpo Sacacorcho (Sin Marca)" },
          ],
        },
        "79": {
          pregunta: "Matriz 79 - Corte Destapacorona:",
          opciones: [
            { label: "Loeke",     matriz: "79", nombre: "Corte Destapacorona Loeke" },
            { label: "Sin Marca", matriz: "79B", nombre: "Corte Destapacorona Sin Marca" },
          ],
        },
        "80": {
          pregunta: "Matriz 80 - Estampa Destapacorona:",
          opciones: [
            { label: "Loeke",     matriz: "80", nombre: "Estampa Destapacorona Loeke" },
            { label: "Sin Marca", matriz: "80B", nombre: "Estampa Destapacorona Sin Marca" },
          ],
        },
        "81": {
          pregunta: "Matriz 81 - Doblado Destapacorona:",
          opciones: [
            { label: "LK",       matriz: "81", nombre: "Doblado Destapacorona LK" },
            { label: "Sin Marca", matriz: "81B", nombre: "Doblado Destapacorona Sin Marca" },
          ],
        },
        "127": {
          pregunta: "Matriz 127 - Selecciona el tipo:",
          opciones: [
            { label: "LK",  matriz: "127", nombre: "Estampado Pza Gr Sacaf LK" },
            { label: "Chef", matriz: "127B", nombre: "Estampado Pza Gr Sacaf CH" },
          ],
        },
      };
      if (MATRICES_CON_VARIANTE[texto] && !_varianteYaElegida) {
        const cfg = MATRICES_CON_VARIANTE[texto];
        const varianteElegida = await mostrarSelectorVariante(cfg.pregunta, cfg.opciones);
        if (!varianteElegida) return;
        texto = varianteElegida.matriz;
        textInput.value = texto;
        _varianteYaElegida = true;
        if (varianteElegida.nombre) {
          _nombreMatrizOverride = varianteElegida.nombre;
        }
      }
      if (!matricesMap.has(texto)) {
        alert(`La matriz ${texto} no existe. Verifica el numero.`);
        _varianteYaElegida = false;
        _nombreMatrizOverride = null;
        return;
      }
      const matCheck = matricesMap.get(texto);
      if (matCheck && (Number(matCheck.Tiempo_Historico) === 0 || matCheck.Tiempo_Historico === null)) {
        const emp = empleadosMap.get(String(legajo).trim());
        const nombre = emp?.Empleado || "Legajo " + legajo;
        enviarAlertaWA({
          problema: "Matriz sin Tiempo",
          matriz: texto,
          descripcion: matCheck.Matriz || "?",
          operario: nombre,
          horaEvento: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })
        });
      }
    }
    if (selected.code === "CM" || selected.code === "TRM") {
      if (!matricesMap.has(texto)) {
        alert(`La matriz ${texto} no existe. Verifica el numero.`);
        return;
      }
    }
    if (["C", "RM", "PM", "RD", "PCM"].includes(selected.code)) {
      if (!stateBefore.lastMatrix?.texto) {
        alert('Primero envia "E (Empece Matriz)" para registrar una matriz.');
        return;
      }
    }

    if (stateBefore.lastDowntime && !sameDowntime(stateBefore.lastDowntime, { opcion: selected.code, texto })) {
      alert(`Hay un Tiempo Muerto pendiente (${stateBefore.lastDowntime.opcion}). Envia el MISMO para cerrarlo.`);
      return;
    }

    let textoToSend = texto;
    if (selected.code === "C" && isMatrix501(stateBefore)) textoToSend = normalizeToComma(texto);

    const tsEvent = isoNow();
    const payload = {
      id: uuidv4(), legajo, opcion: selected.code, descripcion: selected.desc,
      texto: textoToSend, ts_event: tsEvent,
      hs_inicio: "", matriz: ""
    };

    // nombreOverride para variantes
    if (selected.code === "E" && _nombreMatrizOverride) {
      payload.nombreOverride = _nombreMatrizOverride;
      _nombreMatrizOverride = null;
    }

    if (["C", "RM", "PM", "RD"].includes(payload.opcion)) {
      payload.matriz = stateBefore.lastMatrix?.texto || "";
      if (stateBefore.lastMatrix?.nombreOverride) {
        payload.nombreOverride = stateBefore.lastMatrix.nombreOverride;
      }
    }
    if (payload.opcion === "C") {
      payload.hs_inicio = computeHsInicio(stateBefore);
      if (!payload.hs_inicio && stateBefore.last2.length > 0) {
        payload.hs_inicio = stateBefore.last2[0].ts || "";
      }
      // CONTINUACION CROSS-DIA: si hay cajonContinuado activo, propagar al procesador
      if (stateBefore.cajonContinuado) {
        payload.cajon_continuado = {
          matriz: stateBefore.cajonContinuado.matriz,
          fechaAyer: stateBefore.cajonContinuado.fechaAyer,
          // (v1.8.32) tsInicioCajon = ts del E (o lastCajon) de ayer = Hora_Inicio en BD
          tsInicioCajon: stateBefore.cajonContinuado.tsInicioCajon,
          segPostAyer: stateBefore.cajonContinuado.segPostAyer,
          tsActivacion: stateBefore.cajonContinuado.tsActivacion
        };
      }
    }
    if (payload.opcion === "RD") {
      payload.hs_inicio = tsEvent;
    }
    // TM (incluye ahora RM/PM): al CERRAR, hs_inicio = ts de apertura -> se mide la duracion.
    if (stateBefore.lastDowntime && sameDowntime(stateBefore.lastDowntime, payload)) {
      payload.hs_inicio = stateBefore.lastDowntime.ts || "";
    }

    // (v1.8.47) PM es tiempo muerto: la alerta "Paro Matriz" se manda solo al ABRIR.
    // (RM ya no llega aca: se intercepta arriba y dispara ejecutarFlujoRM con su alerta.)
    const abriendoPM = payload.opcion === "PM" &&
      !(stateBefore.lastDowntime && sameDowntime(stateBefore.lastDowntime, payload));
    if (abriendoPM) {
      const emp = empleadosMap.get(String(legajo).trim());
      const nombre = emp?.Empleado || "Legajo " + legajo;
      const matNum = payload.matriz || "?";
      const matInfo = matricesMap.get(matNum);
      const matNombre = matInfo?.Matriz || "";
      const tipo = "Paro Matriz";
      enviarAlertaWA({
        problema: tipo,
        matriz: matNum,
        descripcion: matNombre,
        operario: nombre,
        horaEvento: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })
      });
    }

    btnEnviar.disabled = true;
    btnEnviar.innerText = "Enviando...";

    updateStateAfterSend(legajo, payload);
    enqueue(payload);
    // (v1.8.47) Fin del flujo Rotura Matriz: al enviar el Cambiar Matriz, limpiar pendingRM.
    if (payload.opcion === "CM") {
      const sPend = readState(legajo);
      if (sPend.pendingRM) { sPend.pendingRM = null; writeState(legajo, sPend); }
    }
    renderSummary();

    // (v1.8.40) Registrar las unidades del cajon en el stock compartido (si aplica).
    // Idempotente por payload.id; si falla queda encolado para reintento.
    if (payload.opcion === "C" && stockActivo(payload.matriz)) {
      const completar = !!(document.getElementById("cajonCompletoChk")?.checked);
      registrarUnidadesStock(payload.matriz, Number(texto), completar, legajo, payload.id);
    }
    const chkReset = document.getElementById("cajonCompletoChk");
    if (chkReset) chkReset.checked = false;

    // (v1.8.49) Matriz alimentador (Tipo_Matriz='A'): al cerrar un cajon, en vez de
    // volver directo, preguntar "Continuar Produciendo / Cambiar Matriz".
    if (payload.opcion === "C" && esAlimentador(payload.matriz) && puedeCM(legajo)) {
      selected = null;
      selectedArea.classList.add("hidden");
      matrizInfo.classList.add("hidden");
      errorEl.innerText = "";
      document.querySelectorAll(".box.selected").forEach(x => x.classList.remove("selected"));
      btnEnviar.disabled = false; btnEnviar.innerText = "Enviar";
      try { await flushQueue(); await flushStockQueue(); } catch (_e) {}
      await popupAlimentadorCajon(legajo, { desdeRotura: false });
      return;
    }

    selected = null;
    selectedArea.classList.add("hidden");
    optionsScreen.classList.add("hidden");
    legajoScreen.classList.remove("hidden");
    matrizInfo.classList.add("hidden");
    errorEl.innerText = "";
    document.querySelectorAll(".box.selected").forEach(x => x.classList.remove("selected"));

    try { await flushQueue(); await flushStockQueue(); await flushBalancinQueue(); }
    finally { btnEnviar.disabled = false; btnEnviar.innerText = "Enviar"; }
  }

  /* ================= PARE CONSULTA MATRIZ (PCM) / ROTURA (RM) ================= */
  // (v1.8.47) Modal OBLIGATORIO (sin cancelar) para pedir las unidades con las que
  // se cierra el cajon. Devuelve siempre el texto ingresado (string).
  function pedirCantidadCajon(es501) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center";
      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff;border-radius:20px;padding:32px 28px;max-width:480px;width:92%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)";
      const titulo = document.createElement("p");
      titulo.style.cssText = "font-size:28px;font-weight:800;margin:0 0 22px;line-height:1.25";
      titulo.textContent = "Unidades hechas para cerrar el cajon";
      modal.appendChild(titulo);
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = es501 ? "decimal" : "numeric";
      input.placeholder = es501 ? "Ej: 12,5" : "Ej: 1500";
      input.style.cssText = "width:100%;box-sizing:border-box;padding:18px;font-size:28px;text-align:center;border:2px solid #c9d1d9;border-radius:14px;margin-bottom:8px";
      modal.appendChild(input);
      const err = document.createElement("div");
      err.style.cssText = "color:#dc2626;font-size:15px;min-height:18px;margin-bottom:14px";
      modal.appendChild(err);
      const re = es501 ? /^\d+(?:[.,]\d+)?$/ : /^\d+$/;
      const confirmar = () => {
        const v = String(input.value || "").trim();
        if (!re.test(v)) { err.textContent = es501 ? "Numero valido (coma o punto)" : "Solo numeros enteros"; return; }
        overlay.remove(); resolve(v);
      };
      const btnOk = document.createElement("button");
      btnOk.textContent = "Confirmar y cerrar cajon";
      btnOk.style.cssText = "display:block;width:100%;padding:24px;border:1px solid #1aa34a;border-radius:14px;font-size:25px;font-weight:800;cursor:pointer;background:#eafff1;color:#0b6b2c";
      btnOk.onclick = confirmar;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmar(); });
      modal.appendChild(btnOk);
      // (v1.8.47) SIN boton Cancelar: la carga de unidades es obligatoria.
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      setTimeout(() => { try { input.focus(); } catch (_e) {} }, 50);
    });
  }

  function volverAInicio() {
    selected = null;
    selectedArea.classList.add("hidden");
    optionsScreen.classList.add("hidden");
    legajoScreen.classList.remove("hidden");
    matrizInfo.classList.add("hidden");
    errorEl.innerText = "";
    document.querySelectorAll(".box.selected").forEach(x => x.classList.remove("selected"));
    renderSummary();
  }

  // (v1.8.53) Modal de Cambiar Matriz: pide el numero de la matriz nueva Y el balancin
  // donde se coloca (lista de balancines activos). Valida ambos. Devuelve
  // { matriz, balancin } o null si cancela.
  function pedirMatrizYBalancinModal() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center";
      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff;border-radius:20px;padding:32px 28px;max-width:480px;width:92%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)";
      const titulo = document.createElement("p");
      titulo.style.cssText = "font-size:28px;font-weight:800;margin:0 0 22px;line-height:1.25";
      titulo.textContent = "Cambiar Matriz";
      modal.appendChild(titulo);

      const lblM = document.createElement("div");
      lblM.style.cssText = "font-size:18px;font-weight:700;color:#334155;text-align:left;margin-bottom:6px";
      lblM.textContent = "Matriz nueva";
      modal.appendChild(lblM);
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "Ej: 110";
      input.style.cssText = "width:100%;box-sizing:border-box;padding:18px;font-size:28px;text-align:center;border:2px solid #c9d1d9;border-radius:14px;margin-bottom:14px";
      modal.appendChild(input);

      const lblB = document.createElement("div");
      lblB.style.cssText = "font-size:18px;font-weight:700;color:#334155;text-align:left;margin-bottom:6px";
      lblB.textContent = "En que balancin";
      modal.appendChild(lblB);
      const sel = document.createElement("select");
      sel.style.cssText = "width:100%;box-sizing:border-box;padding:16px;font-size:22px;border:2px solid #c9d1d9;border-radius:14px;margin-bottom:8px;background:#fff";
      const activos = balancinesActivos();
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = activos.length ? "Elegi un balancin…" : "(no hay balancines cargados)";
      sel.appendChild(ph);
      activos.forEach(b => {
        const opt = document.createElement("option");
        opt.value = String(b.Num);
        opt.textContent = (b.Tipo || "Balancin") + " " + b.Num;
        sel.appendChild(opt);
      });
      modal.appendChild(sel);

      const err = document.createElement("div");
      err.style.cssText = "color:#dc2626;font-size:16px;min-height:20px;margin-bottom:14px";
      modal.appendChild(err);

      const confirmar = () => {
        const m = String(input.value || "").trim();
        if (!/^[0-9]+$/.test(m)) { err.textContent = "Matriz: solo numeros enteros"; return; }
        if (!matricesMap.has(m)) { err.textContent = "La matriz " + m + " no existe"; return; }
        const b = String(sel.value || "").trim();
        if (!b) { err.textContent = "Elegi el balancin"; return; }
        overlay.remove(); resolve({ matriz: m, balancin: b });   // (v1.8.56) Num alfanumerico
      };
      const btnOk = document.createElement("button");
      btnOk.textContent = "Enviar";
      btnOk.style.cssText = "display:block;width:100%;padding:24px;margin-bottom:10px;border:1px solid #1d4ed8;border-radius:14px;font-size:25px;font-weight:800;cursor:pointer;background:#eff6ff;color:#1e3a8a";
      btnOk.onclick = confirmar;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmar(); });
      modal.appendChild(btnOk);
      const btnCancel = document.createElement("button");
      btnCancel.textContent = "Cancelar";
      btnCancel.style.cssText = "display:block;width:100%;padding:14px;border:none;background:transparent;color:#888;font-size:16px;cursor:pointer";
      btnCancel.onclick = () => { overlay.remove(); resolve(null); };
      modal.appendChild(btnCancel);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      setTimeout(() => { try { input.focus(); } catch (_e) {} }, 50);
    });
  }

  // (v1.8.53) "Cambiar Matriz" (boton CM y popups de terminar cajon / PCM-Rota): abre el
  // modal matriz + balancin. Al confirmar: asigna la matriz al balancin (y la libera de
  // otros) via RPC, y registra el evento CM reutilizando sendFast.
  async function abrirCambiarMatriz() {
    const legajo = legajoKey();
    const res = await pedirMatrizYBalancinModal();
    if (res === null) {
      // Cancelo: no cambia matriz. Cierra el flujo Rotura si estaba pendiente.
      const s = readState(legajo);
      if (s.pendingRM) { s.pendingRM = null; writeState(legajo, s); }
      volverAInicio();
      return;
    }
    // Asignar matriz -> balancin (RPC + cola de reintento; update local optimista).
    asignarMatrizBalancin(res.balancin, res.matriz);
    // Registrar el evento Cambiar Matriz (valida, encola, limpia pendingRM, navega al inicio).
    selected = OPTIONS.find(o => o.code === "CM");
    textInput.value = res.matriz;
    await sendFast();
  }

  // (v1.8.49) Popup post-cajon SOLO para matrices alimentador (Tipo_Matriz='A'):
  // "Continuar Produciendo" (sigue en la misma matriz) o "Cambiar Matriz" (abre CM).
  // Reemplaza el auto-seleccionar Cambiar Matriz del flujo Rotura para esas matrices.
  async function popupAlimentadorCajon(legajo, opts) {
    const desdeRotura = !!(opts && opts.desdeRotura);
    const el = await mostrarSelectorVariante("Cajon cerrado. ¿Que queres hacer?", [
      { label: "Continuar Produciendo", val: "SEGUIR" },
      { label: "Cambiar Matriz", val: "CM" }
    ], true);   // sin boton Cancelar: los dos caminos son no destructivos
    if (el && el.val === "CM") {
      await abrirCambiarMatriz();   // modal matriz nueva; si venia de Rotura, pendingRM se limpia al enviar el CM
      return;
    }
    // Continuar Produciendo: seguir en la misma matriz.
    if (desdeRotura) {
      const s = readState(legajo);
      if (s.pendingRM) { s.pendingRM = null; writeState(legajo, s); }
    }
    volverAInicio();
  }

  // Cierra el TM de la consulta PCM (carga en PCM todo el tiempo desde que se abrio).
  function cerrarPCM(legajo) {
    const s = readState(legajo);
    const dt = s.lastDowntime;
    const cierre = {
      id: uuidv4(), legajo, opcion: "PCM", descripcion: "Pare Consulta Matriz",
      texto: "", ts_event: isoNow(),
      hs_inicio: (dt && dt.opcion === "PCM") ? (dt.ts || "") : "", matriz: ""
    };
    updateStateAfterSend(legajo, cierre);   // sameDowntime(PCM,PCM) => cierra lastDowntime
    enqueue(cierre);
    renderSummary();
  }

  // (v1.8.47) FLUJO ROTURA MATRIZ (RM): NO es tiempo muerto. Es lo mismo apretar el
  // boton RM que elegir "Matriz Rota" en el popup de PCM. Persistente ante F5 via
  // state.pendingRM. Pasos: pide unidades (obligatorio) -> cierra el cajon completo
  // (suma stock) -> marca la rotura (evento + alerta WhatsApp) -> abre Cambiar Matriz.
  async function ejecutarFlujoRM(legajo) {
    const s0 = readState(legajo);
    const matriz = s0.lastMatrix?.texto || "";
    if (!matriz) {
      alert('Primero envia "E (Empece Matriz)" para registrar una matriz.');
      return;
    }
    const s = readState(legajo);
    s.pendingRM = { matriz, cajonHecho: false };
    writeState(legajo, s);
    await pasoCantidadYCajonRM(legajo);
  }

  // Paso resumible: pide la cantidad y cierra el cajon + rotura; luego abre Cambiar Matriz.
  async function pasoCantidadYCajonRM(legajo) {
    const s = readState(legajo);
    const matriz = s.lastMatrix?.texto || s.pendingRM?.matriz || "";
    if (!matriz) { volverAInicio(); return; }
    const es501 = isMatrix501(s) || matriz === "501";
    const cant = await pedirCantidadCajon(es501);   // obligatorio (no cancela)

    // 1) Cajon "completo" con esas unidades (suma al stock si aplica)
    const textoC = es501 ? normalizeToComma(cant) : cant;
    const cajon = {
      id: uuidv4(), legajo, opcion: "C", descripcion: "Cajon",
      texto: textoC, ts_event: isoNow(),
      hs_inicio: computeHsInicio(s) || (s.last2[0]?.ts || ""),
      matriz
    };
    if (s.lastMatrix?.nombreOverride) cajon.nombreOverride = s.lastMatrix.nombreOverride;
    if (s.cajonContinuado) {
      cajon.cajon_continuado = {
        matriz: s.cajonContinuado.matriz,
        fechaAyer: s.cajonContinuado.fechaAyer,
        tsInicioCajon: s.cajonContinuado.tsInicioCajon,
        segPostAyer: s.cajonContinuado.segPostAyer,
        tsActivacion: s.cajonContinuado.tsActivacion
      };
    }
    updateStateAfterSend(legajo, cajon);
    enqueue(cajon);
    if (stockActivo(matriz)) {
      registrarUnidadesStock(matriz, Number(String(textoC).replace(",", ".")), true, legajo, cajon.id);
    }

    // 2) Marcar la rotura (evento puntual, NO tiempo muerto) + alerta WhatsApp
    const rm = {
      id: uuidv4(), legajo, opcion: "RM", descripcion: "Rotura Matriz",
      texto: "", ts_event: isoNow(), hs_inicio: "", matriz
    };
    if (s.lastMatrix?.nombreOverride) rm.nombreOverride = s.lastMatrix.nombreOverride;
    enqueue(rm);
    const emp = empleadosMap.get(String(legajo).trim());
    enviarAlertaWA({
      problema: "Rompio Matriz",
      matriz: matriz || "?",
      descripcion: matricesMap.get(matriz)?.Matriz || "",
      operario: emp?.Empleado || ("Legajo " + legajo),
      horaEvento: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })
    });

    // 3) Persistir que el cajon ya se cargo (para F5 -> reabrir directo Cambiar Matriz)
    const s2 = readState(legajo);
    if (s2.pendingRM) { s2.pendingRM.cajonHecho = true; writeState(legajo, s2); }
    renderSummary();

    try { await flushQueue(); await flushStockQueue(); } catch (_e) {}

    // 4) Alimentador (Tipo_Matriz='A'): preguntar Continuar Produciendo / Cambiar Matriz.
    //    Resto: ejecutar Cambiar Matriz directo (el operario tipea la matriz nueva).
    //    pendingRM se limpia al enviar el CM (ver sendFast) o al elegir "Continuar".
    // (v1.8.54) Fin del flujo RM: Cambiar Matriz SOLO si el operario tiene esa capacidad.
    // El operario normal no cambia matriz -> termina en la rotura.
    await finalizarFlujoRM(legajo);
  }

  // (v1.8.54) Cierre del flujo Rotura: con CM abre Cambiar Matriz; sin CM termina.
  async function finalizarFlujoRM(legajo) {
    if (puedeCM(legajo)) {
      await abrirCambiarMatriz();
      return;
    }
    const s = readState(legajo);
    if (s.pendingRM) { s.pendingRM = null; writeState(legajo, s); }
    volverAInicio();
    try { await flushQueue(); await flushStockQueue(); await flushBalancinQueue(); } catch (_e) {}
  }

  // Reanuda un flujo RM que quedo a medias (ej: el operario actualizo con F5).
  async function resumirFlujoRMSiHace(legajo) {
    const s = readState(legajo);
    if (!s.pendingRM) return false;
    if (!s.pendingRM.cajonHecho) { await pasoCantidadYCajonRM(legajo); }
    else { await finalizarFlujoRM(legajo); }   // (v1.8.54) CM solo si tiene permiso
    return true;
  }

  // (v1.8.47) Cierre de "Pare Consulta Matriz": popup Rota / no Rota. El PCM sigue
  // ABIERTO durante el popup (si el operario actualiza con F5, PCM queda abierto y
  // puede volver a decidir). Recien se cierra al elegir.
  async function manejarCierrePCM(legajo) {
    const eleccion = await mostrarSelectorVariante("¿La matriz se rompio?", [
      { label: "Matriz Rota (RM)", val: "RM" },
      { label: "Matriz no Rota (continua)", val: "NO" }
    ]);

    // Cancelar el popup: no decide nada, PCM queda abierto (se puede reintentar).
    if (!eleccion) { return; }

    if (eleccion.val !== "RM") {
      // Matriz no Rota: cierra PCM (mide la consulta) y sigue como estaba.
      cerrarPCM(legajo);
      volverAInicio();
      try { await flushQueue(); await flushStockQueue(); } catch (_e) {}
      return;
    }

    // Matriz Rota: cierra PCM (todo el tiempo hasta aca se carga en PCM) y dispara RM.
    cerrarPCM(legajo);
    await ejecutarFlujoRM(legajo);
  }

  /* ================= HISTORIAL DIAS ANTERIORES ================= */
  const btnHistDias = $("btnHistDias");
  btnHistDias.addEventListener("click", () => {
    const leg = legajoKey();
    if (!leg) { alert("Ingresa tu legajo primero"); return; }

    // Recolectar states de dias anteriores del localStorage
    const dias = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX + "::")) continue;
      const parts = k.split("::");
      const dia = parts[1];
      const legStored = parts[2];
      if (legStored !== leg || dia === today) continue;
      try {
        const s = JSON.parse(localStorage.getItem(k));
        if (s && s.last2 && s.last2.length > 0) dias.push({ dia, items: s.last2 });
      } catch { /* skip */ }
    }

    dias.sort((a, b) => b.dia.localeCompare(a.dia)); // mas reciente primero

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow:auto";

    const modal = document.createElement("div");
    modal.style.cssText = "background:#fff;border-radius:18px;padding:20px;max-width:600px;width:95%;max-height:90vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.3)";

    const btnClose = document.createElement("button");
    btnClose.textContent = "✕";
    btnClose.style.cssText = "float:right;border:none;background:none;font-size:22px;cursor:pointer;color:#666;padding:0;margin:0 0 0 8px;line-height:1";
    btnClose.onclick = () => overlay.remove();
    const header = document.createElement("div");
    header.style.cssText = "margin-bottom:14px";
    header.appendChild(btnClose);
    const titulo2 = document.createElement("span");
    titulo2.style.cssText = "font-size:18px;font-weight:800";
    titulo2.textContent = `Historial - Legajo ${leg}`;
    header.appendChild(titulo2);
    modal.appendChild(header);

    const safeTime = (ts) => {
      if (!ts) return "";
      try {
        const d = new Date(String(ts).replace(/\s(\d{2}:\d{2})/, "T$1"));
        if (isNaN(d.getTime())) return "";
        return d.toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" });
      } catch { return ""; }
    };

    if (dias.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:#888;text-align:center;padding:20px";
      empty.textContent = "Sin historial de dias anteriores";
      modal.appendChild(empty);
    } else {
      // Botones de dia (filtro)
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:6px;margin-bottom:16px";
      const listContainer = document.createElement("div");

      let activeDia = null;

      const renderList = (items) => {
        listContainer.innerHTML = "";
        items.forEach(it => {
          const statusColor = it.status === "sent" ? "#0b6b2c" : it.status === "failed" ? "#9b1c1c" : "#8a5a00";
          const statusText = it.status === "sent" ? "ENVIADO" : it.status === "failed" ? "ERROR" : "PENDIENTE";
          const isFJ = it.opcion === "FJ";
          const showTexto = !isFJ && it.texto;
          const row = document.createElement("div");
          row.style.cssText = "padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:18px";
          row.innerHTML = `<span style="font-weight:700">${it.opcion}${showTexto ? ": " + it.texto : ""}</span> <span style="color:${statusColor};font-size:13px;font-weight:800">${statusText}</span> <span style="color:#888;font-size:14px">${safeTime(it.ts)}</span>`;
          listContainer.appendChild(row);
        });
      };

      dias.forEach(({ dia, items }) => {
        const parts = dia.split("-");
        const diaNum = parts[2] + "/" + parts[1];
        const dow = ["Dom","Lun","Mar","Mie","Jue","Vie","Sab"][new Date(dia + "T12:00:00").getDay()];
        const btn = document.createElement("button");
        btn.style.cssText = "flex:1;padding:8px 2px;border:2px solid #d1d5db;border-radius:8px;background:#f8fafc;font-weight:800;font-size:13px;cursor:pointer;text-align:center;line-height:1.3";
        btn.innerHTML = `${dow}<br>${diaNum}`;
        btn.addEventListener("click", () => {
          activeDia = dia;
          btnRow.querySelectorAll("button").forEach(b => { b.style.background = "#f8fafc"; b.style.borderColor = "#e5e7eb"; b.style.color = "#222"; });
          btn.style.background = "#1e40af"; btn.style.borderColor = "#1e40af"; btn.style.color = "#fff";
          renderList(items);
        });
        btnRow.appendChild(btn);
      });

      modal.appendChild(btnRow);
      modal.appendChild(listContainer);

      // Seleccionar el primer dia por defecto
      btnRow.querySelector("button").click();
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });

  /* ================= TERMINAR DIA ================= */
  const btnTerminarDia = $("btnTerminarDia");
  const terminarDiaModal = $("terminarDiaModal");
  const terminarDiaContent = $("terminarDiaContent");
  const btnCancelTD = $("btnCancelTD");
  const btnConfirmTD = $("btnConfirmTD");

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getTodaySummaryForLegajo(legajo) {
    const state = readState(legajo);
    const counts = {};
    let total = 0;
    for (const it of state.last2) {
      if (it.opcion === "FJ") continue;
      counts[it.opcion] = (counts[it.opcion] || 0) + 1;
      total++;
    }
    return { total, counts };
  }

  async function bulkSendDayReplay(legajoStr, snapshot) {
    const payloads = (snapshot || [])
      .filter(it => it && it.id && it.opcion !== "FJ")
      .map(it => ({
        id: it.id,
        legajo: legajoStr,
        opcion: it.opcion,
        descripcion: it.descripcion || (OPTIONS.find(o => o.code === it.opcion)?.desc) || "",
        texto: it.texto || "",
        ts_event: it.ts,
        hs_inicio: it.hsInicio || "",
        matriz: it.matriz || ""
      }));
    if (!payloads.length) return { ok: true, count: 0 };
    try {
      const { error } = await sb.from(TABLA_REGISTROS).upsert(payloads, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return { ok: true, count: payloads.length };
    } catch (err) {
      console.warn("[bulkReplay] error:", err.message || err);
      return { ok: false, count: payloads.length, error: err.message || String(err) };
    }
  }

  function terminarDia() {
    const legajoStr = legajoKey();
    if (!legajoStr) { alert("Falta el numero de legajo"); return; }

    const state = readState(legajoStr);
    const summary = getTodaySummaryForLegajo(legajoStr);
    const lastDowntime = state.lastDowntime;
    const lastMatrix = state.lastMatrix;
    const prevFJ = state.last2.find(it => it.opcion === "FJ");

    let html = "";

    if (prevFJ) {
      html += '<div class="td-fj-warn"><b>⚠ Ya cerraste el día hoy.</b><br>Si confirmás, se reemplaza el reporte anterior.</div>';
    }

    html += '<div class="td-section">';
    html += `<div><b>Legajo:</b> ${escapeHtml(legajoStr)}</div>`;
    html += `<div><b>Eventos hoy:</b> ${summary.total}</div>`;
    const opciones = Object.keys(summary.counts).sort();
    if (opciones.length) {
      html += "<ul>";
      for (const op of opciones) {
        const desc = OPTIONS.find(o => o.code === op)?.desc || "";
        html += `<li><b>${escapeHtml(op)}</b>${desc ? " — " + escapeHtml(desc) : ""}: ${summary.counts[op]}</li>`;
      }
      html += "</ul>";
    } else {
      html += '<div style="color:#777;">Sin reportes hoy.</div>';
    }
    html += '</div>';

    if (lastDowntime) {
      const tmDesc = OPTIONS.find(o => o.code === lastDowntime.opcion)?.desc || "";
      html += '<div class="td-warn-tm">';
      html += '<div class="td-warn-tm-title">⛔ Tiempo Muerto abierto</div>';
      html += `<div>Se cierra automáticamente: <b>${escapeHtml(lastDowntime.opcion)}</b>${tmDesc ? " — " + escapeHtml(tmDesc) : ""}${lastDowntime.texto ? ` (a ${escapeHtml(lastDowntime.texto)})` : ""}</div>`;
      html += '</div>';
    }

    // (eliminado v1.8.20) Cajon extra: se quito la pregunta "Hiciste otro cajon
    // sin enviar?". Si el operario no apreto C antes de TD, ese cajon no se carga.
    // Asumimos que el operario siempre cierra con C antes de terminar el dia.

    // (v1.8.25) Si hay matriz abierta sin cerrar, preguntar "vas a seguir manana?"
    // SI -> termina dia normal con flag terminoConContinuacion=true (banner aparece manana)
    // NO -> form para completar (cantidad uni o TM) antes de terminar
    // (v1.8.38) Si ya cargo previamente (apreto Cargar y cancelo TD), NO mostrar form
    //          de nuevo (evitar duplicados). Mostrar mensaje "Ya cargaste X".
    // (v1.8.40) Matrices CON control de cajon (stock): pregunta "¿hiciste un ultimo cajon?".
    //   SI -> unidades (+ cajon completo) => se carga como C del dia y suma a uni_actual.
    //   NO -> que estuvo haciendo => Tiempo Muerto con inicio = fin del ultimo cajon.
    // Reemplaza, para esas matrices, al viejo "¿seguis manana?" + "Continuar Cajon".
    // Las matrices SIN control (501, sin Uni_X_Cajon) mantienen el flujo viejo.
    const matrizTD = lastMatrix?.texto || "";
    const usarUltimoCajon = !!(matrizTD && stockActivo(matrizTD));
    const yaCargoTD = !!(state.tdCargaPreviaListo && state.tdCargaPreviaInfo);

    if (usarUltimoCajon) {
      const matDesc = lastMatrix.nombreOverride || (matricesMap.get(matrizTD)?.Matriz || "");
      if (yaCargoTD) {
        html += '<div class="td-cont-pregunta">';
        html += '<div class="td-cont-title">&#10003; Ya cargaste el cierre</div>';
        html += `<div style="font-weight:700;color:#15803d;margin:8px 0;">${escapeHtml(state.tdCargaPreviaInfo.texto || '')}</div>`;
        html += '<button type="button" id="btnUltFinalizar" class="td-confirm-btn" style="width:100%;margin-top:8px;">Finalizar d&iacute;a</button>';
        html += '</div>';
      } else {
        const falta = faltanteCajon(matrizTD);
        const act = Number(stockRow(matrizTD)?.Uni_Actual) || 0;
        html += '<div class="td-cont-pregunta" id="tdUltBox">';
        html += '<div class="td-cont-title">&iquest;Hiciste un &uacute;ltimo caj&oacute;n?</div>';
        html += `<div class="td-cont-mat">Matriz <b>${escapeHtml(matrizTD)}</b>${matDesc ? " &mdash; " + escapeHtml(matDesc) : ""}<br><small>Faltan ${falta} para completar el caj&oacute;n${act > 0 ? ` (ya hay ${act})` : ""}</small></div>`;
        html += '<div class="td-cont-btns">';
        html += '<button type="button" id="btnUltSi" class="td-cont-btn-si">S&iacute;</button>';
        html += '<button type="button" id="btnUltNo" class="td-cont-btn-no">No</button>';
        html += '</div>';
        html += '<div class="td-cont-feedback" id="tdUltFeedback"></div>';
        // Form SI: unidades + cajon completo
        html += '<div class="td-cont-no-form hidden" id="tdUltSiForm">';
        html += `<div class="td-cont-no-row"><label>&iquest;Cu&aacute;ntas unidades hiciste en ese &uacute;ltimo caj&oacute;n? (Matriz ${escapeHtml(matrizTD)}):</label>`;
        html += '<input type="text" id="tdUltUni" inputmode="numeric" placeholder="Cantidad de unidades"></div>';
        html += '<div class="td-cont-no-row" style="margin-top:6px;"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;color:#9a3412;"><input type="checkbox" id="tdUltCompleto" style="width:18px;height:18px;"> Caj&oacute;n completo (no hay m&aacute;s material &mdash; deja el stock en 0)</label></div>';
        html += '<button type="button" id="btnUltSiCargar" class="td-cont-no-cargar">Cargar y finalizar d&iacute;a</button>';
        html += '</div>';
        // Form NO: que estuvo haciendo
        html += '<div class="td-cont-no-form hidden" id="tdUltNoForm">';
        html += '<div class="td-cont-no-title">&iquest;Qu&eacute; estuviste haciendo en ese tiempo?</div>';
        html += '<div class="td-cont-no-row"><select id="tdUltNoTM"><option value="">-- eleg&iacute; --</option>';
        OPTIONS.filter(o => isDowntime(o.code) && !["E","C","CM"].includes(o.code))
          .forEach(o => { html += `<option value="${escapeHtml(o.code)}">${escapeHtml(o.code)} &mdash; ${escapeHtml(o.desc)}</option>`; });
        html += '</select></div>';
        html += '<button type="button" id="btnUltNoCargar" class="td-cont-no-cargar">Cargar y finalizar d&iacute;a</button>';
        html += '</div>';
        html += '<div class="td-cont-no-feedback" id="tdUltFb2"></div>';
        html += '</div>';
      }
    } else if (lastMatrix && lastMatrix.texto && state.matrixNeedsC) {
      const matDesc = lastMatrix.nombreOverride || (matricesMap.get(lastMatrix.texto)?.Matriz || "");
      if (state.tdCargaPreviaListo && state.tdCargaPreviaInfo) {
        // Ya cargo antes y cancelo TD. Mostrar mensaje en lugar de form.
        html += '<div class="td-cont-pregunta">';
        html += '<div class="td-cont-title">&#10003; Ya cargaste lo que faltaba</div>';
        html += `<div style="font-weight:700;color:#15803d;margin:8px 0;">${escapeHtml(state.tdCargaPreviaInfo.texto || '')}</div>`;
        html += '<div style="font-size:13px;color:#1f2937;">Apret&aacute; <b>Terminar D&iacute;a</b> para finalizar.</div>';
        html += '</div>';
      } else {
        html += '<div class="td-cont-pregunta" id="tdContPregunta">';
        html += '<div class="td-cont-title">&iquest;Vas a seguir ma&ntilde;ana con esta matriz?</div>';
        html += `<div class="td-cont-mat">Matriz <b>${escapeHtml(lastMatrix.texto)}</b>${matDesc ? " &mdash; " + escapeHtml(matDesc) : ""}</div>`;
        html += '<div class="td-cont-btns">';
        html += '<button type="button" id="btnContSi" class="td-cont-btn-si">S&iacute;, sigo ma&ntilde;ana</button>';
        html += '<button type="button" id="btnContNo" class="td-cont-btn-no">No</button>';
        html += '</div>';
        html += '<div class="td-cont-feedback" id="tdContFeedback"></div>';
        html += '</div>';

        // Form caso NO (oculto inicialmente)
        html += '<div class="td-cont-no-form hidden" id="tdContNoForm">';
        html += '<div class="td-cont-no-title">Antes de terminar, complet&aacute; lo que falta:</div>';
        html += `<div class="td-cont-no-row"><label>Cantidad de unidades del caj&oacute;n (Matriz ${escapeHtml(lastMatrix.texto)}):</label>`;
        html += '<input type="text" id="tdContNoUni" inputmode="numeric" placeholder="Cantidad o vac&iacute;o si fue TM"></div>';
        html += '<div class="td-cont-no-row"><label>O cargar Tiempo Muerto:</label>';
        html += '<select id="tdContNoTM"><option value="">-- ninguno --</option>';
        OPTIONS.filter(o => isDowntime(o.code) && !["E","C","CM"].includes(o.code))
          .forEach(o => { html += `<option value="${escapeHtml(o.code)}">${escapeHtml(o.code)} &mdash; ${escapeHtml(o.desc)}</option>`; });
        html += '</select></div>';
        html += '<button type="button" id="btnContNoCargar" class="td-cont-no-cargar">Cargar y habilitar Terminar D&iacute;a</button>';
        html += '<div class="td-cont-no-feedback" id="tdContNoFeedback"></div>';
        html += '</div>';
      }
    }

    terminarDiaContent.innerHTML = html;
    terminarDiaModal.classList.remove("hidden");
    // Wireup handlers (los elementos recien se crearon en el DOM)
    if (usarUltimoCajon) {
      wireUpTDUltimoCajon(legajoStr);
    } else if (lastMatrix && lastMatrix.texto && state.matrixNeedsC) {
      wireUpTDContinuacion(legajoStr);
    }
    // (v1.8.44) El flujo de "ultimo cajon" usa su propio boton unico (cargar+finalizar),
    // asi que ocultamos el boton de pie "Si, terminar dia" en ese caso.
    if (btnConfirmTD) {
      if (usarUltimoCajon) {
        btnConfirmTD.style.display = "none";
      } else {
        btnConfirmTD.style.display = "";
        const requiereEleccion = !!(lastMatrix && lastMatrix.texto && state.matrixNeedsC);
        const yaEligio = !!state.terminoConContinuacion || !!state.tdCargaPreviaListo;
        btnConfirmTD.disabled = requiereEleccion && !yaEligio;
      }
    }
  }

  // Cablea los handlers del form de continuacion dentro del modal TD.
  function wireUpTDContinuacion(legajoStr) {
    const btnSi = document.getElementById("btnContSi");
    const btnNo = document.getElementById("btnContNo");
    const formNo = document.getElementById("tdContNoForm");
    const fb = document.getElementById("tdContFeedback");
    if (btnSi) btnSi.addEventListener("click", () => {
      const s = readState(legajoStr);
      s.terminoConContinuacion = true;
      writeState(legajoStr, s);
      if (fb) {
        fb.style.color = "#15803d";
        fb.innerText = "OK. Mañana al entrar va a aparecer el botón 'Continuar Cajón'.";
      }
      if (btnSi) btnSi.disabled = true;
      if (btnNo) btnNo.disabled = true;
      if (formNo) formNo.classList.add("hidden");
      if (btnConfirmTD) btnConfirmTD.disabled = false;
    });
    if (btnNo) btnNo.addEventListener("click", () => {
      const s = readState(legajoStr);
      s.terminoConContinuacion = false;
      writeState(legajoStr, s);
      if (fb) {
        fb.style.color = "#b91c1c";
        fb.innerText = "Cargá abajo lo que faltaba antes de terminar.";
      }
      if (btnSi) btnSi.disabled = true;
      if (btnNo) btnNo.disabled = true;
      if (formNo) formNo.classList.remove("hidden");
      // TerminarDia queda deshabilitado hasta cargar uni o TM
    });
    const btnCargar = document.getElementById("btnContNoCargar");
    if (btnCargar) btnCargar.addEventListener("click", async () => {
      await handleTDContNoCargar(legajoStr);
    });
  }

  // Encola un C con la cantidad ingresada o un TM con el codigo seleccionado.
  // hs_inicio = max(lastCajon.ts, lastMatrix.ts).
  async function handleTDContNoCargar(legajoStr) {
    const inpUni = document.getElementById("tdContNoUni");
    const selTM = document.getElementById("tdContNoTM");
    const fbNo = document.getElementById("tdContNoFeedback");
    const uniVal = (inpUni?.value || "").trim();
    const tmVal  = (selTM?.value || "").trim();
    // (v1.8.38) Anti-duplicado: si ya cargo previamente, no permitir cargar otra vez
    const sPre = readState(legajoStr);
    if (sPre.tdCargaPreviaListo) {
      if (fbNo) { fbNo.style.color = "#b91c1c"; fbNo.innerText = "Ya cargaste un evento. Apretá Terminar Día o Cancelá."; }
      return;
    }
    if (!uniVal && !tmVal) {
      if (fbNo) { fbNo.style.color = "#b91c1c"; fbNo.innerText = "Cargá cantidad o seleccioná un TM (uno solo)."; }
      return;
    }
    // (v1.8.37) Validacion: solo se permite UNO (no ambos)
    if (uniVal && tmVal) {
      if (fbNo) { fbNo.style.color = "#b91c1c"; fbNo.innerText = "Cargá UNA sola opción: cantidad O TM, no las dos."; }
      return;
    }
    const s = readState(legajoStr);
    const lm = s.lastMatrix;
    if (!lm || !lm.texto) {
      if (fbNo) { fbNo.style.color = "#b91c1c"; fbNo.innerText = "Estado inválido: no hay matriz."; }
      return;
    }
    const tsLM = lm.ts || "";
    const tsLC = s.lastCajon?.ts || "";
    const hsInicio = (tsLC && tsLC > tsLM) ? tsLC : tsLM;
    const ahora = isoNow();

    if (uniVal) {
      // Validar formato
      const isPiedra = String(lm.texto).trim() === "501";
      const re = isPiedra ? /^\d+(?:[.,]\d+)?$/ : /^[0-9]+$/;
      if (!re.test(uniVal)) {
        if (fbNo) { fbNo.style.color = "#b91c1c"; fbNo.innerText = isPiedra ? "Piedra (501): coma o punto" : "Solo enteros"; }
        return;
      }
      const cantNorm = isPiedra ? uniVal.replace(/\./g, ",") : uniVal;
      const cajPayload = {
        id: uuidv4(),
        legajo: legajoStr,
        opcion: "C",
        descripcion: "Cajon",
        texto: cantNorm,
        ts_event: ahora,
        hs_inicio: hsInicio,
        matriz: lm.texto
      };
      if (lm.nombreOverride) cajPayload.nombreOverride = lm.nombreOverride;
      updateStateAfterSend(legajoStr, cajPayload);
      enqueue(cajPayload);
    }
    if (tmVal) {
      const optTM = OPTIONS.find(o => o.code === tmVal);
      const tmPayload = {
        id: uuidv4(),
        legajo: legajoStr,
        opcion: tmVal,
        descripcion: optTM?.desc || tmVal,
        texto: "",
        ts_event: ahora,
        hs_inicio: hsInicio,
        matriz: lm.texto || ""
      };
      updateStateAfterSend(legajoStr, tmPayload);
      enqueue(tmPayload);
    }
    // (v1.8.38) Marcar carga lista + guardar info para mostrar si reabre TD despues
    const s2 = readState(legajoStr);
    s2.tdCargaPreviaListo = true;
    s2.tdCargaPreviaInfo = uniVal
      ? { tipo: "C", texto: `Cajón cerrado con ${uniVal} unidades (Matriz ${s2.lastMatrix?.texto || ""})` }
      : { tipo: tmVal, texto: `Tiempo Muerto: ${(OPTIONS.find(o => o.code === tmVal)?.desc) || tmVal}` };
    writeState(legajoStr, s2);
    if (fbNo) { fbNo.style.color = "#15803d"; fbNo.innerText = "OK. Ya podés apretar Terminar Día."; }
    const btnCargar = document.getElementById("btnContNoCargar");
    if (btnCargar) btnCargar.disabled = true;
    if (btnConfirmTD) btnConfirmTD.disabled = false;
  }

  // (v1.8.40) Handlers de "¿hiciste un último cajón?" (matrices con control de stock).
  function wireUpTDUltimoCajon(legajoStr) {
    const btnSi = document.getElementById("btnUltSi");
    const btnNo = document.getElementById("btnUltNo");
    const siForm = document.getElementById("tdUltSiForm");
    const noForm = document.getElementById("tdUltNoForm");
    const fb = document.getElementById("tdUltFeedback");
    if (btnSi) btnSi.addEventListener("click", () => {
      if (siForm) siForm.classList.remove("hidden");
      if (noForm) noForm.classList.add("hidden");
      if (fb) fb.innerText = "";
    });
    if (btnNo) btnNo.addEventListener("click", () => {
      if (noForm) noForm.classList.remove("hidden");
      if (siForm) siForm.classList.add("hidden");
      if (fb) fb.innerText = "";
    });
    const btnSiCargar = document.getElementById("btnUltSiCargar");
    if (btnSiCargar) btnSiCargar.addEventListener("click", () => handleTDUltimoCajon(legajoStr, true));
    const btnNoCargar = document.getElementById("btnUltNoCargar");
    if (btnNoCargar) btnNoCargar.addEventListener("click", () => handleTDUltimoCajon(legajoStr, false));
    // (v1.8.44) caso "ya cargado" (reabrio TD): boton unico para finalizar
    const btnFin = document.getElementById("btnUltFinalizar");
    if (btnFin) btnFin.addEventListener("click", () => confirmarTerminarDia());
  }

  // (v1.8.44) Carga el cierre del ultimo cajon (si todavia no se cargo) y finaliza
  // el dia en UN solo paso (boton "Cargar y finalizar dia").
  //   esSi=true  -> C con unidades (+ cajon completo) y suma al stock compartido.
  //   esSi=false -> TM elegido, con inicio = fin del ultimo cajon (lastCajon.ts).
  async function handleTDUltimoCajon(legajoStr, esSi) {
    const fb = document.getElementById("tdUltFb2");
    let s = readState(legajoStr);

    if (!s.tdCargaPreviaListo) {
      const lm = s.lastMatrix;
      if (!lm || !lm.texto) {
        if (fb) { fb.style.color = "#b91c1c"; fb.innerText = "Estado inválido: no hay matriz."; }
        return;
      }
      const tsLM = lm.ts || "";
      const tsLC = s.lastCajon?.ts || "";
      const hsInicio = (tsLC && tsLC > tsLM) ? tsLC : tsLM;   // inicio = fin del ultimo cajon
      const ahora = isoNow();

      if (esSi) {
        const uniVal = (document.getElementById("tdUltUni")?.value || "").trim();
        const completo = !!document.getElementById("tdUltCompleto")?.checked;
        if (!/^[0-9]+$/.test(uniVal)) {
          if (fb) { fb.style.color = "#b91c1c"; fb.innerText = "Cargá la cantidad de unidades (solo enteros)."; }
          return;
        }
        const cajPayload = {
          id: uuidv4(), legajo: legajoStr, opcion: "C", descripcion: "Cajon",
          texto: uniVal, ts_event: ahora, hs_inicio: hsInicio, matriz: lm.texto
        };
        if (lm.nombreOverride) cajPayload.nombreOverride = lm.nombreOverride;
        updateStateAfterSend(legajoStr, cajPayload);
        enqueue(cajPayload);
        if (stockActivo(lm.texto)) {
          registrarUnidadesStock(lm.texto, Number(uniVal), completo, legajoStr, cajPayload.id);
        }
        s = readState(legajoStr);
        s.tdCargaPreviaListo = true;
        s.tdCargaPreviaInfo = { tipo: "C", texto: `Último cajón: ${uniVal} unidades (Matriz ${lm.texto})${completo ? " — completo" : ""}` };
        writeState(legajoStr, s);
      } else {
        const tmVal = (document.getElementById("tdUltNoTM")?.value || "").trim();
        if (!tmVal) {
          if (fb) { fb.style.color = "#b91c1c"; fb.innerText = "Elegí qué estuviste haciendo."; }
          return;
        }
        const optTM = OPTIONS.find(o => o.code === tmVal);
        const tmPayload = {
          id: uuidv4(), legajo: legajoStr, opcion: tmVal, descripcion: optTM?.desc || tmVal,
          texto: "", ts_event: ahora, hs_inicio: hsInicio, matriz: lm.texto || ""
        };
        updateStateAfterSend(legajoStr, tmPayload);
        enqueue(tmPayload);
        s = readState(legajoStr);
        s.tdCargaPreviaListo = true;
        s.tdCargaPreviaInfo = { tipo: tmVal, texto: `Tiempo Muerto: ${optTM?.desc || tmVal}` };
        writeState(legajoStr, s);
      }
    }

    // Cargado (ahora o antes) -> finalizar el dia directamente.
    if (fb) { fb.style.color = "#15803d"; fb.innerText = "Finalizando día..."; }
    await confirmarTerminarDia();
  }

  function closeTerminarDia() {
    terminarDiaModal.classList.add("hidden");
  }

  async function confirmarTerminarDia() {
    const legajoStr = legajoKey();
    if (!legajoStr) { closeTerminarDia(); return; }

    if (btnConfirmTD) { btnConfirmTD.disabled = true; btnConfirmTD.textContent = "Procesando..."; }

    try {
      const stateBefore = readState(legajoStr);

      // (eliminado v1.8.20) Validacion y procesamiento de "cajon extra".
      // Si el operario no apreto C antes de TD, ese cajon NO se carga.

      // 1) Bulk replay snapshot del día (best-effort, idempotente)
      const replayRes = await bulkSendDayReplay(legajoStr, stateBefore.last2);

      // 2) Cerrar TM abierto si lo hay
      if (stateBefore.lastDowntime) {
        const ld = stateBefore.lastDowntime;
        const closePayload = {
          id: uuidv4(),
          legajo: legajoStr,
          opcion: ld.opcion,
          descripcion: OPTIONS.find(o => o.code === ld.opcion)?.desc || "",
          texto: ld.texto || "",
          ts_event: isoNow(),
          hs_inicio: ld.ts || "",
          matriz: ""
        };
        updateStateAfterSend(legajoStr, closePayload);
        enqueue(closePayload);
      }

      // 3) (eliminado v1.8.20) Cajon extra ya no se procesa.

      // 4) FJ con id deterministico (upsert merge para overwrite si ya existe)
      //    texto del FJ = snapshot completo del dia para auditoria:
      //    { counts: {opcion: n, ...}, events: [{id, opcion, texto, ts, ...}, ...] }
      //    Permite detectar mensajes perdidos: si un evento esta en events[] pero
      //    no aparece en la tabla de Registros / db_n8n_espejo => se perdio en el envio.
      //    InformesVirgilio/calculo.js ya soporta este formato (lineas 271-281).
      const summaryFinal = getTodaySummaryForLegajo(legajoStr);
      const stateForSnapshot = readState(legajoStr);
      const eventsSnapshot = (stateForSnapshot.last2 || [])
        .filter(it => it && it.opcion !== "FJ")
        .map(it => ({
          id: it.id,
          opcion: it.opcion,
          descripcion: it.descripcion || "",
          texto: it.texto || "",
          ts: it.ts,
          hsInicio: it.hsInicio || "",
          matriz: it.matriz || "",
          nombreOverride: it.nombreOverride || null,
          status: it.status || "",
          sentAt: it.sentAt || "",
          tries: it.tries || 0
        }));
      const fjId = `fj_${legajoStr}_${dayKeyAR()}`;
      const fjTs = isoNow();
      const fjPayload = {
        id: fjId,
        legajo: legajoStr,
        opcion: "FJ",
        descripcion: "Fin de Jornada",
        texto: JSON.stringify({
          counts: summaryFinal.counts,
          events: eventsSnapshot
        }),
        ts_event: fjTs,
        hs_inicio: "",
        matriz: ""
      };

      try {
        const { error } = await sb.from(TABLA_REGISTROS).upsert(fjPayload, { onConflict: "id" });
        if (error) {
          alert("Error al enviar el cierre del día: " + error.message);
          if (btnConfirmTD) { btnConfirmTD.disabled = false; btnConfirmTD.textContent = "Sí, terminar día"; }
          return;
        }
      } catch (err) {
        alert("Error de red al enviar el cierre del día. Intentá de nuevo.");
        if (btnConfirmTD) { btnConfirmTD.disabled = false; btnConfirmTD.textContent = "Sí, terminar día"; }
        return;
      }

      // Reflejar FJ en el historial local (reemplaza FJ anterior si había)
      const sFinal = readState(legajoStr);
      sFinal.last2 = sFinal.last2.filter(it => it.opcion !== "FJ");
      sFinal.last2.unshift({
        id: fjId, legajo: legajoStr, opcion: "FJ", descripcion: "Fin de Jornada",
        texto: fjPayload.texto, ts: fjTs, hsInicio: "", matriz: "",
        status: "sent", sentAt: fjTs
      });
      // (v1.8.20) tdCajonPending ya no se usa, se elimino la pregunta de cajon extra.
      // (v1.8.38) Limpiar flags de carga previa al cerrar dia exitosamente.
      sFinal.tdCargaPreviaListo = false;
      sFinal.tdCargaPreviaInfo = null;
      writeState(legajoStr, sFinal);

      // 5) Forzar flush de la cola (TM cerrado / cajon extra) con deadline 10s.
      //    Si tarda mas, completamos TD igual; los eventos quedan en IDB y
      //    siguen reintentando solos via background sync / flush automatico.
      await Promise.race([
        flushQueue(),
        new Promise(resolve => setTimeout(resolve, 10000))
      ]);

      // 6) Avisar al operario si quedo algo pendiente (red intermitente)
      const pendingAfter = readQueue().length;
      const partes = [];
      if (pendingAfter > 0) partes.push(`${pendingAfter} evento${pendingAfter > 1 ? "s" : ""} en cola`);
      if (!replayRes.ok && replayRes.count > 0) partes.push("re-envio del dia incompleto");
      if (partes.length) {
        alert(`Tu cierre del dia se grabo OK, pero ${partes.join(" y ")}. Se reintentara automaticamente cuando haya red.`);
      }

      // 7) Cerrar modal y volver a pantalla de legajo
      closeTerminarDia();
      backToLegajo();
    } finally {
      if (btnConfirmTD) { btnConfirmTD.disabled = false; btnConfirmTD.textContent = "Sí, terminar día"; }
    }
  }

  /* ================= EVENTOS ================= */
  btnContinuar.addEventListener("click", goToOptions);
  btnBackTop.addEventListener("click", backToLegajo);
  btnBackLabel.addEventListener("click", backToLegajo);
  btnResetSelection.addEventListener("click", resetSelection);
  btnEnviar.addEventListener("click", sendFast);
  if (btnTerminarDia) btnTerminarDia.addEventListener("click", terminarDia);
  if (btnCancelTD) btnCancelTD.addEventListener("click", closeTerminarDia);
  if (btnConfirmTD) btnConfirmTD.addEventListener("click", confirmarTerminarDia);
  if (terminarDiaModal) terminarDiaModal.addEventListener("click", (e) => {
    if (e.target === terminarDiaModal) closeTerminarDia();
  });

  // (v1.8.26) Boton "Continuar Cajon" se inyecta dinamicamente en row1 desde renderOptions().
  // El handler se cablea ahi mismo. No hay event listener global.

  // (v1.8.39) Botones de TEST eliminados — solo necesarios en desarrollo inicial.

  const syncBadgeEl = document.getElementById("syncBadge");
  if (syncBadgeEl) {
    syncBadgeEl.addEventListener("click", async () => {
      syncBadgeEl.style.transform = "scale(0.92)";
      setTimeout(() => { syncBadgeEl.style.transform = ""; }, 120);
      flushQueue();
      if ("serviceWorker" in navigator) {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            await reg.update().catch(() => {});
            // Si hay SW esperando, decirle que tome el control ya
            if (reg.waiting) {
              reg.waiting.postMessage({ type: "SKIP_WAITING" });
            }
          }
        } catch {}
      }
    });
  }
  legajoInput.addEventListener("keydown", e => { if (e.key === "Enter") goToOptions(); });

  let legajoTimer = null;
  legajoInput.addEventListener("input", () => {
    clearTimeout(legajoTimer);
    legajoTimer = setTimeout(renderSummary, 120);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { flushQueue(); flushStockQueue(); }
  });
  window.addEventListener("focus", () => { flushQueue(); flushStockQueue(); });
  window.addEventListener("online", async () => {
    const end = Date.now() + 3000;
    while (Date.now() < end && readQueue().length) await flushQueue();
    flushStockQueue();
  });
  setInterval(() => { flushQueue(); flushStockQueue(); }, 3000);

  /* ================= LOG SW (debug visible en celu) ================= */
  const SW_LOG_KEY = "sw_log_v1";
  function swLog(msg) {
    const ts = new Date().toLocaleTimeString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const line = `[${ts}] ${msg}`;
    console.log("[SW LOG]", line);
    try {
      const arr = JSON.parse(localStorage.getItem(SW_LOG_KEY) || "[]");
      arr.push(line);
      localStorage.setItem(SW_LOG_KEY, JSON.stringify(arr.slice(-100)));
    } catch {}
    renderSwLog();
  }
  function renderSwLog() {
    const el = document.getElementById("swLog");
    if (!el) return;
    try {
      const arr = JSON.parse(localStorage.getItem(SW_LOG_KEY) || "[]");
      if (!arr.length) { el.innerHTML = '<div style="color:#9ca3af;">(sin eventos)</div>'; return; }
      const esc = (s) => String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
      el.innerHTML = arr.slice(-40).reverse().map(l => `<div>${esc(l)}</div>`).join("");
    } catch {}
  }
  const btnClearSwLog = document.getElementById("btnClearSwLog");
  if (btnClearSwLog) btnClearSwLog.addEventListener("click", () => {
    try { localStorage.removeItem(SW_LOG_KEY); } catch {}
    renderSwLog();
  });
  renderSwLog();

  // Capturar errores globales en el log
  window.addEventListener("error", (e) => {
    try { swLog(`JS error: ${e.message || "?"} @ ${e.filename || "?"}:${e.lineno || "?"}`); } catch {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      const reason = e.reason;
      const msg = (reason && reason.message) || String(reason || "?");
      swLog(`Promise rejection: ${msg}`);
    } catch {}
  });

  swLog(`Pagina cargada (${LOCAL_VERSION})`);

  /* ================= SERVICE WORKER ================= */
  let __swReloading = false;

  // Brave Android ignora updateViaCache:"none" y devuelve sw.js cacheado
  // en cada reg.update(), asi que nunca dispara updatefound. Fix:
  // fetch manual con cache-buster + comparar CACHE_VERSION + reload si cambio.
  // El reload triggerea un registro fresh de SW que SI funciona.
  //
  // Anti-loop: el CDN puede tener sw.js nuevo pero app.js viejo cacheado.
  // Si recargamos por update hace <COOLDOWN y todavia vemos mismatch, NO recargar.
  // (v1.8.28) En TESTEO usamos 15s para iterar rapido. En PROD queda 60s.
  const UPDATE_RELOAD_KEY = "__lastUpdateReload";
  const IS_TESTEO = /TESTEO/i.test(window.location.href);
  const RELOAD_COOLDOWN_MS = IS_TESTEO ? 15000 : 60000;
  async function checkForUpdateManual() {
    try {
      const res = await fetch(`sw.js?_t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) { swLog(`check manual HTTP ${res.status}`); return; }
      const txt = await res.text();
      const m = txt.match(/CACHE_VERSION\s*=\s*["']([^"']+)["']/);
      if (!m) { swLog("check manual: no se encontro CACHE_VERSION"); return; }
      const remote = m[1];
      swLog(`check manual: local=${LOCAL_VERSION} remote=${remote}`);
      if (remote === LOCAL_VERSION || __swReloading) return;

      const lastReload = parseInt(sessionStorage.getItem(UPDATE_RELOAD_KEY) || "0", 10);
      const sinceMs = Date.now() - lastReload;
      if (lastReload > 0 && sinceMs < RELOAD_COOLDOWN_MS) {
        swLog(`Update ${LOCAL_VERSION}->${remote} pero ya recargamos hace ${Math.round(sinceMs/1000)}s (CDN a mitad de deploy), espero`);
        return;
      }
      __swReloading = true;
      sessionStorage.setItem(UPDATE_RELOAD_KEY, String(Date.now()));
      swLog(`Update detectado ${LOCAL_VERSION} -> ${remote}, reload`);
      setTimeout(() => window.location.reload(), 300);
    } catch (e) {
      swLog(`check manual error: ${(e && e.message) || e}`);
    }
  }

  if ("serviceWorker" in navigator) {
    swLog("serviceWorker disponible - iniciando registro");

    // Si la pagina cargo SIN controller (primer registro de SW en este origin),
    // el controllerchange que viene cuando el SW toma control por primera vez
    // NO es un update real - es solo "ahora hay SW". Skipear el reload en ese
    // caso evita 2-3 reloads consecutivos al primer load del operario.
    const __hadInitialController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      swLog(`controllerchange (ctrl=${navigator.serviceWorker.controller ? "si" : "no"})`);
      if (!__hadInitialController) {
        swLog("primer registro de SW - no recargar");
        return;
      }
      if (__swReloading) return;
      __swReloading = true;
      swLog("Reload por controllerchange");
      setTimeout(() => window.location.reload(), 300);
    });

    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((reg) => {
        swLog(`SW register OK scope=${reg.scope}`);
        if (reg.installing) swLog("Al cargar: hay SW instalando");
        if (reg.waiting)    swLog("Al cargar: hay SW waiting - envio SKIP_WAITING");
        if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        if (reg.active)     swLog(`Al cargar: SW activo (state=${reg.active.state})`);

        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          swLog(`updatefound (installing=${nw ? nw.state : "null"})`);
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            swLog(`SW nuevo state=${nw.state}`);
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              swLog("Envio SKIP_WAITING al SW nuevo");
              nw.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch((err) => {
        swLog(`Error registrando SW: ${(err && err.message) || err}`);
        console.warn("SW no se pudo registrar:", err);
      });

    navigator.serviceWorker.addEventListener("message", (event) => {
      const d = event.data || {};
      if (d.type === "SW_UPDATED") {
        swLog(`SW_UPDATED recibido v=${d.version} - reload`);
        if (__swReloading) return;
        __swReloading = true;
        setTimeout(() => window.location.reload(), 300);
      }
    });

    setInterval(checkForUpdateManual, 60000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdateManual();
    });
    checkForUpdateManual();
  } else {
    swLog("serviceWorker NO disponible en este browser");
  }

  /* ================= INIT ================= */
  updateSyncBadge();
  // reconcilia primero (saca de LS los que el SW ya envio en background) y despues migra
  reconcileQueueWithIDB().then(() => {
    migrateQueueToIDB();
    updateSyncBadge();
  });
  if (readQueue().length > 0) registerBackgroundSync();
  cargarCatalogos().then(() => {
    renderOptions();
    renderSummary();
    renderPending();
    updateSyncBadge();
    console.log(`app.js OK - ${LOCAL_VERSION}`);
  }).catch(err => {
    console.error("Error cargando catalogos:", err);
    renderOptions();
    renderSummary();
    renderPending();
    updateSyncBadge();
  });
});
