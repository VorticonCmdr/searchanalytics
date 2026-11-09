import bb, { grid, line, regions } from "billboard.js";
import {
  $,
  bootstrap,
  MS_PER_DAY,
  MS_PER_HOUR,
  addFilter,
  addFilters,
  apiError,
  assemblePageFilters,
  chartColors,
  clearError,
  ctrFormat,
  escapeHtml,
  escapeRegex,
  exportButtons,
  getLocalISOStringSlice,
  gscQuery,
  gscQueryAll,
  initAuth,
  initClipboardIcons,
  initHistory,
  initKeyboardShortcuts,
  initPageFilterActions,
  initPageFilterModal,
  initPropertyPicker,
  initRangePresets,
  initTabs,
  initViewSwitcher,
  loadProperties,
  numberFormat,
  pageActionButtons,
  pageFilterFor,
  parseTimestamp,
  readSharedUrlState,
  removeFilter,
  setClipboard,
  showChartState,
  showNotice,
  showProperty,
  syncPageFilterUi,
} from "./common.js";

// billboard.js v4 ESM: the region (timeframe/event bands) and grid (event lines)
// APIs are tree-shakable modules that must be registered before bb.generate().
grid();
regions();

const currentURL = new URL(document.location);

let settings = {
  properties: [],
  type: currentURL.searchParams.get("type") || "discover",
  from: parseTimestamp(currentURL.searchParams.get("from")),
  to: parseTimestamp(currentURL.searchParams.get("to")),
  auth: {
    token: null,
  },
  siteUrl: currentURL.searchParams.get("property") || null,
  page: currentURL.searchParams.get("page") || null,
  timeseries: ["x"],
  pages: [],
  selectedPages: [],
  metric: currentURL.searchParams.get("metric") || "clicks",
};


let noticeTimer;
const pageFilterModal = new bootstrap.Modal("#pageFilterModal", {});

let chart;

let $hoursTable = $("#hourstable");
let $pagesTable = $("#pagestable");

function listSites() {
  return loadProperties(settings);
}

async function getPages() {
  if (!settings.siteUrl) {
    $pagesTable.bootstrapTable("removeAll").bootstrapTable("hideLoading");
    return;
  }
  $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

  if (!settings.from || !settings.to) {
    $pagesTable.bootstrapTable("hideLoading");
    showNotice("Select a timeframe first", 3000);
    return;
  }

  const requestBody = {
    aggregationType: "AUTO",
    dataState: "HOURLY_ALL",
    type: settings.type,
    rowLimit: 10000,
    startDate: `${new Date(settings.from).getFullYear()}-01-01`,
    endDate: `${new Date(settings.to).getFullYear()}-12-31`,
    startRow: 0,
    dimensions: ["HOUR", "PAGE"],
    dimensionFilterGroups: [{ filters: assemblePageFilters(settings.page) }],
  };

  try {
    const data = await gscQuery(settings.siteUrl, settings.auth.token, requestBody);

    if (!data.rows) {
      settings.pages = [];
      $pagesTable.bootstrapTable("hideLoading");
      return;
    }
    settings.pages = data?.rows?.map((d) => {
      return {
        timestamp: new Date(d?.keys?.[0]).getTime(),
        page: d?.keys?.[1],
        clicks: d?.clicks,
        impressions: d?.impressions,
        ctr: d?.ctr,
      };
    });

    // Metrics cover the selected timeframe; "first hour" is the first hour with data
    // anywhere in the hourly window.
    const firstHours = new Map();
    settings.pages.forEach(({ page, timestamp }) => {
      if (!(firstHours.get(page) <= timestamp)) firstHours.set(page, timestamp);
    });
    const inRange = settings.pages.filter(
      (d) => d.timestamp >= settings.from && d.timestamp <= settings.to,
    );
    let { aggregatedPages } = aggregateByUrl(inRange);
    aggregatedPages.forEach((p) => {
      p.timestamp = firstHours.get(p.page);
      // keep the swatch of pages that are already drawn
      if (settings.selectedPages.includes(p.page)) p.color = chart?.data.colors()[p.page];
      p.state = settings.selectedPages.includes(p.page);
    });

    $pagesTable
      .bootstrapTable("load", aggregatedPages)
      .bootstrapTable("hideLoading");
  } catch (err) {
    apiError(err);
  } finally {
    $pagesTable.bootstrapTable("hideLoading");
  }
}

