# browser-activity-tracker-extension - Enterprise Deployment Guide

Developed by Vendaxis.

## 1. Supported Features

- Browser tab activation tracking
- URL change tracking
- Navigation completion tracking
- Session duration tracking per tab
- Domain-wise usage aggregation
- Idle and locked state tracking
- Daily tracking summary
- Weekly tracking summary
- Monthly tracking summary
- Local storage for offline-first behavior
- Multi-target API delivery
- Retry queue for unavailable API targets
- Popup dashboard for local reporting
- JSON export of current snapshot

## 2. How to Use and Deploy

### Local Development (Unpacked)

1. Open Chrome and go to chrome://extensions.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this folder: browser-activity-tracker-extension.
5. Pin extension to toolbar.
6. Open popup and verify live metrics.

### Company Deployment (Always-On Enforcement)

Always-on is enforced through enterprise policy, not extension code.

Prerequisites:

- Stable extension ID from published package
- Managed Chrome environment via AD/Intune/MDM

Windows policy options:

- ExtensionInstallForcelist: force installs extension
- ExtensionSettings: lock installation mode as force_installed and pin toolbar

Example for force install value:

- <EXTENSION_ID>;https://clients2.google.com/service/update2/crx

Validation steps:

1. Open chrome://policy and reload policies.
2. Confirm ExtensionInstallForcelist and ExtensionSettings are active.
3. Open chrome://extensions and verify enterprise-managed lock state.

### Backend/Service Endpoints

The extension pushes each event to the local desktop bridge:

- Electron desktop API: http://127.0.0.1:32145/browser-activity (legacy fallback: 3002)

The extension discovers bridge config from `/api/bridge-config` and sends requests with `X-Tracker-Token`.
If the bridge is temporarily unreachable, events remain queued and can be retried with Sync queued.

## 3. How It Works

### High-level Flow

1. Service worker listens for browser events.
2. Event is normalized and stored in chrome.storage.local.
3. Session finalization computes duration and domain totals.
4. Event is sent to Electron desktop bridge API.
5. Failed deliveries are recorded in unsent queue for retry.
6. Popup requests live snapshot from service worker.
7. Popup renders totals, top domains, recent events, and daily/weekly/monthly summaries.

### Event Sources

- tabs.onActivated
- tabs.onUpdated (URL change)
- tabs.onRemoved
- windows.onFocusChanged
- webNavigation.onCompleted
- idle.onStateChanged

### Reporting Model

The service worker calculates interval summaries directly from event history:

- Daily: current day window
- Weekly: rolling last 7 days
- Monthly: rolling last 30 days

Each interval includes:

- Tracked time
- Idle time
- Event count
- Top domains

## 4. Tech Stack

- Chrome Extension Manifest V3
- JavaScript (Vanilla)
- Chrome APIs: tabs, storage, idle, webNavigation, runtime
- Popup UI: HTML + CSS + JavaScript
- Backend integration targets:
  - Local dashboard API (Node or similar)
  - Laravel API (ERP)
  - Electron desktop app service endpoint

## 5. Other Information

### Data Retention and Deletion Behavior

- In-extension clear controls are intentionally removed.
- Users cannot clear data from extension popup.
- Browser-level manual clearing or extension removal by unmanaged users is still technically possible.
- On managed company devices, enforce controls through enterprise policy.

### Privacy and Compliance

- Inform employees/users before tracking.
- Obtain consent where required.
- Avoid collecting sensitive fields beyond operational scope.
- Maintain access control and retention policies on ERP/backend storage.

### Recommended Production Additions

- Auth token or signed request headers for APIs
- Payload encryption in transit (HTTPS only)
- API rate limiting and batching
- Endpoint health monitoring and alerting
- Server-side deduplication and validation

### Suggested Folder Additions for Next Phase

- docs/policies for org-specific policy templates
- desktop-agent for local service receiver
- backend-contract for API schema and examples
- dashboards for analytics/report UI integration

