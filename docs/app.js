"use strict";

/* global L */

const CONFIG = window.APP_CONFIG || {};
const STORAGE_KEY = "theaternacht-umfrage";
const HAMBURG = [53.5503, 9.9937];

const state = {
  name: "",
  unlocked: false,
  // showId -> { theaterId, theaterName, showTitle, times }
  selections: {},
};

const markersByTheater = {};
let theatersById = {};
let mapInstance = null;
// Flacher Suchindex: { theaterId, theater, show }
let searchIndex = [];

/* ---------- Persistenz ---------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.name = saved.name || "";
    state.selections = saved.selections || {};
    state.unlocked = Boolean(saved.unlocked);
  } catch (err) {
    console.warn("Konnte gespeicherten Zustand nicht laden:", err);
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        name: state.name,
        selections: state.selections,
        unlocked: state.unlocked,
      })
    );
  } catch (err) {
    console.warn("Konnte Zustand nicht speichern:", err);
  }
}

/* ---------- Zugangs-Overlay ---------- */

function setupGate() {
  const gate = document.getElementById("gate");
  const form = document.getElementById("gate-form");
  const nameInput = document.getElementById("gate-name");
  const passwordInput = document.getElementById("gate-password");
  const errorEl = document.getElementById("gate-error");

  // Handler immer registrieren, damit die Anmeldung auch nach dem Abmelden
  // (ohne Seiten-Reload) funktioniert.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const password = passwordInput.value;
    if (!name) return;
    if (password !== CONFIG.SHARED_PASSWORD) {
      errorEl.textContent = "Passwort stimmt nicht.";
      errorEl.hidden = false;
      return;
    }
    state.name = name;
    state.unlocked = true;
    saveState();
    gate.hidden = true;
    onUnlocked();
  });

  if (state.unlocked && state.name) {
    gate.hidden = true;
    onUnlocked();
    return;
  }

  gate.hidden = false;
  nameInput.value = state.name;
}

function onUnlocked() {
  const topbar = document.getElementById("topbar");
  document.getElementById("topbar-user").textContent = state.name;
  topbar.hidden = false;
  document.getElementById("submitbar").hidden = false;
  updateSubmitBar();
}

function logout() {
  state.name = "";
  state.unlocked = false;
  state.selections = {};
  saveState();

  // Bereits gesetzte Markierungen auf der Karte zurücksetzen.
  Object.keys(markersByTheater).forEach(refreshMarker);

  closePanel();
  document.getElementById("topbar").hidden = true;
  document.getElementById("submitbar").hidden = true;

  const gate = document.getElementById("gate");
  document.getElementById("gate-password").value = "";
  document.getElementById("gate-error").hidden = true;
  document.getElementById("gate-name").value = "";
  gate.hidden = false;
  document.getElementById("gate-name").focus();
}

/* ---------- Karte ---------- */

function makeIcon(selected) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-pin${selected ? " selected" : ""}"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 20],
    popupAnchor: [0, -18],
  });
}

function theaterHasSelection(theater) {
  return theater.shows.some((s) => state.selections[s.id]);
}

