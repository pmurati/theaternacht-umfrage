"use strict";

/* global L */

/* ===========================================================================
 * Routenplaner für die Lange Nacht der Theater.
 *
 * Zweite Anwendung des Projekts: nimmt die Umfrage-Ergebnisse (poll_results.json)
 * und die HVV-Fahrplanmatrix (transit_matrix.json) und plant daraus einen Abend:
 *   - Ergebnis-Liste als ein-/ausblendbares Widget
 *   - Auswahl einzelner Programmpunkte -> Marker auf der Karte
 *   - Klick auf Marker: Ereignis(se) mit Uhrzeit und Personen
 *   - "Route berechnen": kürzeste/umstiegsarme Reihenfolge inkl. Zeitslot-Wahl
 *   - Fahrplan-Übersicht zum Kopieren
 *   - Teilstrecken einfrieren und Rest neu berechnen
 * ======================================================================== */

const HAMBURG = [53.5503, 9.9937];

/* Planungsparameter (Minuten). */
const SLOT = 30; // Dauer eines Programmpunkts
const BREAK_BEFORE = 10; // Puffer vor einem Programmpunkt
const BREAK_AFTER = 10; // Puffer nach einem Programmpunkt
const TRANSFER_PENALTY = 10; // Gewicht eines Umstiegs (in "Minuten")
const WALK_MAX_DP = 16; // ab so vielen DP-Knoten -> Greedy statt exakt

const state = {
  entries: [],
  entriesById: new Map(),
  entriesByTheater: new Map(),
  theaters: {}, // id -> {name, lat, lng}
  voters: [],
  selected: new Set(),
  voterFilter: null, // aktiver Personen-Filter oder null
  route: null, // berechnetes Ergebnis
  freezes: [], // [{a,b,aStart,bStart}]
};

let WALK = {};
let TRANSIT = {};
let SAMPLE_TIMES = [];

let map = null;
let markerLayer = null;
let routeLayer = null;

/* ---------- Zeit-Helfer ---------- */

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 6) h += 24; // Nach-Mitternacht gehört ans Abendende
  return h * 60 + min;
}

function fmtTime(mins) {
  mins = Math.round(mins);
  let h = Math.floor(mins / 60) % 24;
  const m = ((mins % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function haversine(a, b) {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dphi = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ---------- Datenladen ---------- */

async function loadData() {
  const [pollResp, transitResp] = await Promise.all([
    fetch("data/poll_results.json", { cache: "no-cache" }),
    fetch("data/transit_matrix.json", { cache: "no-cache" }),
  ]);
  if (!pollResp.ok) throw new Error(`poll_results.json HTTP ${pollResp.status}`);
  if (!transitResp.ok)
    throw new Error(`transit_matrix.json HTTP ${transitResp.status}`);
  const poll = await pollResp.json();
  const transit = await transitResp.json();

  state.entries = poll.entries.filter((e) => e.lat != null && e.lng != null);
  state.voters = poll.voters || [];
  state.entries.forEach((e) => {
    e.slotVoters = buildSlotVoters(e);
    state.entriesById.set(e.id, e);
    if (!state.entriesByTheater.has(e.theaterId))
      state.entriesByTheater.set(e.theaterId, []);
    state.entriesByTheater.get(e.theaterId).push(e);
  });

  WALK = transit.walk || {};
  TRANSIT = transit.transit || {};
  SAMPLE_TIMES = transit.sample_times || [];
  state.theaters = transit.theaters || {};
  // Fallback: Theater-Koordinaten aus den Einträgen ergänzen.
  state.entries.forEach((e) => {
    if (!state.theaters[e.theaterId]) {
      state.theaters[e.theaterId] = {
        name: e.theaterName,
        lat: e.lat,
        lng: e.lng,
      };
    }
  });
}

/** Ordnet jedem Zeitslot eines Eintrags die Personen zu, die ihn gewählt haben. */
function buildSlotVoters(entry) {
  const map = new Map();
  (entry.times || []).forEach((t) => map.set(t, []));
  (entry.votes || []).forEach((v) => {
    const times = v.times && v.times.length ? v.times : entry.times || [];
    times.forEach((t) => {
      if (!map.has(t)) map.set(t, []);
      const arr = map.get(t);
      if (!arr.includes(v.voter)) arr.push(v.voter);
    });
  });
  return map;
}

function entryVoters(entry) {
  const s = new Set();
  (entry.votes || []).forEach((v) => s.add(v.voter));
  return [...s];
}

/* ---------- Karte ---------- */

function initMap() {
  map = L.map("map", { zoomControl: true }).setView(HAMBURG, 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap-Mitwirkende",
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

function pinIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="marker-pin selected"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 20],
    popupAnchor: [0, -18],
  });
}

function numIcon(label) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-num">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14],
  });
}

