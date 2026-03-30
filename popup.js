const totalTabMsEl = document.getElementById("totalTabMs");
const totalIdleMsEl = document.getElementById("totalIdleMs");
const idleStateEl = document.getElementById("idleState");
const unsentCountEl = document.getElementById("unsentCount");
const domainListEl = document.getElementById("domainList");
const eventListEl = document.getElementById("eventList");
const dailySummaryEl = document.getElementById("dailySummary");
const weeklySummaryEl = document.getElementById("weeklySummary");
const monthlySummaryEl = document.getElementById("monthlySummary");

const refreshBtn = document.getElementById("refreshBtn");
const syncBtn = document.getElementById("syncBtn");
const exportBtn = document.getElementById("exportBtn");

refreshBtn.addEventListener("click", () => {
  loadSnapshot();
});

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "SYNC_QUEUED_EVENTS" });
  await loadSnapshot();
  syncBtn.disabled = false;
});

exportBtn.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "GET_TRACKER_SNAPSHOT" });
  if (!response?.ok) {
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

  const recent = [...(events || [])].reverse().slice(0, 12);
  if (recent.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No events yet.";
    eventListEl.appendChild(li);
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
}

function renderPeriodSummary(targetEl, periodData) {
  const tracked = formatDuration(periodData?.tabMs || 0);
  const idle = formatDuration(periodData?.idleMs || 0);
  const events = periodData?.eventCount || 0;
  targetEl.textContent = `Tracked: ${tracked} | Idle: ${idle} | Events: ${events}`;
}

async function loadSnapshot() {
  const response = await chrome.runtime.sendMessage({ type: "GET_TRACKER_SNAPSHOT" });
  if (!response?.ok) {
    return;
  }

  const snapshot = response.snapshot;
  totalTabMsEl.textContent = formatDuration(snapshot.totalTabMs || 0);
  totalIdleMsEl.textContent = formatDuration(snapshot.totalIdleMs || 0);
  idleStateEl.textContent = safeText(snapshot.idleState);
  unsentCountEl.textContent = String(snapshot.unsentEvents?.length || 0);

  renderDomainList(snapshot.domainTotals || {});
  renderEventList(snapshot.events || []);
  renderPeriodSummary(dailySummaryEl, snapshot.reporting?.daily);
  renderPeriodSummary(weeklySummaryEl, snapshot.reporting?.weekly);
  renderPeriodSummary(monthlySummaryEl, snapshot.reporting?.monthly);
}

loadSnapshot();
