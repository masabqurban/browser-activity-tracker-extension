const extApi = globalThis.browser || globalThis["chrome"];

function detectBrowser() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    if (navigator.userAgent.includes("Edg")) return "Edge";
    if (navigator.userAgent.includes("OPR/")) return "Opera";
    return "Chrome";
  }
  if (typeof browser !== "undefined" && browser.runtime) return "Firefox";
  if (typeof safari !== "undefined" && safari.extension) return "Safari";
  return "Unknown";
}

const BROWSER_NAME = detectBrowser();

const STORAGE_KEYS = {
  events: "activityEvents",
  domainTotals: "domainTotals",
  totalTabMs: "totalTabMs",
  totalIdleMs: "totalIdleMs",
  currentSession: "currentSession",
  idleState: "idleState",
  idleStateChangedAt: "idleStateChangedAt",
  unsentEvents: "unsentEvents",
  officeHoursStatus: "officeHoursStatus",
  syncResetState: "syncResetState",
  bridgeConfig: "bridgeConfig",
  droppedEvents: "droppedEvents"
};

const ALARM_NAMES = {
  officeStatus: "tracker-office-status-refresh",
  syncReset: "tracker-sync-reset-check",
  extensionSnapshot: "tracker-extension-snapshot"
};

const DEFAULT_BRIDGE_PORT = 32145;
const FALLBACK_BRIDGE_PORTS = [3002];
const BRIDGE_ENDPOINTS = {
  bridgeConfig: "/api/bridge-config",
  browserActivity: "/browser-activity",
  officeHoursStatus: "/api/office-hours-status",
  syncStatus: "/api/sync-status"
};

const MAX_EVENTS = 2000;
const MAX_UNSENT_EVENTS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const OFFICE_STATUS_CACHE_GRACE_MS = 30 * 60 * 1000;
const MAX_SYNC_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 60000;
const MAX_BACKOFF_MS = 3600000;
const UNSENT_EVENT_ATTEMPT_LIMIT = 5;
const UNSENT_EVENT_EXPIRY_MS = 48 * 60 * 60 * 1000;
const EVENT_CLEANUP_THRESHOLD_DAYS = 30;
const SESSION_LOCK_TIMEOUT_MS = 5000;

let bridgeCache = null;
let bridgeCacheLoadedAt = 0;
let sessionLock = false;
let intervalsStarted = false;
let alarmsSupported = false;

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

function uniqueNumbers(values) {
  const output = [];
  for (const value of values) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
      continue;
    }
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }
  return output;
}