/** Zeichnet die Auswahl-Marker (ein Marker pro Theater = pro Koordinate). */
function renderSelectionMarkers() {
  markerLayer.clearLayers();
  const byTheater = new Map();
  state.selected.forEach((id) => {
    const e = state.entriesById.get(id);
    if (!e) return;
    if (!byTheater.has(e.theaterId)) byTheater.set(e.theaterId, []);
    byTheater.get(e.theaterId).push(e);
  });

  byTheater.forEach((entries) => {
    const e0 = entries[0];
    const marker = L.marker([e0.lat, e0.lng], { icon: pinIcon() }).addTo(
      markerLayer
    );
    marker.bindPopup(selectionPopupHtml(entries), { maxWidth: 280 });
  });
}

function selectionPopupHtml(entries) {
  const th = entries[0].theaterName;
  let html = `<div class="popup-theater"><b>${escapeHtml(th)}</b></div>`;
  entries.forEach((e) => {
    html += `<div class="popup-entry"><div class="popup-title">${escapeHtml(
      e.showTitle
    )}</div>`;
    html += slotVotersHtml(e);
    html += `</div>`;
  });
  return html;
}

function slotVotersHtml(entry) {
  let html = "";
  const slots = [...entry.slotVoters.entries()].sort(
    (a, b) => (parseTime(a[0]) ?? 9999) - (parseTime(b[0]) ?? 9999)
  );
  if (!slots.length) {
    html += `<div class="popup-slot">${escapeHtml(
      entryVoters(entry).join(", ")
    )}</div>`;
    return html;
  }
  slots.forEach(([time, voters]) => {
    if (!voters.length) return;
    html += `<div class="popup-slot"><b>${escapeHtml(
      time
    )}</b> · ${escapeHtml(voters.join(", "))}</div>`;
  });
  return html;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}

/* ---------- Ergebnis-Liste (Widget) ---------- */

function toggleList(open) {
  const panel = document.getElementById("listpanel");
  const toggle = document.getElementById("list-toggle");
  const show = open != null ? open : panel.hidden;
  panel.hidden = !show;
  panel.setAttribute("aria-hidden", String(!show));
  toggle.setAttribute("aria-expanded", String(show));
}

function renderVoterFilter() {
  const box = document.getElementById("voter-filter");
  box.innerHTML = "";
  state.voters.forEach((v) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "voter-chip" + (state.voterFilter === v ? " active" : "");
    chip.textContent = v;
    chip.addEventListener("click", () => {
      state.voterFilter = state.voterFilter === v ? null : v;
      renderVoterFilter();
      renderList();
    });
    box.appendChild(chip);
  });
}

function renderList() {
  const container = document.getElementById("list-items");
  const query = (
    document.getElementById("list-search").value || ""
  )
    .trim()
    .toLowerCase();
  container.innerHTML = "";

  // Gruppieren nach Theater.
  const groups = new Map();
  state.entries.forEach((e) => {
    if (state.voterFilter && !entryVoters(e).includes(state.voterFilter)) return;
    if (query) {
      const hay = `${e.showTitle} ${e.theaterName} ${entryVoters(e).join(
        " "
      )}`.toLowerCase();
      if (!hay.includes(query)) return;
    }
    if (!groups.has(e.theaterId)) groups.set(e.theaterId, []);
    groups.get(e.theaterId).push(e);
  });

  if (!groups.size) {
    container.innerHTML = `<p class="list-empty">Keine Treffer.</p>`;
    return;
  }

  [...groups.entries()]
    .sort((a, b) =>
      (state.theaters[a[0]]?.name || "").localeCompare(
        state.theaters[b[0]]?.name || ""
      )
    )
    .forEach(([theaterId, entries]) => {
      const group = document.createElement("div");
      group.className = "list-theater";
      const name = document.createElement("div");
      name.className = "list-theater-name";
      name.textContent = entries[0].theaterName;
      group.appendChild(name);

      entries.forEach((e) => group.appendChild(renderListEntry(e)));
      container.appendChild(group);
    });
}

