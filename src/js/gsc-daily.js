import bb, { grid, line, regions } from "billboard.js";
import {
  $,
  bootstrap,
  MS_PER_DAY,
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
  from:
    currentURL.searchParams.get("from") ||
    `${new Date().getFullYear()}-01-01`,
  to:
    currentURL.searchParams.get("to") || new Date().toISOString().slice(0, 10),
  auth: {
    token: null,
  },
  siteUrl: currentURL.searchParams.get("property") || null,
  page: currentURL.searchParams.get("page") || null,
  groupBy: currentURL.searchParams.get("groupBy") || "day",
  dataState: currentURL.searchParams.get("dataState") || "ALL",
};


let noticeTimer;
const pageFilterModal = new bootstrap.Modal("#pageFilterModal", {});

let chart;

let $hoursTable = $("#hourstable");
let $pagesTable = $("#pagestable");
let $eventsTable = $("#eventstable");

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
    dataState: "FINAL",
    type: settings.type,
    rowLimit: 10000,
    startDate: settings.from,
    endDate: settings.to,
    startRow: 0,
    dimensions: ["PAGE"],
    dimensionFilterGroups: [{ filters: assemblePageFilters(settings.page) }],
  };

  try {
    const data = await gscQuery(settings.siteUrl, settings.auth.token, requestBody);

    const pages = (data.rows ?? []).map((d) => {
      return {
        page: d?.keys?.[0],
        clicks: d?.clicks,
        impressions: d?.impressions,
        ctr: d?.ctr,
      };
    });

    $pagesTable.bootstrapTable("load", pages).bootstrapTable("hideLoading");
  } catch (err) {
    apiError(err);
  } finally {
    $pagesTable.bootstrapTable("hideLoading");
  }
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
    dimensions: ["DATE"],
    searchType: settings.type,
    rowLimit: 10000,
    dataState: settings.dataState,
    startDate: settings.from,
    endDate: settings.to,
    dimensionFilterGroups: [{ filters: assemblePageFilters(settings.page) }],
  };

  try {
    const data = await gscQuery(settings.siteUrl, settings.auth.token, requestBody);

    const {
      timeline: monthlyTL,
      chartData: monthlyCD,
      firstIncompleteHour: firstIncompleteHour,
    } = transformData(data, settings.groupBy);

    $hoursTable.bootstrapTable("load", monthlyTL).bootstrapTable("hideLoading");

    if (!data.rows?.length) {
      clearChart();
      showChartState("noData");
      return;
    }
    drawChart(monthlyCD);
    showChartState(null);
  } catch (err) {
    showChartState("error");
    apiError(err);
  } finally {
    $hoursTable.bootstrapTable("hideLoading");
  }
}

/**
 * Transform API response rows into daily or monthly aggregates.
 *
 * @param {object} data       - The parsed JSON from your fetch.
 * @param {'day'|'month'} [groupBy='day'] - Whether to group by day or by month.
 * @returns {{
 *   timeline: Array<{
 *     timestamp: string,  // "YYYY-MM-DD" for day, "YYYY-MM-01" for month
 *     year: string,       // 4-digit year
 *     month: string,      // 2-digit month
 *     day?: string,       // 2-digit day (only for day granularity)
 *     clicks: number,
 *     impressions: number,
 *     ctr: number
 *   }>,
 *   chartData: {
 *     timeseries: number[],    // [ 'x', ms, … ]
 *     clicks: number[],        // [ 'clicks', … ]
 *     impressions: number[],   // [ 'impressions', … ]
 *     ctr: number[]            // [ 'ctr', … ]
 *   }
 * }}
 */
