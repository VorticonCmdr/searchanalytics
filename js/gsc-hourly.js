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
    dataState: "HOURLY_ALL",
    type: settings.type,
    rowLimit: 10000,
    startDate: new Date(settings.from).toISOString().slice(0, 10),
    endDate: new Date(settings.to).toISOString().slice(0, 10),
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

    const pages = data.rows
      .filter(
        (d) =>
          new Date(d?.keys?.[0]).getTime() >= settings.from &&
          new Date(d?.keys?.[0]).getTime() <= settings.to,
      )
      .map((d) => {
        return {
          timestamp: new Date(d?.keys?.[0]).getTime(),
          page: d?.keys?.[1],
          clicks: d?.clicks,
          impressions: d?.impressions,
          ctr: d?.ctr,
        };
      });

    let aggregatedPages = aggregateByUrl(pages);
    $pagesTable
      .bootstrapTable("load", aggregatedPages)
      .bootstrapTable("hideLoading");
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

    const timeline = data.rows.map((d) => {
      return {
        timestamp: new Date(d?.keys?.[0]).getTime(),
        clicks: d?.clicks,
        impressions: d?.impressions,
        ctr: d?.ctr,
      };
    });
    $hoursTable.bootstrapTable("load", timeline).bootstrapTable("hideLoading");

    let chartData = generateHourlyGraphData(data.rows);
    drawChart(chartData);
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

function generateHourlyGraphData(source) {
  const dataMap = new Map();

  // Map each timestamp (in ms) to clicks
  source.forEach((entry) => {
    const timestamp = new Date(entry.keys[0]).getTime();
    dataMap.set(timestamp, entry.clicks);
  });

  // Get most recent timestamp
  const mostRecentStr = source[source.length - 1].keys[0];
  const mostRecent = new Date(mostRecentStr);
  mostRecent.setDate(mostRecent.getDate() + 1);
  mostRecent.setHours(0, 0, 0, 0);

  // Calculate start time: 7 days before, at 00:00
  const start = new Date(mostRecent);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);

  const timeseries = ["x"];
  const clicksLast7Days = ["last7Days"];
  const clicksPrev7Days = ["prev7Days"];

  const MS_PER_HOUR = 60 * 60 * 1000;

  for (let i = 0; i < 24 * 7; i++) {
    const ts = start.getTime() + i * MS_PER_HOUR;
    const tsPrev = ts - 7 * 24 * MS_PER_HOUR;

    timeseries.push(ts);
    clicksLast7Days.push(dataMap.get(ts) ?? null);
    clicksPrev7Days.push(dataMap.get(tsPrev) ?? null);
  }

  return { timeseries, clicksLast7Days, clicksPrev7Days };
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
    last7Days: "#4285f4",
    prev7Days: "#f45f42",
  };

  columns.push(chartData.timeseries);
  columns.push(chartData.clicksLast7Days);
  columns.push(chartData.clicksPrev7Days);

  clearChart();
  chart = bb.generate({
    point: {
      show: false,
    },
    padding: {
      left: 46,
      right: 46,
    },
    data: {
      x: "x",
      columns: columns,
      colors: colors,
      order: "desc",
      type: "line",
    },
    tooltip: {
      format: {
        value: function (value, ratio, id, index) {
          return parseFloat(value).toLocaleString();
        },
        title: function (x) {
          return new Date(x).toLocaleString();
        },
      },
    },
    axis: {
      min: {
        y: 0,
      },
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

async function init() {
  checkAuth();

  $("#property").attr("placeholder", settings.siteUrl);
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

  $(".nav-tabs").on("click", ".nav-item", function (e) {
    e.preventDefault(); // Prevent the default link behavior

    $tabs.toggleClass(["invisible", "visible"]);
    $tabs.toggleClass("d-none");

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
}
init();
