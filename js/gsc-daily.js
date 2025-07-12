let currentURL = new URL(document.location);

let settings = {
  properties: [],
  type: currentURL.searchParams.get("type") || "discover",
  from:
    currentURL.searchParams.get("from") ||
    new Date(new Date().getTime() - 24 * 60 * 60 * 1000 * 30)
      .toISOString()
      .slice(0, 10),
  to:
    currentURL.searchParams.get("to") || new Date().toISOString().slice(0, 10),
  auth: {
    token: null,
  },
  siteUrl: currentURL.searchParams.get("property") || null,
  page: currentURL.searchParams.get("page") || null,
  groupBy: currentURL.searchParams.get("groupBy") || "month",
};

const authorizeButton = document.getElementById("authorize_button");
const signoutButton = document.getElementById("signout_button");
const pageFilterModal = new bootstrap.Modal("#pageFilterModal", {});

let tokenClient;
let gapiInited = false;
let gisInited = false;

let chart;

let $hoursTable = $("#hourstable");
let $pagesTable = $("#pagestable");
let $eventsTable = $("#eventstable");
let $tabs = $(".tab");

authorizeButton.onclick = function handleAuthClick() {
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError || !token) {
      console.error(
        "Could not get auth token:",
        chrome.runtime.lastError.message,
      );
      return;
    }
    $("#auth_dropdown")
      .removeClass("btn-outline-primary")
      .removeClass("btn-outline-danger")
      .addClass("btn-outline-success");
    settings.auth.token = token;
    listSites();
  });
};

signoutButton.onclick = function handleSignoutClick() {
  chrome.identity.clearAllCachedAuthTokens(() => {
    console.info("Signed out");
    clearChart();
    $pagesTable.bootstrapTable("removeAll");
    $hoursTable.bootstrapTable("removeAll");
    $("#properties-list").empty();
    $("#auth_dropdown")
      .removeClass("btn-outline-primary")
      .removeClass("btn-outline-success")
      .addClass("btn-outline-danger");
  });
};

async function listSites() {
  if (!settings.auth.token) {
    console.error("No auth token");
    return;
  }
  try {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${settings.auth.token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error(`Error: ${error.error.message}`);
      return;
    }

    const data = await response.json();

    settings.properties = [];
    let selectsHTML = data?.siteEntry
      ?.map((entry) => {
        return entry.siteUrl.replace("sc-domain:", "sc-domain://");
      })
      ?.sort((a, b) => {
        try {
          const urlA = new URL(a);
          const urlB = new URL(b);

          const hostA = urlA.host.split(".").reverse().join(".");
          const hostB = urlB.host.split(".").reverse().join(".");

          if (hostA < hostB) return -1;
          if (hostA > hostB) return 1;

          const pathA = urlA.pathname.toLowerCase();
          const pathB = urlB.pathname.toLowerCase();

          if (pathA < pathB) return -1;
          if (pathA > pathB) return 1;

          return 0;
        } catch (e) {
          console.error("Invalid URL", a, b);
          return 0;
        }
      })
      ?.map((data) => {
        let property = data.replace("sc-domain://", "sc-domain:");
        if (settings.property == property) {
          $("#property").val(settings.property);
          getTimeline(settings.property);
        }
        settings.properties.push(property);
        return `<option value="${property}"></option>`;
      })
      .join("\n");

    $("#properties-list").html(selectsHTML);
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

$("#fetch").on("click", function () {
  clearChart();
  $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

  settings.siteUrl = $("#property").val().trim();
  if (!settings.siteUrl) {
    return;
  }
  getTimeline();
  getPages();
});

async function getPages() {
  $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

  if (!settings.from && !settings.to) {
    console.error("timeframe not selected");
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
    dimensionFilterGroups: [{ filters: assemblePageFilters() }],
  };

  try {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(settings.siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error(`Error: ${error.error.message}`);
      return;
    }

    const data = await response.json();

    const pages = data.rows.map((d) => {
      return {
        page: d?.keys?.[0],
        clicks: d?.clicks,
        impressions: d?.impressions,
        ctr: d?.ctr,
      };
    });

    $pagesTable.bootstrapTable("load", pages).bootstrapTable("hideLoading");
  } catch (err) {
    console.error(`Error: ${err.message}`);
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
    ctr: entry.ctrSum / entry.count,
  }));
}

