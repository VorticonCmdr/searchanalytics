let currentURL = new URL(document.location);

let settings = {
  properties: [],
  type: currentURL.searchParams.get("type") || "discover",
  from: currentURL.searchParams.get("from") || null,
  to: currentURL.searchParams.get("to") || null,
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

const authorizeButton = document.getElementById("authorize_button");
const signoutButton = document.getElementById("signout_button");
const pageFilterModal = new bootstrap.Modal("#pageFilterModal", {});

let tokenClient;
let gapiInited = false;
let gisInited = false;

let chart;

let $hoursTable = $("#hourstable");
let $pagesTable = $("#pagestable");
let $tabs = $(".tab");

Date.prototype.getISOWeek = function () {
  // Copy date so we don't modify the original
  const date = new Date(
    Date.UTC(this.getFullYear(), this.getMonth(), this.getDate()),
  );
  // ISO week day (Monday=1, Sunday=7)
  const dayNum = date.getUTCDay() || 7;
  // Set to nearest Thursday: current date + 4 - current day number
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  // Year of the Thursday in question
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  // Calculate full weeks to nearest Thursday
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return weekNo;
};

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
      .removeClass("btn-danger")
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
      .addClass("btn-danger");
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

  if (!settings.siteUrl) {
    return;
  }
  getTimeline();
  getPages();
  listSites();
});

async function getPages() {
  $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

  if (!settings.from && !settings.to) {
    console.error("timeframe not selected");
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

    settings.pages = data.rows.map((d) => {
      return {
        timestamp: new Date(d?.keys?.[0]).getTime(),
        page: d?.keys?.[1],
        clicks: d?.clicks,
        impressions: d?.impressions,
        ctr: d?.ctr,
      };
    });

    let { aggregatedPages } = aggregateByUrl(settings.pages);

    $pagesTable
      .bootstrapTable("load", aggregatedPages)
      .bootstrapTable("hideLoading");
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

function drawSelections() {
  let data = $pagesTable.bootstrapTable("getSelections");
  settings.selectedPages = data.map((d) => d.page);

  let chartData = {
    columns: [],
  };
  data.forEach((d) => {
    let series = generatePageLine(d.page, settings.metric);
    chartData.columns.push(series);
  });
  chart.load(chartData);
  colorTable();

  generateNewHoursTable();
}

function generateNewHoursTable() {
  let filteredPages = settings.pages.filter(
    (d) => settings.selectedPages.indexOf(d.page) > -1,
  );
  let pivotHours = pivotByTimestamp(filteredPages, settings.metric);
  console.log(pivotHours);
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
    ctr: entry.ctrSum / entry.count,
  }));
  return {
    aggregatedPages,
  };
}