function toLocalDateKey(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getDateKey(ts) {
  return toLocalDateKey(ts);
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

function shouldTrackWithStatus(status) {
  if (!status || typeof status !== "object") {
    return true;
  }

  if (typeof status.isTrackingActive === "boolean") {
    return status.isTrackingActive;
  }

  return true;
}

async function ensureStorageDefaults() {
  const existing = await extApi.storage.local.get([
    STORAGE_KEYS.events,
    STORAGE_KEYS.domainTotals,
    STORAGE_KEYS.totalTabMs,
    STORAGE_KEYS.totalIdleMs,
    STORAGE_KEYS.idleState,
    STORAGE_KEYS.idleStateChangedAt,
    STORAGE_KEYS.unsentEvents,
    STORAGE_KEYS.syncResetState,
    STORAGE_KEYS.bridgeConfig,
    STORAGE_KEYS.droppedEvents
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
  if (!existing[STORAGE_KEYS.syncResetState] || typeof existing[STORAGE_KEYS.syncResetState] !== "object") {
    updates[STORAGE_KEYS.syncResetState] = {
      lastHandledSyncAt: null
    };
  }
  if (!existing[STORAGE_KEYS.bridgeConfig] || typeof existing[STORAGE_KEYS.bridgeConfig] !== "object") {
    updates[STORAGE_KEYS.bridgeConfig] = {
      baseUrl: null,
      token: null,
      port: null,
      fallbackPorts: []
    };
  }
  if (typeof existing[STORAGE_KEYS.droppedEvents] !== "number") {
    updates[STORAGE_KEYS.droppedEvents] = 0;
  }

  if (Object.keys(updates).length > 0) {
    await extApi.storage.local.set(updates);
  }
}

async function readStoredBridgeConfig() {
  const { bridgeConfig } = await extApi.storage.local.get(STORAGE_KEYS.bridgeConfig);
  if (!bridgeConfig || typeof bridgeConfig !== "object") {
    return null;
  }

  return {
    baseUrl: typeof bridgeConfig.baseUrl === "string" ? bridgeConfig.baseUrl : null,
    token: typeof bridgeConfig.token === "string" ? bridgeConfig.token : null,
    port: Number(bridgeConfig.port) || null,
    fallbackPorts: Array.isArray(bridgeConfig.fallbackPorts) ? bridgeConfig.fallbackPorts : []
  };
}

async function persistBridgeConfig(config) {
  await extApi.storage.local.set({
    [STORAGE_KEYS.bridgeConfig]: {
      baseUrl: config?.baseUrl || null,
      token: config?.token || null,
      port: Number(config?.port) || null,
      fallbackPorts: Array.isArray(config?.fallbackPorts) ? config.fallbackPorts : []
    }
  });
}

function buildBridgeBaseCandidates(storedConfig) {
  const storedPorts = Array.isArray(storedConfig?.fallbackPorts) ? storedConfig.fallbackPorts : [];
  const prioritizedPorts = uniqueNumbers([
    storedConfig?.port,
    DEFAULT_BRIDGE_PORT,
    ...storedPorts,
    ...FALLBACK_BRIDGE_PORTS
  ]);

  const bases = [];
  if (storedConfig?.baseUrl) {
    bases.push(storedConfig.baseUrl.replace(/\/+$/, ""));
  }

  for (const port of prioritizedPorts) {
    bases.push(`http://127.0.0.1:${port}`);
  }

  return [...new Set(bases)];
}

async function fetchBridgeConfigFromBase(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}${BRIDGE_ENDPOINTS.bridgeConfig}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const bridge = payload?.bridge || {};
    if (!bridge?.token) {
      return null;
    }

    return {
      baseUrl: String(bridge.baseUrl || baseUrl).replace(/\/+$/, ""),
      token: String(bridge.token),
      port: Number(bridge.port) || null,
      fallbackPorts: Array.isArray(bridge.fallbackPorts) ? bridge.fallbackPorts : []
    };
  } catch {
    return null;
  }
}

async function ensureBridgeConfig(options = {}) {
  const force = options?.force === true;
  const now = Date.now();

  if (!force && bridgeCache?.baseUrl && bridgeCache?.token && now - bridgeCacheLoadedAt < 5 * 60 * 1000) {
    return bridgeCache;
  }

  const stored = await readStoredBridgeConfig();
  const candidates = buildBridgeBaseCandidates(stored);

  for (const baseUrl of candidates) {
    const config = await fetchBridgeConfigFromBase(baseUrl);
    if (!config) {
      continue;
    }

    bridgeCache = config;
    bridgeCacheLoadedAt = now;
    await persistBridgeConfig(config);
    return config;
  }

  if (stored?.baseUrl && stored?.token) {
    bridgeCache = stored;
    bridgeCacheLoadedAt = now;
    return stored;
  }

  return null;
}

function buildBridgeHeaders(token) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (token) {
    headers["X-Tracker-Token"] = token;
  }

  return headers;
}

async function bridgeGet(path) {
  const bridge = await ensureBridgeConfig();
  if (!bridge) {
    return { ok: false, status: 0, data: null, bridgeUnavailable: true };
  }

  try {
    let response = await fetch(`${bridge.baseUrl}${path}`, {
      method: "GET",
      headers: buildBridgeHeaders(bridge.token)
    });

    // If desktop app restarted, bridge token may rotate. Refresh once and retry.
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const refreshed = await ensureBridgeConfig({ force: true });
      if (refreshed?.baseUrl && refreshed?.token) {
        response = await fetch(`${refreshed.baseUrl}${path}`, {
          method: "GET",
          headers: buildBridgeHeaders(refreshed.token)
        });
      }
    }

    if (!response.ok) {
      return { ok: false, status: response.status, data: null, bridgeUnavailable: false };
    }

    const data = await response.json();
    return { ok: true, status: response.status, data, bridgeUnavailable: false };
  } catch {
    return { ok: false, status: 0, data: null, bridgeUnavailable: true };
  }
}

