# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome extension (Manifest V3) providing an alternative UI for Google Search Console. It calls the GSC Search Analytics API (`/webmasters/v3/`) using OAuth2 via `chrome.identity`. Sources are in `src/` and bundled by Vite 8 (`vite.config.js`) into `dist/`; dependencies come from npm (Node ≥ 22.12). Files Chrome needs verbatim — `manifest.json`, `icons/*.png`, `src/js/background.js`, `src/js/theme.js` and the two Billboard stylesheets — are listed in `extensionFiles` in `vite.config.js` and emitted into `dist/` by a small plugin; add new unbundled files there.

billboard.js v4 ESM: `grid` and `regions` are tree-shakable modules. Each view calls `grid(); regions();` once after importing; any new chart feature module (e.g. `zoom`, `subchart`) must be imported and registered the same way.

## Build

```bash
npm install
npm run build   # one-off build to dist/
npm run dev     # rebuild on change
```

## Testing without the extension

`npm run harness` builds and serves `dist/` on http://127.0.0.1:8765 with `dev/harness/stub.js` injected: fake `chrome.identity`/`chrome.storage` and a deterministic fake Search Console API (query bodies land in `window.__requests`). Use it to verify UI changes and dependency upgrades in a normal tab; see `dev/harness/README.md` for the checklist. It cannot test real OAuth or the extension CSP.

## Loading the extension for testing

1. `npm run build`
2. Open `chrome://extensions/`, enable "Developer mode"
3. Click "Load unpacked" and select the `dist/` directory

## Packaging for the Chrome Web Store

Bump `version` in `manifest.json` and push to `master`; `.github/workflows/release.yml` builds and attaches `searchanalytics-v<version>.zip` to a GitHub release. Keep `package.json`'s version in sync.

Note: GSC hourly data (`dimensions: ["HOUR"]`, `dataState: "HOURLY_ALL"`) only covers roughly the last 10 days, even when the request spans the whole year.

## Architecture

Three views, each with its own HTML + JS pair:

| HTML | JS | View |
|------|----|------|
| `src/html/index.html` | `src/js/gsc-hourly.js` | Property by hour (main view) — timeline table + Billboard.js chart + pages tab |
| `src/html/days.html` | `src/js/gsc-daily.js` | Property by day — same structure, day-granularity focus, plus the events tab (chart annotations) |
| `src/html/hourly.html` | `src/js/gsc-hourly2.js` | Pages by hour — per-URL hourly timeseries |

`js/background.js` is the service worker — it only opens `index.html` when the extension icon is clicked.

`src/html/options.html` + `src/js/options.js` — options page: ID-extraction regex for URL aggregation (`chrome.storage.sync`) and import of Google Search Status incidents into the events list (`chrome.storage.local`).

`src/js/common.js` holds everything the views share: library/CSS imports (in the order bootstrap-table needs), auth (`initAuth`), API access (`gscQuery`, `gscQueryAll`, `loadProperties`), URL state (`addFilter`/`removeFilter`, `assemblePageFilters`), formatters, table export (`exportButtons` → Sheets TSV + CSV download) and UI helpers (`initTabs`, `showNotice`, `apiError`). View files import from it rather than from `jquery`/`bootstrap` directly.

`src/js/theme.js` is a classic (unbundled) `<head>` script that sets `data-bs-theme` from `prefers-color-scheme`; colours in `searchanalytics.css` are theme tokens, so avoid hardcoded colours.

`src/js/jquery-global.js` attaches jQuery to `globalThis` before the bootstrap-table UMD bundle loads; `common.js` imports it first.

### State model

Each view file has a top-level `settings` object initialized from URL search params (`from`/`to` are ms timestamps in the hourly views, `YYYY-MM-DD` strings in the daily view). Filters and property selection are persisted back to URL params via `addFilter()`/`addFilters()`/`removeFilter()`, which use `history.pushState`. Back/Forward: `initHistory(syncFromUrl)` listens for `popstate`; each view's `syncFromUrl(params)` calls `readSharedUrlState()` (type, property, page filter) and re-reads its own params, then `reloadAll()`. Any new URL param must be read there too. URL filters are applied through each view's `setPageFilter(page)` (dialog, × on the chip, and the row funnel via `initPageFilterActions()` + `pageActionButtons()`). Events (chart annotations) are persisted in `chrome.storage.local`.

### Page filter encoding

`settings.page` is a single string where the first character is an operator prefix:
- `*` = contains, `-` = notContains, `=` = equals, `!` = notEquals, `~` = includingRegex, `_` = excludingRegex

`assemblePageFilters()` decodes this into GSC API `dimensionFilterGroups`.

### Data pipeline (index/days views)

`getTimeline()` → GSC API (dimension: `DATE`) → `transformData(data, groupBy)` → Bootstrap Table + `drawChart()` (Billboard.js dual-axis line chart)

`transformData()` in `gsc-daily.js` aggregates raw date rows into either `"day"` or `"month"` granularity, building both table rows and Billboard.js column arrays simultaneously. Rows with `timestamp >= firstIncompleteHour` are flagged `incomplete: true` and styled via `rowStyle()`.

### Table pattern

Each table is a Bootstrap Table instance initialized in a `generate*Table()` function. Toolbar buttons come from `tableButtons(name)` → `exportButtons(settings, name)` in `common.js` (Google Sheets clipboard + CSV download; `name` is the CSV filename suffix). Export uses visible columns and all rows matching the current search; columns can opt out with `suppressExport` or export the raw value with `suppressFormatterExport`. Column definitions are declared as top-level `*Columns` arrays.

### Auth flow

`initAuth(settings, { onSignIn, onSignOut })` in `common.js`: silent `getAuthToken({ interactive: false })` on load and when the tab becomes visible; interactive on the "Sign in with Google" menu item (`#authorize_button`, also triggered by the empty-state and error buttons). `setAuthState()` is the only place that changes the button: `btn-outline-secondary` "Checking sign-in…" (unknown) → `btn-outline-success` "Signed in" → `btn-outline-danger` "Sign in" (failed/expired/signed out). A 401 from the API sets the danger state via `apiError()`.

### Feedback & empty states

- `showError()`/`clearError()` — persistent dismissible banner in `#notices` (API errors, failed sign-in). `apiError()` uses it. Each view's `getTimeline()` clears it on reload.
- `showNotice()` — short toast (`#action-badge`) for confirmations only.
- `showChartState(kind)` — overlay in `#chart-state` over the chart: `loading`, `signedOut`, `noProperty`, `noData`, `error`, `selectPages`, or `null` to hide. It also sets the "no rows" text of every bootstrap-table (via a `formatNoMatches` default), so empty tables say the same thing.
- `showPageFilter(page)` renders the URL-filter button as a chip ("URLs containing “news”" + × to clear).
- Chart colours come from CSS tokens (`--sa-clicks`, `--sa-impressions`, `--sa-ctr`, `--sa-series-palette`) via `chartColors()`; don't hardcode hex in the views. The hourly chart's line styles (current / previous / incomplete) are set with billboard `data.classes` and styled in `searchanalytics.css`.
