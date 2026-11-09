// Test harness: stubs chrome.* and fakes the Search Console API so dist/ pages run on localhost.
// Injected into every page by serve.mjs. See README.md in this folder.
(() => {
  const later = (fn) => setTimeout(fn, 0);
  const lsKey = (area) => `__chrome_storage_${area}`;
  const readArea = (area) => JSON.parse(localStorage.getItem(lsKey(area)) || "{}");
  const writeArea = (area, obj) => localStorage.setItem(lsKey(area), JSON.stringify(obj));

  function storageArea(area) {
    return {
      get(keys, cb) {
        const all = readArea(area);
        let out = {};
        if (keys == null) out = all;
        else if (typeof keys === "string") { if (keys in all) out[keys] = all[keys]; }
        else if (Array.isArray(keys)) keys.forEach((k) => { if (k in all) out[k] = all[k]; });
        else Object.keys(keys).forEach((k) => { out[k] = k in all ? all[k] : keys[k]; });
        if (cb) return later(() => cb(out));
        return Promise.resolve(out);
      },
      set(obj, cb) {
        writeArea(area, { ...readArea(area), ...obj });
        if (cb) return later(cb);
        return Promise.resolve();
      },
    };
  }

  const authFails = new URLSearchParams(location.search).has("__noauth");
  window.chrome = {
    runtime: { lastError: undefined, getURL: (p) => p },
    identity: {
      getAuthToken(opts, cb) {
        later(() => {
          if (authFails && !opts?.interactive) {
            chrome.runtime.lastError = { message: "OAuth2 not granted or revoked." };
            cb(undefined);
            chrome.runtime.lastError = undefined;
          } else cb("fake-token");
        });
      },
      clearAllCachedAuthTokens(cb) { later(cb); },
    },
    storage: { sync: storageArea("sync"), local: storageArea("local") },
  };

  // ── fake data ──────────────────────────────────────────────────────────────
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const PAGES = [
    "https://www.example.com/",
    "https://www.example.com/news/12345/big-story",
    "https://www.example.com/news/12345/big-story?amp=1",
    "https://www.example.com/news/67890/other-story",
    "https://www.example.com/sport/live?id=1+2",
    "https://www.example.com/products/(special)",
    "https://www.example.com/about",
    "https://www.example.com/contact",
  ];
  const noise = (n) => (Math.sin(n * 12.9898) * 43758.5453) % 1;
  const pst = (ts) => {
    const d = new Date(ts - 8 * HOUR);
    return d.toISOString().slice(0, 19) + "-08:00";
  };
  const hourTs = (() => { const now = Date.now(); return now - (now % HOUR); })();
  const hourly = (seed = 1) => {
    const rows = [];
    for (let ts = hourTs - 10 * DAY; ts <= hourTs; ts += HOUR) {
      const h = new Date(ts).getHours();
      const base = 40 + 30 * Math.sin(((h - 6) / 24) * 2 * Math.PI);
      const clicks = Math.max(0, Math.round(base * seed + 10 * Math.abs(noise(ts / HOUR + seed))));
      const impressions = clicks * 18 + Math.round(200 * Math.abs(noise(ts / HOUR * 3 + seed)));
      rows.push({ ts, clicks, impressions });
    }
    return rows;
  };
  const withCtr = (r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0, position: 5 });

  function applyFilters(pages, body) {
    const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
    return pages.filter((p) => filters.every((f) => {
      const op = String(f.operator).toLowerCase();
      if (op === "contains") return p.includes(f.expression);
      if (op === "notcontains") return !p.includes(f.expression);
      if (op === "equals") return p === f.expression;
      if (op === "notequals") return p !== f.expression;
      if (op === "including_regex" || op === "includingregex") return new RegExp(f.expression).test(p);
      if (op === "excluding_regex" || op === "excludingregex") return !new RegExp(f.expression).test(p);
      return true;
    }));
  }

  const apiFails = new URLSearchParams(location.search).has("__apierror");

  function query(body) {
    window.__requests.push(body);
    if (apiFails) return { __error: { code: 403, message: "User does not have sufficient permission for site (harness __apierror)." } };
    const type = body.type || body.searchType;
    if (type === "discover") return {}; // no rows → exercise empty state
    const dims = (body.dimensions || []).map((d) => d.toUpperCase()).join(",");
    const pages = applyFilters(PAGES, body);
    if (body.dimensionFilterGroups?.[0]?.filters?.some((f) => /regex/i.test(f.operator))) {
      const expr = body.dimensionFilterGroups[0].filters[0].expression;
      if (expr.length > 4096) return { __error: { code: 400, message: "Expression too long (harness cap 4096)" } };
    }
    if (!pages.length) return {};
    const meta = { firstIncompleteHour: pst(hourTs - 30 * HOUR), firstIncompleteDate: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) };
    if (dims === "HOUR") {
      return { rows: hourly(pages.length / PAGES.length).map((r) => withCtr({ keys: [pst(r.ts)], clicks: r.clicks, impressions: r.impressions })), metadata: meta, responseAggregationType: "byProperty" };
    }
    if (dims === "DATE") {
      const rows = [];
      for (let d = new Date(body.startDate); d <= new Date(body.endDate) && d.getTime() < Date.now(); d = new Date(d.getTime() + DAY)) {
        const n = d.getTime() / DAY;
        const clicks = Math.round(600 + 200 * Math.sin(n / 3) + 100 * Math.abs(noise(n)));
        rows.push(withCtr({ keys: [d.toISOString().slice(0, 10)], clicks, impressions: clicks * 25 }));
      }
      return { rows, metadata: meta };
    }
    if (dims === "PAGE") {
      return { rows: pages.map((p, i) => withCtr({ keys: [p], clicks: 500 - i * 50, impressions: 9000 - i * 700 })) };
    }
    if (dims === "HOUR,PAGE") {
      const rows = [];
      pages.forEach((p, i) => hourly(1 / (i + 1)).forEach((r) => {
        if (r.clicks + r.impressions) rows.push(withCtr({ keys: [pst(r.ts), p], clicks: r.clicks, impressions: r.impressions }));
      }));
      rows.sort((a, b) => new Date(a.keys[0]) - new Date(b.keys[0]));
      return { rows, metadata: meta };
    }
    return {};
  }

  window.__requests = [];
  const realFetch = window.fetch.bind(window);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://www.googleapis.com/webmasters/v3/sites") && url.endsWith("/sites")) {
      return json({ siteEntry: [
        { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        { siteUrl: "https://www.example.com/", permissionLevel: "siteOwner" },
        { siteUrl: "https://blog.example.org/", permissionLevel: "siteFullUser" },
      ] });
    }
    if (url.includes("/searchAnalytics/query")) {
      const res = query(JSON.parse(init.body || "{}"));
      if (res.__error) return json({ error: res.__error }, res.__error.code);
      return json(res);
    }
    return realFetch(input, init);
  };
})();