async function initMap() {
  const map = L.map("map", { zoomControl: true }).setView(HAMBURG, 12);
  mapInstance = map;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap-Mitwirkende",
  }).addTo(map);

  let data;
  try {
    const params = new URLSearchParams(window.location.search);
    const dataFile =
      params.get("data") === "programm"
        ? "data/programm.json"
        : "data/programm_manual.json";
    const resp = await fetch(dataFile, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    showToast("Programm konnte nicht geladen werden.", true);
    console.error(err);
    return;
  }

  const bounds = [];
  data.theaters.forEach((theater) => {
    theatersById[theater.id] = theater;
    theater.shows.forEach((show) => {
      const haystack = [
        show.title,
        theater.name,
        show.venue || "",
        show.teaser || "",
        show.description || "",
      ]
        .join(" ")
        .toLowerCase();
      searchIndex.push({ theaterId: theater.id, theater, show, haystack });
    });
    if (theater.lat == null || theater.lng == null) return;
    const marker = L.marker([theater.lat, theater.lng], {
      icon: makeIcon(theaterHasSelection(theater)),
      title: theater.name,
    }).addTo(map);
    marker.on("click", () => openPanel(theater));
    markersByTheater[theater.id] = marker;
    bounds.push([theater.lat, theater.lng]);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function refreshMarker(theaterId) {
  const marker = markersByTheater[theaterId];
  const theater = theatersById[theaterId];
  if (marker && theater) {
    marker.setIcon(makeIcon(theaterHasSelection(theater)));
  }
}

/* ---------- Programm-Panel ---------- */

function openPanel(theater, highlightShowId) {
  const panel = document.getElementById("panel");
  document.getElementById("panel-title").textContent = theater.name;
  const addressEl = document.getElementById("panel-address");
  addressEl.textContent = theater.address || "";
  addressEl.hidden = !theater.address;

  const list = document.getElementById("panel-shows");
  list.innerHTML = "";
  theater.shows.forEach((show) => {
    list.appendChild(renderShow(theater, show));
  });

  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");

  if (highlightShowId) {
    const row = list.querySelector(
      `.show[data-show-id="${CSS.escape(highlightShowId)}"]`
    );
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.remove("highlight");
      // Reflow erzwingen, damit die Animation erneut startet.
      void row.offsetWidth;
      row.classList.add("highlight");
    }
  }
}

function closePanel() {
  const panel = document.getElementById("panel");
  panel.hidden = true;
  panel.setAttribute("aria-hidden", "true");
}

function renderShow(theater, show) {
  const row = document.createElement("label");
  row.className = "show";
  row.dataset.showId = show.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.showId = show.id;
  checkbox.checked = Boolean(state.selections[show.id]);
  checkbox.addEventListener("change", () => {
    toggleSelection(theater, show, checkbox.checked);
  });

  const body = document.createElement("div");
  body.className = "show-body";

  const title = document.createElement("p");
  title.className = "show-title";
  title.textContent = show.title;
  if (show.venue) {
    const venue = document.createElement("span");
    venue.className = "show-venue";
    venue.textContent = ` · ${show.venue}`;
    title.appendChild(venue);
  }
  body.appendChild(title);

  if (show.times && show.times.length) {
    const times = document.createElement("div");
    times.className = "show-times";
    show.times.forEach((t) => {
      const badge = document.createElement("span");
      badge.className = "time-badge";
      badge.textContent = t;
      times.appendChild(badge);
    });
    body.appendChild(times);
  }

  const text = show.teaser || show.description;
  if (text) {
    const desc = document.createElement("p");
    desc.className = "show-desc clamped";
    desc.textContent = text;
    body.appendChild(desc);

    const more = document.createElement("button");
    more.type = "button";
    more.className = "show-more";
    more.textContent = "mehr";
    more.addEventListener("click", (event) => {
      event.preventDefault();
      const clamped = desc.classList.toggle("clamped");
      more.textContent = clamped ? "mehr" : "weniger";
    });
    body.appendChild(more);
  }

  row.appendChild(checkbox);
  row.appendChild(body);
  return row;
}

/* ---------- Auswahl ---------- */

function toggleSelection(theater, show, checked) {
  if (checked) {
    state.selections[show.id] = {
      theaterId: theater.id,
      theaterName: theater.name,
      showTitle: show.title,
      venue: show.venue || "",
      times: (show.times || []).join(", "),
    };
  } else {
    delete state.selections[show.id];
  }
  saveState();
  refreshMarker(theater.id);
  updateSubmitBar();
}

/**
 * Entfernt einen Programmpunkt aus der Auswahl (z. B. über den Auswahl-Reiter)
 * und hält Karte, Panel-Checkbox und Zähler synchron.
 */
function removeSelection(showId) {
  const sel = state.selections[showId];
  if (!sel) return;
  delete state.selections[showId];
  saveState();

  // Checkbox im geöffneten Programm-Panel abwählen, falls sichtbar.
  const checkbox = document.querySelector(
    `#panel-shows input[data-show-id="${CSS.escape(showId)}"]`
  );
  if (checkbox) checkbox.checked = false;

  refreshMarker(sel.theaterId);
  updateSubmitBar();
}

function toggleMyList(forceOpen) {
  const list = document.getElementById("mylist");
  const toggle = document.getElementById("mylist-toggle");
  const open = forceOpen != null ? forceOpen : list.hidden;
  list.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (open) {
    document.getElementById("mylist-search-input").focus();
  }
}

/* ---------- Suche ---------- */

function setupSearch() {
  const input = document.getElementById("mylist-search-input");
  input.addEventListener("input", () => runSearch(input.value));
}

function runSearch(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  const results = document.getElementById("mylist-results");
  const head = document.querySelector(".mylist-head");
  const items = document.getElementById("mylist-items");

  if (!query) {
    results.hidden = true;
    results.innerHTML = "";
    head.hidden = false;
    items.hidden = false;
    return;
  }

  // Suche in Titel, Theatername, Bühne und Beschreibung (vorberechnet).
  const matches = searchIndex.filter((entry) => entry.haystack.includes(query));

  head.hidden = true;
  items.hidden = true;
  results.hidden = false;
  results.innerHTML = "";

  if (!matches.length) {
    const empty = document.createElement("li");
    empty.className = "mylist-empty";
    empty.textContent = "Keine Treffer.";
    results.appendChild(empty);
    return;
  }

  matches.slice(0, 40).forEach(({ theaterId, theater, show }) => {
    const li = document.createElement("li");
    li.className = "mylist-result";

    const title = document.createElement("div");
    title.className = "mylist-result-title";
    title.textContent = show.title;
    if (state.selections[show.id]) {
      const check = document.createElement("span");
      check.className = "checked";
      check.textContent = "✓";
      title.appendChild(check);
    }
    li.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "mylist-result-meta";
    const venue = show.venue ? ` · ${show.venue}` : "";
    const times = (show.times || []).length ? ` · ${show.times.join(", ")}` : "";
    meta.textContent = `${theater.name}${venue}${times}`;
    li.appendChild(meta);

    li.addEventListener("click", () => focusShow(theaterId, show.id));
    results.appendChild(li);
  });
}

/**
 * Springt zum Marker eines Programmpunkts, öffnet das Menü und hebt den
 * Punkt hervor.
 */
function focusShow(theaterId, showId) {
  const theater = theatersById[theaterId];
  if (!theater) return;

  // Suche zurücksetzen und Reiter schließen.
  const input = document.getElementById("mylist-search-input");
  input.value = "";
  runSearch("");
  toggleMyList(false);

  if (mapInstance && theater.lat != null && theater.lng != null) {
    mapInstance.setView([theater.lat, theater.lng], 15, { animate: true });
    // Auf schmalen Screens verdeckt das Menü (Bottom-Sheet) die untere
    // Kartenhälfte – den Marker daher nach oben aus der Verdeckung schieben.
    if (window.innerWidth <= 720) {
      const offset = Math.round(mapInstance.getSize().y * 0.25);
      mapInstance.panBy([0, -offset], { animate: true });
    }
  }
  openPanel(theater, showId);
}

function renderMyList() {
  const container = document.getElementById("mylist-items");
  container.innerHTML = "";

  const entries = Object.entries(state.selections);
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "mylist-empty";
    empty.textContent = "Noch nichts ausgewählt.";
    container.appendChild(empty);
    return;
  }

  entries.forEach(([showId, sel]) => {
    const item = document.createElement("li");
    item.className = "mylist-item";

    const body = document.createElement("div");
    body.className = "mylist-item-body";

    const title = document.createElement("div");
    title.className = "mylist-item-title";
    title.textContent = sel.showTitle;
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "mylist-item-meta";
    const venue = sel.venue ? ` · ${sel.venue}` : "";
    const times = sel.times ? ` · ${sel.times}` : "";
    meta.textContent = `${sel.theaterName}${venue}${times}`;
    body.appendChild(meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mylist-remove";
    remove.setAttribute("aria-label", `${sel.showTitle} entfernen`);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeSelection(showId));

    item.appendChild(body);
    item.appendChild(remove);
    container.appendChild(item);
  });
}

function updateSubmitBar() {
  const count = Object.keys(state.selections).length;
  document.getElementById("submit-count").textContent =
    count === 1 ? "1 ausgewählt" : `${count} ausgewählt`;
  const btn = document.getElementById("submit-btn");
  btn.disabled = false;
  btn.textContent = count === 0 ? "Eintrag löschen" : "Auswahl absenden";
  renderMyList();
  if (count === 0) toggleMyList(false);
}

/* ---------- Bestätigungs-Dialog ---------- */

function askConfirm(message, okLabel) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm");
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    document.getElementById("confirm-text").textContent = message;
    okBtn.textContent = okLabel || "Ja";

    function cleanup(result) {
      overlay.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      resolve(result);
    }
    function onOk() {
      cleanup(true);
    }
    function onCancel() {
      cleanup(false);
    }
    function onBackdrop(event) {
      if (event.target === overlay) cleanup(false);
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    overlay.hidden = false;
  });
}

