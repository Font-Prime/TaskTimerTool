const STORAGE_KEY = "chronicle-timers-state-v1";
const MAX_TIMERS = 2015;
const MAX_TIMER_MS = 100000 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 1000;
const OVERVIEW_TEMPLATE = [
  { key: "activeTimers", title: "Running now", description: "Timers currently counting live across this device and any restored sessions." },
  { key: "today", title: "Today", description: "Time logged today, including active timer overlap right now." },
  { key: "week", title: "This week", description: "Rolling week total from your history and any current running time." },
  { key: "allTime", title: "All time", description: "Total tracked time across your full Chronicle dataset." }
];

const state = loadState();
const elements = {
  timerForm: document.querySelector("#timer-form"),
  timerLimitNote: document.querySelector("#timer-limit-note"),
  overviewGrid: document.querySelector("#overview-grid"),
  searchInput: document.querySelector("#search-input"),
  statusFilter: document.querySelector("#status-filter"),
  sortSelect: document.querySelector("#sort-select"),
  timersList: document.querySelector("#timers-list"),
  timersEmpty: document.querySelector("#timers-empty"),
  template: document.querySelector("#timer-card-template"),
  backupExport: document.querySelector("#backup-export"),
  backupImport: document.querySelector("#backup-import"),
  syncSettingsToggle: document.querySelector("#sync-settings-toggle"),
  syncDialog: document.querySelector("#sync-dialog"),
  syncSave: document.querySelector("#sync-save"),
  syncNow: document.querySelector("#sync-now"),
  syncEnabled: document.querySelector("#sync-enabled"),
  syncUrl: document.querySelector("#sync-url"),
  syncKey: document.querySelector("#sync-key"),
  syncProfile: document.querySelector("#sync-profile")
};

bootstrap();

function bootstrap() {
  ensureStateShape();
  bindEvents();
  render();
  hydrateSyncDialog();
  window.setInterval(() => {
    renderOverview();
    renderTimerClocks();
    maybeAutoPersistRunningTimers();
  }, TICK_INTERVAL_MS);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
}

function bindEvents() {
  elements.timerForm.addEventListener("submit", handleCreateTimer);
  elements.searchInput.addEventListener("input", render);
  elements.statusFilter.addEventListener("change", render);
  elements.sortSelect.addEventListener("change", render);
  elements.backupExport.addEventListener("click", exportBackup);
  elements.backupImport.addEventListener("change", importBackup);
  elements.syncSettingsToggle.addEventListener("click", () => elements.syncDialog.showModal());
  elements.syncSave.addEventListener("click", saveSyncSettings);
  elements.syncNow.addEventListener("click", () => syncNow({ direction: "push-pull", interactive: true }));
}

function handleCreateTimer(event) {
  event.preventDefault();
  if (state.timers.length >= MAX_TIMERS) {
    window.alert(`You have reached the ${MAX_TIMERS.toLocaleString()} timer limit.`);
    return;
  }

  const formData = new FormData(elements.timerForm);
  const timer = createTimer({
    name: String(formData.get("name") || "").trim(),
    project: String(formData.get("project") || "").trim(),
    category: String(formData.get("category") || "").trim(),
    notes: String(formData.get("notes") || "").trim(),
    tags: parseTags(String(formData.get("tags") || ""))
  });

  state.timers.unshift(timer);
  persistState();
  elements.timerForm.reset();
  render();
}

function createTimer(input) {
  const now = Date.now();
  return {
    id: createId(),
    name: input.name || "Untitled task",
    project: input.project || "",
    category: input.category || "",
    tags: input.tags || [],
    notes: input.notes || "",
    totalMs: 0,
    currentSession: null,
    history: [],
    createdAt: now,
    updatedAt: now
  };
}

function render() {
  renderOverview();
  renderLimitNote();
  renderTimers();
}