/** Makes the chart show exactly the ticked pages (adds new lines, removes unticked). */
function drawSelections() {
  if (!chart) return;
  const data = $pagesTable.bootstrapTable("getSelections");
  const previous = settings.selectedPages;
  settings.selectedPages = data.map((d) => d.page);
  const unload = previous.filter((p) => !settings.selectedPages.includes(p));
  const columns = data.map((d) => generatePageLine(d.page, settings.metric));

  if (columns.length) {
    chart.load({ columns, unload, done: colorTable });
  } else {
    chart.unload({ ids: unload, done: colorTable });
  }
  showChartState(settings.selectedPages.length ? null : "selectPages");
  generateNewHoursTable();
  updateDrawButton();
}

function checkedPages() {
  return $pagesTable.bootstrapTable("getSelections").map((r) => r.page);
}

/** "Draw n pages" when the ticked set differs from what is drawn; disabled otherwise. */
function updateDrawButton() {
  const checked = checkedPages();
  const drawn = settings.selectedPages;
  const same =
    checked.length === drawn.length && checked.every((p) => drawn.includes(p));
  let label = "Draw";
  if (same && checked.length) label = "Drawn";
  else if (checked.length) label = `Draw ${checked.length} page${checked.length === 1 ? "" : "s"}`;
  else if (drawn.length) label = "Clear chart";
  $("#drawPagesLabel").text(label);
  $("#drawPages").prop("disabled", same || !chart);
}

function generateNewHoursTable() {
  let filteredPages = settings.pages.filter(
    (d) => settings.selectedPages.indexOf(d.page) > -1,
  );
  let pivotHours = pivotByTimestamp(filteredPages, settings.metric);
  generateNewHoursTableColumns();
  $hoursTable.bootstrapTable("destroy");
  generateHoursTable();
  $hoursTable.bootstrapTable("load", pivotHours);
}

function generatePageLine(page, key) {
  let timeseries = Array(settings.timeseries.length).fill(null);
  timeseries[0] = page;
  settings.pages
    .filter((d) => d.page == page)
    .forEach((d) => {
      let index = settings.timeseries.indexOf(d.timestamp);
      timeseries[index] = d[key];
    });
  return timeseries;
}

function aggregateByUrl(rows) {
  const agg = {};
  const ts = new Date().getTime();

  rows.forEach((row) => {
    const url = row.page;
    if (!agg[url]) {
      agg[url] = {
        url,
        clicks: 0,
        impressions: 0,
        ctrSum: 0,
        count: 0,
        timestamp: ts,
      };
    }

    agg[url].clicks += row.clicks;
    agg[url].impressions += row.impressions;
    agg[url].ctrSum += row.ctr;
    agg[url].count += 1;
    agg[url].timestamp =
      row.timestamp < agg[url].timestamp ? row.timestamp : agg[url].timestamp;
  });

  let aggregatedPages = Object.values(agg).map((entry) => ({
    timestamp: entry.timestamp,
    page: entry.url,
    clicks: entry.clicks,
    impressions: entry.impressions,
    ctr: entry.impressions > 0 ? entry.clicks / entry.impressions : 0,
  }));
  return {
    aggregatedPages,
  };
}