function renderListEntry(entry) {
  const row = document.createElement("label");
  row.className = "list-entry" + (state.selected.has(entry.id) ? " selected" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(entry.id);
  cb.addEventListener("change", () => toggleSelection(entry.id, cb.checked));

  const body = document.createElement("div");
  body.className = "list-entry-body";

  const title = document.createElement("div");
  title.className = "list-entry-title";
  title.textContent = entry.showTitle;
  body.appendChild(title);

  if (entry.venue) {
    const meta = document.createElement("div");
    meta.className = "list-entry-meta";
    meta.textContent = entry.venue;
    body.appendChild(meta);
  }

  const times = document.createElement("div");
  times.className = "list-entry-meta";
  (entry.times || []).forEach((t) => {
    const b = document.createElement("span");
    b.className = "time-badge";
    b.textContent = t;
    times.appendChild(b);
  });
  body.appendChild(times);

  const voters = document.createElement("div");
  voters.className = "list-entry-votes";
  const vs = entryVoters(entry);
  voters.textContent = `♥ ${vs.join(", ")}`;
  body.appendChild(voters);

  row.appendChild(cb);
  row.appendChild(body);
  return row;
}

function toggleSelection(id, checked) {
  if (checked) state.selected.add(id);
  else {
    state.selected.delete(id);
    // Einfrierungen entfernen, die diesen Eintrag betreffen.
    state.freezes = state.freezes.filter((f) => f.a !== id && f.b !== id);
  }
  // Route verwerfen, sobald sich die Auswahl ändert.
  clearRoute(false);
  renderSelectionMarkers();
  updateCounts();
  // Nur die betroffene Zeile aktualisieren wäre feiner; neu rendern reicht.
  renderList();
}

function updateCounts() {
  const n = state.selected.size;
  document.getElementById("list-toggle-count").textContent = String(n);
  document.getElementById("list-selcount").textContent =
    n === 1 ? "1 ausgewählt" : `${n} ausgewählt`;
  const btn = document.getElementById("compute-btn");
  btn.disabled = n < 1;
  document.getElementById("topbar-info").textContent = n
    ? `${n} Programmpunkt${n === 1 ? "" : "e"} gewählt`
    : "";
}

/* ---------- Reise-Modell ---------- */

function pickTransit(a, b, depMin) {
  const recs = TRANSIT[`${a}|${b}`];
  if (!recs || !recs.length) return null;
  const depSec = depMin * 60;
  let best = recs[0];
  for (const r of recs) {
    if (r.t <= depSec) best = r;
  }
  return best;
}

function score(opt) {
  return opt.min + opt.transfers * TRANSFER_PENALTY;
}

/** Beste Reiseoption (Fußweg vs. ÖPNV) von Theater a nach b bei Abfahrt depMin. */
function travelOption(a, b, depMin) {
  if (a === b) return { min: 0, transfers: 0, mode: "same", legs: [] };
  const opts = [];
  const w = WALK[`${a}|${b}`];
  if (w) opts.push({ min: w.min, transfers: 0, mode: "walk", meters: w.meters, legs: [] });
  const rec = pickTransit(a, b, depMin);
  if (rec)
    opts.push({
      min: rec.dur_min,
      transfers: rec.transfers,
      mode: "transit",
      legs: rec.legs || [],
    });
  if (!opts.length) {
    const ta = state.theaters[a];
    const tb = state.theaters[b];
    const m = ta && tb ? Math.round((haversine(ta, tb) * 1.3) / 1.3 / 60) : 30;
    return { min: m, transfers: 0, mode: "walk", legs: [] };
  }
  opts.sort((x, y) => score(x) - score(y));
  return opts[0];
}

/* ---------- Route-Optimierung ---------- */

/** Baut die Ereignisliste aus der aktuellen Auswahl. */
function buildEvents() {
  const events = [];
  const skipped = [];
  state.selected.forEach((id) => {
    const e = state.entriesById.get(id);
    if (!e) return;
    const slots = (e.times || [])
      .map((t) => ({ label: t, start: parseTime(t) }))
      .filter((s) => s.start != null)
      .sort((a, b) => a.start - b.start);
    if (!slots.length) {
      skipped.push(e);
      return;
    }
    events.push({
      id: e.id,
      entry: e,
      theaterId: e.theaterId,
      slots,
    });
  });
  return { events, skipped };
}

/** Fasst eingefrorene, direkt aufeinanderfolgende Ereignisse zu Ketten-Knoten
 *  zusammen und lässt freie Ereignisse als Mehrslot-Knoten stehen. */
function buildNodes(events) {
  const idx = new Map();
  events.forEach((e, i) => idx.set(e.id, i));

  const nextOf = new Map();
  const prevOf = new Map();
  const fixedStart = new Map();
  state.freezes.forEach((f) => {
    if (!idx.has(f.a) || !idx.has(f.b)) return;
    nextOf.set(f.a, f.b);
    prevOf.set(f.b, f.a);
    fixedStart.set(f.a, f.aStart);
    fixedStart.set(f.b, f.bStart);
  });

  const nodes = [];
  const consumed = new Set();

  events.forEach((e) => {
    if (consumed.has(e.id)) return;
    if (prevOf.has(e.id)) return; // Teil einer Kette, nicht der Kopf
    if (!nextOf.has(e.id)) {
      // Freies Ereignis: alle Zeitslots als Optionen.
      nodes.push({
        firstTheater: e.theaterId,
        lastTheater: e.theaterId,
        required: false,
        options: e.slots.map((s) => ({
          order: [e.id],
          eventStarts: [s.start],
          start: s.start,
          end: s.start + SLOT,
          cost: 0,
        })),
      });
      return;
    }
    // Kette ab e verfolgen.
    const chain = [e.id];
    let cur = e.id;
    while (nextOf.has(cur)) {
      cur = nextOf.get(cur);
      chain.push(cur);
    }
    chain.forEach((id) => consumed.add(id));
    const starts = chain.map((id) => fixedStart.get(id));
    let cost = 0;
    for (let k = 0; k < chain.length - 1; k++) {
      const ea = state.entriesById.get(chain[k]);
      const eb = state.entriesById.get(chain[k + 1]);
      const dep = starts[k] + SLOT + BREAK_AFTER;
      cost += score(travelOption(ea.theaterId, eb.theaterId, dep));
    }
    nodes.push({
      firstTheater: state.entriesById.get(chain[0]).theaterId,
      lastTheater: state.entriesById.get(chain[chain.length - 1]).theaterId,
      required: true, // eingefrorene Teilstrecke muss erhalten bleiben
      options: [
        {
          order: chain.slice(),
          eventStarts: starts,
          start: starts[0],
          end: starts[chain.length - 1] + SLOT,
          cost,
        },
      ],
    });
  });

  return nodes;
}

function feasibleNext(prevNode, po, nextNode, no) {
  const a = prevNode.options[po];
  const b = nextNode.options[no];
  const dep = a.end + BREAK_AFTER;
  const opt = travelOption(prevNode.lastTheater, nextNode.firstTheater, dep);
  const earliest = a.end + BREAK_AFTER + opt.min + BREAK_BEFORE;
  if (b.start < earliest) return null;
  return score(opt);
}

/** Held-Karp-DP über die Knoten: minimiert Reisekosten (inkl. Umstiege). */
function optimize(nodes) {
  const m = nodes.length;
  if (m === 0) return null;
  if (m > WALK_MAX_DP) return greedy(nodes);

  const FULL = (1 << m) - 1;
  // dp[mask] : Map "i:o" -> {cost, prev}
  const dp = new Array(1 << m);

  for (let i = 0; i < m; i++) {
    nodes[i].options.forEach((opt, o) => {
      const mask = 1 << i;
      if (!dp[mask]) dp[mask] = new Map();
      dp[mask].set(`${i}:${o}`, { cost: opt.cost, prev: null });
    });
  }

  for (let mask = 1; mask <= FULL; mask++) {
    const cur = dp[mask];
    if (!cur) continue;
    cur.forEach((stateVal, key) => {
      const [i, o] = key.split(":").map(Number);
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const nodeJ = nodes[j];
        for (let oj = 0; oj < nodeJ.options.length; oj++) {
          const add = feasibleNext(nodes[i], o, nodeJ, oj);
          if (add == null) continue;
          const nmask = mask | (1 << j);
          const ncost = stateVal.cost + add + nodeJ.options[oj].cost;
          if (!dp[nmask]) dp[nmask] = new Map();
          const nkey = `${j}:${oj}`;
          const existing = dp[nmask].get(nkey);
          if (!existing || ncost < existing.cost) {
            dp[nmask].set(nkey, {
              cost: ncost,
              prev: { mask, key },
            });
          }
        }
      }
    });
  }

  // Pflicht-Knoten (eingefrorene Teilstrecken) müssen enthalten sein.
  let requiredMask = 0;
  for (let i = 0; i < m; i++) {
    if (nodes[i].required) requiredMask |= 1 << i;
  }

  // Bestes Ergebnis: zuerst alle Pflicht-Knoten, dann möglichst viele
  // Ereignisse, dann geringste Kosten.
  let best = null;
  for (let mask = 1; mask <= FULL; mask++) {
    if (!dp[mask]) continue;
    const hasRequired = (mask & requiredMask) === requiredMask;
    const pop = popcount(mask);
    dp[mask].forEach((val, key) => {
      if (
        !best ||
        (hasRequired && !best.hasRequired) ||
        (hasRequired === best.hasRequired && pop > best.pop) ||
        (hasRequired === best.hasRequired &&
          pop === best.pop &&
          val.cost < best.cost)
      ) {
        best = { pop, cost: val.cost, mask, key, hasRequired };
      }
    });
  }
  if (!best) return null;


  // Rückverfolgung.
  const seq = [];
  let cursor = { mask: best.mask, key: best.key };
  while (cursor) {
    const val = dp[cursor.mask].get(cursor.key);
    const [i, o] = cursor.key.split(":").map(Number);
    seq.push({ node: nodes[i], opt: nodes[i].options[o] });
    cursor = val.prev;
  }
  seq.reverse();
  return { seq, coveredMask: best.mask, nodes };
}

