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
  idRegex: null,
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
    rowLimit: 25000,
    startDate: new Date(settings.from - MS_PER_DAY).toISOString().slice(0, 10),
    endDate: new Date(settings.to + MS_PER_DAY).toISOString().slice(0, 10),
    startRow: 0,
    dimensions: ["HOUR", "PAGE"],
    dimensionFilterGroups: [{ filters: assemblePageFilters(settings.page) }],
  };

  try {
    const data = await gscQuery(settings.siteUrl, settings.auth.token, requestBody);

    let firstClicks = {};

    let pages = (data.rows ?? [])
      .map((d) => {
        let ts = new Date(d?.keys?.[0]).getTime();
        let originalUrl = d?.keys?.[1];
        let extractedId = getIdentifier(originalUrl);

        if (!firstClicks[extractedId] || ts < firstClicks[extractedId]) {
          firstClicks[extractedId] = ts;
        }
        // Wir geben sowohl die extrahierte ID als auch die Original-URL weiter
        return { ...d, extractedId: extractedId, originalUrl: originalUrl };
      })
      .filter(
        (d) =>
          new Date(d?.keys?.[0]).getTime() >= settings.from &&
          new Date(d?.keys?.[0]).getTime() <= settings.to,
      );

    let aggregatedPages = aggregateById(pages, firstClicks);

    $pagesTable
      .bootstrapTable("load", aggregatedPages)
      .bootstrapTable("hideLoading");

    getFirstImpressions();
  } catch (err) {
    apiError(err);
  } finally {
    $pagesTable.bootstrapTable("hideLoading");
  }
}

function aggregateById(rows, firstClicks) {
  const agg = {};

  rows.forEach((row) => {
    const id = row.extractedId;
    if (!agg[id]) {
      agg[id] = {
        id: id,
        page: row.originalUrl, // Hier nehmen wir die erste URL als Repräsentanten
        clicks: 0,
        impressions: 0,
        ctrSum: 0,
        count: 0,
        timestamp: firstClicks[id],
      };
    }

    agg[id].clicks += row.clicks;
    agg[id].impressions += row.impressions;
    agg[id].ctrSum += row.ctr;
    agg[id].count += 1;
  });

  return Object.values(agg).map((entry) => ({
    id: entry.id,
    page: entry.page, // Das ist jetzt wieder eine klickbare URL
    clicks: entry.clicks,
    impressions: entry.impressions,
    ctr: entry.impressions > 0 ? entry.clicks / entry.impressions : 0,
    timestamp: entry.timestamp,
  }));
}

function aggregateByUrl(rows) {
  const agg = {};

  rows.forEach((row) => {
    const url = row.page;
    if (!agg[url]) {
      agg[url] = {
        url,
        clicks: 0,
        impressions: 0,
        ctrSum: 0,
        count: 0,
        timestamp: 0,
      };
    }

    agg[url].clicks += row.clicks;
    agg[url].impressions += row.impressions;
    agg[url].ctrSum += row.ctr;
    agg[url].count += 1;
    agg[url].timestamp = row.timestamp;
  });

  return Object.values(agg).map((entry) => ({
    timestamp: entry.timestamp,
    page: entry.url,
    clicks: entry.clicks,
    impressions: entry.impressions,
    ctr: entry.impressions > 0 ? entry.clicks / entry.impressions : 0,
  }));
}

