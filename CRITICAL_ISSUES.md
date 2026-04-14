# Critical Issues Report - browser-activity-tracker-extension

Scope: critical issues only. These items can stop tracking entirely or cause unrecoverable loss of browser history in an ERP deployment.

## 1. Critical timers rely on setInterval inside a Manifest V3 service worker

**Why this is critical:** Manifest V3 service workers are not persistent. The extension uses setInterval for office-hours refresh and sync-reset polling, but those timers can stop when the service worker is suspended. That means tracking state checks and reset synchronization can silently stop until another event wakes the worker.

**Evidence:** [background.js](background.js#L112), [background.js](background.js#L117)

**Recommended solution:**
- Replace setInterval with chrome.alarms for periodic work.
- Re-register alarms on install and startup.
- Keep the background logic event-driven so the worker can recover after suspension without losing periodic jobs.

## 2. Tracking fails closed whenever the desktop local API is unavailable

**Why this is critical:** Every important browser path depends on /api/office-hours-status. If the desktop app crashes, is not running, or localhost:3002 is unreachable, the extension returns isTrackingActive false and stops capturing sessions, idle events, and navigation events. That creates a complete browser-tracking outage with no fallback capture path.

**Evidence:** [background.js](background.js#L260), [background.js](background.js#L267), [background.js](background.js#L279), [background.js](background.js#L343), [background.js](background.js#L409), [background.js](background.js#L439), [background.js](background.js#L479)

**Recommended solution:**
- Cache the last known good office state for a short grace period.
- Keep capturing locally even if the desktop bridge is temporarily offline.
- Show a clear degraded-state warning instead of silently stopping all tracking.
- Reconnect and flush queued events automatically when the desktop API returns.

## 3. Local storage retention is capped and can drop queued events under offline load

**Why this is critical:** The extension stores recent events and queued unsent events in chrome.storage.local, but it keeps only the latest 1000 entries. If the desktop bridge stays offline long enough, or the user has heavy browsing activity, older browser evidence is discarded before it can be synced to ERP.

**Evidence:** [background.js](background.js#L29), [background.js](background.js#L429)

**Recommended solution:**
- Replace the fixed-size queue with durable time-based retention.
- Move critical queued data to a more robust store such as IndexedDB.
- Increase retry capacity and add explicit backlog monitoring so the loss is visible before it happens.