/** Mehrstart-Greedy für sehr große Auswahlen (mehr Knoten als das exakte DP
 *  verkraftet). Probiert jeden möglichen Startpunkt und wählt jeweils das
 *  nächste machbare Ereignis mit dem frühesten Ende (klassische Intervall-
 *  Heuristik) – das maximiert in der Praxis die Zahl der besuchten Punkte.
 *  Am Ende gewinnt die Route mit den meisten Ereignissen (bei Gleichstand die
 *  günstigste), wobei eingefrorene Pflicht-Knoten Vorrang haben. */
function greedy(nodes) {
  const m = nodes.length;
  let requiredMask = 0;
  for (let i = 0; i < m; i++) if (nodes[i].required) requiredMask |= 1 << i;

  function runFrom(startI, startO) {
    const used = new Array(m).fill(false);
    used[startI] = true;
    const seq = [{ i: startI, o: startO }];
    let cost = nodes[startI].options[startO].cost;
    let mask = 1 << startI;
    for (;;) {
      const last = seq[seq.length - 1];
      let pick = null;
      for (let j = 0; j < m; j++) {
        if (used[j]) continue;
        for (let oj = 0; oj < nodes[j].options.length; oj++) {
          const add = feasibleNext(nodes[last.i], last.o, nodes[j], oj);
          if (add == null) continue;
          const opt = nodes[j].options[oj];
          const total = add + opt.cost;
          const req = nodes[j].required ? 1 : 0;
          // Pflicht-Knoten zuerst, dann frühestes Ende, dann geringste Kosten.
          if (
            !pick ||
            req > pick.req ||
            (req === pick.req && opt.end < pick.end) ||
            (req === pick.req && opt.end === pick.end && total < pick.cost)
          ) {
            pick = { j, oj, cost: total, end: opt.end, req };
          }
        }
      }
      if (!pick) break;
      used[pick.j] = true;
      seq.push({ i: pick.j, o: pick.oj });
      cost += pick.cost;
      mask |= 1 << pick.j;
    }
    return {
      seq,
      cost,
      mask,
      pop: popcount(mask),
      hasRequired: (mask & requiredMask) === requiredMask,
    };
  }

  let best = null;
  for (let i = 0; i < m; i++) {
    for (let o = 0; o < nodes[i].options.length; o++) {
      const r = runFrom(i, o);
      if (
        !best ||
        (r.hasRequired && !best.hasRequired) ||
        (r.hasRequired === best.hasRequired && r.pop > best.pop) ||
        (r.hasRequired === best.hasRequired &&
          r.pop === best.pop &&
          r.cost < best.cost)
      ) {
        best = r;
      }
    }
  }
  if (!best) return null;
  const seq = best.seq.map(({ i, o }) => ({
    node: nodes[i],
    opt: nodes[i].options[o],
  }));
  return { seq, coveredMask: best.mask, nodes };
}

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/* ---------- Route berechnen & darstellen ---------- */