function transformData(data, groupBy = "day") {
  // Initialize containers
  const chartData = {
    timeseries: ["x"],
    clicks: ["clicks"],
    impressions: ["impressions"],
    ctr: ["ctr"],
    incompleteClicks: ["incomplete clicks"],
    incompleteImpressions: ["incomplete impressions"],
    incompleteCtr: ["incomplete ctr"],
  };

  let firstIncompleteHour = Infinity;

  let timeline = [];

  if (groupBy === "day") {
    if (data?.metadata?.firstIncompleteDate) {
      firstIncompleteHour = new Date(
        data.metadata.firstIncompleteDate,
      ).getTime();
    }
    timeline = (data.rows ?? []).map((d) => {
      const timestamp = new Date(d.keys[0]).getTime();
      const dt = new Date(d.keys[0]);
      const yyyy = dt.toISOString().slice(0, 4);
      const mm = dt.toISOString().slice(5, 7);
      const dd = dt.toISOString().slice(8, 10);
      chartData.timeseries.push(dt.getTime());
      chartData.clicks.push(d.clicks);
      chartData.impressions.push(d.impressions);
      chartData.ctr.push(d.ctr);
      return {
        timestamp: `${yyyy}-${mm}-${dd}`,
        year: yyyy,
        month: mm,
        day: dd,
        clicks: d.clicks,
        impressions: d.impressions,
        ctr: d.ctr,
        incomplete: timestamp >= firstIncompleteHour,
      };
    });
  } else if (groupBy === "month") {
    if (data?.metadata?.firstIncompleteDate) {
      firstIncompleteHour = new Date(
        data.metadata.firstIncompleteDate.slice(0, 7),
      ).getTime();
    }
    const monthMap = new Map();
    (data.rows ?? []).forEach((d) => {
      const dt = new Date(d.keys[0]);
      const yyyy = dt.getUTCFullYear().toString();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const key = `${yyyy}-${mm}`;
      if (!monthMap.has(key)) {
        monthMap.set(key, { clicks: 0, impressions: 0 });
      }
      const agg = monthMap.get(key);
      agg.clicks += d.clicks;
      agg.impressions += d.impressions;
    });

    // Sort months chronologically
    const sortedKeys = Array.from(monthMap.keys()).sort(
      (a, b) => new Date(a + "-01") - new Date(b + "-01"),
    );

    // Build timeline & chartData
    sortedKeys.forEach((key) => {
      const timestamp = new Date(key).getTime();

      const [yyyy, mm] = key.split("-");
      const { clicks, impressions } = monthMap.get(key);
      const ctr = impressions > 0 ? clicks / impressions : 0;
      const dtForMs = new Date(`${key}-01`);
      chartData.timeseries.push(dtForMs.getTime());
      chartData.clicks.push(clicks);
      chartData.impressions.push(impressions);
      chartData.ctr.push(ctr);

      timeline.push({
        timestamp: `${key}-01`,
        year: yyyy,
        month: mm,
        clicks,
        impressions,
        ctr,
        incomplete: timestamp >= firstIncompleteHour,
      });
    });
  } else {
    throw new Error(`Unknown groupBy value: ${groupBy}`);
  }

  return { timeline, chartData, firstIncompleteHour };
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

function drawChart(chartData) {
  let columns = [];
  const tokens = chartColors();
  let colors = {
    clicks: tokens.clicks,
    impressions: tokens.impressions,
    ctr: tokens.ctr,
  };

  columns.push(chartData.timeseries);
  columns.push(chartData.clicks);
  columns.push(chartData.impressions);

  clearChart();
  chart = bb.generate({
    point: {
      show: false,
    },
    padding: {
      left: 75,
      right: 85,
    },
    data: {
      x: "x",
      columns: columns,
      colors: colors,
      order: "desc",
      type: line(),
      axes: {
        clicks: "y",
        impressions: "y2",
      },
      hide: ["impressions", "ctr"],
    },
    tooltip: {
      format: {
        value: function (value, ratio, id, index) {
          return numberFormat(value);
        },
        title: function (x) {
          if (settings.groupBy == "day") {
            return new Date(x).toISOString().slice(0, 10);
          }
          return new Date(x).toISOString().slice(0, 7);
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
          format: numberFormat,
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
          format: settings.groupBy == "day" ? "%Y-%m-%d" : "%Y-%m",
        },
      },
    },
  });
  getEvents();
}

function tableButtons(name) {
  return exportButtons(settings, name);
}

function eventsTableButtons() {
  return {
    ...exportButtons(settings, "events"),
    btnRemove: {
      text: "Remove selected events",
      icon: "bi-trash",
      event: function () {
        let rows = $eventsTable.bootstrapTable("getSelections");
        if (!rows.length) return;
        let ids = rows.map((row) => row.id);
        $eventsTable.bootstrapTable("remove", {
          field: "id",
          values: ids,
        });

        chart.xgrids.remove();
        chart.regions.remove();

        setTimeout(function () {
          chart.flush();
        }, 1000);
        saveEvents();
        updateRemoveButton();
        showNotice(rows.length === 1 ? "Event removed" : `${rows.length} events removed`);
      },
      attributes: {
        title: "Remove the ticked events",
        "aria-label": "Remove the ticked events",
        disabled: "disabled",
      },
    },
  };
}

let hoursColumns = [
  {
    field: "timestamp",
    title: "timestamp",
    sortable: true,
    visible: false,
    searchable: false,
    align: "right",
  },
  {
    field: "year",
    title: "year",
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "month",
    title: "month",
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "day",
    title: "day",
    sortable: true,
    visible: settings.groupBy == "day",
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
    field: "page",
    title: "page",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
    formatter: (value) => `${escapeHtml(value)}${pageActionButtons(value)}`,
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
];

let eventsColumns = [
  {
    field: "state",
    checkbox: true,
  },
  {
    field: "from",
    title: "from",
    sortable: true,
    visible: true,
    searchable: true,
    align: "left",
  },
  {
    field: "to",
    title: "to",
    sortable: true,
    visible: true,
    searchable: true,
    align: "left",
  },
  {
    field: "title",
    title: "title",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
  },
  {
    field: "category",
    title: "category",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
  },
  {
    field: "property",
    title: "applies to",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
    formatter: (value) => (value === "all" ? "all properties" : escapeHtml(value)),
    suppressFormatterExport: true,
  },
];

let dtf = new Intl.DateTimeFormat("default", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
});

function dateFormat(value) {
  if (!value) return undefined;

  return dtf.format(new Date(Number(value)));
}

async function generateEventsTable() {
  $eventsTable.bootstrapTable({
    buttonsClass: "outline-secondary",
    toolbar: "#eventstable-toolbar",
    multipleSelectRow: true,
    clickToSelect: true,
    classes: "table table-hover",
    data: [],
    pageList: [10, 100, "all"],
    pageSize: 100,
    pagination: true,
    showRefresh: false,
    buttons: eventsTableButtons,
    search: true,
    columns: eventsColumns,
    showColumns: true,
    onCheckSome: checkSomeEvents,
    onCheck: checkEvent,
    onCheckAll: checkAllEvents,
    onUncheckSome: unCheckSomeEvents,
    onUncheck: unCheckEvent,
    onUncheckAll: unCheckAllEvents,
    sortOrder: "desc",
    sortName: "from",
    formatNoMatches: () =>
      "No events yet — add one above, or import Google updates on the Options page.",
  });
  $eventsTable.on(
    "check.bs.table uncheck.bs.table check-all.bs.table uncheck-all.bs.table check-some.bs.table uncheck-some.bs.table post-body.bs.table",
    updateRemoveButton,
  );
}

function updateRemoveButton() {
  const n = $eventsTable.bootstrapTable("getSelections").length;
  $('#eventsTab button[name="btnRemove"]').prop("disabled", n === 0);
}
function unCheckEvent(row, $element) {
  unCheckSomeEvents([row]);
}
function unCheckSomeEvents(rows) {
  processEvents(rows, false);
}
function unCheckAllEvents(rowsAfter, rowsBefore) {
  processEvents(rowsBefore, false);
}
function checkEvent(row, $element) {
  checkSomeEvents([row]);
}
function checkSomeEvents(rows) {
  processEvents(rows, true);
}
function checkAllEvents(rowsAfter, rowsBefore) {
  processEvents(rowsAfter, true);
}
function processEvents(rows, checked) {
  const css = getComputedStyle(document.documentElement);
  let gridColor = css
    .getPropertyValue(checked ? "--sa-event-highlight" : "--sa-event-muted")
    .trim();
  rows.forEach((row) => {
    let index;
    if (!row.to || row.from == row.to) {
      index = chart.xgrids().findIndex((item) => item.id === row.id);
      $($(".bb-xgrid-line line")[index]).css("stroke", gridColor);
      $($(".bb-xgrid-line text")[index]).css("fill", gridColor);
    } else {
      index = chart.regions().findIndex((item) => item.id === row.id);
      $($(".bb-region")[index]).css("fill", gridColor);
      $($(".bb-region text")[index]).css("fill", gridColor);
    }
  });
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
    rowStyle: () => ({ classes: "action-link" }),
    showColumns: true,
    sortOrder: "desc",
    sortName: "clicks",
  });
}

