const extApi = globalThis.browser || globalThis["chrome"];

const STORAGE_KEYS = {
  events: "activityEvents",
  domainTotals: "domainTotals",
  totalTabMs: "totalTabMs",
  totalIdleMs: "totalIdleMs",
  currentSession: "currentSession",
  idleState: "idleState",
  idleStateChangedAt: "idleStateChangedAt",
  unsentEvents: "unsentEvents"
};

const MAX_EVENTS = 1000;
const API_TARGETS = {
  localDashboard: "http://localhost:3001/track",
  laravelErp: "http://localhost:8000/api/browser-activity",
  electronDesktop: "http://localhost:3002/browser-activity"
};

function addListenerSafe(eventObj, handler) {
  if (eventObj && typeof eventObj.addListener === "function") {
    eventObj.addListener(handler);
    return true;
  }
  return false;
}

function setIdleDetectionInterval(seconds) {
  if (extApi.idle && typeof extApi.idle.setDetectionInterval === "function") {
    extApi.idle.setDetectionInterval(seconds);
  }
}

addListenerSafe(extApi.runtime?.onInstalled, async () => {
  setIdleDetectionInterval(60);
  await ensureStorageDefaults();
  await captureActiveTabAsSession("installed");
});

addListenerSafe(extApi.runtime?.onStartup, async () => {
  setIdleDetectionInterval(60);
  await ensureStorageDefaults();
  await captureActiveTabAsSession("startup");
});

addListenerSafe(extApi.tabs?.onActivated, async (activeInfo) => {
  await finalizeCurrentSession("tab_switched");
  const tab = await safeGetTab(activeInfo.tabId);
  if (!tab) {
    return;
  }
  await startSessionFromTab(tab, "tab_activated");
});

addListenerSafe(extApi.tabs?.onUpdated, async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) {
    return;
  }

  const { currentSession } = await extApi.storage.local.get(STORAGE_KEYS.currentSession);
  if (!currentSession || currentSession.tabId !== tabId) {
    return;
  }

  await finalizeCurrentSession("url_changed");
  await startSessionFromTab(tab, "url_changed");
});

addListenerSafe(extApi.tabs?.onRemoved, async (tabId) => {
  const { currentSession } = await extApi.storage.local.get(STORAGE_KEYS.currentSession);
  if (currentSession && currentSession.tabId === tabId) {
    await finalizeCurrentSession("tab_closed");
  }
});

addListenerSafe(extApi.windows?.onFocusChanged, async (windowId) => {
  if (windowId === extApi.windows.WINDOW_ID_NONE) {
    await finalizeCurrentSession("browser_blur");
    return;
  }

  await finalizeCurrentSession("window_focus_change");
  await captureActiveTabAsSession("browser_focus");
});

addListenerSafe(extApi.idle?.onStateChanged, async (state) => {
  await updateIdleState(state);
});

addListenerSafe(extApi.webNavigation?.onCompleted, async (details) => {
  if (details.frameId !== 0 || !details.url) {
    return;
  }

  const event = {
    type: "navigation",
    url: details.url,
    title: "",
    tabId: details.tabId,
    timestamp: Date.now(),
    transitionType: details.transitionType || "unknown"
  };

  await appendEvent(event);
  await sendOrQueueEvent(event);
});

addListenerSafe(extApi.runtime?.onMessage, (message, _sender, sendResponse) => {
  if (message?.type === "GET_TRACKER_SNAPSHOT") {
    getSnapshot().then((snapshot) => sendResponse({ ok: true, snapshot }));
    return true;
  }

  if (message?.type === "SYNC_QUEUED_EVENTS") {
    flushQueuedEvents().then((result) => sendResponse({ ok: true, result }));
    return true;
  }

  return undefined;
});

