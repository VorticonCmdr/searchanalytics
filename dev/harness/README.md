# Test harness

Runs the built extension pages in an ordinary browser tab, with `chrome.*` stubbed and the
Search Console API faked, so every view can be clicked through without loading the extension
or signing in. Use it before each release and after dependency upgrades.

```bash
npm run harness        # vite build, then serve dist/ on http://127.0.0.1:8765
```

Open the URLs it prints. Nothing here is part of the extension build: `dev/` is never copied
into `dist/`.

## What is faked (`stub.js`)

- `chrome.identity` — always returns a token. Add `&__noauth=1` to a view URL to start
  signed out (silent auth fails; the chart's "Sign in" button or "Sign in with Google" then succeeds).
- `chrome.storage.sync` / `.local` — backed by `localStorage`, so events and the ID regex
  persist across reloads. Clear site data for 127.0.0.1 to reset.
- `fetch` to the Search Console API — deterministic data for 3 properties and 8 pages
  (including URLs with `?`, `+` and parentheses to exercise regex escaping):
  - `HOUR`, `HOUR,PAGE`: the last 10 days, ascending, Pacific-time keys, with
    `firstIncompleteHour` metadata;
  - `DATE`, `PAGE`: the requested range;
  - page filters (`contains`, `equals`, regex, …) are applied;
  - `type=discover` returns no rows, to exercise the empty state;
  - regex filters longer than 4096 characters return a 400;
  - add `&__apierror=1` to a view URL to make every query fail with a 403 (error banner).
- Every query body is recorded in `window.__requests` for inspection in DevTools.
- Requests to other hosts (e.g. the Google Search Status feed on the options page) go to
  the real network.

## Checklist

- **Property by hour:** chart with timeframe band and solid/dashed/dotted lines; legend toggles a
  metric; CTR alone on the right axis shows % ticks; hours tab; pages tab (arrow keys switch
  tabs); quick ranges; copy for Google Sheets; download CSV; URL filter chip (Enter applies, ×
  clears); `type=discover` shows the "no data" overlay without a stuck spinner.
- **Empty & error states:** `&__noauth=1` → "Sign in" overlay; no `property` param → "Choose
  property"; `&__apierror=1` → red banner + "Couldn’t load data" overlay.
- **Navigation:** view menu keeps property/type/filter; Options item opens the options page;
  `/` focuses the visible table's search; Back/Forward after a filter, search type, range or
  granularity change restores the previous state (URL and view).
- **Row filter (all three views):** hover a URL in a pages table → funnel → chip shows
  "URLs equal to …" (or "containing" the ID fragment when aggregated by ID).
- **Property by day:** by day / by month; quick ranges; events tab: empty submit shows field
  errors, add (Enter works), check (band turns magenta), remove (button disabled until ticked).
- **Pages by hour:** tick pages → "Draw n pages"; swatches only for drawn pages; untick + draw
  removes the line; switch metric (lines redraw, CTR in %).
- **Options:** regex tester (invalid regex blocks Save); Fetch events → Import.
- **Dark mode:** switch the OS appearance, or DevTools → Rendering → "Emulate CSS
  prefers-color-scheme: dark".

The harness does not cover the real OAuth flow or the extension's content security policy. For
those, load `dist/` unpacked in `chrome://extensions` once before publishing.