function renderOverview() {
  const metrics = buildOverviewMetrics();
  elements.overviewGrid.innerHTML = "";

  for (const item of OVERVIEW_TEMPLATE) {
    const card = document.createElement("article");
    card.className = "overview-card";
    const value = item.key === "activeTimers" ? String(metrics.activeTimers) : formatDuration(metrics[item.key]);
    card.innerHTML = `<div><p class="eyebrow">${escapeHtml(item.title)}</p><strong>${escapeHtml(value)}</strong></div><p>${escapeHtml(item.description)}</p>`;
    elements.overviewGrid.append(card);
  }
}

function renderLimitNote() {
  const activeCount = state.timers.length;
  elements.timerLimitNote.textContent = `${activeCount.toLocaleString()} / ${MAX_TIMERS.toLocaleString()} timers in use`;
}

function renderTimers() {
  const timers = getVisibleTimers();
  elements.timersList.innerHTML = "";
  elements.timersEmpty.hidden = state.timers.length !== 0;

  for (const timer of timers) {
    const fragment = elements.template.content.cloneNode(true);
    const card = fragment.querySelector(".timer-card");
    card.dataset.timerId = timer.id;
    populateTimerCard(card, timer);
    elements.timersList.append(fragment);
  }
}

function populateTimerCard(card, timer) {
  const status = getTimerStatus(timer);
  card.querySelector('[data-field="name"]').value = timer.name;
  card.querySelector('[data-field="project"]').value = timer.project;
  card.querySelector('[data-field="category"]').value = timer.category;
  card.querySelector('[data-field="tags"]').value = timer.tags.join(", ");
  card.querySelector('[data-field="notes"]').value = timer.notes;
  card.querySelector('[data-role="project"]').textContent = timer.project || "No project";
  card.querySelector('[data-role="category"]').textContent = timer.category || "No category";
  card.querySelector('[data-role="status"]').textContent = toDisplayStatus(status);
  card.querySelector('[data-role="status"]').dataset.status = status;
  card.querySelector('[data-role="clock"]').textContent = formatDuration(getElapsedMs(timer));
  card.querySelector('[data-role="hours-left"]').textContent = `${formatHoursLeft(timer)} remaining before the 100,000-hour cap`;
  card.querySelector('[data-role="history-count"]').textContent = `${timer.history.length} logged`;

  const historyPreview = timer.history.slice(0, 5);
  card.querySelector('[data-role="history-list"]').innerHTML = historyPreview.length
    ? historyPreview.map(renderHistoryItem).join("")
    : `<li class="history-item"><strong>No saved sessions yet</strong><span>Stopping a timer writes a history entry here.</span></li>`;

  card.querySelectorAll("[data-field]").forEach((field) => {
    field.addEventListener("change", (event) => updateTimerField(timer.id, event.target.dataset.field, event.target.value));
  });

  card.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleTimerAction(timer.id, button.dataset.action));
  });
}

function renderTimerClocks() {
  document.querySelectorAll(".timer-card").forEach((card) => {
    const timer = getTimerById(card.dataset.timerId);
    if (!timer) {
      return;
    }
    const status = getTimerStatus(timer);
    card.querySelector('[data-role="clock"]').textContent = formatDuration(getElapsedMs(timer));
    card.querySelector('[data-role="hours-left"]').textContent = `${formatHoursLeft(timer)} remaining before the 100,000-hour cap`;
    card.querySelector('[data-role="status"]').textContent = toDisplayStatus(status);
    card.querySelector('[data-role="status"]').dataset.status = status;
  });
}