async function ensureStorageDefaults() {
  const existing = await extApi.storage.local.get([
    STORAGE_KEYS.events,
    STORAGE_KEYS.domainTotals,
    STORAGE_KEYS.totalTabMs,
    STORAGE_KEYS.totalIdleMs,
    STORAGE_KEYS.idleState,
    STORAGE_KEYS.idleStateChangedAt,
    STORAGE_KEYS.unsentEvents
  ]);

  const updates = {};

  if (!Array.isArray(existing[STORAGE_KEYS.events])) {
    updates[STORAGE_KEYS.events] = [];
  }
  if (!existing[STORAGE_KEYS.domainTotals] || typeof existing[STORAGE_KEYS.domainTotals] !== "object") {
    updates[STORAGE_KEYS.domainTotals] = {};
  }
  if (typeof existing[STORAGE_KEYS.totalTabMs] !== "number") {
    updates[STORAGE_KEYS.totalTabMs] = 0;
  }
  if (typeof existing[STORAGE_KEYS.totalIdleMs] !== "number") {
    updates[STORAGE_KEYS.totalIdleMs] = 0;
  }
  if (typeof existing[STORAGE_KEYS.idleState] !== "string") {
    updates[STORAGE_KEYS.idleState] = "active";
  }
  if (typeof existing[STORAGE_KEYS.idleStateChangedAt] !== "number") {
    updates[STORAGE_KEYS.idleStateChangedAt] = Date.now();
  }
  if (!Array.isArray(existing[STORAGE_KEYS.unsentEvents])) {
    updates[STORAGE_KEYS.unsentEvents] = [];
  }

  if (Object.keys(updates).length > 0) {
    await extApi.storage.local.set(updates);
  }
}