async function getTimeline() {
  if (!settings.siteUrl) {
    $hoursTable.bootstrapTable("removeAll").bootstrapTable("hideLoading");
    showChartState("noProperty");
    return;
  }
  clearError();
  showChartState("loading");
  // The chart is regenerated below without page lines; clear the drawn set now (not
  // after the await) so a concurrent getPages() doesn't restore ticks and swatches.
  settings.selectedPages = [];
  resetHoursTableColumns();
  $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  const requestBody = {
    aggregationType: "AUTO",
    startRow: 0,
    dimensions: ["HOUR"],
    searchType: settings.type,
    rowLimit: 1000,
    dataState: "HOURLY_ALL",
    startDate: `${new Date(settings.from).getFullYear()}-01-01`,
    endDate: `${new Date(settings.to).getFullYear()}-12-31`,
    dimensionFilterGroups: [{ filters: assemblePageFilters(settings.page) }],
  };

  try {
    const data = await gscQuery(settings.siteUrl, settings.auth.token, requestBody);

    let firstIncompleteHour = data?.metadata?.firstIncompleteHour;
    let firstIncompleteHourTs = Infinity;
    if (firstIncompleteHour) {
      firstIncompleteHourTs = new Date(firstIncompleteHour).getTime();
    }

    if (!data.rows?.length) {
      $hoursTable.bootstrapTable("hideLoading");
      clearChart();
      showChartState("noData");
      return;
    }
    const timeline = (data.rows ?? []).map((d) => {
      let ts = new Date(d?.keys?.[0]).getTime();
      return {
        timestamp: ts,
        clicks: d?.clicks,
        impressions: d?.impressions,
        ctr: d?.ctr,
        incomplete: ts >= firstIncompleteHourTs,
      };
    });
    $hoursTable.bootstrapTable("load", timeline).bootstrapTable("hideLoading");

    let chartData = generateHourlyGraphData(data);
    settings.timeseries = chartData.timeseries;
    drawChart(chartData);
    showChartState("selectPages");
    updateDrawButton();
  } catch (err) {
    showChartState("error");
    apiError(err);
  } finally {
    $hoursTable.bootstrapTable("hideLoading");
  }
}

function generateHourlyGraphData(data) {
  let source = data.rows;
  let firstIncompleteHour = Infinity;
  if (data?.metadata?.firstIncompleteHour) {
    firstIncompleteHour = new Date(data.metadata.firstIncompleteHour).getTime();
  }

  const dataMapClicks = new Map();
  const dataMapImpressions = new Map();
  const dataMapCtr = new Map();

  // Map each timestamp (in ms) to clicks
  source.forEach((entry) => {
    const timestamp = new Date(entry.keys[0]).getTime();
    dataMapClicks.set(timestamp, entry.clicks);
    dataMapImpressions.set(timestamp, entry.impressions);
    dataMapCtr.set(timestamp, entry.ctr * 100);
  });

  const dataMapClicksMax = dataMapClicks.size
    ? Math.max(...dataMapClicks.values())
    : undefined;
  const dataMapImpressionsMax = dataMapImpressions.size
    ? Math.max(...dataMapImpressions.values())
    : undefined;
  const dataMapCtrMax = dataMapCtr.size
    ? Math.max(...dataMapCtr.values())
    : undefined;

  // Get most recent timestamp
  const mostRecentStr = source[source.length - 1].keys[0];
  const mostRecent = new Date(mostRecentStr);
  mostRecent.setDate(mostRecent.getDate() + 1);
  mostRecent.setHours(0, 0, 0, 0);

  // Calculate start time: 7 days before, at 00:00
  const start = new Date(mostRecent);
  start.setDate(start.getDate() - 10);
  start.setHours(0, 0, 0, 0);

  const timeseries = ["x"];
  const clicksLast7Days = ["clicks last 7 days"];
  const clicksIncomplete = ["incomplete clicks"];
  const impressionsLast7Days = ["impressions last 7 days"];
  const impressionsIncomplete = ["incomplete impressions"];
  const ctrLast7Days = ["ctr last 7 days"];
  const ctrIncomplete = ["incomplete ctr"];

  const MS_PER_HOUR = 60 * 60 * 1000;

  for (let i = 0; i < 24 * 10; i++) {
    const ts = start.getTime() + i * MS_PER_HOUR;

    let ctr = (dataMapCtr.get(ts) / dataMapCtrMax) * dataMapImpressionsMax;

    timeseries.push(ts);
    if (ts >= firstIncompleteHour) {
      clicksIncomplete.push(dataMapClicks.get(ts) ?? null);
      impressionsIncomplete.push(dataMapImpressions.get(ts) ?? null);
      ctrIncomplete.push(ctr ?? null);

      clicksLast7Days.push(null);
      impressionsLast7Days.push(null);
      ctrLast7Days.push(null);
    } else {
      if (ts >= firstIncompleteHour - MS_PER_HOUR) {
        clicksIncomplete.push(dataMapClicks.get(ts) ?? null);
        impressionsIncomplete.push(dataMapImpressions.get(ts) ?? null);
        ctrIncomplete.push(ctr ?? null);
      } else {
        clicksIncomplete.push(null);
        impressionsIncomplete.push(null);
        ctrIncomplete.push(null);
      }

      clicksLast7Days.push(dataMapClicks.get(ts) ?? null);
      impressionsLast7Days.push(dataMapImpressions.get(ts) ?? null);
      ctrLast7Days.push(ctr ?? null);
    }
  }

  return {
    timeseries,
    clicksLast7Days,
    clicksIncomplete,
    impressionsLast7Days,
    impressionsIncomplete,
    ctrLast7Days,
    ctrIncomplete,
    dataMapImpressionsMax,
    dataMapCtrMax,
    dataMapCtr,
  };
}

