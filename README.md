# Browser Activity Tracker Extension

Chrome activity tracking extension that records browsing behavior locally in Chrome storage and displays it inside the extension popup.

Developed by Vendaxis.

## Ownership and Attribution

- Original developer and owner: Vendaxis.
- Project brand label: browser-activity-tracker-extension.
- Rebranding, removing attribution, or publishing under a different author name is not permitted without written permission.
- See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for usage terms.

## Features

- Tracks active tab changes and URL changes
- Tracks time spent per tab and per domain
- Tracks browser idle and active state
- Tracks completed navigation events
- Stores data locally using `chrome.storage.local`
- Shows local analytics directly in popup
- Supports daily, weekly, and monthly reporting snapshots
- Includes a big-screen dashboard view in a Chrome tab
- Includes visual graphs on big-screen dashboard (period comparison + top domains)
- Includes hourly activity timeline chart (last 24 hours) with peak-hour insight
- Supports incremental event pagination (5 initially, then +10 on demand)
- Includes dashboard productivity controls: search filter, auto-refresh, CSV export
- Supports clickable hour bars to filter activity by selected hour
- Supports date picker for historical daily timeline view
- Adds productivity score card based on tracked vs idle ratio
- Sends event data to three API targets:
	- Local system dashboard API
	- Laravel ERP API
	- Local Electron desktop API
- No in-extension clear action is exposed in popup

## Project Structure

```
browser-activity-tracker-extension/
	manifest.json
	background.js
	popup.html
	popup.css
	popup.js
	dashboard.html
	dashboard.css
	dashboard.js
	content.js
	utils.js
	README.md
```

## Load Extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `browser-activity-tracker-extension` folder.

## Always-On Enforcement (Company Devices)

For company-managed devices, enforce always-on behavior with Chrome enterprise policy.

### Important

- Chrome extensions cannot self-enforce always-on from extension code.
- Always-on must be applied by IT policy (ADMX/Group Policy/Intune/MDM).
- For policy-based force install, the extension must be published (private or public) with a stable extension ID.

### Windows Group Policy / Registry (Force Install)

Set policy key:

- Path: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist`
- Value name: `1`
- Value data: `<EXTENSION_ID>;https://clients2.google.com/service/update2/crx`

Example:

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="abcdefghijklmnopabcdefghijklmnop;https://clients2.google.com/service/update2/crx"
```

### Extension Lockdown (Recommended)

Set `ExtensionSettings` policy to force-install and pin:

- Path: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome`
- Value name: `ExtensionSettings`
- Type: `REG_SZ`
- Value data (JSON):

```json
{
	"abcdefghijklmnopabcdefghijklmnop": {
		"installation_mode": "force_installed",
		"update_url": "https://clients2.google.com/service/update2/crx",
		"toolbar_pin": "force_pinned"
	}
}
```

### Validation on Device

1. Open `chrome://policy`.
2. Click **Reload policies**.
3. Confirm `ExtensionInstallForcelist` and `ExtensionSettings` are applied.
4. Open `chrome://extensions` and verify the extension appears as enterprise-managed and cannot be disabled by users.

### Intune / MDM

Use Chrome ADMX-backed policy settings and push the same values for:

- `ExtensionInstallForcelist`
- `ExtensionSettings`

## Full Deployment and Operations Guide

Use [ENTERPRISE_DEPLOYMENT_GUIDE.md](ENTERPRISE_DEPLOYMENT_GUIDE.md) for complete documentation:

1. Supported features
2. Usage and deployment
3. How it works
4. Tech stack
5. Additional operational information

## Live Store Deployment Guide

For store-based installation (no source code download), see [LIVE_DEPLOYMENT_GUIDE.md](LIVE_DEPLOYMENT_GUIDE.md).

## How Local Data Display Works

Open the extension popup from the toolbar icon. You can view:

- Total tracked tab time
- Total idle time
- Current idle state
- Number of queued offline events
- Top domains by usage duration
- Recent activity events
- Daily summary (tracked, idle, events)
- Weekly summary (tracked, idle, events)
- Monthly summary (tracked, idle, events)

Buttons available in popup:

- **Refresh**: reload current local snapshot
- **Sync queued**: send unsent events to local desktop agent
- **Export JSON**: download all current tracked data

## API Targets

Configured in `background.js`:

- `electronDesktop`: `http://127.0.0.1:32145/browser-activity` (with fallback discovery to `3002`)

The extension discovers the active desktop bridge and auth token via `GET /api/bridge-config`, then sends events with `X-Tracker-Token`.
ERP synchronization is handled by the desktop tracker service.

Each tracked event is wrapped and sent as:

```json
{
	"source": "browser-activity-tracker-extension",
	"generatedAt": 1710000000000,
	"event": {
		"type": "tab",
		"url": "https://github.com",
		"duration": 120000,
		"timestamp": 1710000000000
	}
}
```

If any target is unavailable, the event is queued locally and retried using **Sync queued**.

## Storage Keys

- `activityEvents`
- `domainTotals`
- `totalTabMs`
- `totalIdleMs`
- `currentSession`
- `idleState`
- `idleStateChangedAt`
- `unsentEvents`
- `bridgeConfig`
- `droppedEvents`

## Notes

- After install, the extension starts tracking immediately while it is enabled.
- Chrome does not allow an extension to force itself to stay enabled forever; a user/admin policy is required for enforced always-on mode.
- This build removes in-extension clear controls, but Chrome still allows manual data/extension removal from browser settings.
- To include incognito activity, enable **Allow in Incognito** in extension settings.
- Chrome extensions cannot auto-enable incognito mode.
- System app tracking (outside browser) requires a desktop agent.

## Cross-Browser Support

- Chrome: supported
- Microsoft Edge: supported (Chromium)
- Opera: supported (Chromium)
- Firefox: supported with Manifest V3 WebExtensions compatibility
- Safari on macOS: supported via Safari Web Extension conversion flow

## Cross-OS Support

- Windows: supported
- macOS: supported (Chrome, Edge, Firefox, Opera, Safari with conversion)
- Linux: supported (Chrome/Chromium, Edge, Firefox, Opera)

Implementation notes:

- Code uses WebExtensions namespace fallback (`browser` then `chrome`) for broader compatibility.
- Firefox-specific metadata is included in manifest (`browser_specific_settings.gecko`).
- Runtime listener registration is API-guarded so unsupported browser APIs do not crash extension startup.

### Safari (macOS) Build and Run

Safari requires converting this extension to a Safari Web Extension project on macOS:

1. Install Xcode from App Store.
2. Run converter in Terminal:

```bash
xcrun safari-web-extension-converter /path/to/browser-activity-tracker-extension --project-location /path/to/output --no-open
```

3. Open generated project in Xcode.
4. Build and run the Safari extension target.
5. Enable extension in Safari settings.

Note: Safari support depends on the Safari WebExtensions compatibility layer provided by the macOS/Xcode version.