function computeRoute() {
  const { events, skipped } = buildEvents();
  if (!events.length) {
    showToast("Keine planbaren Programmpunkte (fehlende Uhrzeiten).", true);
    return;
  }
  const nodes = buildNodes(events);
  const result = optimize(nodes);
  if (!result) {
    showToast("Keine machbare Route gefunden.", true);
    return;
  }

  // Flache Ereignisliste mit Startzeiten aus der Knoten-Sequenz.
  const ordered = [];
  result.seq.forEach(({ opt }) => {
    opt.order.forEach((eid, k) => {
      ordered.push({ id: eid, start: opt.eventStarts[k] });
    });
  });

  // Legs zwischen aufeinanderfolgenden Ereignissen (einheitlich neu berechnen).
  const plan = [];
  for (let k = 0; k < ordered.length; k++) {
    const e = state.entriesById.get(ordered[k].id);
    const item = {
      id: ordered[k].id,
      entry: e,
      start: ordered[k].start,
      end: ordered[k].start + SLOT,
    };
    if (k > 0) {
      const prev = plan[k - 1];
      const dep = prev.end + BREAK_AFTER;
      const opt = travelOption(prev.entry.theaterId, e.theaterId, dep);
      const frozen = state.freezes.some(
        (f) => f.a === prev.id && f.b === e.id
      );
      item.legIn = {
        from: prev.id,
        to: e.id,
        depMin: dep,
        arrMin: dep + opt.min,
        opt,
        frozen,
      };
    }
    plan.push(item);
  }

  // Ereignisse, die nicht eingeplant werden konnten.
  const plannedIds = new Set(plan.map((p) => p.id));
  const dropped = events
    .filter((e) => !plannedIds.has(e.id))
    .map((e) => e.entry);

  state.route = { plan, dropped, skipped };
  renderRouteOnMap();
  renderSchedule();
  document.getElementById("schedule-toggle").hidden = false;
  document.getElementById("clear-route-btn").hidden = false;
  toggleSchedule(true);
  toggleList(false);
}