async function safeGetTab(tabId) {
  try {
    return await extApi.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function captureActiveTabAsSession(reason) {
  const tab = await getCurrentActiveTab();
  if (!tab) {
    return;
  }
  await startSessionFromTab(tab, reason);
}

async function getCurrentActiveTab() {
  try {
    const tabs = await extApi.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

function isTrackableUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  return /^(https?:|file:)/i.test(url);
}

function getDomain(url) {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

async function startSessionFromTab(tab, reason) {
  if (!tab || !isTrackableUrl(tab.url)) {
    await extApi.storage.local.remove(STORAGE_KEYS.currentSession);
    return;
  }

  const now = Date.now();
  const currentSession = {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title || "",
    startedAt: now,
    reason
  };

  await extApi.storage.local.set({
    [STORAGE_KEYS.currentSession]: currentSession
  });

  const event = {
    type: "session_start",
    url: tab.url,
    title: tab.title || "",
    tabId: tab.id,
    timestamp: now,
    reason
  };

  await appendEvent(event);
  await sendOrQueueEvent(event);
}

async function finalizeCurrentSession(reason) {
  const { currentSession } = await extApi.storage.local.get(STORAGE_KEYS.currentSession);
  if (!currentSession || !currentSession.startedAt) {
    return;
  }

  const now = Date.now();
  const duration = Math.max(0, now - currentSession.startedAt);

  if (duration > 0 && isTrackableUrl(currentSession.url)) {
    const domain = getDomain(currentSession.url);
    const stored = await extApi.storage.local.get([
      STORAGE_KEYS.domainTotals,
      STORAGE_KEYS.totalTabMs
    ]);

    const domainTotals = { ...(stored[STORAGE_KEYS.domainTotals] || {}) };
    domainTotals[domain] = (domainTotals[domain] || 0) + duration;

    const totalTabMs = (stored[STORAGE_KEYS.totalTabMs] || 0) + duration;

    await extApi.storage.local.set({
      [STORAGE_KEYS.domainTotals]: domainTotals,
      [STORAGE_KEYS.totalTabMs]: totalTabMs
    });

    const event = {
      type: "tab",
      url: currentSession.url,
      title: currentSession.title || "",
      tabId: currentSession.tabId,
      duration,
      timestamp: now,
      reason
    };

    await appendEvent(event);
    await sendOrQueueEvent(event);
  }

  await extApi.storage.local.remove(STORAGE_KEYS.currentSession);
}

async function updateIdleState(nextState) {
  const now = Date.now();
  const stored = await extApi.storage.local.get([
    STORAGE_KEYS.idleState,
    STORAGE_KEYS.idleStateChangedAt,
    STORAGE_KEYS.totalIdleMs
  ]);

  const previousState = stored[STORAGE_KEYS.idleState] || "active";
  const previousChangedAt = stored[STORAGE_KEYS.idleStateChangedAt] || now;
  let totalIdleMs = stored[STORAGE_KEYS.totalIdleMs] || 0;

  if ((previousState === "idle" || previousState === "locked") && now > previousChangedAt) {
    totalIdleMs += now - previousChangedAt;
  }

  await extApi.storage.local.set({
    [STORAGE_KEYS.idleState]: nextState,
    [STORAGE_KEYS.idleStateChangedAt]: now,
    [STORAGE_KEYS.totalIdleMs]: totalIdleMs
  });

  const event = {
    type: "idle",
    state: nextState,
    timestamp: now
  };

  await appendEvent(event);
  await sendOrQueueEvent(event);
}

async function appendEvent(event) {
  const { activityEvents } = await extApi.storage.local.get(STORAGE_KEYS.events);
  const events = Array.isArray(activityEvents) ? activityEvents : [];

  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }

  await extApi.storage.local.set({
    [STORAGE_KEYS.events]: events
  });
}

async function sendOrQueueEvent(event) {
  const targetNames = Object.keys(API_TARGETS).filter((name) => Boolean(API_TARGETS[name]));
  if (targetNames.length === 0) {
    return;
  }

  const payload = {
    source: "browser-activity-tracker-extension",
    generatedAt: Date.now(),
    event
  };

  const pendingTargets = [];
  for (const targetName of targetNames) {
    const endpoint = API_TARGETS[targetName];
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch {
      pendingTargets.push(targetName);
    }
  }

  if (pendingTargets.length > 0) {
    const { unsentEvents } = await extApi.storage.local.get(STORAGE_KEYS.unsentEvents);
    const queued = Array.isArray(unsentEvents) ? unsentEvents : [];
    queued.push({ event, pendingTargets, queuedAt: Date.now() });
    await extApi.storage.local.set({ [STORAGE_KEYS.unsentEvents]: queued.slice(-MAX_EVENTS) });
  }
}

async function flushQueuedEvents() {
  const { unsentEvents } = await extApi.storage.local.get(STORAGE_KEYS.unsentEvents);
  const queued = Array.isArray(unsentEvents) ? unsentEvents : [];

  if (queued.length === 0) {
    return { sent: 0, remaining: 0 };
  }

  let sent = 0;
  const remaining = [];

  for (const queuedItem of queued) {
    const itemEvent = queuedItem?.event || queuedItem;
    const itemTargets = Array.isArray(queuedItem?.pendingTargets)
      ? queuedItem.pendingTargets
      : Object.keys(API_TARGETS).filter((name) => Boolean(API_TARGETS[name]));

    const nextPending = [];
    for (const targetName of itemTargets) {
      const endpoint = API_TARGETS[targetName];
      if (!endpoint) {
        continue;
      }

      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "browser-activity-tracker-extension",
            generatedAt: Date.now(),
            event: itemEvent
          })
        });
      } catch {
        nextPending.push(targetName);
      }
    }

    if (nextPending.length === 0) {
      sent += 1;
    } else {
      remaining.push({
        event: itemEvent,
        pendingTargets: nextPending,
        queuedAt: queuedItem?.queuedAt || Date.now()
      });
    }
  }

  await extApi.storage.local.set({ [STORAGE_KEYS.unsentEvents]: remaining });
  return { sent, remaining: remaining.length };
}

function getDayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildRangeReport(events, rangeStart, rangeEnd, liveState) {
  const inRange = (events || []).filter((event) => {
    const t = event?.timestamp || 0;
    return t >= rangeStart && t <= rangeEnd;
  });

  let tabMs = 0;
  const domainTotals = {};
  for (const event of inRange) {
    if (event.type !== "tab") {
      continue;
    }

    const duration = event.duration || 0;
    if (duration <= 0) {
      continue;
    }
    tabMs += duration;

    const domain = getDomain(event.url || "");
    domainTotals[domain] = (domainTotals[domain] || 0) + duration;
  }

  let idleMs = 0;
  const idleEvents = (events || [])
    .filter((event) => event.type === "idle" && (event.timestamp || 0) <= rangeEnd)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  let state = "active";
  let cursor = rangeStart;

  for (const idleEvent of idleEvents) {
    const t = idleEvent.timestamp || 0;
    if (t < rangeStart) {
      state = idleEvent.state || state;
      continue;
    }

    if ((state === "idle" || state === "locked") && t > cursor) {
      idleMs += t - cursor;
    }

    cursor = Math.max(cursor, t);
    state = idleEvent.state || state;
  }

  if ((state === "idle" || state === "locked") && rangeEnd > cursor) {
    idleMs += rangeEnd - cursor;
  }

  const topDomains = Object.entries(domainTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, ms]) => ({ domain, ms }));

  return {
    start: rangeStart,
    end: rangeEnd,
    tabMs,
    idleMs,
    eventCount: inRange.length,
    activeState: liveState,
    topDomains
  };
}

async function getSnapshot() {
  const data = await extApi.storage.local.get([
    STORAGE_KEYS.events,
    STORAGE_KEYS.domainTotals,
    STORAGE_KEYS.totalTabMs,
    STORAGE_KEYS.totalIdleMs,
    STORAGE_KEYS.currentSession,
    STORAGE_KEYS.idleState,
    STORAGE_KEYS.idleStateChangedAt,
    STORAGE_KEYS.unsentEvents
  ]);

  let totalTabMs = data[STORAGE_KEYS.totalTabMs] || 0;
  const currentSession = data[STORAGE_KEYS.currentSession] || null;

  if (currentSession?.startedAt && isTrackableUrl(currentSession.url)) {
    totalTabMs += Math.max(0, Date.now() - currentSession.startedAt);
  }

  let totalIdleMs = data[STORAGE_KEYS.totalIdleMs] || 0;
  const idleState = data[STORAGE_KEYS.idleState] || "active";
  const idleChangedAt = data[STORAGE_KEYS.idleStateChangedAt] || Date.now();

  if ((idleState === "idle" || idleState === "locked") && Date.now() > idleChangedAt) {
    totalIdleMs += Date.now() - idleChangedAt;
  }

  const events = Array.isArray(data[STORAGE_KEYS.events]) ? data[STORAGE_KEYS.events] : [];

  const now = Date.now();
  const currentDayStart = getDayStart(now);
  const weekStart = currentDayStart - 6 * 24 * 60 * 60 * 1000;
  const monthStart = currentDayStart - 29 * 24 * 60 * 60 * 1000;

  // Include open session in interval reports so the dashboard is near real-time.
  if (currentSession?.startedAt && isTrackableUrl(currentSession.url) && now > currentSession.startedAt) {
    events.push({
      type: "tab",
      url: currentSession.url,
      title: currentSession.title || "",
      tabId: currentSession.tabId,
      duration: now - currentSession.startedAt,
      timestamp: now,
      reason: "live_session"
    });
  }

  return {
    events,
    domainTotals: data[STORAGE_KEYS.domainTotals] || {},
    totalTabMs,
    totalIdleMs,
    idleState,
    currentSession,
    unsentEvents: Array.isArray(data[STORAGE_KEYS.unsentEvents]) ? data[STORAGE_KEYS.unsentEvents] : [],
    reporting: {
      daily: buildRangeReport(events, currentDayStart, now, idleState),
      weekly: buildRangeReport(events, weekStart, now, idleState),
      monthly: buildRangeReport(events, monthStart, now, idleState)
    },
    apiTargets: API_TARGETS
  };
}
