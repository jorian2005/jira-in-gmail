# Jira Mail & Calendar Badges (Chrome Extension)

This extension adds Jira issue badges to Gmail and Google Calendar whenever an issue key is detected (for example, `ABC-123`). It is designed for Jira Cloud and runs entirely in your browser as a Manifest V3 extension.

## Features

- Scans visible Gmail message rows for Jira keys.
- Scans opened Google Calendar events for Jira keys and injects a Jira status section.
- Fetches Jira data through the extension service worker (avoids page-level CORS issues).
- Shows status badges with click-through links to Jira issues.
- Caches issue responses locally for 5 minutes to reduce Jira API calls.
- Uses browser language via Chrome i18n (`en` and `nl` locales included).

## Requirements

- Google Chrome or another Chromium-based browser with Manifest V3 support.
- Gmail at `https://mail.google.com/*`.
- Google Calendar at `https://calendar.google.com/*`.
- A Jira Cloud account on `*.atlassian.net`.
- An Atlassian API token.

## How it works

1. Gmail and Calendar content scripts detect matching issue keys.
2. Content scripts send messages to `background.js`.
3. The service worker reads Jira credentials from `chrome.storage.local`.
4. The service worker calls Jira REST API (`/rest/api/3/issue/{key}`) and caches the result.
5. Content scripts render badges in the page.

This architecture keeps credentials out of page context and prevents direct page CORS problems.

## Installation (developer mode)

1. Download or clone this folder locally.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `jira-gmail-badge` folder.
6. The extension will appear in your extension list.

## Configuration

1. Open extension settings:
   - `chrome://extensions` -> find **Jira Ticket Badges for Gmail** -> **Details** -> **Extension options**.
2. Fill in:
   - **Jira URL** (for example `https://yourcompany.atlassian.net`)
   - **Atlassian email address**
   - **API token**
3. Click **Save**.
4. Cache is cleared automatically so new settings become active right away.

## Key format

- Supported key pattern is strictly: 2 or 3 uppercase letters + `-` + digits.
- Examples: `AB-123`, `ABC-123`.
- Maximum displayed keys:
  - Gmail row: 3 keys
  - Calendar event: 3 keys

## Usage

1. Open Gmail or Google Calendar (refresh tab after install/update).
2. Make sure the message or event contains a Jira key like `AB-123` or `ABC-123`.
3. The extension shows Jira badges with status information.
4. Click a badge to open the issue in Jira.

## Permissions

- `storage`: stores Jira URL, email, token, and cache entries.
- `host_permissions`:
  - `https://mail.google.com/*`
  - `https://calendar.google.com/*`
  - `https://*.atlassian.net/*`

No remote analytics, tracking, or telemetry is included.

## Create a Jira API token

1. Open Atlassian Account Security settings.
2. Create a new API token.
3. Copy the token and paste it into extension options.

> Tip: leave the token field empty when saving if you want to keep the currently stored token.

## Known limits

- The extension reads a maximum of 3 unique Jira keys per Gmail row or Calendar event.
- Key pattern: 2 or 3 letters + `-` + digits, for example `AB-123` or `ABC-123`.
- The extension works on Gmail/Calendar web UI, not in mobile apps.

## Localization

- Locales live in `_locales/en/messages.json` and `_locales/nl/messages.json`.
- `manifest.json` uses `default_locale` and `__MSG_*__` placeholders.
- UI text in options/content scripts is resolved with `chrome.i18n.getMessage(...)`.

## Troubleshooting

- **No badges are visible**
  - Check that you are on `https://mail.google.com` or `https://calendar.google.com`.
  - Reload the tab after installing or changing settings.
  - Verify the text actually contains a valid Jira key.

- **Badge shows an error**
  - Open extension options and verify URL/email/token.
  - `Authentication failed`: token is incorrect or the account has no access.
  - `Not found`: issue key does not exist or is not visible to this account.
  - `Network error`: temporary network or Jira availability issue.

- **Changes do not appear immediately**
  - Save options again (this clears cache).
  - Reload the Gmail/Calendar tab.

- **Extension page or script is blocked by CSP**
  - Do not use inline JavaScript in extension pages.
  - Use external `.js` files referenced with `<script src="..."></script>`.

## Development

Project structure:

- `manifest.json` - extension configuration (MV3)
- `background.js` - service worker; Jira API calls + cache
- `content.js` - Gmail DOM scan + badge injection
- `calendar-content.js` - Google Calendar DOM scan + Jira section injection
- `content.css` / `calendar-content.css` - badge and Calendar section styling
- `options.html` / `options.js` - settings page
- `_locales/` - translations (`en`, `nl`)

## Testing

This repository includes a Node test suite that validates:

- manifest structure and referenced files
- regex consistency across scripts
- locale key parity (`en` vs `nl`)

Run locally:

```bash
npm test
```

## GitHub Actions

CI runs tests on push and pull requests via `.github/workflows/test.yml`.

Current workflow:

- checks out the repository
- uses Node.js 20
- runs `npm test`

## Security and privacy

- Jira credentials are stored in `chrome.storage.local` in your own browser profile.
- Jira API calls are made only from the extension service worker.
- No external analytics or tracking is included.

## Reload after code changes

1. Go to `chrome://extensions`.
2. Click **Reload** on the extension.
3. Reload your Gmail/Calendar tab.