function renderRouteOnMap() {
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  if (!state.route) return;
  const plan = state.route.plan;

  // Mehrere Ereignisse am selben Theater teilen sich einen Marker.
  const byTheater = new Map();
  plan.forEach((p, i) => {
    const tid = p.entry.theaterId;
    if (!byTheater.has(tid)) byTheater.set(tid, []);
    byTheater.get(tid).push({ p, order: i + 1 });
  });

  const pts = [];
  byTheater.forEach((items) => {
    const e = items[0].p.entry;
    const label = items.map((it) => it.order).join(",");
    const marker = L.marker([e.lat, e.lng], { icon: numIcon(label) }).addTo(
      routeLayer
    );
    marker.bindPopup(routePopupHtml(items), { maxWidth: 280 });
  });

  // Linien zwischen aufeinanderfolgenden Ereignissen (Theaterwechsel).
  for (let k = 1; k < plan.length; k++) {
    const a = plan[k - 1].entry;
    const b = plan[k].entry;
    if (a.theaterId === b.theaterId) continue;
    const leg = plan[k].legIn;
    const line = L.polyline(
      [
        [a.lat, a.lng],
        [b.lat, b.lng],
      ],
      {
        color: leg.opt.mode === "walk" ? "#e8590c" : "#5b3f8c",
        weight: 4,
        opacity: 0.8,
        dashArray: leg.opt.mode === "walk" ? "6 8" : null,
      }
    ).addTo(routeLayer);
    pts.push([a.lat, a.lng], [b.lat, b.lng]);
  }
  plan.forEach((p) => pts.push([p.entry.lat, p.entry.lng]));
  if (pts.length) map.fitBounds(pts, { padding: [60, 60] });
}

function routePopupHtml(items) {
  const th = items[0].p.entry.theaterName;
  let html = `<div class="popup-theater"><b>${escapeHtml(th)}</b></div>`;
  items.forEach(({ p, order }) => {
    html += `<div class="popup-entry"><div class="popup-title"><span class="ev-order">${order}</span>${escapeHtml(
      p.entry.showTitle
    )}</div>`;
    html += `<div class="popup-slot"><b>${fmtTime(p.start)}–${fmtTime(
      p.end
    )}</b> · ${escapeHtml(votersForSlot(p.entry, p.start).join(", "))}</div>`;
    html += `</div>`;
  });
  return html;
}

function votersForSlot(entry, startMin) {
  // Passenden Slot-Label finden.
  for (const [label, voters] of entry.slotVoters.entries()) {
    if (parseTime(label) === startMin) return voters.length ? voters : entryVoters(entry);
  }
  return entryVoters(entry);
}

/* ---------- Fahrplan-Übersicht ---------- */