/* ---------- Absenden ---------- */

async function submitSelections() {
  const entries = Object.entries(state.selections);

  if (!CONFIG.APPS_SCRIPT_URL) {
    showToast("Kein Ziel konfiguriert (APPS_SCRIPT_URL fehlt).", true);
    return;
  }

  // Leere Auswahl = eigenen Eintrag komplett löschen -> Rückfrage.
  if (!entries.length) {
    const confirmed = await askConfirm(
      "Du hast nichts ausgewählt. Möchtest du deinen bisherigen Eintrag komplett löschen?",
      "Ja, löschen"
    );
    if (!confirmed) return;
  }

  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Senden…";

  const payload = {
    password: CONFIG.SHARED_PASSWORD,
    name: state.name,
    submittedAt: new Date().toISOString(),
    selections: entries.map(([showId, sel]) => ({
      showId,
      theater: sel.theaterName,
      show: sel.showTitle,
      times: sel.times,
    })),
  };

  try {
    const resp = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      // text/plain -> "simple request", vermeidet CORS-Preflight.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${resp.status}`);
    }
    showToast(
      entries.length
        ? "Danke! Deine Auswahl wurde gespeichert."
        : "Dein Eintrag wurde gelöscht."
    );
  } catch (err) {
    console.error(err);
    showToast("Senden fehlgeschlagen. Bitte später erneut versuchen.", true);
  } finally {
    updateSubmitBar();
  }
}

/* ---------- Toast ---------- */

let toastTimer = null;
function showToast(message, isError) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(isError));
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

/* ---------- Start ---------- */

function main() {
  loadState();
  setupGate();
  document.getElementById("panel-close").addEventListener("click", closePanel);
  document.getElementById("submit-btn").addEventListener("click", submitSelections);
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("mylist-toggle").addEventListener("click", () => toggleMyList());
  setupSearch();
  initMap();
}

document.addEventListener("DOMContentLoaded", main);