function rowStyle(row, index) {
  if (row.incomplete) {
    return {
      classes: "incomplete",
    };
  }
  return {};
}

async function generateHoursTable() {
  $hoursTable.bootstrapTable({
    buttonsClass: "outline-secondary",
    toolbar: "#hourstable-toolbar",
    uniqueId: "timestamp",
    classes: "table table-hover",
    data: [],
    pageSize: settings.hours,
    rowStyle: rowStyle,
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

async function saveEvents() {
  let rows = $eventsTable.bootstrapTable("getData", {
    includeHiddenRows: true,
    unfiltered: true,
    formatted: false,
  });
  let data = Array.isArray(rows) ? rows : [rows];
  chrome.storage.local.set({ events: data }, () => {
    console.info("events saved");
  });
  addEvents(data);
}

async function getEvents() {
  chrome.storage.local.get(["events"], (result) => {
    if (!result.events) {
      console.debug("no events found");
      return;
    }
    $eventsTable.bootstrapTable("load", result.events);
    addEvents(result.events);
  });
}

function addEvents(rows) {
  if (!chart) {
    return;
  }
  rows
    .filter((row) => row.property == "all" || row.property == settings.siteUrl)
    .filter((row) => {
      if (!settings.from || !settings.to) return true;
      const eventEnd = row.to && row.to !== row.from ? row.to : row.from;
      return row.from <= settings.to && eventEnd >= settings.from;
    })
    .forEach((row) => {
      if (!row.to || row.from == row.to) {
        chart.xgrids.add({ value: row.from, text: row.title, id: row.id });
      } else {
        chart.regions.add({
          axis: "x",
          start: row.from,
          end: row.to,
          class: "regionCut",
          id: row.id,
          label: {
            text: row.title,
            x: 0,
            y: 4,
            rotated: true,
          },
        });
      }
    });
}

function loadAll() {
  listSites();
  getTimeline();
  getPages();
}

function showDayColumn() {
  $hoursTable.bootstrapTable(settings.groupBy == "day" ? "showColumn" : "hideColumn", "day");
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

/** Back/forward: take the whole state from the URL again (defaults as in `settings`). */
function syncFromUrl(params) {
  readSharedUrlState(settings, params);
  settings.from = params.get("from") || `${new Date().getFullYear()}-01-01`;
  settings.to = params.get("to") || new Date().toISOString().slice(0, 10);
  settings.groupBy = params.get("groupBy") || "day";
  settings.dataState = params.get("dataState") || "ALL";
  $("#from").val(settings.from);
  $("#to").val(settings.to);
  $("#from, #to").removeClass("is-invalid");
  $("#groupBy").val(settings.groupBy);
  showDayColumn();
  reloadAll();
}

function clearAll() {
  clearChart();
  $pagesTable.bootstrapTable("removeAll");
  $hoursTable.bootstrapTable("removeAll");
}

const isoDay = (d) => getLocalISOStringSlice(d).slice(0, 10);

/** Sets the timeframe (YYYY-MM-DD strings) and reloads chart and tables. */
function applyRange({ from, to }) {
  $("#from").val(from);
  $("#to").val(to);
  const valid = from <= to;
  $("#from, #to").toggleClass("is-invalid", !valid);
  if (!valid) {
    showNotice("“From” must be on or before “to”", 3000);
    return;
  }
  if (settings.from === from && settings.to === to) return;
  settings.from = from;
  settings.to = to;
  addFilters({ from, to });

  clearChart();
  $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  getTimeline();
  getPages();
}

/** Quick ranges; Search Console keeps 16 months of daily data. */
function dayPresets() {
  const ago = ({ days = 0, months = 0 }) => {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    d.setDate(d.getDate() - days);
    return isoDay(d);
  };
  const today = () => isoDay(new Date());
  return [
    { label: "Last 7 days", range: () => ({ from: ago({ days: 6 }), to: today() }) },
    { label: "Last 28 days", range: () => ({ from: ago({ days: 27 }), to: today() }) },
    { label: "Last 3 months", range: () => ({ from: ago({ months: 3 }), to: today() }) },
    { label: "This year", range: () => ({ from: `${new Date().getFullYear()}-01-01`, to: today() }) },
    { label: "Last 12 months", range: () => ({ from: ago({ months: 12 }), to: today() }) },
    { label: "Last 16 months (maximum)", range: () => ({ from: ago({ months: 16 }), to: today() }) },
  ];
}

async function init() {
  initAuth(settings, { onSignIn: loadAll, onSignOut: clearAll });

  showProperty(settings.siteUrl);
  $("#type").val(settings.type);
  $("#groupBy").val(settings.groupBy);

  $("#from").val(settings.from);
  $("#to").val(settings.to);
  $("#from, #to").on("change", function () {
    const value = $(this).val();
    if (!value) return;
    applyRange({ ...settings, [this.id]: value });
  });
  initRangePresets(dayPresets(), applyRange);

  generateHoursTable();
  generatePagesTable();
  generateEventsTable();

  initTabs();

  $("#type").on("change", function () {
    let type = $(this).val();
    settings.type = type;
    addFilter("type", type);
    getTimeline();
    getPages();
  });
  $("#groupBy").on("change", function () {
    clearChart();
    $hoursTable.bootstrapTable("removeAll");

    let groupBy = $(this).val();
    settings.groupBy = groupBy;
    addFilter("groupBy", groupBy);
    getTimeline();
    showDayColumn();
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

  syncPageFilterUi(settings.page);

  initPageFilterModal(function () {
    const value = $("#floatingPageFilterInput").val();
    setPageFilter(value ? `${$("#urlFilterMode").val()}${value}` : null);
  });
  initPageFilterActions((url) => setPageFilter(pageFilterFor(url)));
  initClipboardIcons();
  initHistory(syncFromUrl);

  getEvents();

  $("#eventForm").on("input change", ".is-invalid", function () {
    $(this).removeClass("is-invalid");
  });
  $("#eventForm").on("submit", function (e) {
    e.preventDefault();
    let eventDateFrom = $("#event-date-from").val();
    let eventDateTo = $("#event-date-to").val();
    let eventTitle = $("#event-title").val()?.trim();
    const invalid = {
      "#event-date-from": !eventDateFrom,
      "#event-date-to": Boolean(eventDateTo && eventDateFrom && eventDateTo < eventDateFrom),
      "#event-title": !eventTitle,
    };
    Object.entries(invalid).forEach(([sel, bad]) => $(sel).toggleClass("is-invalid", bad));
    const firstInvalid = Object.keys(invalid).find((sel) => invalid[sel]);
    if (firstInvalid) {
      $(firstInvalid).trigger("focus");
      return;
    }
    let eventId = crypto.randomUUID();
    let eventCategory = $("#event-category").val()?.trim();
    let eventPropertySelection = $("#event-property").val()?.trim();
    let eventProperty =
      eventPropertySelection == "this"
        ? settings.siteUrl
        : eventPropertySelection;
    $eventsTable.bootstrapTable("append", [
      {
        id: eventId,
        from: eventDateFrom,
        to: eventDateTo,
        title: eventTitle,
        category: eventCategory,
        property: eventProperty,
      },
    ]);
    saveEvents();
    $("#event-date-to, #event-title, #event-category").val("");
    $("#event-title").trigger("focus");
    showNotice(`Event “${eventTitle}” added`);
  });

  initPropertyPicker();
  initViewSwitcher();
  initKeyboardShortcuts();
}
init();
