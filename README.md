# Search Analytics Alternative

A Chrome extension that provides an alternative UI for the [Google Search Console](https://search.google.com/search-console) Search Analytics API. It focuses on high-granularity, hourly data and offers views that the native GSC interface does not provide.

**Chrome Web Store:** https://chromewebstore.google.com/detail/search-analytics-alternat/amobaldhodbblgmphdddddippgjgphga

---

## Features

- Hourly-granularity data from the GSC Search Analytics API (`/webmasters/v3/`)
- Three distinct views: property by hour, property by day, and pages by hour
- Interactive Billboard.js line chart with week-over-week comparison and incomplete-data highlighting
- URL/page filtering with six operator modes including regex
- Page aggregation by configurable ID regex (useful for parameterized or ID-based URLs)
- "First impression" timestamp lookup per page within the hourly data window (Google keeps ~10 days of hourly data)
- One-click Google Sheets clipboard export (tab-separated, respects visible columns and the current search)
- CSV download for every table (UTF-8 with BOM, so Excel opens it correctly)
- Chart annotations ("events") for deploys, issues and Google updates — add them by hand or import them from the [Google Search Status Dashboard](https://status.search.google.com) on the options page
- Dark mode that follows the operating system (`prefers-color-scheme`)
- Keyboard accessible: view switcher, tabs (arrow keys), filter dialog (Enter applies), row actions, and `/` to jump to the visible table's search box
- Guided empty states: the chart area tells you the next step (sign in, choose a property, no data, pick pages to draw)
- Quick ranges (today, yesterday, last 7 days, last 28 days, …) next to every date picker
- Switching views keeps the property, search type and URL filter
- All state (property, date range, filter, search type) persisted in URL params — shareable and bookmarkable; the browser's Back/Forward buttons step through it
- Every pages table has hover actions on each URL: filter the whole view by that page, or copy the URL
- No server-side component; all data flows directly from Google's API to the extension

---

## Views

### Property by Hour (`index.html`)

The main view. Loads the hourly data for the selected GSC property. Google only keeps about the last 10 days of hourly data, so that is the window this view (and pages by hour) can show.

- **Chart:** Dual-axis Billboard.js line chart showing clicks (left y-axis) and impressions/CTR (right y-axis). The last 7 days are drawn solid, the preceding 7 days dashed on the same x positions, and incomplete hours (not yet finalized by Google) dotted. Clicking a legend entry toggles a metric (with its incomplete hours). CTR shares the right axis scaled to fit; when it is the only series there, the axis shows real CTR percentages. The shaded band marks the Pages tab's timeframe.
- **Hours tab:** Full hourly timeline table. Rows for hours with incomplete data are visually flagged.
- **Pages tab:** Aggregated page performance for the selected time window (`from`/`to` datetime pickers or a quick range). The funnel icon on a row filters the whole view by that page (by its ID fragment when rows are aggregated by ID, otherwise by the exact URL). Pages are optionally aggregated by a configurable ID regex (see Options). Includes an optional "first impression" column (enable it via the columns menu) showing the first hour each page/ID received impressions within the hourly data window.

### Property by Day (`days.html`)

Same structure as the main view but at day or month granularity. Useful for longer-range trend analysis. Supports an additional `groupBy` toggle (day / month) and a `dataState` URL parameter (ALL / FINAL). The timeframe above the chart applies to the chart and both tables. The **Events** tab adds annotations (from, optional to, title, category, all properties or this one); tick events to highlight them on the chart.

### Pages by Hour (`hourly.html`)

Per-URL hourly time series. Tick one or more pages in the table and choose **Draw**: the chart then shows exactly the ticked pages (unticking and drawing again removes lines), each with a colour swatch you can change. Metric (clicks / impressions / CTR) is switchable. The table's timeframe (default: all available hours) controls which hours the page totals cover; "first hour" is always the first hour with data in the whole hourly window.

---

## Installation (development / unpacked)

1. Clone this repository and run `npm install` (Node.js 22.12 or newer).
2. Run `npm run build` (or `npm run dev` for a rebuild-on-change watcher). Output goes to `dist/`.
3. Open `chrome://extensions/` in Chrome and enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the **`dist/`** directory.
5. The extension icon appears in the toolbar. Click it to open the main view.

To click through the views without loading the extension or signing in, run `npm run harness`: it serves `dist/` on localhost with fake Chrome APIs and fake Search Console data (see [`dev/harness/README.md`](dev/harness/README.md)).

The `manifest.json` includes a `key`, so the unpacked build gets the same extension ID as the store version and the OAuth client keeps working.

---

## Authentication

The extension uses OAuth 2.0 via `chrome.identity` with the `webmasters.readonly` scope. No credentials are stored outside Chrome's identity layer.

- **Silent auth** is attempted automatically on page load (`interactive: false`).
- If silent auth fails, the auth button turns red and reads **Sign in**, and the chart area offers a **Sign in** button that starts the interactive OAuth flow (also available as **Sign in with Google** in the button's menu).
- **Sign out** clears all cached tokens via `chrome.identity.clearAllCachedAuthTokens`.

Auth button color codes:

| Color | Meaning |
|-------|---------|
| Grey (outline), "Checking sign-in…" | Auth state not checked yet |
| Green (outline), "Signed in" | Authenticated |
| Red (outline), "Sign in" | Auth failed, expired or signed out |

API errors (including an expired session) are shown in a red banner under the navigation bar that stays until dismissed or the next successful load; an expired session offers **Sign in again**. Short confirmations (copied, event added) appear as a toast at the bottom.

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

Bump `version` in `manifest.json` and push to `master`. The GitHub Action in `.github/workflows/release.yml` builds `dist/`, zips it and attaches `searchanalytics-v<version>.zip` to a GitHub release. Upload that ZIP in the Chrome Web Store developer console.

To build the ZIP locally instead:

```bash
npm run build && (cd dist && zip -r "../searchanalytics-v$(node -p "require('../manifest.json').version").zip" . -x "*.DS_Store")
```

---

## Architecture

Sources live in `src/` and are bundled with [Vite](https://vitejs.dev/) (`vite.config.js`) into `dist/`, which is what Chrome loads. Dependencies come from npm. At runtime the extension only talks to the Search Console API and, when you click **Fetch events** on the options page, the public Google Search Status feed.

| File | Role |
|------|------|
| `src/html/index.html` + `src/js/gsc-hourly.js` | Property by hour (main view) |
| `src/html/days.html` + `src/js/gsc-daily.js` | Property by day, events |
| `src/html/hourly.html` + `src/js/gsc-hourly2.js` | Pages by hour |
| `src/html/options.html` + `src/js/options.js` | Options page (ID regex, Search Status import) |
| `src/js/common.js` | Shared by all views: auth, API access, URL state, formatting, CSV/Sheets export, tabs |
| `src/js/theme.js` | Sets the Bootstrap colour theme from `prefers-color-scheme` before first paint |
| `src/js/background.js` | Service worker — opens `index.html` on icon click |

State is managed via a top-level `settings` object in each JS file, initialized from URL search params. Mutations go back through `addFilter()` / `removeFilter()` which call `history.pushState`.

---

## Libraries

| Library | Version | Purpose |
|---------|---------|---------|
| [Bootstrap](https://getbootstrap.com/) | 5.3 | Layout, UI components, light/dark colour modes |
| [Bootstrap Icons](https://icons.getbootstrap.com/) | 1.13 | Icon set |
| [jQuery](https://jquery.com/) | 4.0 | DOM manipulation (required by Bootstrap Table) |
| [Bootstrap Table](https://bootstrap-table.com/) | 1.28 | Sortable, searchable, paginated tables |
| [Billboard.js](https://naver.github.io/billboard.js/) | 4.1 | Interactive line charts (pulls in the D3 modules it needs) |
| [Vite](https://vitejs.dev/) | 8 | Build (dev dependency) |

CSV and Google Sheets export are implemented in `src/js/common.js`; there is no export library.
