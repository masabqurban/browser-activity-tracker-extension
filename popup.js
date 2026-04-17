const extApi = globalThis.browser || globalThis["chrome"];

const totalTabMsEl = document.getElementById("totalTabMs");
const totalIdleMsEl = document.getElementById("totalIdleMs");
const idleStateEl = document.getElementById("idleState");
const unsentCountEl = document.getElementById("unsentCount");
const droppedCountEl = document.getElementById("droppedCount");
const statusMessageEl = document.getElementById("statusMessage");
const domainListEl = document.getElementById("domainList");
const eventListEl = document.getElementById("eventList");
const dailySummaryEl = document.getElementById("dailySummary");
const showMoreBtn = document.getElementById("showMoreBtn");

const openDashboardBtn = document.getElementById("openDashboardBtn");
const refreshBtn = document.getElementById("refreshBtn");
const syncBtn = document.getElementById("syncBtn");
const exportBtn = document.getElementById("exportBtn");

let visibleEventCount = 5;
let allRecentEvents = [];
let autoRefreshTimer = null;

function setStatus(message, kind = "info") {
  if (!statusMessageEl) {
    return;
  }

  statusMessageEl.textContent = message;
  statusMessageEl.classList.remove("error", "success");
  if (kind === "error") {
    statusMessageEl.classList.add("error");
  }
  if (kind === "success") {
    statusMessageEl.classList.add("success");
  }
}

openDashboardBtn.addEventListener("click", async () => {
  await extApi.tabs.create({ url: extApi.runtime.getURL("dashboard.html") });
});

refreshBtn.addEventListener("click", () => {
  visibleEventCount = 5;
  setStatus("Refreshing snapshot...");
  loadSnapshot();
});

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  setStatus("Sync in progress...");
  try {
    await extApi.runtime.sendMessage({ type: "SYNC_QUEUED_EVENTS" });
    visibleEventCount = 5;
    await loadSnapshot();
    setStatus("Sync completed.", "success");
  } catch {
    setStatus("Sync failed. Try again.", "error");
  } finally {
    syncBtn.disabled = false;
  }
});

showMoreBtn.addEventListener("click", () => {
  visibleEventCount += 10;
  renderEventList(allRecentEvents);
});

exportBtn.addEventListener("click", async () => {
  try {
    const response = await extApi.runtime.sendMessage({ type: "GET_TRACKER_SNAPSHOT" });
    if (!response?.ok) {
      setStatus("Unable to export snapshot.", "error");
      return;
    }

    const blob = new Blob([JSON.stringify(response.snapshot, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `browser-activity-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Exported snapshot JSON.", "success");
  } catch {
    setStatus("Export failed.", "error");
  }
});

function formatDuration(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function safeText(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function formatEventLine(event) {
  const when = new Date(event.timestamp || Date.now()).toLocaleTimeString();
  if (event.type === "tab") {
    return {
      title: `${safeText(event.title)}`,
      meta: `${when} | ${safeText(event.url)} | ${formatDuration(event.duration || 0)}`
    };
  }
  if (event.type === "navigation") {
    return {
      title: "Navigation",
      meta: `${when} | ${safeText(event.url)}`
    };
  }
  if (event.type === "idle") {
    return {
      title: "Idle state",
      meta: `${when} | ${safeText(event.state)}`
    };
  }
  return {
    title: safeText(event.type),
    meta: `${when} | ${safeText(event.url)}`
  };
}

function renderDomainList(domainTotals) {
  domainListEl.innerHTML = "";

  const rows = Object.entries(domainTotals || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (rows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No domain usage yet.";
    domainListEl.appendChild(li);
    return;
  }

  for (const [domain, ms] of rows) {
    const li = document.createElement("li");
    li.textContent = `${domain} - ${formatDuration(ms)}`;
    domainListEl.appendChild(li);
  }
}

function renderEventList(events) {
  eventListEl.innerHTML = "";

  const recent = (events || []).slice(0, visibleEventCount);
  if (recent.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No events yet.";
    eventListEl.appendChild(li);
    showMoreBtn.style.display = "none";
    return;
  }

  for (const event of recent) {
    const li = document.createElement("li");
    const line = formatEventLine(event);

    const title = document.createElement("div");
    title.textContent = line.title;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = line.meta;

    li.appendChild(title);
    li.appendChild(meta);
    eventListEl.appendChild(li);
  }

  const remaining = Math.max(0, allRecentEvents.length - visibleEventCount);
  if (remaining > 0) {
    showMoreBtn.style.display = "block";
    showMoreBtn.textContent = `Show 10 more (${remaining} left)`;
  } else {
    showMoreBtn.style.display = "none";
  }
}

function renderPeriodSummary(targetEl, periodData) {
  const tracked = formatDuration(periodData?.tabMs || 0);
  const idle = formatDuration(periodData?.idleMs || 0);
  const events = periodData?.eventCount || 0;
  targetEl.textContent = `Tracked: ${tracked} | Idle: ${idle} | Events: ${events}`;
}

function ensureAutoRefreshRunning() {
  if (autoRefreshTimer) {
    return;
  }

  autoRefreshTimer = setInterval(() => {
    loadSnapshot();
  }, 8000);
}

window.addEventListener("beforeunload", () => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});

async function loadSnapshot() {
  try {
    const response = await extApi.runtime.sendMessage({ type: "GET_TRACKER_SNAPSHOT" });
    if (!response?.ok) {
      setStatus("Unable to load snapshot.", "error");
      return;
    }

    const snapshot = response.snapshot;
    totalTabMsEl.textContent = formatDuration(snapshot.totalTabMs || 0);
    totalIdleMsEl.textContent = formatDuration(snapshot.totalIdleMs || 0);
    idleStateEl.textContent = safeText(snapshot.idleState);
    unsentCountEl.textContent = String(snapshot.unsentEvents?.length || 0);
    if (droppedCountEl) {
      droppedCountEl.textContent = String(snapshot.droppedEvents || 0);
    }

    renderDomainList(snapshot.domainTotals || {});
    allRecentEvents = [...(snapshot.events || [])].reverse();
    renderEventList(allRecentEvents);
    renderPeriodSummary(dailySummaryEl, snapshot.reporting?.daily);
    setStatus("Snapshot updated.", "success");
  } catch {
    setStatus("Failed to refresh data. Is tracker running?", "error");
  }
}

loadSnapshot();
ensureAutoRefreshRunning();