async function getTimeline() {
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

    let firstIncompleteHour = data?.metadata?.firstIncompleteHour;
    let firstIncompleteHourTs = Infinity;
    if (firstIncompleteHour) {
      firstIncompleteHourTs = new Date(firstIncompleteHour).getTime();
    }

    const timeline = data.rows.map((d) => {
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
  } catch (err) {
    console.error(`Error: ${err.message}`);
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

function colorTable() {
  let colors = chart.data.colors();
  Object.keys(colors).forEach((key) => {
    $(`[data-page="${key}"]`).val(colors[key]);
  });
}

function drawChart(chartData) {
  let columns = [];
  let colors = {
    "clicks last 7 days": "#4285f4",
    "incomplete clicks": "#4285f4",
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
    bindto: "#chart",
    padding: {
      left: 46,
      right: 60,
    },
    data: {
      x: "x",
      columns: columns,
      colors: colors,
      order: "desc",
      type: "line",
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
          return parseFloat(value).toLocaleString();
        },
        title: function (x) {
          return dateFormat(x);
        },
      },
    },
    axis: {
      y: {
        label: settings.metric,
        padding: {
          top: 0,
          bottom: 0,
        },
        min: 0,
        show: true,
        tick: {
          fit: true,
          format: function (d) {
            return d.toLocaleString();
          },
        },
      },
      y2: {},
      x: {
        label: "by hour",
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
    btnPaintCharts: {
      text: "paint chart",
      icon: "bi-graph-up",
      event: function () {
        drawSelections();
        $pagesTable.bootstrapTable("uncheckAll");
      },
      attributes: {
        title: "draw selected pages on graph",
      },
    },
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

function rowStyle(row, index) {
  if (row.incomplete) {
    return {
      classes: "incomplete",
    };
  }
  return {};
}

let hoursColumns = [
  {
    field: "timestamp",
    title: "timestamp",
    formatter: dateFormat,
    sortable: true,
    visible: true,
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
    checkbox: true,
    sortable: false,
    visible: true,
    searchable: false,
  },
  {
    field: "color",
    title: "color",
    sortable: false,
    visible: true,
    searchable: false,
    align: "center",
    formatter: colorFormatter,
  },
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
  return `<input type="color" data-page="${row.page}" value="#ffffff" class="graphColors form-control form-control-sm">`;
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
  const num = Number(value);
  if (!isFinite(num) || num === 0) return "0.0%";
  return `${(num * 100).toFixed(1)}%`;
}

function sanitizeFilename(input) {
  const illegalRe = /[\\\/:*?"<>|\x00-\x1F]/g;
  return input.replace(illegalRe, "_");
}

function generateFilename(name) {
  return `${sanitizeFilename(settings.siteUrl)}-${sanitizeFilename(settings.type)}-${sanitizeFilename(toLocaleString(settings.from))}-${sanitizeFilename(toLocaleString(settings.to))}-${name}`;
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
    sortOrder: "asc",
    sortName: "timestamp",
    onCheck: function (row, $element) {
      chart.focus(row.page);
    },
    onUncheck: function (row, $element) {
      chart.revert();
      $pagesTable.bootstrapTable("getSelections").forEach((row) => {
        chart.focus(row.page);
      });
    },
    onCheckAll: function (rowsAfter, rowsBefore) {
      //console.log(rowsAfter);
    },
  });
}

async function generateHoursTable() {
  $hoursTable.bootstrapTable({
    toolbar: "#hourstable-toolbar",
    uniqueId: "timestamp",
    classes: "table table-hover",
    rowStyle: rowStyle,
    data: [],
    pageSize: 1000,
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

async function generateNewHoursTableColumns() {
  hoursColumns = [
    {
      field: "timestamp",
      title: "timestamp",
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
      align: "left",
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

function getYesterday10() {
  let d = new Date();
  d.setDate(d.getDate() - 10);
  let from = d.setHours(0, 0, 0, 0);
  let to = d.setDate(d.getDate() + 1);
  to = to - 1000 * 60 * 60 * 1;

  return { from, to };
}

async function checkAuth() {
  if (document.visibilityState !== "visible") {
    return;
  }
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (chrome.runtime.lastError || !token) {
      $("#auth_dropdown")
        .removeClass("btn-outline-primary")
        .removeClass("btn-outline-success")
        .addClass("btn-outline-danger");
      return;
    }
    $("#auth_dropdown")
      .removeClass("btn-outline-primary")
      .removeClass("btn-danger")
      .addClass("btn-outline-success");
    settings.auth.token = token;
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

async function init() {
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (chrome.runtime.lastError || !token) {
      $("#auth_dropdown")
        .removeClass("btn-outline-primary")
        .removeClass("btn-outline-success")
        .addClass("btn-outline-danger");
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
  document.addEventListener("visibilitychange", checkAuth);

  $("#property").attr("placeholder", settings.siteUrl);
  $("#type").val(settings.type);

  let yesterday = getYesterday10();
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

    clearChart();
    $pagesTable.bootstrapTable("removeAll");
    $hoursTable.bootstrapTable("removeAll");

    addFilter("type", type);
    getTimeline();
    getPages();
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

  $(document).on("change", ".graphColors", function () {
    const {
      value: color,
      dataset: { page },
    } = this;
    chart.data.colors({ [page]: color });
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
      chart.regions.add({
        axis: "x",
        start: settings.from,
        end: settings.to,
        class: "regionCut",
        label: {
          text: "pages",
          x: 5,
        },
      });
      getPages();
    }
  });

  if (settings.page) {
    $("#urlFilterMode").val(dimensionsFilterOperators[settings.page[0]]);
    $("#floatingPageFilterInput").val(settings.page.slice(1));

    $("#pageFilter")
      .removeClass("btn-outline-secondary")
      .addClass("btn-primary");
  }

  $("#applyPageFilter").on("click", function () {
    let type = $("#urlFilterMode").val();
    let page = $("#floatingPageFilterInput").val();

    if (!page) {
      settings.page = null;
      removeFilter("page");
      $("#pageFilter")
        .addClass("btn-outline-secondary")
        .removeClass("btn-primary");
    } else {
      settings.page = `${type}${page}`;
      addFilter("page", settings.page);
      $("#pageFilter")
        .removeClass("btn-outline-secondary")
        .addClass("btn-primary");
    }

    pageFilterModal.hide();

    clearChart();
    $pagesTable.bootstrapTable("removeAll").bootstrapTable("showLoading");
    $hoursTable.bootstrapTable("removeAll").bootstrapTable("showLoading");

    getTimeline();
    getPages();
  });

  $("#metric").val(settings.metric);
  $("#metric").on("change", function () {
    clearChart();
    const value = this.value;
    settings.metric = value;
    addFilter("metric", value);
    chart.axis.labels({
      y: settings.metric,
    });
  });
}
init();
