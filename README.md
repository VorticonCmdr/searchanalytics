# Search Analytics Alternative

A Chrome extension that provides an alternative UI for the [Google Search Console](https://search.google.com/search-console) Search Analytics API. It focuses on high-granularity, hourly data and offers views that the native GSC interface does not provide.

**Chrome Web Store:** https://chrome.google.com/webstore/detail/search-analytics-extensio/amobaldhodbblgmphdddddippgjgphga

---

## Features

- Hourly-granularity data from the GSC Search Analytics API (`/webmasters/v3/`)
- Three distinct views: property by hour, property by day, and pages by hour
- Interactive Billboard.js line chart with week-over-week comparison and incomplete-data highlighting
- URL/page filtering with six operator modes including regex
- Page aggregation by configurable ID regex (useful for parameterized or ID-based URLs)
- "First impression" timestamp lookup per page across the full year
- One-click Google Sheets clipboard export (tab-separated, respects visible columns)
- CSV export for all tables
- Dark mode support (auto-detected via `prefers-color-scheme`)
- All state (property, date range, filter, search type) persisted in URL params — shareable and bookmarkable
- No server-side component; all data flows directly from Google's API to the extension

---

## Views

### Property by Hour (`index.html`)

The main view. Loads all hourly data for the selected GSC property and year.

- **Chart:** Dual-axis Billboard.js line chart showing clicks (left y-axis) and impressions/CTR (right y-axis). Displays the last 7 days vs. the preceding 7-day period. Incomplete hours (data not yet finalized by Google) are rendered as a separate series in a lighter style.
- **Hours tab:** Full hourly timeline table. Rows for hours with incomplete data are visually flagged.
- **Pages tab:** Aggregated page performance for the selected time window (`from`/`to` datetime pickers). Pages are optionally aggregated by a configurable ID regex (see Options). Includes a "first impression" column showing when each page/ID first appeared in Google's index within the current year.

### Property by Day (`days.html`)

Same structure as the main view but at day or month granularity. Useful for longer-range trend analysis. Supports an additional `groupBy` toggle (day / month) and a `dataState` toggle (ALL / FINAL).

### Pages by Hour (`hourly.html`)

Per-URL hourly time series. Select one or more pages from the table and the chart plots their individual hourly click/impression curves side by side. Metric (clicks / impressions) is switchable.

---

## Installation (development / unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the repository root directory.
5. The extension icon appears in the toolbar. Click it to open the main view.

---

## Authentication

The extension uses OAuth 2.0 via `chrome.identity` with the `webmasters.readonly` scope. No credentials are stored outside Chrome's identity layer.

- **Silent auth** is attempted automatically on page load (`interactive: false`).
- If silent auth fails, the auth button turns red. Click **authenticate → refresh auth** to trigger the interactive OAuth flow.
- **Sign out** clears all cached tokens via `chrome.identity.clearAllCachedAuthTokens`.

Auth button color codes:

| Color | Meaning |
|-------|---------|
| Blue (outline) | Auth state unknown |
| Green (outline) | Authenticated |
| Red (outline) | Auth failed or signed out |

---

## Usage

1. After authenticating, your GSC properties are loaded into the property selector in the navbar.
2. Click **select property** and type to search, then select a property from the autocomplete list.
3. Choose a **search type** (Discover, Google News, Web, News, Image, Video).
4. The chart and hours table load immediately. Switch to the **Pages** tab and set a `from`/`to` datetime range to load page-level data.
5. All selections are written to the URL — use the browser back button or bookmark the URL to return to the same state.

---

## URL / Page Filter

Click **url filter** in the navbar to open the filter modal. Six operator modes are available:

| Mode | GSC operator |
|------|-------------|
| URLs containing | `contains` |
| URLs not containing | `notContains` |
| Exact URL | `equals` |
| Not exact URL | `notEquals` |
| Custom (matches regex) | `includingRegex` |
| Custom (doesn't match regex) | `excludingRegex` |

The active filter is encoded in the URL param `page` as a single string where the first character is the operator prefix (`*`, `-`, `=`, `!`, `~`, `_`) followed by the expression. Example: `*blog/` filters for all URLs containing `blog/`.

On the pages table, each row has a chart icon button that applies a "contains" filter for that page's ID and reloads all data.

---

## Options: ID Extraction Regex

Open the extension options page (right-click the toolbar icon → **Options**, or via `chrome://extensions/`).

The **ID Extraction Regex** setting lets you define a regular expression with a capture group. When set, the extension extracts the captured group from each page URL and uses it as the aggregation key in the pages table. This collapses multiple URLs that share the same ID (e.g., different query strings on a product page) into a single row.

**Example:** For URLs like `/product/12345/details` and `/product/12345`, the regex `/product/([0-9]+)` extracts `12345` as the ID, and both URLs are merged into one row.

The setting is stored in `chrome.storage.sync` and persists across devices.

---

## Packaging for the Chrome Web Store

```bash
zip -r searchanalytics.v1.5.0.zip ./searchanalytics/ \
  -x "*/.git/*" \
  -x "*/.DS_Store" \
  -x "*/.gitignore" \
  -x "*.md"
```

---

## Architecture

No build system — all JS/CSS/HTML is served directly by Chrome as unpacked extension files. All vendor libraries are vendored locally under `js/` and `css/`.

| File | Role |
|------|------|
| `html/index.html` + `js/gsc-hourly.js` | Property by hour (main view) |
| `html/days.html` + `js/gsc-daily.js` | Property by day |
| `html/hourly.html` + `js/gsc-hourly2.js` | Pages by hour |
| `html/options.html` + `js/options.js` | Options page (ID regex) |
| `js/background.js` | Service worker — opens `index.html` on icon click |

State is managed via a top-level `settings` object in each JS file, initialized from URL search params. Mutations go back through `addFilter()` / `removeFilter()` which call `history.pushState`.

---

## Libraries

| Library | Version | Purpose |
|---------|---------|---------|
| [Bootstrap](https://getbootstrap.com/) | 5.3 | Layout and UI components |
| [Bootstrap Icons](https://icons.getbootstrap.com/) | 1.13.1 | Icon set |
| [jQuery](https://jquery.com/) | 3.7.1 | DOM manipulation |
| [Bootstrap Table](https://bootstrap-table.com/) | 1.24.1 | Sortable, paginated, exportable data tables |
| [Billboard.js](https://naver.github.io/billboard.js/) | — | Interactive line charts (D3-based) |
| [D3.js](https://d3js.org/) | 7.8.5 | Chart rendering (Billboard.js dependency) |
| [tableExport](https://github.com/kayalshri/tableExport.jquery.plugin) | 1.33.0 | CSV export |
