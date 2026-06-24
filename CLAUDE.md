# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome extension (Manifest V3) providing an alternative UI for Google Search Console. It calls the GSC Search Analytics API (`/webmasters/v3/`) using OAuth2 via `chrome.identity`. No build system — all JS/CSS/HTML is served directly by Chrome as unpacked extension files. All vendor libraries are vendored locally.

## Loading the extension for testing

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

## Packaging for the Chrome Web Store

```bash
zip -r searchanalytics.v1.5.0.zip ./searchanalytics/ \
  -x "*/.git/*" \
  -x "*/.DS_Store" \
  -x "*/.gitignore" \
  -x "*.md"
```

## Architecture

Three views, each with its own HTML + JS pair:

| HTML | JS | View |
|------|----|------|
| `html/index.html` | `js/gsc-hourly.js` | Property by hour (main view) — timeline table + Billboard.js chart + pages tab |
| `html/days.html` | `js/gsc-daily.js` | Property by day — same structure, day-granularity focus |
| `html/hourly.html` | `js/gsc-hourly2.js` | Pages by hour — per-URL hourly timeseries |

`js/background.js` is the service worker — it only opens `index.html` when the extension icon is clicked.

`html/options.html` + `js/options.js` — extension options page for an ID-extraction regex used in URL aggregation (stored in `chrome.storage.sync`).

### State model

Each JS file has a top-level `settings` object initialized from URL search params. Filters and property selection are persisted back to URL params via `addFilter()`/`removeFilter()`, which use `history.pushState`. Events (chart annotations) are persisted in `chrome.storage.local`.

### Page filter encoding

`settings.page` is a single string where the first character is an operator prefix:
- `*` = contains, `-` = notContains, `=` = equals, `!` = notEquals, `~` = includingRegex, `_` = excludingRegex

`assemblePageFilters()` decodes this into GSC API `dimensionFilterGroups`.

### Data pipeline (index/days views)

`getTimeline()` → GSC API (dimension: `DATE`) → `transformData(data, groupBy)` → Bootstrap Table + `drawChart()` (Billboard.js dual-axis line chart)

`transformData()` in `gsc-hourly.js` aggregates raw date rows into either `"day"` or `"month"` granularity, building both table rows and Billboard.js column arrays simultaneously. Rows with `timestamp >= firstIncompleteHour` are flagged `incomplete: true` and styled via `rowStyle()`.

### Table pattern

Each table is a Bootstrap Table instance initialized in a `generate*Table()` function. The `tableButtons()` function returns custom toolbar buttons (e.g., "sheets clipboard" which formats data as tab-separated for pasting into Google Sheets). Column definitions are declared as top-level `*Columns` arrays.

### Auth flow

`chrome.identity.getAuthToken({ interactive: false })` on page load for silent auth; `{ interactive: true }` on explicit button click. Auth state shown via button class: `btn-outline-primary` (unknown) → `btn-outline-success` (authed) → `btn-outline-danger` (failed/signed out).
