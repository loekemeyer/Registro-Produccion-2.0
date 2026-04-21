document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  /* ================= SUPABASE ================= */
  const SUPABASE_URL = "https://hrxfctzncixxqmpfhskv.supabase.co";
  const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhyeGZjdHpuY2l4eHFtcGZoc2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MjQyNjEsImV4cCI6MjA4ODMwMDI2MX0.4L6wguch8UZGhC2VpzrWcCjJGUV-IkYsl9JoCWrOLUs";
  const TABLA_REGISTROS = "Registros Produccion Cervantes";

  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
  let _nombreMatrizOverride = null;
  let _varianteYaElegida = false;

  async function cargarCatalogos() {
    const [empRes, matRes] = await Promise.all([
      sb.from("Empleados").select("*"),
      sb.from("Matrices").select("*")
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
  }

  /* ================= TIEMPO ================= */
  function isoNow() {
    const d = new Date();
    d.setMilliseconds(0);
    return d.toISOString();
  }

  function formatDateTimeAR(iso) {
    try { return new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }); }
    catch { return ""; }
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

  /* ================= KEYS STORAGE ================= */
  const APP_TAG = "_Cervantes";
  const VERSION = "_v2_supa";
  const MAX_DAY_HISTORY = 700;
  const LS_PREFIX = `prod_state${APP_TAG}${VERSION}`;
  const LS_QUEUE = `prod_queue${APP_TAG}${VERSION}`;
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
      matrixNeedsC: false, pcDone: false
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

  /* ================= RESET DIARIO ================= */
  const today = dayKeyAR();
  const lastDay = localStorage.getItem(DAY_GUARD_KEY);
  if (lastDay && lastDay !== today) {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX + "::")) continue;
      const parts = k.split("::");
      if (parts[1] !== today) localStorage.removeItem(k);
    }
  }
  localStorage.setItem(DAY_GUARD_KEY, today);

  /* ================= COLA ================= */
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]"); }
    catch { return []; }
  }
  function writeQueue(arr) { localStorage.setItem(LS_QUEUE, JSON.stringify(arr)); }

  function enqueue(payload) {
    const q = readQueue();
    q.push({ ...payload, __tries: 0, __queuedAt: isoNow() });
    writeQueue(q);

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
  }

  /* ================= ENVIO A SUPABASE ================= */
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

    const { error } = await sb.from(TABLA_REGISTROS).upsert(payload, { onConflict: "id" });
    if (error) throw new Error(error.message);

    // Procesar espejo en background (no bloquea el envío principal)
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
    if (!d) return { dia: 0, mes: 0, quincena: 1 };
    const dia = d.getDate();
    const mes = d.getMonth() + 1;
    return { dia, mes, quincena: dia > 15 ? 2 : 1 };
  }

  async function buscarTiemposMuertos(legajo, hsInicio, horaFin, fecha) {
    const dateInfo = dateFromISO(fecha);
    if (!dateInfo.dia || !dateInfo.mes) return 0;

    const hiTime = timeFromISO(hsInicio);
    const hfTime = timeFromISO(horaFin);
    if (!hiTime || !hfTime) return 0;

    try {
      const { data } = await sb.from("db_n8n_espejo")
        .select("Segundos_Tiempo_Muerto, Hora_Inicio, Hora_Fin")
        .eq("Legajo", legajo)
        .eq("Dia", dateInfo.dia)
        .eq("Mes", dateInfo.mes)
        .eq("Uni", 0)
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
  async function recalcularCajonesDelDia(legajo, dia, mes) {
    try {
      const { data: cajones } = await sb.from("db_n8n_espejo")
        .select("ID_Ejecucion, Hora_Inicio, Hora_Fin, Uni, Segundos_Trabajados, Tiempo_Historico")
        .eq("Legajo", legajo)
        .eq("Dia", dia)
        .eq("Mes", mes)
        .gt("Uni", 0)
        .is("Eliminar", null);

      if (!cajones || !cajones.length) return;

      const { data: tiemposMuertos } = await sb.from("db_n8n_espejo")
        .select("Hora_Inicio, Hora_Fin, Segundos_Tiempo_Muerto")
        .eq("Legajo", legajo)
        .eq("Dia", dia)
        .eq("Mes", mes)
        .eq("Uni", 0)
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
      const esRM_PM_RD_LT = ["RM", "PM", "RD", "LT"].includes(op);

      if (!esCajon && !esTM && !esRM_PM_RD_LT) return;

      const matNum = String(item.matriz || "").trim();
      const matInfo = matricesMap.get(matNum);
      const nombreMatriz = matInfo?.Matriz || "";
      const tiempoPromedio = Number(matInfo?.Tiempo_Promedio || 0);

      // FIX Bug 501: reemplazar coma por punto antes de Number()
      const uni = esCajon ? Number(String(item.texto || 0).replace(",", ".")) : 0;
      const tsEvent = item.ts_event;
      let hsInicio = item.hs_inicio || tsEvent;

      if (!item.hs_inicio) {
        console.warn("DEBUG: hsInicio vacio para matriz", matNum, "usando tsEvent");
      }

      let segTrabajados = diffSeconds(hsInicio, tsEvent);
      if (segTrabajados <= 0) segTrabajados = 1;
      const dateInfo = dateFromISO(tsEvent);
      const horaInicio = timeFromISO(hsInicio);
      const horaFin = timeFromISO(tsEvent);

      let segTiempoMuerto = 0;
      let segTrabajadosNeto = segTrabajados;
      let premio = 0;
      let tiempoToma = 0;
      let anularTiempo = false;

      if (esCajon) {
        segTiempoMuerto = await buscarTiemposMuertos(legajo, hsInicio, tsEvent, tsEvent);
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

      const row = {
        Fecha: tsEvent,
        Legajo: legajo,
        // nombreOverride para variantes (ej: Mat 10 recta/curva)
        Nombre_Matriz: esCajon ? (item.nombreOverride || nombreMatriz) : (esRM_PM_RD_LT ? `${op} ${matNum}` : item.descripcion),
        Matriz: esCajon ? matNum : (esRM_PM_RD_LT ? matNum : op),
        Uni: uni,
        Premio: premio,
        Tiempo_Toma: uni === 0 ? 0 : tiempoToma,
        Tiempo_Historico: tiempoPromedio,
        Nombre_Empleado: nombreEmpleado,
        Hora_Inicio: horaInicio,
        Hora_Fin: horaFin,
        Anular_Tiempo: anularTiempo,
        Segundos_Historico: tiempoPromedio * uni,
        Segundos_Trabajados: esTM ? segTrabajados : segTrabajadosNeto,
        Segundos_Tiempo_Muerto: esTM ? segTrabajados : segTiempoMuerto,
        Dia: dateInfo.dia,
        Mes: dateInfo.mes,
        Quincena: dateInfo.quincena
      };

      row.ID_Ejecucion = item.id ? hashId(item.id) : null;

      const { error } = await sb.from("db_n8n_espejo").insert(row);
      if (error) {
        console.warn("Error insertando en db_n8n_espejo:", error.message);
        // No bloquear: solo loguear y continuar
      }
      if (esTM && dateInfo.dia && dateInfo.mes) {
        await recalcularCajonesDelDia(legajo, dateInfo.dia, dateInfo.mes);
      }
    } catch (err) {
      console.error("Error procesando para espejo:", err);
      // No relanzar: se ejecuta en background y no debe bloquear
    }
  }

  let isFlushing = false;

  async function flushQueue() {
    if (isFlushing || !navigator.onLine) return;
    isFlushing = true;
    try {
      let q = readQueue();
      if (!q.length) return;

      const batch = q.slice(0, 20);
      for (const item of batch) {
        try {
          await postToSupabase(item);
          updateHistoryItem(item.legajo, item.id, { status: "sent", sentAt: isoNow() });
          q = readQueue();
          const idx = q.findIndex(x => x.id === item.id);
          if (idx !== -1) { q.splice(idx, 1); writeQueue(q); }
        } catch (err) {
          item.__tries = (item.__tries || 0) + 1;
          updateHistoryItem(item.legajo, item.id, {
            status: "failed", failedAt: isoNow(),
            tries: item.__tries, lastError: String(err.message || err)
          });
          const idx = q.findIndex(x => x.id === item.id);
          if (idx !== -1) { q[idx] = item; writeQueue(q); }
        }
      }
    } finally {
      isFlushing = false;
      renderSummary();
      renderPending();
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
  function mostrarSelectorVariante(pregunta, opciones) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center";

      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff;border-radius:18px;padding:24px;max-width:340px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)";

      const titulo = document.createElement("p");
      titulo.style.cssText = "font-size:16px;font-weight:700;margin:0 0 16px";
      titulo.textContent = pregunta;
      modal.appendChild(titulo);

      opciones.forEach((op) => {
        const btn = document.createElement("button");
        btn.textContent = op.label;
        btn.style.cssText = "display:block;width:100%;padding:14px;margin-bottom:10px;border:1px solid #c9d1d9;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;background:#f8f9fa";
        // FIX: resolve el objeto completo, no solo op.matriz
        btn.onclick = () => { overlay.remove(); resolve(op); };
        modal.appendChild(btn);
      });

      const btnCancel = document.createElement("button");
      btnCancel.textContent = "Cancelar";
      btnCancel.style.cssText = "display:block;width:100%;padding:10px;border:none;background:transparent;color:#888;font-size:14px;cursor:pointer;margin-top:4px";
      btnCancel.onclick = () => { overlay.remove(); resolve(null); };
      modal.appendChild(btnCancel);

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
    { code: "CM", desc: "Cambiar Matriz", row: 4, input: { show: false } },
    { code: "PM", desc: "Pare Matriz", row: 4, input: { show: false } },
    { code: "RM", desc: "Rotura Matriz", row: 4, input: { show: false } },
    { code: "REM", desc: "Reparando Matriz", row: 4, input: { show: false } }
  ];

  const NON_DOWNTIME = new Set(["E", "C", "RM", "PM", "RD", "LT"]);
  const isDowntime = (op) => !NON_DOWNTIME.has(op);
  const sameDowntime = (a, b) => a && b && a.opcion === b.opcion && (a.texto || "") === (b.texto || "");

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

    if (!s.last2.length) {
      daySummary.className = ""; daySummary.innerHTML = '<div class="day-item"><div class="t1">Historial del dia</div><div class="t2">Sin registros</div></div>';
      return;
    }

    daySummary.className = "";
    daySummary.innerHTML = `
      <div class="day-item">
        <div class="t1">Historial del dia (${s.last2.length})</div>
        <div class="t2" style="max-height:360px;overflow:auto;">
          ${s.last2.map((it, idx) => `
            <div style="margin-top:10px;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,.08);" data-hist-idx="${idx}">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <span style="font-weight:900;font-size:34px;">${it.opcion}${it.texto ? `: ${it.texto}` : ""}</span>
                ${badge(it.status)}
                <span class="hist-btn hist-edit" data-idx="${idx}" title="Editar">&#9998;</span>
                <span class="hist-btn hist-del" data-idx="${idx}" title="Eliminar">&#128465;</span>
              </div>
              ${it.ts ? `<div style="color:#555;">Evento: ${formatDateTimeAR(it.ts)}</div>` : ""}
              ${it.sentAt ? `<div style="color:#0b6b2c;">Enviado: ${formatDateTimeAR(it.sentAt)}</div>` : ""}
              ${it.lastError ? `<div style="color:#9b1c1c;font-size:12px;">${it.lastError}</div>` : ""}
            </div>
          `).join("")}
        </div>
      </div>`;

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

    if (eraUnTM && tsParaDia) {
      const dateInfo = dateFromISO(tsParaDia);
      if (dateInfo.dia && dateInfo.mes) {
        await recalcularCajonesDelDia(leg, dateInfo.dia, dateInfo.mes);
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
            const tProm = Number(matInfo?.Tiempo_Promedio || 0);
            const segHist = tProm * uni;

            const horaInicio = fila?.Hora_Inicio || timeFromISO(item.hsInicio || item.ts);
            const horaFin = fila?.Hora_Fin || timeFromISO(item.ts);
            const dia = fila?.Dia || dateFromISO(item.ts).dia;
            const mes = fila?.Mes || dateFromISO(item.ts).mes;

            const segBruto = Math.max(1, toSec(horaFin) - toSec(horaInicio));

            const { data: tms } = await sb.from("db_n8n_espejo")
              .select("Hora_Inicio, Hora_Fin, Segundos_Tiempo_Muerto")
              .eq("Legajo", item.legajo)
              .eq("Dia", dia)
              .eq("Mes", mes)
              .eq("Uni", 0)
              .is("Eliminar", null);

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

            const tmData = {
              Matriz: code,
              Nombre_Matriz: opt.desc,
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
          await recalcularCajonesDelDia(editingLeg, dateInfo.dia, dateInfo.mes);
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
  }

  /* ================= OPCIONES RENDER ================= */
  function renderOptions() {
    row1.innerHTML = ""; row2.innerHTML = ""; row3.innerHTML = ""; row4.innerHTML = "";
    const leg = legajoKey();
    const state = leg ? readState(leg) : null;
    const pending = state?.lastDowntime || null;

    OPTIONS.forEach(o => {
      const d = document.createElement("div");
      d.className = "box";
      d.dataset.code = o.code;
      d.innerHTML = `<div class="box-title">${o.code}</div><div class="box-desc">${o.desc}</div>`;

      const allowedPending = !pending || o.code === pending.opcion;
      const allowedMatrix = o.code !== "E" || !state?.matrixNeedsC;

      if (!allowedPending || !allowedMatrix) {
        d.style.opacity = "0.35"; d.style.pointerEvents = "none"; d.style.filter = "grayscale(100%)";
      } else {
        d.addEventListener("click", () => selectOption(o, d));
      }

      const target = o.row === 1 ? row1 : o.row === 2 ? row2 : o.row === 3 ? row3 : row4;
      target.appendChild(d);
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

    if (opt.input.show) {
      inputArea.classList.remove("hidden");
      inputLabel.innerText = opt.input.label;
      textInput.placeholder = opt.input.placeholder;
    } else {
      inputArea.classList.add("hidden");
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
      writeState(legajo, s); return;
    }
    if (["RM", "PM", "RD"].includes(payload.opcion)) {
      s.lastDowntime = null;
      writeState(legajo, s); return;
    }
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
      // 8 matrices con variante
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
        "39": {
          pregunta: "Matriz 39 - Selecciona el tipo:",
          opciones: [
            { label: "Cpo Sacacorcho CON Marca", matriz: "39", nombre: "Cerrado Cuerpo Sacacorcho (Con Marca)" },
            { label: "Cpo Sacacorcho SIN Marca", matriz: "39B", nombre: "Cerrado Cuerpo Sacacorcho (Sin Marca)" },
          ],
        },
        "21": {
          pregunta: "Matriz 21 - Selecciona el tipo:",
          opciones: [
            { label: "Loeke",     matriz: "21", nombre: "Destapacorona Loeke" },
            { label: "Sin Marca", matriz: "21B", nombre: "Destapacorona Sin Marca" },
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
      const matCheck = matricesMap.get(texto);
      if (matCheck && (Number(matCheck.Tiempo_Promedio) === 0 || matCheck.Tiempo_Promedio === null)) {
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

    if (["C", "RM", "PM", "RD"].includes(selected.code)) {
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
    }
    if (["RM", "PM", "RD"].includes(payload.opcion)) {
      payload.hs_inicio = tsEvent;
    }
    if (stateBefore.lastDowntime && sameDowntime(stateBefore.lastDowntime, payload)) {
      payload.hs_inicio = stateBefore.lastDowntime.ts || "";
    }

    if (payload.opcion === "RM" || payload.opcion === "PM") {
      const emp = empleadosMap.get(String(legajo).trim());
      const nombre = emp?.Empleado || "Legajo " + legajo;
      const matNum = payload.matriz || "?";
      const matInfo = matricesMap.get(matNum);
      const matNombre = matInfo?.Matriz || "";
      const tipo = payload.opcion === "RM" ? "Rompio Matriz" : "Paro Matriz";
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
    renderSummary();

    selected = null;
    selectedArea.classList.add("hidden");
    optionsScreen.classList.add("hidden");
    legajoScreen.classList.remove("hidden");
    matrizInfo.classList.add("hidden");
    errorEl.innerText = "";
    document.querySelectorAll(".box.selected").forEach(x => x.classList.remove("selected"));

    try { await flushQueue(); }
    finally { btnEnviar.disabled = false; btnEnviar.innerText = "Enviar"; }
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
          const row = document.createElement("div");
          row.style.cssText = "padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:18px";
          row.innerHTML = `<span style="font-weight:700">${it.opcion}${it.texto ? ": " + it.texto : ""}</span> <span style="color:${statusColor};font-size:13px;font-weight:800">${statusText}</span> <span style="color:#888;font-size:14px">${safeTime(it.ts)}</span>`;
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

  /* ================= EVENTOS ================= */
  btnContinuar.addEventListener("click", goToOptions);
  btnBackTop.addEventListener("click", backToLegajo);
  btnBackLabel.addEventListener("click", backToLegajo);
  btnResetSelection.addEventListener("click", resetSelection);
  btnEnviar.addEventListener("click", sendFast);
  legajoInput.addEventListener("keydown", e => { if (e.key === "Enter") goToOptions(); });

  let legajoTimer = null;
  legajoInput.addEventListener("input", () => {
    clearTimeout(legajoTimer);
    legajoTimer = setTimeout(renderSummary, 120);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushQueue();
  });
  window.addEventListener("focus", () => flushQueue());
  window.addEventListener("online", async () => {
    const end = Date.now() + 3000;
    while (Date.now() < end && readQueue().length) await flushQueue();
  });
  setInterval(() => flushQueue(), 5000);

  /* ================= INIT ================= */
  cargarCatalogos().then(() => {
    renderOptions();
    renderSummary();
    renderPending();
    console.log("app.js OK - Supabase directo v2");
  }).catch(err => {
    console.error("Error cargando catalogos:", err);
    renderOptions();
    renderSummary();
    renderPending();
  });
});