async function getTimeline() {
  if (!settings.siteUrl) {
    $hoursTable.bootstrapTable("removeAll").bootstrapTable("hideLoading");
    showChartState("noProperty");
    return;
  }
  clearError();
  showChartState("loading");
  $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  const requestBody = {
    aggregationType: "AUTO",
    startRow: 0,
    dimensions: ["HOUR"],
    searchType: settings.type,
    rowLimit: 25000,
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

    if (!data.rows?.length) {
      clearChart();
      showChartState("noData");
      return;
    }

    let chartData = generateHourlyGraphData(data);
    drawChart(chartData);
    showChartState(null);
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
  let lastIncompleteHour = 0;
  let startLast7Days = Infinity;
  let endLast7Days = 0;
  let startPrev7Days = Infinity;
  let endPrev7Days = 0;

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
  endLast7Days = mostRecent.getTime();

  // Calculate start time: 7 days before, at 00:00
  const start = new Date(mostRecent);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  startLast7Days = start.getTime();

  const timeseries = ["x"];
  const clicksLast7Days = ["clicks last 7 days"];
  const clicksIncomplete = ["incomplete clicks"];
  const clicksPrev7Days = ["clicks before"];
  const impressionsLast7Days = ["impressions last 7 days"];
  const impressionsIncomplete = ["incomplete impressions"];
  const impressionsPrev7Days = ["impressions before"];
  const ctrLast7Days = ["ctr last 7 days"];
  const ctrIncomplete = ["incomplete ctr"];
  const ctrPrev7Days = ["ctr before"];

  const MS_PER_HOUR = 60 * 60 * 1000;

  for (let i = 0; i < 24 * 7; i++) {
    const ts = start.getTime() + i * MS_PER_HOUR;
    const tsPrev = ts - 7 * 24 * MS_PER_HOUR;

    let ctr = (dataMapCtr.get(ts) / dataMapCtrMax) * dataMapImpressionsMax;
    let ctrPrev =
      (dataMapCtr.get(tsPrev) / dataMapCtrMax) * dataMapImpressionsMax;

    timeseries.push(ts);
    if (ts >= firstIncompleteHour) {
      clicksIncomplete.push(dataMapClicks.get(ts) ?? null);
      impressionsIncomplete.push(dataMapImpressions.get(ts) ?? null);
      ctrIncomplete.push(ctr ?? null);
      if (dataMapClicks.get(ts) + dataMapImpressions.get(ts)) {
        lastIncompleteHour = ts + MS_PER_HOUR;
      }

      clicksLast7Days.push(null);
      impressionsLast7Days.push(null);
      ctrLast7Days.push(null);
    } else {
      if (ts >= firstIncompleteHour - MS_PER_HOUR) {
        clicksIncomplete.push(dataMapClicks.get(ts) ?? null);
        impressionsIncomplete.push(dataMapImpressions.get(ts) ?? null);
        ctrIncomplete.push(ctr ?? null);

        if (dataMapClicks.get(ts) + dataMapImpressions.get(ts)) {
          lastIncompleteHour = ts + MS_PER_HOUR;
        }
      } else {
        clicksIncomplete.push(null);
        impressionsIncomplete.push(null);
        ctrIncomplete.push(null);
      }

      clicksLast7Days.push(dataMapClicks.get(ts) ?? null);
      impressionsLast7Days.push(dataMapImpressions.get(ts) ?? null);
      ctrLast7Days.push(ctr ?? null);
    }

    clicksPrev7Days.push(dataMapClicks.get(tsPrev) ?? null);
    impressionsPrev7Days.push(dataMapImpressions.get(tsPrev) ?? null);
    ctrPrev7Days.push(ctrPrev ?? null);

    if (dataMapClicks.get(tsPrev) + dataMapImpressions.get(tsPrev)) {
      if (tsPrev < startPrev7Days) {
        startPrev7Days = tsPrev;
      }
      if (tsPrev > endPrev7Days) {
        endPrev7Days = tsPrev;
      }
    }
  }

  return {
    timeseries,
    clicksLast7Days,
    clicksPrev7Days,
    clicksIncomplete,
    impressionsLast7Days,
    impressionsPrev7Days,
    impressionsIncomplete,
    ctrLast7Days,
    ctrPrev7Days,
    ctrIncomplete,
    dataMapImpressionsMax,
    dataMapCtrMax,
    dataMapCtr,
    startLast7Days,
    endLast7Days,
    firstIncompleteHour,
    lastIncompleteHour,
    startPrev7Days,
    endPrev7Days,
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

// Each metric has three series: the current week (hero), the previous week shifted
// onto the same x positions (context), and incomplete hours (provisional).
const METRICS = ["clicks", "impressions", "ctr"];
const seriesIds = (metric) => ({
  current: `${metric} last 7 days`,
  previous: `${metric} before`,
  incomplete: `incomplete ${metric}`,
});
// Legend entries: current week (also toggles its incomplete hours) and previous week.
function legendGroup(id) {
  const metric = METRICS.find((m) => id.includes(m));
  const ids = seriesIds(metric);
  return id === ids.previous ? [ids.previous] : [ids.current, ids.incomplete];
}

// CTR is drawn on the impressions axis, scaled so its maximum meets the impressions
// maximum. When CTR is the only thing on that axis, the ticks show real CTR values.
let y2Mode = "impressions";
function updateY2Axis(hidden, chartData) {
  const visible = (metric) =>
    Object.values(seriesIds(metric)).some((id) => !hidden.has(id));
  const imp = visible("impressions");
  const ctr = visible("ctr");
  y2Mode = ctr && !imp ? "ctr" : "impressions";
  chart.axis.labels({
    y2: ctr && imp ? "impressions (CTR scaled to fit)" : ctr ? "CTR" : "impressions",
  });
  chart.flush();
}
function y2Tick(value, chartData) {
  if (y2Mode === "ctr") {
    const pct = (value / chartData.dataMapImpressionsMax) * chartData.dataMapCtrMax;
    return `${pct.toFixed(1)}%`;
  }
  return numberFormat(value);
}

function drawChart(chartData) {
  let columns = [];
  const tokens = chartColors();
  const colors = {};
  const classes = {};
  METRICS.forEach((metric) => {
    Object.entries(seriesIds(metric)).forEach(([kind, id]) => {
      colors[id] = tokens[metric];
      classes[id] = kind;
    });
  });

  columns.push(chartData.timeseries);
  columns.push(chartData.clicksLast7Days);
  columns.push(chartData.clicksIncomplete);
  columns.push(chartData.clicksPrev7Days);
  columns.push(chartData.impressionsLast7Days);
  columns.push(chartData.impressionsIncomplete);
  columns.push(chartData.impressionsPrev7Days);
  columns.push(chartData.ctrLast7Days);
  columns.push(chartData.ctrIncomplete);
  columns.push(chartData.ctrPrev7Days);

  let ctrSet = new Set(["ctr last 7 days", "ctr before", "incomplete ctr"]);

  // The current week ends at the midnight after the last data point; label the
  // last day that is actually in it.
  const lastWeek = `${dayOnlyFormat(chartData.startLast7Days)}–${dayOnlyFormat(chartData.endLast7Days - MS_PER_DAY)}`;
  const prevWeek = `${dayOnlyFormat(chartData.startPrev7Days)}–${dayOnlyFormat(chartData.endPrev7Days)}`;
  const incomplete = `${dayOnlyFormat(chartData.firstIncompleteHour)}–${dayOnlyFormat(chartData.lastIncompleteHour)}`;
  const names = {};
  METRICS.forEach((metric) => {
    const ids = seriesIds(metric);
    const label = metric === "ctr" ? "CTR" : metric;
    names[ids.current] = `${label} ${lastWeek}`;
    names[ids.previous] = `${label} ${prevWeek}`;
    names[ids.incomplete] = `incomplete ${label} ${incomplete}`;
  });

  const initiallyHidden = [
    ...Object.values(seriesIds("impressions")),
    ...Object.values(seriesIds("ctr")),
  ];
  const hidden = new Set(initiallyHidden);

  const MS_BEFORE = 7 * 24 * 60 * 60 * 1000;
  clearChart();
  y2Mode = "impressions";
  chart = bb.generate({
    point: {
      show: false,
    },
    bindto: "#chart",
    padding: {
      left: 70,
      right: 80,
    },
    legend: {
      hide: METRICS.map((m) => seriesIds(m).incomplete),
      item: {
        onclick(id) {
          const group = legendGroup(id);
          if (hidden.has(id)) {
            group.forEach((g) => hidden.delete(g));
            this.show(group);
          } else {
            group.forEach((g) => hidden.add(g));
            this.hide(group);
          }
          updateY2Axis(hidden, chartData);
        },
      },
    },
    data: {
      x: "x",
      columns: columns,
      colors: colors,
      classes: classes,
      order: "desc",
      type: line(),
      names: names,
      axes: {
        "impressions last 7 days": "y2",
        "impressions before": "y2",
        "incomplete impressions": "y2",
        "ctr last 7 days": "y2",
        "ctr before": "y2",
        "incomplete ctr": "y2",
      },
      hide: initiallyHidden,
    },
    tooltip: {
      format: {
        name: function (name, ratio, id, index) {
          // Use the series id ("clicks before", "incomplete ctr", …): `name` is the
          // display name from data.names and never contains "before".
          let [metric, part2] = id.split(" ");
          // timeseries[0] is the "x" header, so data point `index` is at index + 1.
          let ts = chartData.timeseries[index + 1];
          if (metric == "incomplete") {
            metric = `incomplete ${part2}`;
          }
          if (part2 == "before") {
            ts -= MS_BEFORE;
          }
          return `${metric} ${dayFormat(ts)}`;
        },
        value: function (value, ratio, id, index) {
          if (ctrSet.has(id)) {
            let ts = chartData.timeseries[index + 1];
            let ctr = chartData.dataMapCtr.get(ts);
            return ctrFormat(ctr / 100);
          }
          return numberFormat(value);
        },
        title: function (x) {
          let d = new Date(x).getTime();
          let from = timeWeekdayFormat(d);
          let to = timeFormat(d + 60 * 60 * 1000);
          return `${from} - ${to}`;
        },
      },
    },
    axis: {
      y: {
        label: { text: "clicks", position: "outer-middle" },
        padding: {
          top: 10,
          bottom: 0,
        },
        min: 0,
        show: true,
        tick: {
          fit: true,
          format: numberFormat,
        },
      },
      y2: {
        label: { text: "impressions", position: "outer-middle" },
        padding: {
          top: 10,
          bottom: 0,
        },
        min: 0,
        show: true,
        tick: {
          fit: true,
          format: (d) => y2Tick(d, chartData),
        },
      },
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

  drawTimeframe();
}

/** Shaded band for the Pages tab's timeframe. */
function drawTimeframe() {
  if (!chart) return;
  chart.regions.remove();
  if (!(settings.from < settings.to)) return;
  try {
    chart.regions.add({
      axis: "x",
      start: settings.from,
      end: settings.to + MS_PER_HOUR,
      class: "regionCut",
      label: {
        text:
          new Date(settings.from).toDateString() === new Date(settings.to).toDateString()
            ? dateWeekdayFormat(settings.from)
            : `${dayFormat(settings.from)} – ${dayFormat(settings.to)}`,
        x: 5,
        y: 4,
      },
    });
  } catch (e) {
    console.error(e.message);
  }
}

function tableButtons(name) {
  return exportButtons(settings, name);
}

function rowStyle(row, index) {
  if (row.incomplete) {
    return {
      classes: "incomplete",
    };
  }
  return {};
}

let datetimeFormat = new Intl.DateTimeFormat("default", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
function dateFormat(value) {
  if (!value) return undefined;

  return datetimeFormat.format(new Date(Number(value)));
}

let dateWeekdayFormatter = new Intl.DateTimeFormat("default", {
  weekday: "long",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function dateWeekdayFormat(value) {
  if (!value) return undefined;

  return dateWeekdayFormatter.format(new Date(value));
}

let hourWeekdayFormat = new Intl.DateTimeFormat("default", {
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
});
function timeWeekdayFormat(value) {
  if (!value) return undefined;

  return hourWeekdayFormat.format(new Date(Number(value)));
}

let hourFormat = new Intl.DateTimeFormat("default", {
  hour: "2-digit",
  minute: "2-digit",
});
function timeFormat(value) {
  if (!value) return undefined;

  return hourFormat.format(new Date(Number(value)));
}

let dateonlyFormat = new Intl.DateTimeFormat("default", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
});
function dayFormat(value) {
  if (!value) return undefined;

  try {
    return dateonlyFormat.format(new Date(Number(value)));
  } catch (e) {
    return "";
  }
}

let dayonlyFormatter = new Intl.DateTimeFormat("default", {
  month: "2-digit",
  day: "2-digit",
});
function dayOnlyFormat(value) {
  if (!value) return undefined;

  try {
    return dayonlyFormatter.format(new Date(Number(value)));
  } catch (e) {
    return "";
  }
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
    field: "id",
    title: "ID",
    sortable: true,
    visible: false,
    searchable: true,
    align: "left",
  },
  {
    field: "page",
    title: "page",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
    formatter: urlFormatter,
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
    title: "first impression",
    formatter: dateFormat,
    sortable: true,
    visible: false,
    searchable: true,
    align: "right",
  },
];

function urlFormatter(value, row) {
  return `${escapeHtml(value)}${pageActionButtons(value, row.id)}`;
}

function rowStylePages(row, index) {
  let classes = ["action-link"];

  return {
    classes: classes.join(" "),
  };
}

async function generatePagesTable() {
  $pagesTable.bootstrapTable({
    buttonsClass: "outline-secondary",
    toolbar: "#pagestable-toolbar",
    uniqueId: "id",
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
    sortOrder: "desc",
    sortName: "clicks",
  });
}

async function generateHoursTable() {
  $hoursTable.bootstrapTable({
    buttonsClass: "outline-secondary",
    toolbar: "#hourstable-toolbar",
    uniqueId: "timestamp",
    classes: "table table-hover",
    rowStyle: rowStyle,
    data: [],
    pageSize: settings.hours,
    showRefresh: false,
    buttons: () => tableButtons("timeline"),
    columns: hoursColumns,
    showColumns: true,
    sortOrder: "desc",
    sortName: "timestamp",
  });
}

function getYesterday() {
  let d = new Date();
  d.setDate(d.getDate() - 1);
  let from = d.setHours(0, 0, 0, 0);
  let to = d.setDate(d.getDate() + 1);
  to = to - 1000 * 60 * 60 * 1;

  return { from, to };
}

function getIdentifier(url) {
  if (!settings.idRegex) return url;
  try {
    const regex = new RegExp(settings.idRegex);
    const match = url.match(regex);
    // Wenn Treffer und Capture Group vorhanden -> nimm Group 1, sonst den vollen Match, sonst URL
    if (match) {
      return match[1] || match[0];
    }
  } catch (e) {
    console.error("Regex Error:", e);
  }
  return url;
}

function reconstructFromId(id) {
  if (!settings.idRegex || !id) return id;

  try {
    // 1. Die erste Capture-Group (alles in Klammern) durch die ID ersetzen
    let pattern = settings.idRegex.replace(/\((.*?)\)/, id);

    // 2. Regex-spezifische Escapes entfernen (z. B. \. wird zu .)
    // Das sorgt dafür, dass aus "([0-9]+)\.html" am Ende "94191247.html" wird
    pattern = pattern.replace(/\\(.)/g, "$1");

    return pattern;
  } catch (e) {
    console.error("Reconstruction error:", e);
    return id;
  }
}

// The API rejects very long filter expressions; stay well below that and batch.
const MAX_REGEX_LENGTH = 3500;

/**
 * Position of the first capturing group "( … )" in a regex source, or null.
 * Skips escapes, character classes and non-capturing/lookaround groups.
 */
function findFirstCaptureGroup(source) {
  const skip = (i) => (source[i] === "\\" ? i + 1 : i);
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i = skip(i); continue; }
    if (inClass) { if (source[i] === "]") inClass = false; continue; }
    if (source[i] === "[") { inClass = true; continue; }
    if (source[i] !== "(" || source[i + 1] === "?") continue;
    let depth = 0;
    let cls = false;
    for (let j = i; j < source.length; j++) {
      const c = source[j];
      if (c === "\\") { j = skip(j); continue; }
      if (cls) { if (c === "]") cls = false; continue; }
      if (c === "[") cls = true;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return { start: i, end: j };
    }
    return null;
  }
  return null;
}

/**
 * INCLUDING_REGEX expressions (each ≤ MAX_REGEX_LENGTH) matching the pages of the
 * given table rows. Rows aggregated by ID substitute the escaped IDs into the ID
 * regex's capture group; all other rows match their exact (escaped) URL.
 */
function firstImpressionPatterns(rows) {
  const group = settings.idRegex ? findFirstCaptureGroup(settings.idRegex) : null;
  const idTerms = new Set();
  const urlTerms = new Set();
  rows.forEach(({ id, page }) => {
    if (group && id !== page) idTerms.add(escapeRegex(id));
    else urlTerms.add(escapeRegex(page));
  });

  const wrapId = (alts) =>
    `${settings.idRegex.slice(0, group.start)}(?:${alts})${settings.idRegex.slice(group.end + 1)}`;
  const wrapUrl = (alts) => `^(?:${alts})$`;

  const patterns = [];
  const batch = (terms, wrap) => {
    if (!terms.size) return;
    const overhead = wrap("").length;
    let current = [];
    let length = overhead;
    for (const term of terms) {
      if (current.length && length + term.length + 1 > MAX_REGEX_LENGTH) {
        patterns.push(wrap(current.join("|")));
        current = [];
        length = overhead;
      }
      current.push(term);
      length += term.length + 1;
    }
    if (current.length) patterns.push(wrap(current.join("|")));
  };
  batch(idTerms, wrapId);
  batch(urlTerms, wrapUrl);
  return patterns;
}

async function getFirstImpressions() {
  const rows = $pagesTable.bootstrapTable("getData", { unfiltered: true });
  if (!rows.length) return;

  const firstImpressions = {};
  try {
    for (const expression of firstImpressionPatterns(rows)) {
      const { rows: data } = await gscQueryAll(settings.siteUrl, settings.auth.token, {
        aggregationType: "AUTO",
        dataState: "HOURLY_ALL",
        type: settings.type,
        rowLimit: 25000,
        startDate: `${new Date(settings.from).getFullYear()}-01-01`,
        endDate: `${new Date(settings.to).getFullYear()}-12-31`,
        dimensions: ["HOUR", "PAGE"],
        dimensionFilterGroups: [
          {
            filters: [
              { dimension: "PAGE", operator: "INCLUDING_REGEX", expression },
            ],
          },
        ],
      });
      data.forEach((d) => {
        const ts = new Date(d.keys[0]).getTime();
        const id = getIdentifier(d.keys[1]);
        if (!firstImpressions[id] || ts < firstImpressions[id]) {
          firstImpressions[id] = ts;
        }
      });
    }
  } catch (err) {
    apiError(err);
    return;
  }

  Object.entries(firstImpressions).forEach(([id, value]) => {
    $pagesTable.bootstrapTable("updateCellByUniqueId", {
      id,
      field: "timestamp",
      value,
    });
  });
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
  const fallback = getYesterday();
  settings.from = parseTimestamp(params.get("from")) ?? fallback.from;
  settings.to = parseTimestamp(params.get("to")) ?? fallback.to;
  $("#from").val(getLocalISOStringSlice(settings.from));
  $("#to").val(getLocalISOStringSlice(settings.to));
  $("#from, #to").removeClass("is-invalid");
  reloadAll();
}

function clearAll() {
  clearChart();
  $pagesTable.bootstrapTable("removeAll");
  $hoursTable.bootstrapTable("removeAll");
}

const floorHour = (ts) => {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

/** Sets the Pages tab timeframe (ms timestamps, hour starts) and reloads pages. */
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
  $pagesTable.bootstrapTable("removeAll");
  drawTimeframe();
  if (!valid) {
    showNotice("“From” must be before “to”", 3000);
    return;
  }
  getPages();
}

/** Quick ranges for the hourly window (Google keeps ~10 days of hourly data). */
function hourPresets() {
  const startOfDay = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const now = () => floorHour(Date.now());
  return [
    { label: "Today", range: () => ({ from: startOfDay(0), to: now() }) },
    { label: "Yesterday", range: () => getYesterday() },
    { label: "Last 24 hours", range: () => ({ from: now() - 24 * MS_PER_HOUR, to: now() }) },
    { label: "Last 3 days", range: () => ({ from: startOfDay(2), to: now() }) },
    { label: "Last 7 days", range: () => ({ from: startOfDay(6), to: now() }) },
  ];
}

async function init() {
  // Auth (and with it the first data load) waits for the ID regex so page
  // aggregation never runs with a stale/empty setting.
  chrome.storage.sync.get({ idRegex: "" }, (items) => {
    settings.idRegex = items.idRegex;
    initAuth(settings, { onSignIn: loadAll, onSignOut: clearAll });
  });

  showProperty(settings.siteUrl);
  $("#type").val(settings.type);

  let yesterday = getYesterday();
  if (!settings.from) {
    settings.from = yesterday.from;
  }
  if (!settings.to) {
    settings.to = yesterday.to;
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
      //console.info("No property selected");
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

  // Rows aggregated by ID filter on the ID (rebuilt into a URL fragment from the ID
  // regex); other rows filter on their exact URL.
  initPageFilterActions((url, id) => {
    const fragment = id && id !== url ? reconstructFromId(id) : url;
    setPageFilter(pageFilterFor(url, fragment));
  });

  initHistory(syncFromUrl);

  initPropertyPicker();

  initClipboardIcons();
  initViewSwitcher();
  initKeyboardShortcuts();

}
init();
