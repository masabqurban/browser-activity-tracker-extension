const extApi = globalThis.browser || globalThis["chrome"];

const totalTabMsEl = document.getElementById("totalTabMs");
const totalIdleMsEl = document.getElementById("totalIdleMs");
const idleStateEl = document.getElementById("idleState");
const unsentCountEl = document.getElementById("unsentCount");
const productivityScoreEl = document.getElementById("productivityScore");
const productivityMetaEl = document.getElementById("productivityMeta");
const domainListEl = document.getElementById("domainList");
const eventListEl = document.getElementById("eventList");
const dailySummaryEl = document.getElementById("dailySummary");
const weeklySummaryEl = document.getElementById("weeklySummary");
const monthlySummaryEl = document.getElementById("monthlySummary");
const showMoreBtn = document.getElementById("showMoreBtn");
const autoRefreshBtn = document.getElementById("autoRefreshBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const searchInput = document.getElementById("searchInput");
const timelineDateInput = document.getElementById("timelineDate");
const lastUpdatedEl = document.getElementById("lastUpdated");
const selectedHourEl = document.getElementById("selectedHour");
const peakHourEl = document.getElementById("peakHour");
const periodChart = document.getElementById("periodChart");
const domainChart = document.getElementById("domainChart");
const hourlyChart = document.getElementById("hourlyChart");

const refreshBtn = document.getElementById("refreshBtn");
const syncBtn = document.getElementById("syncBtn");
const exportBtn = document.getElementById("exportBtn");

let visibleEventCount = 20;
let allRecentEvents = [];
let allEvents = [];
let autoRefreshEnabled = false;
let autoRefreshTimer = null;
let selectedHourIndex = null;
let currentSnapshot = null;
let hourlyBarRegions = [];

timelineDateInput.value = formatDateInput(new Date());

refreshBtn.addEventListener("click", () => {
  visibleEventCount = 20;
  selectedHourIndex = null;
  loadSnapshot();
});

autoRefreshBtn.addEventListener("click", () => {
  autoRefreshEnabled = !autoRefreshEnabled;
  autoRefreshBtn.textContent = `Auto-refresh: ${autoRefreshEnabled ? "On" : "Off"}`;

  if (autoRefreshEnabled) {
    autoRefreshTimer = setInterval(() => {
      loadSnapshot();
    }, 10000);
  } else if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  await extApi.runtime.sendMessage({ type: "SYNC_QUEUED_EVENTS" });
  await loadSnapshot();
  syncBtn.disabled = false;
});

exportBtn.addEventListener("click", async () => {
  const response = await extApi.runtime.sendMessage({ type: "GET_TRACKER_SNAPSHOT" });
  if (!response?.ok) {
    return;
  }

  const blob = new Blob([JSON.stringify(response.snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `browser-activity-dashboard-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

exportCsvBtn.addEventListener("click", () => {
  const rows = ["timestamp,type,title,url,duration,state,reason"];
  for (const event of allRecentEvents) {
    const cols = [
      event.timestamp || "",
      event.type || "",
      csvSafe(event.title || ""),
      csvSafe(event.url || ""),
      event.duration || "",
      event.state || "",
      event.reason || ""
    ];
    rows.push(cols.join(","));
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `browser-activity-dashboard-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

showMoreBtn.addEventListener("click", () => {
  visibleEventCount += 10;
  renderWithFilters();
});

searchInput.addEventListener("input", () => {
  visibleEventCount = 20;
  renderWithFilters();
});

timelineDateInput.addEventListener("change", () => {
  selectedHourIndex = null;
  visibleEventCount = 20;
  renderWithFilters();
  drawHourlyTimeline(allEvents);
});

hourlyChart.addEventListener("click", (evt) => {
  const rect = hourlyChart.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;

  const hit = hourlyBarRegions.find((region) => x >= region.x && x <= region.x2 && y >= region.y && y <= region.y2);
  if (!hit) {
    return;
  }

  selectedHourIndex = selectedHourIndex === hit.index ? null : hit.index;
  visibleEventCount = 20;
  renderWithFilters();
  drawHourlyTimeline(allEvents);
});

window.addEventListener("beforeunload", () => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }
});

function csvSafe(value) {
  return `"${String(value).split('"').join('""')}"`;
}

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDateRange(dateInputValue) {
  const [y, m, d] = String(dateInputValue).split("-").map((part) => Number(part));
  const start = new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime();
  const end = start + 24 * 60 * 60 * 1000 - 1;
  return { start, end };
}

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
      title: safeText(event.title),
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
    .slice(0, 25);

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
  const visible = (events || []).slice(0, visibleEventCount);

  if (visible.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No events found for selected filters.";
    eventListEl.appendChild(li);
    showMoreBtn.style.display = "none";
    return;
  }

  for (const event of visible) {
    const line = formatEventLine(event);
    const li = document.createElement("li");
    const title = document.createElement("div");
    const meta = document.createElement("span");

    title.textContent = line.title;
    meta.className = "meta";
    meta.textContent = line.meta;

    li.appendChild(title);
    li.appendChild(meta);
    eventListEl.appendChild(li);
  }

  const remaining = Math.max(0, (events || []).length - visibleEventCount);
  showMoreBtn.style.display = remaining > 0 ? "block" : "none";
  if (remaining > 0) {
    showMoreBtn.textContent = `Show 10 more (${remaining} left)`;
  }
}

function filterEvents(events, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    return events || [];
  }

  return (events || []).filter((event) => {
    const raw = `${event.type || ""} ${event.title || ""} ${event.url || ""} ${event.state || ""}`;
    return raw.toLowerCase().includes(q);
  });
}

function filterBySelectedHour(events) {
  if (selectedHourIndex === null) {
    selectedHourEl.textContent = "All";
    return events;
  }

  const { start } = getDateRange(timelineDateInput.value);
  const hourStart = start + selectedHourIndex * 60 * 60 * 1000;
  const hourEnd = hourStart + 60 * 60 * 1000 - 1;
  const label = `${String(selectedHourIndex).padStart(2, "0")}:00`;
  selectedHourEl.textContent = label;

  return (events || []).filter((event) => {
    const ts = event?.timestamp || 0;
    return ts >= hourStart && ts <= hourEnd;
  });
}

function renderWithFilters() {
  const bySearch = filterEvents(allRecentEvents, searchInput.value);
  const byHour = filterBySelectedHour(bySearch);
  renderEventList(byHour);
}

function renderPeriodSummary(targetEl, periodData) {
  const tracked = formatDuration(periodData?.tabMs || 0);
  const idle = formatDuration(periodData?.idleMs || 0);
  const events = periodData?.eventCount || 0;
  targetEl.textContent = `Tracked: ${tracked} | Idle: ${idle} | Events: ${events}`;
}

function drawPeriodChart(reporting) {
  if (!periodChart) {
    return;
  }

  const ctx = periodChart.getContext("2d");
  if (!ctx) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = periodChart.clientWidth || 520;
  const cssHeight = 240;
  periodChart.width = Math.floor(cssWidth * dpr);
  periodChart.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const rows = [
    { label: "Daily", tracked: reporting?.daily?.tabMs || 0, idle: reporting?.daily?.idleMs || 0 },
    { label: "Weekly", tracked: reporting?.weekly?.tabMs || 0, idle: reporting?.weekly?.idleMs || 0 },
    { label: "Monthly", tracked: reporting?.monthly?.tabMs || 0, idle: reporting?.monthly?.idleMs || 0 }
  ];

  const maxVal = Math.max(1, ...rows.map((row) => Math.max(row.tracked, row.idle)));
  const chartLeft = 74;
  const chartTop = 16;
  const chartHeight = cssHeight - 42;
  const columnWidth = (cssWidth - chartLeft - 26) / rows.length;

  ctx.fillStyle = "#415977";
  ctx.font = "12px Segoe UI";
  rows.forEach((row, i) => {
    const groupX = chartLeft + i * columnWidth;
    const barWidth = Math.max(14, columnWidth * 0.28);
    const trackedH = (row.tracked / maxVal) * (chartHeight - 20);
    const idleH = (row.idle / maxVal) * (chartHeight - 20);
    const baseY = chartTop + chartHeight;

    ctx.fillStyle = "#1d6fa1";
    ctx.fillRect(groupX, baseY - trackedH, barWidth, trackedH);
    ctx.fillStyle = "#8bb8dd";
    ctx.fillRect(groupX + barWidth + 8, baseY - idleH, barWidth, idleH);

    ctx.fillStyle = "#415977";
    ctx.fillText(row.label, groupX - 2, cssHeight - 10);
  });
}

function drawDomainChart(domainTotals) {
  if (!domainChart) {
    return;
  }

  const ctx = domainChart.getContext("2d");
  if (!ctx) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = domainChart.clientWidth || 520;
  const cssHeight = 240;
  domainChart.width = Math.floor(cssWidth * dpr);
  domainChart.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const rows = Object.entries(domainTotals || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (rows.length === 0) {
    ctx.fillStyle = "#6f8098";
    ctx.font = "13px Segoe UI";
    ctx.fillText("No domain activity yet.", 10, 22);
    return;
  }

  const maxVal = Math.max(1, ...rows.map((row) => row[1]));
  const left = 140;
  const top = 20;
  const gap = 34;
  ctx.font = "12px Segoe UI";

  rows.forEach(([domain, ms], i) => {
    const y = top + i * gap;
    const width = ((cssWidth - left - 18) * ms) / maxVal;

    ctx.fillStyle = "#4f83b0";
    ctx.fillRect(left, y, width, 16);
    ctx.fillStyle = "#304f74";
    const shortDomain = domain.length > 22 ? `${domain.slice(0, 22)}...` : domain;
    ctx.fillText(shortDomain, 8, y + 12);
    ctx.fillText(formatDuration(ms), left + width + 6, y + 12);
  });
}

function getDayHourBuckets(events, dateInputValue) {
  const { start, end } = getDateRange(dateInputValue);
  const oneHourMs = 60 * 60 * 1000;
  const buckets = [];

  for (let i = 0; i < 24; i += 1) {
    buckets.push({ label: `${String(i).padStart(2, "0")}:00`, trackedMs: 0, events: 0 });
  }

  for (const event of events || []) {
    const ts = event?.timestamp || 0;
    if (ts < start || ts > end) {
      continue;
    }

    const idx = Math.min(23, Math.max(0, Math.floor((ts - start) / oneHourMs)));
    buckets[idx].events += 1;
    if (event.type === "tab" && event.duration) {
      buckets[idx].trackedMs += Math.max(0, event.duration);
    }
  }

  return buckets;
}

function drawHourlyTimeline(events) {
  if (!hourlyChart) {
    return;
  }

  const buckets = getDayHourBuckets(events, timelineDateInput.value);
  const peak = buckets.reduce((a, b) => (b.trackedMs > a.trackedMs ? b : a), { label: "-", trackedMs: 0 });
  peakHourEl.textContent = peak.trackedMs > 0 ? `${peak.label} (${formatDuration(peak.trackedMs)})` : "No tracked data";

  const ctx = hourlyChart.getContext("2d");
  if (!ctx) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = hourlyChart.clientWidth || 1060;
  const cssHeight = 230;
  hourlyChart.width = Math.floor(cssWidth * dpr);
  hourlyChart.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const maxTracked = Math.max(1, ...buckets.map((bucket) => bucket.trackedMs));
  const plotLeft = 36;
  const plotRight = cssWidth - 12;
  const plotBottom = cssHeight - 26;
  const plotTop = 16;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const barGap = 2;
  const barWidth = Math.max(4, plotWidth / buckets.length - barGap);

  ctx.strokeStyle = "#d8e3f3";
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  hourlyBarRegions = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    const x = plotLeft + i * (barWidth + barGap);
    const h = (bucket.trackedMs / maxTracked) * (plotHeight - 6);
    const y = plotBottom - h;

    ctx.fillStyle = selectedHourIndex === i ? "#0f4e88" : "#77a9d4";
    ctx.fillRect(x, y, barWidth, h);
    hourlyBarRegions.push({ index: i, x, x2: x + barWidth, y, y2: plotBottom });

    if (i % 3 === 0 || i === buckets.length - 1) {
      ctx.fillStyle = "#516881";
      ctx.font = "10px Segoe UI";
      ctx.fillText(bucket.label, x - 3, cssHeight - 8);
    }
  }

  ctx.fillStyle = "#1d6fa1";
  ctx.fillRect(10, 8, 10, 10);
  ctx.fillStyle = "#425a77";
  ctx.font = "12px Segoe UI";
  ctx.fillText("Tracked time by hour for selected date", 26, 17);
}

function calculateIdleMsInRange(events, start, end) {
  const idleEvents = (events || [])
    .filter((event) => event.type === "idle" && (event.timestamp || 0) <= end)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  let state = "active";
  let cursor = start;
  let idleMs = 0;

  for (const idleEvent of idleEvents) {
    const t = idleEvent.timestamp || 0;
    if (t < start) {
      state = idleEvent.state || state;
      continue;
    }

    if ((state === "idle" || state === "locked") && t > cursor) {
      idleMs += t - cursor;
    }

    cursor = Math.max(cursor, t);
    state = idleEvent.state || state;
  }

  if ((state === "idle" || state === "locked") && end > cursor) {
    idleMs += end - cursor;
  }

  return idleMs;
}

function updateProductivityScore(snapshot) {
  const { start, end } = getDateRange(timelineDateInput.value);
  let trackedMs = 0;

  for (const event of allEvents) {
    if (event.type !== "tab") {
      continue;
    }
    const ts = event.timestamp || 0;
    if (ts < start || ts > end) {
      continue;
    }
    trackedMs += Math.max(0, event.duration || 0);
  }

  const idleMs = calculateIdleMsInRange(allEvents, start, end);
  const totalMs = trackedMs + idleMs;
  const score = totalMs > 0 ? Math.round((trackedMs / totalMs) * 100) : 0;

  productivityScoreEl.textContent = `${score}%`;
  productivityMetaEl.textContent = `Date ${timelineDateInput.value} | Tracked ${formatDuration(trackedMs)} vs Idle ${formatDuration(idleMs)}`;

  if (snapshot?.idleState) {
    idleStateEl.textContent = safeText(snapshot.idleState);
  }
}

async function loadSnapshot() {
  const response = await extApi.runtime.sendMessage({ type: "GET_TRACKER_SNAPSHOT" });
  if (!response?.ok) {
    return;
  }

  currentSnapshot = response.snapshot;
  totalTabMsEl.textContent = formatDuration(currentSnapshot.totalTabMs || 0);
  totalIdleMsEl.textContent = formatDuration(currentSnapshot.totalIdleMs || 0);
  idleStateEl.textContent = safeText(currentSnapshot.idleState);
  unsentCountEl.textContent = String(currentSnapshot.unsentEvents?.length || 0);
  lastUpdatedEl.textContent = new Date().toLocaleTimeString();

  allEvents = currentSnapshot.events || [];
  allRecentEvents = [...allEvents].reverse();

  renderDomainList(currentSnapshot.domainTotals || {});
  renderPeriodSummary(dailySummaryEl, currentSnapshot.reporting?.daily);
  renderPeriodSummary(weeklySummaryEl, currentSnapshot.reporting?.weekly);
  renderPeriodSummary(monthlySummaryEl, currentSnapshot.reporting?.monthly);
  drawPeriodChart(currentSnapshot.reporting || {});
  drawDomainChart(currentSnapshot.domainTotals || {});
  drawHourlyTimeline(allEvents);
  renderWithFilters();
  updateProductivityScore(currentSnapshot);
}

loadSnapshot();