function handleTimerAction(timerId, action) {
  const timer = getTimerById(timerId);
  if (!timer) {
    return;
  }

  const now = Date.now();
  if (action === "start") {
    if (timer.currentSession) {
      window.alert("This timer already has an active or paused session.");
      return;
    }
    timer.currentSession = { startedAt: now, runningSince: now, accumulatedMs: 0 };
  }

  if (action === "pause" && timer.currentSession?.runningSince) {
    timer.currentSession.accumulatedMs += now - timer.currentSession.runningSince;
    timer.currentSession.runningSince = null;
  }

  if (action === "resume" && timer.currentSession && !timer.currentSession.runningSince) {
    timer.currentSession.runningSince = now;
  }

  if (action === "stop") {
    closeSession(timer, now);
  }

  if (action === "adjust") {
    adjustTimer(timer, now);
  }

  if (action === "reset") {
    const confirmed = window.confirm(`Reset "${timer.name}" and clear all logged time plus saved session history?`);
    if (!confirmed) {
      return;
    }
    timer.totalMs = 0;
    timer.currentSession = null;
    timer.history = [];
  }

  if (action === "delete") {
    const confirmed = window.confirm(`Delete "${timer.name}"? This removes its active state and history.`);
    if (!confirmed) {
      return;
    }
    state.timers = state.timers.filter((candidate) => candidate.id !== timer.id);
  }

  clampTimer(timer);
  timer.updatedAt = now;
  persistState();
  render();
}

function closeSession(timer, now) {
  if (!timer.currentSession) {
    return null;
  }

  const sessionDuration = getCurrentSessionDuration(timer, now);
  if (sessionDuration <= 0) {
    timer.currentSession = null;
    return null;
  }

  const allowedDuration = Math.min(sessionDuration, MAX_TIMER_MS - timer.totalMs);
  timer.totalMs += allowedDuration;
  timer.history.unshift({ id: createId(), startedAt: timer.currentSession.startedAt, endedAt: now, durationMs: allowedDuration });
  timer.currentSession = null;
  return allowedDuration;
}

function adjustTimer(timer, now) {
  const currentSeconds = Math.floor(getElapsedMs(timer) / 1000);
  const response = window.prompt(
    "Enter the total elapsed time in seconds for this timer. This updates the timer total without changing past session history.",
    String(currentSeconds)
  );

  if (response === null) {
    return;
  }

  const seconds = Number(response.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    window.alert("Please enter a valid non-negative number of seconds.");
    return;
  }

  timer.totalMs = Math.min(seconds * 1000, MAX_TIMER_MS);
  timer.currentSession = null;
  timer.updatedAt = now;
}

function updateTimerField(timerId, field, value) {
  const timer = getTimerById(timerId);
  if (!timer) {
    return;
  }

  timer[field] = field === "tags" ? parseTags(value) : String(value).trim();
  timer.updatedAt = Date.now();
  persistState();
  render();
}

function buildOverviewMetrics() {
  const now = Date.now();
  const ranges = getDateRanges(now);
  let today = 0;
  let week = 0;
  let allTime = 0;
  let activeTimers = 0;

  for (const timer of state.timers) {
    allTime += getElapsedMs(timer);
    if (timer.currentSession?.runningSince) {
      activeTimers += 1;
    }

    const segments = getTimerSegments(timer, now);
    for (const segment of segments) {
      today += overlapDuration(segment.start, segment.end, ranges.todayStart, ranges.tomorrowStart);
      week += overlapDuration(segment.start, segment.end, ranges.weekStart, ranges.tomorrowStart);
    }
  }

  return { activeTimers, today, week, allTime };
}

function getTimerSegments(timer, now) {
  const segments = timer.history.map((entry) => ({ start: entry.startedAt, end: entry.endedAt }));
  if (timer.currentSession) {
    segments.push({ start: timer.currentSession.startedAt, end: now });
  }
  return segments;
}

function getVisibleTimers() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const statusFilter = elements.statusFilter.value;
  const sortValue = elements.sortSelect.value;

  const filtered = state.timers.filter((timer) => {
    const status = getTimerStatus(timer);
    const haystack = [timer.name, timer.project, timer.category, timer.notes, timer.tags.join(" ")].join(" ").toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesStatus = statusFilter === "all" || status === statusFilter;
    return matchesQuery && matchesStatus;
  });

  filtered.sort((left, right) => {
    if (sortValue === "name-asc") {
      return left.name.localeCompare(right.name);
    }
    if (sortValue === "elapsed-desc") {
      return getElapsedMs(right) - getElapsedMs(left);
    }
    if (sortValue === "project-asc") {
      return (left.project || "~").localeCompare(right.project || "~");
    }
    return right.updatedAt - left.updatedAt;
  });

  return filtered;
}

