# Live Deployment Guide (No Source Code Download Required)

Project: Browser Activity Tracker Extension
Developed by Vendaxis

## Goal

Publish the extension to browser stores so users can install it directly with one click, just like public extensions, without downloading source code.

## Supported Live Distribution Channels

1. Chrome Web Store (Chrome)
2. Microsoft Edge Add-ons (Edge)
3. Firefox Add-ons (AMO)
4. Opera Add-ons (Opera)
5. Safari (macOS) via Safari Web Extension app package

## 1. Prepare Release Package

Before publishing to any store:

1. Update version in manifest.json.
2. Verify extension name, description, icons, and permissions.
3. Remove local debug endpoints if needed for production.
4. Create a ZIP package of extension files (root files, not parent folder).

Recommended production checklist:

- Valid icons: 16, 32, 48, 128
- Stable API endpoint URLs (HTTPS)
- Privacy policy URL ready
- Store screenshots ready
- Changelog/release notes ready

## 2. Publish to Chrome Web Store

1. Create a Chrome Web Store developer account.
2. Open Chrome Web Store Developer Dashboard.
3. Upload ZIP package.
4. Fill listing details:
   - Title
   - Description
   - Category
   - Screenshots
   - Privacy policy URL
5. Submit for review.
6. After approval, users install from store listing URL.

Result for users: Install from Chrome Web Store directly, no source code required.

## 3. Publish to Microsoft Edge Add-ons

1. Create Microsoft Partner Center account.
2. Open Edge Add-ons developer portal.
3. Upload same package (or Edge-specific build).
4. Fill metadata and policy links.
5. Submit for certification.
6. After approval, users install from Edge Add-ons listing URL.

## 4. Publish to Firefox Add-ons (AMO)

1. Create Firefox Add-ons developer account.
2. Upload package to AMO developer hub.
3. Ensure manifest and APIs are compatible with Firefox.
4. Submit for signing/review.
5. After approval, users install from AMO listing URL.

## 5. Publish to Opera Add-ons

1. Create Opera Add-ons developer account.
2. Upload package in Opera Add-ons portal.
3. Fill listing details and policy links.
4. Submit and wait for approval.
5. Users install directly from Opera Add-ons listing URL.

## 6. Safari Distribution (macOS)

Safari extensions are distributed through an app container:

1. Convert extension on macOS:

```bash
xcrun safari-web-extension-converter /path/to/browser-activity-tracker-extension --project-location /path/to/output --no-open
```

2. Open generated project in Xcode.
3. Configure signing, bundle ID, and app metadata.
4. Archive and publish through App Store Connect (or internal enterprise distribution).
5. Users install from App Store (or enterprise channel), not from source code.

## 7. Add Store Links in README (Recommended)

After approval, add official install links in README, for example:

- Chrome: https://chromewebstore.google.com/detail/<extension-id>
- Edge: https://microsoftedge.microsoft.com/addons/detail/<extension-id>
- Firefox: https://addons.mozilla.org/firefox/addon/<slug>
- Opera: https://addons.opera.com/extensions/details/<slug>
- Safari: App Store listing URL

## 8. Production Security and Compliance

Before going live:

1. Use HTTPS API endpoints only.
2. Add authentication/token strategy for API writes.
3. Publish a clear privacy policy and data retention policy.
4. Ensure user consent and legal compliance in target countries.
5. Keep attribution and licensing files in release package.

## 9. CI/CD Release Flow (Optional but Recommended)

Automate releases with a pipeline:

1. Tag release in GitHub.
2. Build ZIP artifact.
3. Run lint/tests.
4. Upload artifact to release.
5. Submit package to each store portal.

## 10. Internal Company-Only Live Deployment

If public store listing is not desired:

1. Use private/unlisted store listing where supported.
2. Use enterprise policies for force-install in managed devices.
3. Share only official store install links with employees.

This gives no-source-code install behavior while keeping controlled distribution.