function clearChart() {
  if (chart) {
    chart.regions.remove();
    chart.unload({
      done: function () {},
      resizeAfter: true, // will resize after unload
    });
  }
}

/** Shows a colour swatch for every drawn page (and none for the others). */
function colorTable() {
  const colors = chart.data.colors();
  const updates = $pagesTable
    .bootstrapTable("getData", { unfiltered: true })
    .map((row) => ({
      id: row.page,
      field: "color",
      value: settings.selectedPages.includes(row.page) ? colors[row.page] : undefined,
    }));
  if (updates.length) $pagesTable.bootstrapTable("updateCellByUniqueId", updates);
}

function drawChart(chartData) {
  let columns = [];
  // These two series only carry the x axis for the per-page lines. They are hidden,
  // but chart.focus() defocuses (and thereby reveals) hidden series at 30% opacity,
  // so draw them transparent.
  let colors = {
    "clicks last 7 days": "transparent",
    "incomplete clicks": "transparent",
  };

  columns.push(chartData.timeseries);
  columns.push(chartData.clicksLast7Days);
  columns.push(chartData.clicksIncomplete);

  let ctrSet = new Set(["ctr last 7 days", "ctr before", "incomplete ctr"]);

  clearChart();
  chart = bb.generate({
    point: {
      show: false,
    },
    line: {
      classes: [],
    },
    color: {
      pattern: chartColors().palette,
    },
    bindto: "#chart",
    padding: {
      left: 75,
      right: 30,
    },
    data: {
      x: "x",
      columns: columns,
      colors: colors,
      order: "desc",
      type: line(),
      axes: {},
      hide: [
        "clicks last 7 days",
        "incomplete clicks",
        "impressions last 7 days",
        "incomplete impressions",
        "ctr last 7 days",
        "incomplete ctr",
      ],
    },
    legend: {
      show: false,
    },
    tooltip: {
      format: {
        value: function (value, ratio, id, index) {
          if (ctrSet.has(id)) {
            let ts = chartData.timeseries[index + 1];
            let ctr = chartData.dataMapCtr.get(ts);
            return ctrFormat(ctr / 100);
          }
          return settings.metric === "ctr" ? ctrFormat(value) : numberFormat(value);
        },
        title: function (x) {
          return dateFormat(x);
        },
      },
    },
    axis: {
      y: {
        label: { text: metricLabel(), position: "outer-middle" },
        padding: {
          top: 10,
          bottom: 0,
        },
        min: 0,
        show: true,
        tick: {
          fit: true,
          format: (d) => (settings.metric === "ctr" ? ctrFormat(d) : numberFormat(d)),
        },
      },
      y2: {},
      x: {
        padding: {
          left: 0,
          right: 0,
        },
        type: "timeseries",
        tick: {
          fit: false,
          count: 8,
          format: "%Y-%m-%d",
        },
      },
    },
  });
}

function tableButtons(name) {
  return exportButtons(settings, name);
}

const metricLabel = () => (settings.metric === "ctr" ? "CTR" : settings.metric);

function rowStylePages(row, index) {
  let classes = ["action-link"];

  return {
    classes: classes.join(" "),
  };
}

function rowStyleHours(row, index) {
  let classes = [];

  if (row.incomplete) {
    classes.push("incomplete");
  }

  return {
    classes: classes.join(" "),
  };
}

let hoursColumns = [
  {
    field: "timestamp",
    title: "hour",
    formatter: dateFormat,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "clicks",
    title: "clicks",
    formatter: numberFormat,
    suppressFormatterExport: true,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "impressions",
    title: "impressions",
    formatter: numberFormat,
    suppressFormatterExport: true,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "ctr",
    title: "ctr",
    formatter: ctrFormat,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "incomplete",
    title: "incomplete",
    sortable: false,
    visible: false,
    searchable: false,
    align: "left",
  },
];