async function getTimeline() {
  $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
  const requestBody = {
    aggregationType: "AUTO",
    startRow: 0,
    dimensions: ["DATE"],
    searchType: settings.type,
    rowLimit: 10000,
    dataState: "FINAL",
    startDate: settings.from,
    endDate: settings.to,
    dimensionFilterGroups: [{ filters: assemblePageFilters() }],
  };

  try {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(settings.siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!response.ok) {
      if (response.status == 401) {
        console.error(`Unauthorized`);
        clearChart();
        $pagesTable.bootstrapTable("removeAll");
        $hoursTable.bootstrapTable("removeAll");
        $("#properties-list").empty();
        $("#auth_dropdown")
          .removeClass("btn-outline-primary")
          .removeClass("btn-outline-success")
          .addClass("btn-outline-danger");
        return;
      }
      const error = await response.json();
      console.error(`Error: ${error.error.message}`);
      return;
    }

    const data = await response.json();

    const { timeline: monthlyTL, chartData: monthlyCD } = transformData(
      data,
      (groupBy = settings.groupBy),
    );

    $hoursTable.bootstrapTable("load", monthlyTL).bootstrapTable("hideLoading");

    drawChart(monthlyCD);
  } catch (err) {
    console.error(`Error: ${err.message}`);
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
  };

  let timeline = [];

  if (groupBy === "day") {
    timeline = data.rows.map((d) => {
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
      };
    });
  } else if (groupBy === "month") {
    const monthMap = new Map();
    data.rows.forEach((d) => {
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
      });
    });
  } else {
    throw new Error(`Unknown groupBy value: ${groupBy}`);
  }

  return { timeline, chartData };
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
  let colors = {
    clicks: "#4285f4",
    impressions: "#5e35b1",
    ctr: "#00897b",
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
      left: 70,
      right: 70,
    },
    data: {
      x: "x",
      columns: columns,
      colors: colors,
      order: "desc",
      type: "line",
      axes: {
        clicks: "y",
        impressions: "y2",
      },
      hide: ["impressions", "ctr"],
    },
    tooltip: {
      format: {
        value: function (value, ratio, id, index) {
          return parseFloat(value).toLocaleString();
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
        label: "clicks",
        padding: {
          top: 0,
          bottom: 0,
        },
        min: 0,
        show: document.body.clientWidth > 767,
        tick: {
          fit: true,
          format: function (d) {
            return d.toLocaleString();
          },
        },
      },
      y2: {
        label: "impressions",
        padding: {
          top: 0,
          bottom: 0,
        },
        min: 0,
        show: document.body.clientWidth > 767,
        tick: {
          fit: true,
          format: function (d) {
            return d.toLocaleString();
          },
        },
      },
      x: {
        label: settings.groupBy == "day" ? "by day" : "by month",
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

async function setClipboard(text) {
  const type = "text/plain";
  const blob = new Blob([text], { type });
  const data = [new ClipboardItem({ [type]: blob })];
  await navigator.clipboard.write(data);
}

function getNestedProperty(obj, path) {
  return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

// Function to filter selections based on visible columns and use column titles in the output
function filterVisibleColumns(selections, columns) {
  // Create a mapping of field paths to titles for visible columns
  const columnMap = columns
    .filter((column) => column.visible)
    .reduce((map, column) => {
      map[column.field] = column.title;
      return map;
    }, {});

  // Filter each selection to include only data from visible columns
  const filteredSelections = selections.map((selection) => {
    const filteredData = {};
    Object.keys(columnMap).forEach((field) => {
      const value = getNestedProperty(selection, field);
      if (value !== undefined) {
        // Use the title as the key in the output object
        filteredData[columnMap[field]] = value;
      }
    });
    return filteredData;
  });

  return filteredSelections;
}

function getGSheetClipboard(table) {
  let filteredSelections = filterVisibleColumns(table.data, table.columns);
  let formatters = [];
  let output = table.columns
    .map((col) => {
      formatters.push(col.formatter);
      if (col.visible) {
        return col.title;
      }
    })
    .filter((col) => col)
    .join("\t");
  output += "\n";
  output += filteredSelections
    .map((col) => {
      return Object.values(col)
        .map((data, index) => {
          let formatter = formatters[index];
          if (!formatter) {
            return data;
          }
          return formatter(data);
        })
        .join("\t");
    })
    .join("\n");
  return output;
}

function tableButtons() {
  return {
    btnGSheetClipboard: {
      text: "sheets clipboard",
      icon: "bi-file-spreadsheet",
      event: function () {
        let text = getGSheetClipboard(this);
        setClipboard(text);
      },
      attributes: {
        title: "copy selected rows for google sheets",
      },
    },
  };
}

function eventsTableButtons() {
  return {
    btnGSheetClipboard: {
      text: "sheets clipboard",
      icon: "bi-file-spreadsheet",
      event: function () {
        let text = getGSheetClipboard(this);
        setClipboard(text);
      },
      attributes: {
        title: "copy selected rows for google sheets",
      },
    },
    btnRemove: {
      text: "remove events",
      icon: "bi-trash",
      event: function () {
        let rows = $eventsTable.bootstrapTable("getSelections");
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
      },
      attributes: {
        title: "delete selected events",
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
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "impressions",
    title: "impressions",
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

let pagesColumns = [
  {
    field: "page",
    title: "page",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
  },
  {
    field: "clicks",
    title: "clicks",
    sortable: true,
    visible: true,
    searchable: false,
    align: "right",
  },
  {
    field: "impressions",
    title: "impressions",
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
    title: "property",
    sortable: false,
    visible: true,
    searchable: true,
    align: "left",
  },
];

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

function toLocaleString(value) {
  if (!value) return "";
  let d = new Date(Number(value));
  return d.toLocaleString();
}

function getLocalISOStringSlice(ts) {
  const now = new Date(ts);
  const offset = now.getTimezoneOffset(); // in minutes
  const localTime = new Date(now.getTime() - offset * 60000);
  return localTime.toISOString().slice(0, 16);
}

function ctrFormat(value) {
  if (!value) return 0;

  return `${(value * 100).toPrecision(2)}%`;
}

function sanitizeFilename(input) {
  const illegalRe = /[\\\/:*?"<>|\x00-\x1F]/g;
  return input.replace(illegalRe, "_");
}

function generateFilename(name) {
  return `${sanitizeFilename(settings.siteUrl)}-${sanitizeFilename(settings.type)}-${sanitizeFilename(toLocaleString(settings.from))}-${sanitizeFilename(toLocaleString(settings.to))}-${name}`;
}

async function generateEventsTable() {
  $eventsTable.bootstrapTable({
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
    exportTypes: ["csv"],
    showExport: true,
    exportOptions: {
      fileName: function () {
        return generateFilename("events");
      },
    },
    onCheckSome: checkSomeEvents,
    onCheck: checkEvent,
    onCheckAll: checkAllEvents,
    onUncheckSome: unCheckSomeEvents,
    onUncheck: unCheckEvent,
    onUncheckAll: unCheckAllEvents,
    sortOrder: "desc",
    sortName: "from",
  });
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
  let gridColor = checked ? "#e20074" : "#aaaaaa";
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
    toolbar: "#pagestable-toolbar",
    uniqueId: "page",
    classes: "table table-hover",
    data: [],
    pageList: [10, 100, "all"],
    pageSize: 100,
    pagination: true,
    showRefresh: false,
    buttons: tableButtons,
    search: true,
    columns: pagesColumns,
    showColumns: true,
    exportTypes: ["csv"],
    showExport: true,
    exportOptions: {
      fileName: function () {
        return generateFilename("pages");
      },
    },
    sortOrder: "desc",
    sortName: "clicks",
  });
}

async function generateHoursTable() {
  $hoursTable.bootstrapTable({
    toolbar: "#hourstable-toolbar",
    uniqueId: "timestamp",
    classes: "table table-hover",
    data: [],
    pageSize: settings.hours,
    showRefresh: false,
    buttons: tableButtons,
    columns: hoursColumns,
    showColumns: true,
    exportTypes: ["csv"],
    showExport: true,
    exportOptions: {
      fileName: function () {
        return generateFilename("timeline");
      },
    },
    sortOrder: "asc",
    sortName: "timestamp",
  });
}

function addFilter(name, value) {
  let u = new URL(document.location.href);
  if (u.searchParams.has(name)) {
    u.searchParams.set(name, value);
  } else {
    u.searchParams.append(name, value);
  }
  history.pushState(null, null, u.search);
  currentURL = new URL(document.location);
}
function removeFilter(name) {
  let u = new URL(document.location.href);
  u.searchParams.delete(name);
  if (u.search) {
    history.pushState(null, null, u.search);
  } else {
    history.pushState(
      null,
      null,
      document.location.origin + document.location.pathname,
    );
  }
  currentURL = new URL(document.location);
}

function getYesterday() {
  let d = new Date();
  d.setDate(d.getDate() - 1);
  let from = d.setHours(0, 0, 0, 0);
  let to = d.setDate(d.getDate() + 1);
  to = to - 1000 * 60 * 60 * 1;

  return { from, to };
}

async function checkAuth() {
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (chrome.runtime.lastError || !token) {
      console.error(
        "Could not get auth token:",
        chrome.runtime.lastError.message,
      );
      return;
    }
    $("#auth_dropdown")
      .removeClass("btn-outline-primary")
      .removeClass("btn-outline-danger")
      .addClass("btn-outline-success");
    settings.auth.token = token;
    listSites();
    if (settings.siteUrl) {
      getTimeline();
      getPages();
    }
  });
}

let dimensionsFilterOperators = {
  "*": "contains",
  "-": "notContains",
  "=": "equals",
  "!": "notEquals",
  "~": "includingRegex",
  _: "excludingRegex",
};
function assemblePageFilters() {
  if (!settings.page) {
    return [];
  }
  if (settings.page.length < 2) {
    return [];
  }
  let operator = dimensionsFilterOperators[settings.page[0]];
  let dimension = "page";
  let expression = settings.page.slice(1);

  return [{ dimension, operator, expression }];
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
      console.error("no events found");
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

async function init() {
  checkAuth();

  $("#property").attr("placeholder", settings.siteUrl);
  $("#type").val(settings.type);
  $("#groupBy").val(settings.groupBy);

  $("#from").val(settings.from);
  $("#to").val(settings.to);
  $("#from").on("blur", function () {
    let from = $(this).val();
    if (settings.from == from) {
      return;
    }
    settings.from = from;
    addFilter("from", settings.from);

    clearChart();
    $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
    $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

    getTimeline();
    getPages();
  });

  $("#to").on("blur", function () {
    let to = $(this).val();
    if (settings.to == to) {
      return;
    }
    settings.to = to;
    addFilter("to", settings.to);

    clearChart();
    $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
    $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

    getTimeline();
    getPages();
  });

  generateHoursTable();
  generatePagesTable();
  generateEventsTable();

  $(".nav-tabs").on("click", ".nav-item", function (e) {
    e.preventDefault(); // Prevent the default link behavior

    let id = $(this).data("id");
    $tabs.removeClass("visible").addClass("invisible d-none");
    $(`#${id}Tab`).removeClass("invisible d-none").addClass("visible");

    // Remove 'active' from all nav links in the same nav-tabs container
    $(this)
      .closest(".nav-tabs")
      .find(".nav-link")
      .removeClass("active text-primary")
      .addClass("text-secondary");

    // Add 'active' to the clicked nav-item's nav-link
    $(this)
      .find(".nav-link")
      .removeClass("text-secondary")
      .addClass("active text-primary");
  });

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

    if (settings.groupBy == "day") {
      $hoursTable.bootstrapTable("showColumn", "day");
    } else {
      $hoursTable.bootstrapTable("hideColumn", "day");
    }
  });

  $("#property").on("change", function () {
    clearChart();
    $pagesTable.bootstrapTable("removeAll");
    $hoursTable.bootstrapTable("removeAll");

    let selectedValue = $(this).val();
    if (!selectedValue) {
      console.log("No property selected");
      return;
    }
    if (!settings.properties.includes(selectedValue)) {
      return;
    }
    settings.siteUrl = selectedValue;
    $("#property").attr("placeholder", settings.siteUrl);
    $("#property").val("");
    addFilter("property", selectedValue);
    getTimeline();
    getPages();
  });

  $("input[type='datetime-local']").on("change", function () {
    let val = $(this).val();
    let id = $(this).attr("id");
    if (!val) return;

    const date = new Date(val);
    date.setMinutes(0);
    date.setSeconds(0);
    date.setMilliseconds(0);

    // Format back to datetime-local string
    const pad = (n) => String(n).padStart(2, "0");
    const formatted = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;

    $(this).val(formatted);
    settings[id] = date.getTime();
    addFilter(id, formatted);

    if (chart) {
      chart.regions.remove();
    }

    $pagesTable.bootstrapTable("removeAll");
    if (chart && settings.from < settings.to) {
      getPages();
    }
  });

  if (settings.page) {
    $("#urlFilterMode").val(dimensionsFilterOperators[settings.page[0]]);
    $("#floatingPageFilterInput").val(settings.page.slice(1));
  }

  $("#applyPageFilter").on("click", function () {
    let type = $("#urlFilterMode").val();
    let page = $("#floatingPageFilterInput").val();

    if (!page) {
      settings.page = null;
      removeFilter("page");
    } else {
      settings.page = `${type}${page}`;
      addFilter("page", settings.page);
    }

    pageFilterModal.hide();

    clearChart();
    $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
    $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

    getTimeline();
    getPages();
  });

  getEvents();

  $("#addEvent").on("click", function () {
    let eventDateFrom = $("#event-date-from").val();
    if (!eventDateFrom) {
      console.error("no event start set");
      return;
    }
    let eventId = crypto.randomUUID();
    let eventDateTo = $("#event-date-to").val();
    let eventTitle = $("#event-title").val()?.trim();
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
  });
}
init();