function toggleSchedule(open) {
  const el = document.getElementById("schedule");
  const show = open != null ? open : el.hidden;
  el.hidden = !show;
  el.setAttribute("aria-hidden", String(!show));
}

function renderSchedule() {
  const body = document.getElementById("schedule-body");
  const summary = document.getElementById("schedule-summary");
  body.innerHTML = "";
  if (!state.route) return;
  const { plan, dropped, skipped } = state.route;

  const totalTransfers = plan.reduce(
    (s, p) => s + (p.legIn && p.legIn.opt.mode === "transit" ? p.legIn.opt.transfers : 0),
    0
  );
  const totalTravel = plan.reduce(
    (s, p) => s + (p.legIn ? p.legIn.opt.min : 0),
    0
  );
  const first = plan[0] ? fmtTime(plan[0].start) : "–";
  const last = plan.length ? fmtTime(plan[plan.length - 1].end) : "–";
  const totalSelected = plan.length + dropped.length + skipped.length;
  summary.textContent = `${plan.length} von ${totalSelected} Programmpunkten · ${first}–${last} · ${totalTravel} min unterwegs · ${totalTransfers} Umstiege`;

  if (skipped.length) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.innerHTML =
      `<b>Ohne Uhrzeit – nicht planbar:</b> ` +
      escapeHtml(skipped.map((e) => e.showTitle).join(", "));
    body.appendChild(warn);
  }
  if (dropped.length) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.innerHTML =
      `<b>Zeitlich nicht unterzubringen</b> (Slots überschneiden sich mit ` +
      `der geplanten Route inkl. Weg &amp; Puffer): ` +
      escapeHtml(dropped.map((e) => e.showTitle).join(", "));
    body.appendChild(warn);
  }

  plan.forEach((p, k) => {
    if (p.legIn && p.entry.theaterId !== plan[k - 1].entry.theaterId) {
      body.appendChild(renderLeg(p.legIn));
    }
    body.appendChild(renderEvent(p, k + 1));
  });
}

function renderEvent(p, order) {
  const div = document.createElement("div");
  div.className = "ev";
  const voters = votersForSlot(p.entry, p.start);
  div.innerHTML =
    `<div class="ev-time"><span class="ev-order">${order}</span>${fmtTime(
      p.start
    )} – ${fmtTime(p.end)}</div>` +
    `<div class="ev-title">${escapeHtml(p.entry.showTitle)}</div>` +
    `<div class="ev-meta">${escapeHtml(p.entry.theaterName)}${
      p.entry.venue ? " · " + escapeHtml(p.entry.venue) : ""
    }</div>` +
    `<div class="ev-voters">♥ ${escapeHtml(voters.join(", "))}</div>`;
  return div;
}

function renderLeg(leg) {
  const div = document.createElement("div");
  div.className = "leg" + (leg.frozen ? " frozen" : "");
  const opt = leg.opt;
  let icon = "🚶";
  let lines = `${opt.min} min zu Fuß`;
  let sub = "";
  if (opt.mode === "transit") {
    icon = "🚆";
    const lineLabels = (opt.legs || [])
      .map((l) => l.line)
      .filter(Boolean)
      .join(" → ");
    lines = `${lineLabels || "ÖPNV"} · ${opt.min} min`;
    sub = `${opt.transfers} Umstieg${opt.transfers === 1 ? "" : "e"} · ab ${fmtTime(
      leg.depMin
    )}`;
    if (opt.legs && opt.legs.length) {
      const first = opt.legs[0];
      const lastL = opt.legs[opt.legs.length - 1];
      sub += ` · ${escapeHtml(first.from)} → ${escapeHtml(lastL.to)}`;
    }
  } else if (opt.mode === "walk") {
    sub = opt.meters ? `${opt.meters} m · ab ${fmtTime(leg.depMin)}` : `ab ${fmtTime(leg.depMin)}`;
  }

  const bodyHtml =
    `<div class="leg-icon">${icon}</div>` +
    `<div class="leg-body"><div class="leg-lines">${escapeHtml(
      lines
    )}</div><div class="leg-sub">${sub}</div></div>`;
  div.innerHTML = bodyHtml;

  const freezeBtn = document.createElement("button");
  freezeBtn.type = "button";
  freezeBtn.className = "leg-freeze" + (leg.frozen ? " on" : "");
  freezeBtn.textContent = leg.frozen ? "❄ fixiert" : "fixieren";
  freezeBtn.title = "Diese Teilstrecke behalten und den Rest neu berechnen";
  freezeBtn.addEventListener("click", () => toggleFreeze(leg));
  div.appendChild(freezeBtn);
  return div;
}

