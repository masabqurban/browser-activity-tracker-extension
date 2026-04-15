# Browser Activity Tracker Extension Critical Issues Report

Date: 2026-04-15
Scope: browser-activity-tracker-extension + integration with erp-tracker local bridge + ERP sync chain
Overall verdict: NOT production-ready for enterprise reliability requirements.

## 1) Critical: MV3 service worker relies on setInterval for critical jobs

Severity: Critical

Affected flow:
- Periodic office-hours refresh, sync reset polling, extension snapshot uploads

Evidence:
- browser-activity-tracker-extension/background.js:112 uses setInterval for office-hours polling.
- browser-activity-tracker-extension/background.js:117 uses setInterval for sync reset polling.
- browser-activity-tracker-extension/background.js:882 uses setInterval for extension snapshot upload.

Why this is critical:
- In Manifest V3, service workers are suspended; setInterval is not reliable for guaranteed periodic execution.
- Leads to missed sync resets, stale status, and inconsistent uploads.

Recommended solution:
- Replace all periodic setInterval jobs with chrome.alarms (or browser.alarms) + onAlarm handler.
- Persist last-run timestamps and run catch-up logic when worker wakes.

## 2) Critical: Event delivery treats HTTP failures as success (silent data loss)

Severity: Critical

Affected flow:
- sendOrQueueEvent, flushQueuedEvents, sendExtensionSnapshot

Evidence:
- browser-activity-tracker-extension/background.js:460 posts event without checking response.ok.
- browser-activity-tracker-extension/background.js:466 queues retry only on network exception.
- browser-activity-tracker-extension/background.js:510 retries queued items without checking response.ok.
- browser-activity-tracker-extension/background.js:520 marks retry failure only on exception.
- browser-activity-tracker-extension/background.js:870 posts snapshots without checking response.ok.

Why this is critical:
- 4xx/5xx API responses are not retried, so events can be dropped permanently while appearing successful.

Recommended solution:
- Treat non-2xx as failed delivery and keep items in unsent queue.
- Add retry backoff and max-attempt metadata per event.
- Add delivery telemetry counters for sent/failed/retried.

## 3) Critical: Tracking fails closed when desktop bridge is unavailable

Severity: Critical

Affected flow:
- Session start/finalize, idle events, manual/auto queue flush

Evidence:
- browser-activity-tracker-extension/background.js:262 depends on http://localhost:3002/api/office-hours-status.
- browser-activity-tracker-extension/background.js:267 and 279 return not-tracking on any non-ok/exception.
- browser-activity-tracker-extension/background.js:302 removes currentSession when not tracking.
- browser-activity-tracker-extension/background.js:344 removes/aborts finalize if bridge says not tracking.
- browser-activity-tracker-extension/background.js:34 has only one API target (desktop bridge).

Why this is critical:
- If desktop app is down/restarting/unreachable, extension stops producing durable browser activity records.
- Enterprise requirement for resilient offline capture is not met.

Recommended solution:
- Decouple local capture from bridge availability: always record local events, then sync later.
- Keep session continuity even when bridge status cannot be fetched.
- Add grace policy: if status unknown, keep collecting and queue for deferred validation/upload.

## 4) Critical: Sync reset can purge unsent browser backlog

Severity: Critical

Affected flow:
- Post-summary cleanup after desktop successful daily sync

Evidence:
- browser-activity-tracker-extension/background.js:648 removes all same-day events.
- browser-activity-tracker-extension/background.js:649 removes same-day unsentEvents.
- browser-activity-tracker-extension/background.js:660 and 673 perform additional weekly/monthly unsent trimming.

Why this is critical:
- If desktop summary sync succeeds without all extension backlog ingested, extension may delete remaining unsent evidence for that day.
- Causes irreversible data loss and compliance gaps.

Recommended solution:
- Reset only after explicit acknowledgment that extension backlog for the same day was ingested.
- Track reset watermark by activityDate + sequence/ack token, not just last successful summary timestamp.

## 5) High: Date-key logic mixes UTC and local time (wrong-day resets near midnight)

Severity: High

Affected flow:
- Day-based purge and reset matching

Evidence:
- browser-activity-tracker-extension/background.js:546 uses UTC date extraction via toISOString.
- browser-activity-tracker-extension/background.js:648 compares this key for reset deletion.
- Desktop services generally use local date keys for daily partitioning.

Why this is high risk:
- Cross-timezone and near-midnight activity can be assigned to wrong day, causing improper deletion or missed cleanup.

Recommended solution:
- Standardize day partition on ERP server date (preferred) or a shared timezone policy.
- Replace UTC toISOString slicing with explicit timezone-aware date key conversion.

## 6) High: Queue retention cap drops offline backlog under enterprise outage scenarios

Severity: High

Affected flow:
- Offline event buffering

Evidence:
- browser-activity-tracker-extension/background.js:29 caps storage to MAX_EVENTS = 1000.
- browser-activity-tracker-extension/background.js:473 appends queued unsent events then truncates.

Why this is high risk:
- Extended offline windows or high browsing volume can silently discard oldest unsynced events.

Recommended solution:
- Move to durable chunked queue (IndexedDB) with size/time retention policy and overflow alerts.
- Add user/admin-visible warning when retention threshold is hit.

## Functional readiness summary

Data sync with erp-tracker and ERP chain: Not OK for enterprise reliability.
Data refresh and reset: Not deterministic under MV3 lifecycle and bridge outages.
Tracker accuracy: Degrades during local bridge outages and around reset windows.
Data uploading/storing: Exists but can silently lose data under non-2xx responses and queue truncation.
Cross-device (Windows + MacBook M4): Browser extension packaging is broad, but operational robustness is below enterprise standards.
Background running: Event listeners work, but periodic jobs via setInterval are not lifecycle-safe in MV3.

## Immediate enterprise action plan (priority order)

1. Replace setInterval jobs with alarms-based scheduling and wake-safe catch-up.
2. Make all outbound delivery response-aware (retry on non-2xx).
3. Capture-first architecture: always store locally even if desktop bridge is unavailable.
4. Redesign reset handshake to prevent unsent backlog deletion.
5. Unify date key policy with server date/timezone.
6. Replace capped in-memory/local queue pattern with durable bounded persistence and alerts.