let pagesColumns = [
  {
    field: "state",
    checkbox: true,
    sortable: false,
    visible: true,
    searchable: false,
  },
  {
    field: "color",
    title: "line",
    sortable: false,
    visible: true,
    searchable: false,
    align: "center",
    formatter: colorFormatter,
    suppressExport: true,
  },
  {
    field: "page",
    title: "page",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
    formatter: urlFormatter,
    suppressFormatterExport: true,
  },
  {
    field: "clicks",
    title: "clicks",
    formatter: numberFormat,
    suppressFormatterExport: true,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "impressions",
    title: "impressions",
    formatter: numberFormat,
    suppressFormatterExport: true,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "ctr",
    title: "ctr",
    formatter: ctrFormat,
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "timestamp",
    title: "first hour",
    formatter: dateFormat,
    sortable: true,
    visible: true,
    searchable: true,
    align: "right",
  },
];

function colorFormatter(value, row) {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return "";
  const page = escapeHtml(row?.page);
  return `<input type="color" data-page="${page}" value="${value}" class="graphColors form-control form-control-sm d-inline-block" aria-label="Line colour for ${page}" title="Change line colour">`;
}

let dtf = new Intl.DateTimeFormat("default", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function dateFormat(value) {
  if (!value) return undefined;

  return dtf.format(new Date(Number(value)));
}

function urlFormatter(value, row) {
  return `${escapeHtml(value)}${pageActionButtons(value)}`;
}

async function generatePagesTable() {
  $pagesTable.bootstrapTable({
    buttonsClass: "outline-secondary",
    toolbar: "#pagestable-toolbar",
    uniqueId: "page",
    classes: "table table-hover",
    data: [],
    pageList: [10, 100, "all"],
    pageSize: 100,
    pagination: true,
    showRefresh: false,
    buttons: () => tableButtons("pages"),
    search: true,
    columns: pagesColumns,
    rowStyle: rowStylePages,
    showColumns: true,
    sortOrder: "asc",
    sortName: "timestamp",
  });
  $pagesTable.on(
    "check.bs.table uncheck.bs.table check-all.bs.table uncheck-all.bs.table check-some.bs.table uncheck-some.bs.table post-body.bs.table",
    updateDrawButton,
  );
}

// Property-level columns; drawing pages swaps in one column per page.
const propertyHoursColumns = hoursColumns;

function resetHoursTableColumns() {
  if (hoursColumns === propertyHoursColumns) return;
  hoursColumns = propertyHoursColumns;
  $hoursTable.bootstrapTable("destroy");
  generateHoursTable();
}

async function generateHoursTable() {
  $hoursTable.bootstrapTable({
    buttonsClass: "outline-secondary",
    toolbar: "#hourstable-toolbar",
    uniqueId: "timestamp",
    classes: "table table-hover",
    rowStyle: rowStyleHours,
    data: [],
    pageSize: 1000,
    showRefresh: false,
    buttons: () => tableButtons("timeline"),
    columns: hoursColumns,
    showColumns: true,
    sortOrder: "asc",
    sortName: "timestamp",
  });
}

async function generateNewHoursTableColumns() {
  hoursColumns = [
    {
      field: "timestamp",
      title: "hour",
      formatter: dateFormat,
      sortable: true,
      visible: true,
      searchable: true,
      align: "right",
    },
  ];

  settings.selectedPages.forEach((page) => {
    hoursColumns.push({
      field: page,
      title: page,
      sortable: false,
      visible: true,
      searchable: false,
      align: "right",
      formatter: (v) => (v == null ? "–" : settings.metric === "ctr" ? ctrFormat(v) : numberFormat(v)),
      suppressFormatterExport: true,
    });
  });
}

/**
 * Pivot [{timestamp, page, ...metrics}] into
 * [{ timestamp, "<page1>": value, "<page2>": value, ... }]
 *
 * @param {Array<Object>} data
 * @param {string} metric                    // e.g. "clicks" | "impressions" | "ctr"
 * @param {Object} [opts]
 * @param {*} [opts.fill=null]               // value when a page has no data for a timestamp
 * @param {'last'|'sum'|'max'|'min'|Function} [opts.aggregate='last'] // combine duplicates
 * @param {boolean} [opts.sort=true]         // sort timestamps ascending
 * @param {string} [opts.tsKey='timestamp']  // custom key for timestamp
 * @param {string} [opts.pageKey='page']     // custom key for page
 * @param {string[]} [opts.onlyPages]        // restrict to these pages
 * @returns {Array<Object>}
 */
function pivotByTimestamp(data, metric, opts = {}) {
  if (!Array.isArray(data) || !metric) return [];

  const {
    fill = null,
    aggregate = "last",
    sort = true,
    tsKey = "timestamp",
    pageKey = "page",
    onlyPages,
  } = opts;

  const combiner =
    typeof aggregate === "function"
      ? aggregate
      : {
          last: (_, b) => b,
          sum: (a, b) => (a ?? 0) + (b ?? 0),
          max: (a, b) => (a == null ? b : b == null ? a : Math.max(a, b)),
          min: (a, b) => (a == null ? b : b == null ? a : Math.min(a, b)),
        }[aggregate] || ((_, b) => b);

  const rowsByTs = new Map(); // ts -> row object
  const pagesSet = new Set(onlyPages || undefined);

  for (const r of data) {
    const ts = r?.[tsKey];
    const page = r?.[pageKey];
    if (ts == null || !page) continue;

    if (!onlyPages || pagesSet.has(page)) {
      pagesSet.add(page);
      const val = r?.[metric] ?? null;
      const row = rowsByTs.get(ts) || { [tsKey]: ts };
      if (row.hasOwnProperty(page)) {
        row[page] = combiner(row[page], val);
      } else {
        row[page] = val;
      }
      rowsByTs.set(ts, row);
    }
  }

  const pageList = [...pagesSet];
  const out = [...rowsByTs.entries()]
    .sort((a, b) => (sort ? a[0] - b[0] : 0))
    .map(([_, row]) => {
      // ensure every page key exists on every row
      for (const p of pageList) {
        if (!Object.prototype.hasOwnProperty.call(row, p)) row[p] = fill;
      }
      return row;
    });

  return out;
}

const floorHour = (ts) => {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};
const startOfDay = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Default timeframe: the whole hourly window (Google keeps about 10 days). */
function wholeWindow() {
  return { from: startOfDay(10), to: floorHour(Date.now()) };
}

function hourPresets() {
  const now = () => floorHour(Date.now());
  return [
    { label: "All available hours", range: wholeWindow },
    { label: "Today", range: () => ({ from: startOfDay(0), to: now() }) },
    { label: "Yesterday", range: () => ({ from: startOfDay(1), to: startOfDay(0) - MS_PER_HOUR }) },
    { label: "Last 24 hours", range: () => ({ from: now() - 24 * MS_PER_HOUR, to: now() }) },
    { label: "Last 3 days", range: () => ({ from: startOfDay(2), to: now() }) },
  ];
}

/** Shaded band when the pages timeframe is narrower than the chart. */
function drawTimeframe() {
  if (!chart) return;
  chart.regions.remove();
  const first = settings.timeseries[1];
  const last = settings.timeseries[settings.timeseries.length - 1];
  if (!(settings.from < settings.to)) return;
  if (settings.from <= first && settings.to >= last) return;
  chart.regions.add({
    axis: "x",
    start: settings.from,
    end: settings.to + MS_PER_HOUR,
    class: "regionCut",
    label: { text: "Pages tab timeframe", x: 5, y: 4 },
  });
}

/** Sets the pages timeframe (ms timestamps, hour starts) and re-aggregates pages. */
function applyRange({ from, to }) {
  from = floorHour(from);
  to = floorHour(to);
  settings.from = from;
  settings.to = to;
  $("#from").val(getLocalISOStringSlice(from));
  $("#to").val(getLocalISOStringSlice(to));
  addFilters({ from: getLocalISOStringSlice(from), to: getLocalISOStringSlice(to) });
  const valid = from < to;
  $("#from, #to").toggleClass("is-invalid", !valid);
  drawTimeframe();
  if (!valid) {
    showNotice("“From” must be before “to”", 3000);
    return;
  }
  getPages();
}

function loadAll() {
  listSites();
  getTimeline();
  getPages();
}

/** Reloads chart and both tables for the current settings. */
function reloadAll() {
  clearChart();
  if (!settings.auth.token) return;
  $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  getTimeline();
  getPages();
}

/** Applies a URL filter (settings.page format, or null to remove) and reloads. */
function setPageFilter(page) {
  settings.page = page || null;
  if (settings.page) addFilter("page", settings.page);
  else removeFilter("page");
  syncPageFilterUi(settings.page);
  pageFilterModal.hide();
  reloadAll();
}

/** Back/forward: take the whole state from the URL again. */
function syncFromUrl(params) {
  readSharedUrlState(settings, params);
  const full = wholeWindow();
  settings.from = parseTimestamp(params.get("from")) ?? full.from;
  settings.to = parseTimestamp(params.get("to")) ?? full.to;
  settings.metric = params.get("metric") || "clicks";
  $("#from").val(getLocalISOStringSlice(settings.from));
  $("#to").val(getLocalISOStringSlice(settings.to));
  $("#from, #to").removeClass("is-invalid");
  $("#metric").val(settings.metric);
  reloadAll();
}

function clearAll() {
  clearChart();
  $pagesTable.bootstrapTable("removeAll");
  $hoursTable.bootstrapTable("removeAll");
}

async function init() {
  initAuth(settings, { onSignIn: loadAll, onSignOut: clearAll });

  showProperty(settings.siteUrl);
  $("#type").val(settings.type);

  const full = wholeWindow();
  if (!settings.from) {
    settings.from = full.from;
  }
  if (!settings.to) {
    settings.to = full.to;
  }
  $("#from").val(getLocalISOStringSlice(settings.from));
  $("#to").val(getLocalISOStringSlice(settings.to));

  generateHoursTable();
  generatePagesTable();

  initTabs();

  $("#type").on("change", function () {
    let type = $(this).val();
    settings.type = type;

    clearChart();
    $pagesTable.bootstrapTable("removeAll");
    $hoursTable.bootstrapTable("removeAll");

    addFilter("type", type);
    getTimeline();
    getPages();
  });

  $("#property").on("change", function () {
    let selectedValue = $(this).val();
    if (!selectedValue) {
      console.log("No property selected");
      return;
    }
    if (!settings.properties.includes(selectedValue)) {
      showProperty(null, false);
      return;
    }
    clearChart();
    $pagesTable.bootstrapTable("removeAll");
    $hoursTable.bootstrapTable("removeAll");
    settings.siteUrl = selectedValue;
    showProperty(settings.siteUrl);
    $("#property").val("").trigger("blur");
    addFilter("property", selectedValue);
    getTimeline();
    getPages();
  });

  $(document).on("change", ".graphColors", function () {
    const {
      value: color,
      dataset: { page },
    } = this;
    chart.data.colors({ [page]: color });
    const row = $pagesTable.bootstrapTable("getRowByUniqueId", page);
    if (row) row.color = color;
  });

  $("#drawPages").on("click", drawSelections);

  $("input[type='datetime-local']").on("change", function () {
    let val = $(this).val();
    let id = $(this).attr("id");
    if (!val) return;
    applyRange({ ...settings, [id]: new Date(val).getTime() });
  });
  initRangePresets(hourPresets(), applyRange);

  syncPageFilterUi(settings.page);

  initPageFilterModal(function () {
    const value = $("#floatingPageFilterInput").val();
    setPageFilter(value ? `${$("#urlFilterMode").val()}${value}` : null);
  });
  initPageFilterActions((url) => setPageFilter(pageFilterFor(url)));
  initHistory(syncFromUrl);

  $("#metric").val(settings.metric);
  $("#metric").on("change", function () {
    const value = this.value;
    settings.metric = value;
    addFilter("metric", value);
    if (!chart) return;
    chart.axis.labels({
      y: metricLabel(),
    });
    chart.flush();
    if (settings.selectedPages.length) {
      chart.load({
        columns: settings.selectedPages.map((page) =>
          generatePageLine(page, settings.metric),
        ),
      });
      colorTable();
      generateNewHoursTable();
    }
  });

  initPropertyPicker();

  initClipboardIcons();
  initViewSwitcher();
  initKeyboardShortcuts();

}
init();