function toggleFreeze(leg) {
  const exists = state.freezes.findIndex(
    (f) => f.a === leg.from && f.b === leg.to
  );
  if (exists >= 0) {
    state.freezes.splice(exists, 1);
  } else {
    const a = state.route.plan.find((p) => p.id === leg.from);
    const b = state.route.plan.find((p) => p.id === leg.to);
    state.freezes.push({
      a: leg.from,
      b: leg.to,
      aStart: a.start,
      bStart: b.start,
    });
  }
  // Route mit den aktualisierten Fixierungen neu berechnen.
  computeRoute();
}

/* ---------- Kopieren / Teilen ---------- */

function scheduleAsText() {
  if (!state.route) return "";
  const { plan } = state.route;
  const lines = ["🎭 Lange Nacht der Theater – unser Abend", ""];
  plan.forEach((p, k) => {
    if (p.legIn && p.entry.theaterId !== plan[k - 1].entry.theaterId) {
      const opt = p.legIn.opt;
      if (opt.mode === "transit") {
        const ll = (opt.legs || []).map((l) => l.line).filter(Boolean).join(" → ");
        lines.push(
          `   ↓ ${opt.min} min · ${ll || "ÖPNV"} · ${opt.transfers} Umstieg(e)`
        );
      } else {
        lines.push(`   ↓ ${opt.min} min zu Fuß`);
      }
    }
    const voters = votersForSlot(p.entry, p.start).join(", ");
    lines.push(
      `${k + 1}. ${fmtTime(p.start)}–${fmtTime(p.end)}  ${p.entry.showTitle}`
    );
    lines.push(`   ${p.entry.theaterName}${p.entry.venue ? " · " + p.entry.venue : ""}  (${voters})`);
  });
  return lines.join("\n");
}

async function copySchedule() {
  const text = scheduleAsText();
  try {
    await navigator.clipboard.writeText(text);
    showToast("Fahrplan kopiert.");
  } catch (err) {
    // Fallback: temporäres Textfeld.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast("Fahrplan kopiert.");
    } catch (e) {
      showToast("Kopieren nicht möglich.", true);
    }
    ta.remove();
  }
}

function clearRoute(rerender = true) {
  state.route = null;
  state.freezes = [];
  routeLayer.clearLayers();
  document.getElementById("schedule-toggle").hidden = true;
  document.getElementById("clear-route-btn").hidden = true;
  toggleSchedule(false);
  if (rerender) renderSelectionMarkers();
}

/* ---------- Toast ---------- */

let toastTimer = null;
function showToast(message, isError) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(isError));
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

/* ---------- Start ---------- */

async function main() {
  initMap();
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    showToast("Daten konnten nicht geladen werden.", true);
    return;
  }
  renderVoterFilter();
  renderList();
  updateCounts();

  document.getElementById("list-toggle").addEventListener("click", () => toggleList());
  document.getElementById("listpanel-close").addEventListener("click", () => toggleList(false));
  document.getElementById("list-search").addEventListener("input", renderList);
  document.getElementById("select-all").addEventListener("click", () => {
    getVisibleEntryIds().forEach((id) => state.selected.add(id));
    clearRoute(false);
    renderSelectionMarkers();
    updateCounts();
    renderList();
  });
  document.getElementById("select-none").addEventListener("click", () => {
    state.selected.clear();
    state.freezes = [];
    clearRoute(false);
    renderSelectionMarkers();
    updateCounts();
    renderList();
  });
  document.getElementById("compute-btn").addEventListener("click", computeRoute);
  document.getElementById("schedule-toggle").addEventListener("click", () => toggleSchedule());
  document.getElementById("schedule-close").addEventListener("click", () => toggleSchedule(false));
  document.getElementById("clear-route-btn").addEventListener("click", () => clearRoute(true));
  document.getElementById("copy-btn").addEventListener("click", copySchedule);
}

/** Aktuell in der Liste sichtbare (gefilterte) Einträge. */
function getVisibleEntryIds() {
  const query = (document.getElementById("list-search").value || "")
    .trim()
    .toLowerCase();
  return state.entries
    .filter((e) => {
      if (state.voterFilter && !entryVoters(e).includes(state.voterFilter))
        return false;
      if (query) {
        const hay = `${e.showTitle} ${e.theaterName} ${entryVoters(e).join(
          " "
        )}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .map((e) => e.id);
}

document.addEventListener("DOMContentLoaded", main);