function getElapsedMs(timer) {
  return Math.min(timer.totalMs + getCurrentSessionDuration(timer, Date.now()), MAX_TIMER_MS);
}

function getCurrentSessionDuration(timer, now) {
  if (!timer.currentSession) {
    return 0;
  }

  const runningMs = timer.currentSession.runningSince ? now - timer.currentSession.runningSince : 0;
  return Math.min(timer.currentSession.accumulatedMs + runningMs, MAX_TIMER_MS - timer.totalMs);
}

function getTimerStatus(timer) {
  if (timer.currentSession?.runningSince) {
    return "running";
  }
  if (timer.currentSession) {
    return "paused";
  }
  return "idle";
}

function toDisplayStatus(status) {
  return status === "running" ? "Running" : status === "paused" ? "Paused" : "Idle";
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatHoursLeft(timer) {
  const hoursLeft = Math.max(0, 100000 - getElapsedMs(timer) / 3600000);
  return `${hoursLeft.toLocaleString(undefined, { maximumFractionDigits: 2 })} hours`;
}

function renderHistoryItem(entry) {
  const started = new Date(entry.startedAt);
  const ended = new Date(entry.endedAt);
  return `<li class="history-item"><strong>${escapeHtml(formatDuration(entry.durationMs))}</strong><span>${escapeHtml(started.toLocaleString())} to ${escapeHtml(ended.toLocaleString())}</span></li>`;
}

function exportBackup() {
  const payload = JSON.stringify(state, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `chronicle-timers-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || !Array.isArray(parsed.timers)) {
        throw new Error("Invalid backup format.");
      }
      state.version = parsed.version || state.version;
      state.settings = normalizeSettings(parsed.settings || state.settings);
      state.timers = parsed.timers.map(normalizeTimer);
      persistState();
      hydrateSyncDialog();
      render();
    } catch (error) {
      window.alert(`Import failed: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function hydrateSyncDialog() {
  const sync = state.settings.sync;
  elements.syncEnabled.checked = !!sync.enabled;
  elements.syncUrl.value = sync.url || "";
  elements.syncKey.value = sync.key || "";
  elements.syncProfile.value = sync.profileId || "default";
}

function saveSyncSettings() {
  state.settings.sync = normalizeSettings({
    sync: {
      enabled: elements.syncEnabled.checked,
      url: elements.syncUrl.value.trim(),
      key: elements.syncKey.value.trim(),
      profileId: elements.syncProfile.value.trim() || "default"
    }
  }).sync;
  persistState();
  elements.syncDialog.close();
}

async function syncNow({ direction, interactive }) {
  const sync = state.settings.sync;
  if (!sync.enabled || !sync.url || !sync.key) {
    if (interactive) {
      window.alert("Cloud sync is not enabled yet. Open Sync settings to configure your Supabase project.");
    }
    return;
  }

  try {
    if (direction === "push-pull") {
      const remote = await fetchRemoteSnapshot(sync);
      if (remote?.updatedAt && remote.updatedAt > state.settings.lastSyncedAt) {
        state.timers = remote.payload.timers.map(normalizeTimer);
        state.settings = normalizeSettings({ ...state.settings, sync: { ...state.settings.sync }, lastSyncedAt: remote.updatedAt });
      }
      await pushRemoteSnapshot(sync);
    } else {
      await pushRemoteSnapshot(sync);
    }

    state.settings.lastSyncedAt = new Date().toISOString();
    persistState(false);
    render();
    if (interactive) {
      window.alert("Sync complete.");
    }
  } catch (error) {
    if (interactive) {
      window.alert(`Sync failed: ${error.message}`);
    }
  }
}

async function fetchRemoteSnapshot(sync) {
  const response = await fetch(`${sync.url}/rest/v1/timer_snapshots?profile_id=eq.${encodeURIComponent(sync.profileId)}&select=payload,updated_at`, {
    headers: buildSyncHeaders(sync)
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch remote snapshot (${response.status}).`);
  }

  const rows = await response.json();
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    payload: { ...state, ...row.payload, timers: Array.isArray(row.payload?.timers) ? row.payload.timers : [] },
    updatedAt: row.updated_at
  };
}

async function pushRemoteSnapshot(sync) {
  const response = await fetch(`${sync.url}/rest/v1/timer_snapshots`, {
    method: "POST",
    headers: { ...buildSyncHeaders(sync), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ profile_id: sync.profileId, payload: state, updated_at: new Date().toISOString() })
  });

  if (!response.ok) {
    throw new Error(`Unable to push remote snapshot (${response.status}).`);
  }
}

function buildSyncHeaders(sync) {
  return { apikey: sync.key, Authorization: `Bearer ${sync.key}` };
}

function maybeAutoPersistRunningTimers() {
  if (!state.timers.some((timer) => timer.currentSession?.runningSince)) {
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19);
  if (state.settings.lastTickPersistAt === stamp) {
    return;
  }

  state.settings.lastTickPersistAt = stamp;
  persistState(false);
}

function persistState(allowSync = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (allowSync && state.settings.sync.enabled) {
    window.setTimeout(() => syncNow({ direction: "push", interactive: false }), 0);
  }
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { version: 1, settings: normalizeSettings({}), timers: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      settings: normalizeSettings(parsed.settings || {}),
      timers: Array.isArray(parsed.timers) ? parsed.timers.map(normalizeTimer) : []
    };
  } catch {
    return { version: 1, settings: normalizeSettings({}), timers: [] };
  }
}

function ensureStateShape() {
  state.settings = normalizeSettings(state.settings);
  state.timers = state.timers.map(normalizeTimer);
}

function normalizeTimer(timer) {
  return {
    id: timer.id || createId(),
    name: timer.name || "Untitled task",
    project: timer.project || "",
    category: timer.category || "",
    tags: Array.isArray(timer.tags) ? timer.tags : parseTags(timer.tags || ""),
    notes: timer.notes || "",
    totalMs: Math.max(0, Math.min(Number(timer.totalMs) || 0, MAX_TIMER_MS)),
    currentSession: normalizeSession(timer.currentSession),
    history: Array.isArray(timer.history)
      ? timer.history.map((entry) => ({
          id: entry.id || createId(),
          startedAt: Number(entry.startedAt) || Date.now(),
          endedAt: Number(entry.endedAt) || Date.now(),
          durationMs: Math.max(0, Number(entry.durationMs) || 0)
        }))
      : [],
    createdAt: Number(timer.createdAt) || Date.now(),
    updatedAt: Number(timer.updatedAt) || Date.now()
  };
}

function normalizeSession(session) {
  if (!session) {
    return null;
  }

  return {
    startedAt: Number(session.startedAt) || Date.now(),
    runningSince: session.runningSince ? Number(session.runningSince) : null,
    accumulatedMs: Math.max(0, Number(session.accumulatedMs) || 0)
  };
}

function normalizeSettings(settings) {
  const sync = settings.sync || {};
  return {
    sync: {
      enabled: !!sync.enabled,
      url: sync.url || "",
      key: sync.key || "",
      profileId: sync.profileId || "default"
    },
    lastSyncedAt: settings.lastSyncedAt || "",
    lastTickPersistAt: settings.lastTickPersistAt || ""
  };
}

function parseTags(value) {
  const source = Array.isArray(value) ? value.join(",") : String(value || "");
  return source.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function overlapDuration(startA, endA, startB, endB) {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);
  return Math.max(0, end - start);
}

function getDateRanges(now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  return { todayStart: today.getTime(), tomorrowStart: tomorrow.getTime(), weekStart: weekStart.getTime() };
}

function clampTimer(timer) {
  timer.totalMs = Math.min(timer.totalMs, MAX_TIMER_MS);
  if (getElapsedMs(timer) >= MAX_TIMER_MS) {
    timer.currentSession = null;
  }
}

function getTimerById(timerId) {
  return state.timers.find((timer) => timer.id === timerId) || null;
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `timer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