async function bridgePost(path, payload) {
  const bridge = await ensureBridgeConfig();
  if (!bridge) {
    return { ok: false, status: 0, bridgeUnavailable: true };
  }

  try {
    let response = await fetch(`${bridge.baseUrl}${path}`, {
      method: "POST",
      headers: buildBridgeHeaders(bridge.token),
      body: JSON.stringify(payload)
    });

    // If desktop app restarted, bridge token may rotate. Refresh once and retry.
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const refreshed = await ensureBridgeConfig({ force: true });
      if (refreshed?.baseUrl && refreshed?.token) {
        response = await fetch(`${refreshed.baseUrl}${path}`, {
          method: "POST",
          headers: buildBridgeHeaders(refreshed.token),
          body: JSON.stringify(payload)
        });
      }
    }

    if (!response.ok) {
      return { ok: false, status: response.status, bridgeUnavailable: false };
    }

    return { ok: true, status: response.status, bridgeUnavailable: false };
  } catch {
    return { ok: false, status: 0, bridgeUnavailable: true };
  }
}

async function safeGetTab(tabId) {
  try {
    return await extApi.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function getCurrentActiveTab() {
  try {
    const tabs = await extApi.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

async function queueDroppedCount(increment = 1) {
  const stored = await extApi.storage.local.get(STORAGE_KEYS.droppedEvents);
  const current = Number(stored[STORAGE_KEYS.droppedEvents] || 0);
  await extApi.storage.local.set({ [STORAGE_KEYS.droppedEvents]: current + Math.max(0, increment) });
}

async function pushToBoundedArray(storageKey, item, maxLength) {
  const stored = await extApi.storage.local.get(storageKey);
  const current = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
  current.push(item);

  if (maxLength > 0 && current.length > maxLength) {
    const overflow = current.length - maxLength;
    current.splice(0, overflow);
    await queueDroppedCount(overflow);
  }

  await extApi.storage.local.set({ [storageKey]: current });
}

async function appendEvent(event) {
  await pushToBoundedArray(STORAGE_KEYS.events, event, MAX_EVENTS);
}

async function queueEventForRetry(event, pendingTargets) {
  const now = Date.now();
  const queueItem = {
    event,
    pendingTargets,
    queuedAt: now,
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: now + INITIAL_BACKOFF_MS,
    expireAt: now + UNSENT_EVENT_EXPIRY_MS
  };
  await pushToBoundedArray(STORAGE_KEYS.unsentEvents, queueItem, MAX_UNSENT_EVENTS);
}

async function checkOfficeHoursStatus() {
  const bridgeResult = await bridgeGet(BRIDGE_ENDPOINTS.officeHoursStatus);
  if (bridgeResult.ok) {
    const data = bridgeResult.data || {};
    return {
      isWithinOfficeHours: data.isWithinOfficeHours !== false,
      isAuthenticated: data.isAuthenticated === true,
      isTrackingActive:
        data.isTrackingActive === true ||
        (data.isAuthenticated === true && data.isWithinOfficeHours !== false),
      employee: data.employee || null,
      checkedAt: Date.now(),
      fromBridge: true
    };
  }

  const { officeHoursStatus } = await extApi.storage.local.get(STORAGE_KEYS.officeHoursStatus);
  if (officeHoursStatus && typeof officeHoursStatus === "object") {
    const checkedAt = Number(officeHoursStatus.checkedAt || 0);
    if (Date.now() - checkedAt <= OFFICE_STATUS_CACHE_GRACE_MS) {
      return {
        ...officeHoursStatus,
        fromBridge: false,
        statusUnknown: true
      };
    }
  }

  return {
    isWithinOfficeHours: true,
    isAuthenticated: false,
    employee: null,
    checkedAt: Date.now(),
    fromBridge: false,
    statusUnknown: true
  };
}

async function updateOfficeHoursStatus() {
  const status = await checkOfficeHoursStatus();
  if (status.fromBridge) {
    await extApi.storage.local.set({
      [STORAGE_KEYS.officeHoursStatus]: {
        isWithinOfficeHours: status.isWithinOfficeHours,
        isAuthenticated: status.isAuthenticated,
        isTrackingActive: status.isTrackingActive,
        employee: status.employee,
        checkedAt: status.checkedAt
      }
    });
  }

  return status;
}

async function captureActiveTabAsSession(reason) {
  const tab = await getCurrentActiveTab();
  if (!tab) {
    return;
  }
  await startSessionFromTab(tab, reason);
}

async function startSessionFromTab(tab, reason) {
  await acquireSessionLock();
  try {
    if (!tab || !isTrackableUrl(tab.url)) {
      await extApi.storage.local.remove(STORAGE_KEYS.currentSession);
      return;
    }

    const officeStatus = await updateOfficeHoursStatus();
    if (!shouldTrackWithStatus(officeStatus)) {
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
      reason,
      isIncognito: tab.incognito || false
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
      reason,
      isIncognito: tab.incognito || false
    };

    await appendEvent(event);
    await sendOrQueueEvent(event);
  } finally {
    releaseSessionLock();
  }
}

async function acquireSessionLock(timeoutMs = SESSION_LOCK_TIMEOUT_MS) {
  const startTime = Date.now();
  while (sessionLock && Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  sessionLock = true;
}

function releaseSessionLock() {
  sessionLock = false;
}

async function finalizeCurrentSession(reason) {
  await acquireSessionLock();
  try {
    const { currentSession } = await extApi.storage.local.get(STORAGE_KEYS.currentSession);
    if (!currentSession || !currentSession.startedAt) {
      return;
    }

  const officeStatus = await checkOfficeHoursStatus();
  if (!shouldTrackWithStatus(officeStatus)) {
    await extApi.storage.local.remove(STORAGE_KEYS.currentSession);
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
      reason,
      isIncognito: currentSession.isIncognito || false
    };

    await appendEvent(event);
    await sendOrQueueEvent(event);
  }

    await extApi.storage.local.remove(STORAGE_KEYS.currentSession);
  } finally {
    releaseSessionLock();
  }
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

  const officeStatus = await checkOfficeHoursStatus();
  if (!shouldTrackWithStatus(officeStatus)) {
    return;
  }

  const event = {
    type: "idle",
    state: nextState,
    timestamp: now
  };

  await appendEvent(event);
  await sendOrQueueEvent(event);
}

function getBridgeTargets() {
  return {
    electronDesktop: BRIDGE_ENDPOINTS.browserActivity
  };
}

async function sendOrQueueEvent(event) {
  const officeStatus = await checkOfficeHoursStatus();
  if (!shouldTrackWithStatus(officeStatus)) {
    return;
  }

  const targets = getBridgeTargets();
  const targetNames = Object.keys(targets);
  if (targetNames.length === 0) {
    return;
  }

  const payload = {
    source: "browser-activity-tracker-extension",
    generatedAt: Date.now(),
    browser: BROWSER_NAME,
    event
  };

  const pendingTargets = [];
  for (const targetName of targetNames) {
    const endpoint = targets[targetName];
    const result = await bridgePost(endpoint, payload);
    if (!result.ok) {
      pendingTargets.push(targetName);
    }
  }

  if (pendingTargets.length > 0) {
    await queueEventForRetry(event, pendingTargets);
  }
}

async function flushQueuedEvents() {
  const { unsentEvents } = await extApi.storage.local.get(STORAGE_KEYS.unsentEvents);
  let queued = Array.isArray(unsentEvents) ? unsentEvents : [];

  if (queued.length === 0) {
    return { sent: 0, remaining: 0 };
  }

  const targets = getBridgeTargets();
  const now = Date.now();
  let sent = 0;
  const remaining = [];

  for (const queuedItem of queued) {
    const itemEvent = queuedItem?.event || queuedItem;
    const itemAttempts = Number(queuedItem?.attempts || 0);
    const nextRetryAt = Number(queuedItem?.nextRetryAt || now);
    const expireAt = Number(queuedItem?.expireAt || now + UNSENT_EVENT_EXPIRY_MS);

    // Skip if expired (48 hours old)
    if (expireAt <= now) {
      continue;
    }

    // Skip if max attempts reached
    if (itemAttempts >= UNSENT_EVENT_ATTEMPT_LIMIT) {
      continue;
    }

    // Skip if next retry time not yet reached (backoff)
    if (nextRetryAt > now) {
      remaining.push(queuedItem);
      continue;
    }

    const itemTargets = Array.isArray(queuedItem?.pendingTargets)
      ? queuedItem.pendingTargets
      : Object.keys(targets);

    const nextPending = [];
    for (const targetName of itemTargets) {
      const endpoint = targets[targetName];
      if (!endpoint) {
        continue;
      }

      const result = await bridgePost(endpoint, {
        source: "browser-activity-tracker-extension",
        generatedAt: Date.now(),
        browser: BROWSER_NAME,
        event: itemEvent
      });

      if (!result.ok) {
        nextPending.push(targetName);
      }
    }

    if (nextPending.length === 0) {
      sent += 1;
    } else {
      // Calculate exponential backoff: 1min, 2min, 4min, 8min, 16min, ...
      const backoffMs = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, itemAttempts),
        MAX_BACKOFF_MS
      );

      remaining.push({
        event: itemEvent,
        pendingTargets: nextPending,
        queuedAt: queuedItem?.queuedAt || now,
        attempts: itemAttempts + 1,
        lastAttemptAt: now,
        nextRetryAt: now + backoffMs,
        expireAt: queuedItem?.expireAt || now + UNSENT_EVENT_EXPIRY_MS
      });
    }
  }

  const retained = MAX_UNSENT_EVENTS > 0 ? remaining.slice(-MAX_UNSENT_EVENTS) : [];
  await extApi.storage.local.set({ [STORAGE_KEYS.unsentEvents]: retained });
  return { sent, remaining: remaining.length };
}

function calcIdleMsAcrossRange(events, start, end) {
  let idleMs = 0;
  const idleEvents = (events || [])
    .filter((event) => event.type === "idle" && (event.timestamp || 0) <= end)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  let state = "active";
  let cursor = start;

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

function rebuildStoredAggregatesFromEvents(events) {
  const domainTotals = {};
  let totalTabMs = 0;

  for (const event of events) {
    if (event?.type !== "tab") {
      continue;
    }

    const duration = Number(event.duration || 0);
    if (duration <= 0) {
      continue;
    }

    totalTabMs += duration;
    const domain = getDomain(event.url || "");
    domainTotals[domain] = (domainTotals[domain] || 0) + duration;
  }

  const now = Date.now();
  const totalIdleMs = calcIdleMsAcrossRange(events, 0, now);

  return {
    domainTotals,
    totalTabMs,
    totalIdleMs
  };
}

async function getDesktopSyncStatus() {
  const result = await bridgeGet(BRIDGE_ENDPOINTS.syncStatus);
  if (!result.ok) {
    return null;
  }

  return result.data;
}

async function checkAndApplySyncResets() {
  const now = Date.now();
  const syncStatus = await getDesktopSyncStatus();
  let successfulSyncAt = Number(syncStatus?.lastSuccessfulSummarySyncAt || 0);

  // Fallback: If no sync heard for > 25 hours, assume daily reset should happen (bridge may be offline)
  // Use current day start as speculative sync time
  if (!successfulSyncAt) {
    const lastHandledSyncAt = await extApi.storage.local.get(STORAGE_KEYS.syncResetState).then(
      s => Number((s?.[STORAGE_KEYS.syncResetState]?.lastHandledSyncAt) || 0)
    );
    
    // Only apply fallback if we haven't synced in > 25 hours
    if (now - lastHandledSyncAt > 25 * 60 * 60 * 1000) {
      successfulSyncAt = getDayStart(now);
    } else {
      return;
    }
  }

  const stored = await extApi.storage.local.get([
    STORAGE_KEYS.events,
    STORAGE_KEYS.unsentEvents,
    STORAGE_KEYS.syncResetState
  ]);

  const resetState = stored[STORAGE_KEYS.syncResetState] || {};
  if (Number(resetState.lastHandledSyncAt || 0) >= successfulSyncAt) {
    return;
  }

  const syncDateKey = getDateKey(successfulSyncAt);
  let events = Array.isArray(stored[STORAGE_KEYS.events]) ? stored[STORAGE_KEYS.events] : [];
  const unsentEvents = Array.isArray(stored[STORAGE_KEYS.unsentEvents]) ? stored[STORAGE_KEYS.unsentEvents] : [];

  // FIX: Don't block reset if unsentEvents exist. Instead, only block if unsentEvent is from the synced date
  // and still within recent attempt window (not expired)
  const hasPendingSyncDate = unsentEvents.some((item) => {
    const event = item?.event || item;
    const eventDate = getDateKey(event?.timestamp || successfulSyncAt);
    const itemExpireAt = Number(item?.expireAt || now + UNSENT_EVENT_EXPIRY_MS);
    
    // Only consider pending if: (1) from sync date, (2) not yet expired, (3) within attempt limit
    return eventDate === syncDateKey && 
           itemExpireAt > now && 
           (item?.attempts || 0) < UNSENT_EVENT_ATTEMPT_LIMIT;
  });

  // Clear old/expired unsent events from the sync date regardless
  const validUnsentEvents = unsentEvents.filter((item) => {
    const event = item?.event || item;
    const eventDate = getDateKey(event?.timestamp || successfulSyncAt);
    const itemExpireAt = Number(item?.expireAt || now + UNSENT_EVENT_EXPIRY_MS);
    
    return !(eventDate === syncDateKey && itemExpireAt <= now);
  });

  if (hasPendingSyncDate) {
    // Update storage with cleaned unsentEvents and return (don't clear main events yet)
    await extApi.storage.local.set({
      [STORAGE_KEYS.unsentEvents]: validUnsentEvents
    });
    return;
  }

  // Now safe to clear events from sync date
  events = events.filter((event) => getDateKey(event?.timestamp || successfulSyncAt) !== syncDateKey);

  const rebuilt = rebuildStoredAggregatesFromEvents(events);

  await extApi.storage.local.set({
    [STORAGE_KEYS.events]: events,
    [STORAGE_KEYS.currentSession]: null,
    [STORAGE_KEYS.domainTotals]: rebuilt.domainTotals,
    [STORAGE_KEYS.totalTabMs]: rebuilt.totalTabMs,
    [STORAGE_KEYS.totalIdleMs]: rebuilt.totalIdleMs,
    [STORAGE_KEYS.syncResetState]: {
      lastHandledSyncAt: successfulSyncAt
    }
  });
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
    STORAGE_KEYS.unsentEvents,
    STORAGE_KEYS.droppedEvents
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

  const bridge = await ensureBridgeConfig();
  const bridgeTargets = {
    electronDesktop: bridge?.baseUrl ? `${bridge.baseUrl}${BRIDGE_ENDPOINTS.browserActivity}` : null
  };

  return {
    events,
    domainTotals: data[STORAGE_KEYS.domainTotals] || {},
    totalTabMs,
    totalIdleMs,
    idleState,
    currentSession,
    unsentEvents: Array.isArray(data[STORAGE_KEYS.unsentEvents]) ? data[STORAGE_KEYS.unsentEvents] : [],
    droppedEvents: Number(data[STORAGE_KEYS.droppedEvents] || 0),
    reporting: {
      daily: buildRangeReport(events, currentDayStart, now, idleState)
    },
    apiTargets: bridgeTargets
  };
}

async function sendExtensionSnapshot() {
  // Drain queued events before snapshot push so desktop dashboard receives fresh extension data.
  await flushQueuedEvents();

  const snapshot = await getSnapshot();
  const daily = snapshot.reporting?.daily || { tabMs: 0, idleMs: 0, eventCount: 0, topDomains: [] };

  const payload = {
    source: "browser-activity-tracker-extension",
    type: "extension_snapshot",
    browser: BROWSER_NAME,
    generatedAt: Date.now(),
    data: {
      topDomains: (daily.topDomains || []).map((d) => ({
        domain: d.domain,
        durationMs: d.ms
      })).slice(0, 10),
      totalTabMs: daily.tabMs || 0,
      totalIdleMs: daily.idleMs || 0,
      daily: {
        tabMs: daily.tabMs || 0,
        idleMs: daily.idleMs || 0,
        eventCount: daily.eventCount || 0,
        topDomains: (daily.topDomains || []).map((d) => ({ domain: d.domain, durationMs: d.ms }))
      },
      productivity: (daily.tabMs || 0) + (daily.idleMs || 0) > 0
        ? Math.round(((daily.tabMs || 0) / ((daily.tabMs || 0) + (daily.idleMs || 0))) * 100)
        : 0
    }
  };

  const result = await bridgePost(BRIDGE_ENDPOINTS.browserActivity, payload);
  if (result.ok) {
    await checkAndApplySyncResets();
  } else {
    // Keep reset logic moving even when snapshot upload fails.
    await checkAndApplySyncResets();
  }
}

async function scheduleAlarms() {
  if (!extApi.alarms || typeof extApi.alarms.create !== "function") {
    alarmsSupported = false;
    return false;
  }

  try {
    extApi.alarms.create(ALARM_NAMES.officeStatus, { periodInMinutes: 5 });
    extApi.alarms.create(ALARM_NAMES.syncReset, { periodInMinutes: 1 });
    extApi.alarms.create(ALARM_NAMES.extensionSnapshot, { periodInMinutes: 1 });
    alarmsSupported = true;
    return true;
  } catch (err) {
    alarmsSupported = false;
    return false;
  }
}

let cleanupIntervalId = null;

function setupIntervalFallbacks() {
  if (intervalsStarted) {
    return;  // Prevent duplicate intervals
  }
  intervalsStarted = true;

  setInterval(async () => {
    await updateOfficeHoursStatus();
  }, 5 * 60 * 1000);

  setInterval(async () => {
    await checkAndApplySyncResets();
  }, 60 * 1000);

  setInterval(async () => {
    await sendExtensionSnapshot();
  }, 60 * 1000);
}

function setupCleanupSchedule() {
  // Run cleanup every 6 hours to remove old events beyond 30-day threshold
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
  }
  
  cleanupIntervalId = setInterval(async () => {
    await cleanupOldEvents();
  }, 6 * 60 * 60 * 1000);
}

async function cleanupOldEvents() {
  try {
    const now = Date.now();
    const cutoffTime = now - (EVENT_CLEANUP_THRESHOLD_DAYS * DAY_MS);
    
    const stored = await extApi.storage.local.get(STORAGE_KEYS.events);
    const events = Array.isArray(stored[STORAGE_KEYS.events]) ? stored[STORAGE_KEYS.events] : [];
    
    const filtered = events.filter((event) => (event?.timestamp || 0) > cutoffTime);
    
    if (filtered.length < events.length) {
      const cleaned = events.length - filtered.length;
      const rebuilt = rebuildStoredAggregatesFromEvents(filtered);
      await extApi.storage.local.set({
        [STORAGE_KEYS.events]: filtered,
        [STORAGE_KEYS.domainTotals]: rebuilt.domainTotals,
        [STORAGE_KEYS.totalTabMs]: rebuilt.totalTabMs,
        [STORAGE_KEYS.totalIdleMs]: rebuilt.totalIdleMs
      });
    }
  } catch (err) {
    // Silently handle cleanup errors to prevent crashes
  }
}

async function initializeRuntime(reason) {
  setIdleDetectionInterval(60);
  await ensureStorageDefaults();
  await ensureBridgeConfig({ force: true });
  await updateOfficeHoursStatus();
  await checkAndApplySyncResets();
  await captureActiveTabAsSession(reason);

  const alarmsConfigured = await scheduleAlarms();
  if (!alarmsConfigured) {
    setupIntervalFallbacks();
  }
  
  // Setup periodic cleanup regardless of alarm support
  setupCleanupSchedule();
}

addListenerSafe(extApi.runtime?.onInstalled, async () => {
  await initializeRuntime("installed");
});

addListenerSafe(extApi.runtime?.onStartup, async () => {
  await initializeRuntime("startup");
});

addListenerSafe(extApi.alarms?.onAlarm, async (alarm) => {
  if (!alarm?.name) {
    return;
  }

  if (alarm.name === ALARM_NAMES.officeStatus) {
    await updateOfficeHoursStatus();
    return;
  }

  if (alarm.name === ALARM_NAMES.syncReset) {
    await checkAndApplySyncResets();
    return;
  }

  if (alarm.name === ALARM_NAMES.extensionSnapshot) {
    await sendExtensionSnapshot();
  }
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

  const officeStatus = await checkOfficeHoursStatus();
  if (!shouldTrackWithStatus(officeStatus)) {
    return;
  }

  const tab = await safeGetTab(details.tabId);
  const isIncognito = tab?.incognito || false;

  const event = {
    type: "navigation",
    url: details.url,
    title: "",
    tabId: details.tabId,
    timestamp: Date.now(),
    transitionType: details.transitionType || "unknown",
    isIncognito
  };

  await appendEvent(event);
  await sendOrQueueEvent(event);
});

addListenerSafe(extApi.runtime?.onMessage, (message, _sender, sendResponse) => {
  if (message?.type === "GET_TRACKER_SNAPSHOT") {
    (async () => {
      await ensureStorageDefaults();
      await ensureBridgeConfig();
      await checkAndApplySyncResets();
      const snapshot = await getSnapshot();
      sendResponse({ ok: true, snapshot });
    })();
    return true;
  }

  if (message?.type === "SYNC_QUEUED_EVENTS") {
    (async () => {
      await ensureStorageDefaults();
      await ensureBridgeConfig();
      await checkAndApplySyncResets();
      const result = await flushQueuedEvents();
      sendResponse({ ok: true, result });
    })();
    return true;
  }

  return undefined;
});

initializeRuntime("service_worker_load").catch(() => {
  // Worker will retry through runtime/onAlarm triggers.
});
