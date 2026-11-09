// Shared code for all three views: library setup, auth, Search Console API access,
// URL state, formatting, table export (Google Sheets clipboard + CSV) and tabs.
//
// Import order matters: jquery-global must run before bootstrap-table so the UMD
// bundle finds globalThis.jQuery.
import $ from "./jquery-global.js";
import * as bootstrap from "bootstrap";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.min.css";
import "bootstrap-table/dist/bootstrap-table.min.css";
import "../css/searchanalytics.css";
import "bootstrap-table";

export { $, bootstrap };

export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

const API_BASE = "https://www.googleapis.com/webmasters/v3";

// ── notices & errors ─────────────────────────────────────────────────────────

let noticeTimer;
export function showNotice(message, duration = 1500) {
  const $badge = $("#action-badge");
  $badge.text(message);
  $badge.removeClass("d-none").addClass("visible");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    $badge
      .removeClass("visible")
      .one("transitionend", () => $badge.addClass("d-none"));
  }, duration);
}

/**
 * Persistent, dismissible error banner under the navbar (one at a time). Use for
 * anything the user must act on; showNotice() is for passing confirmations.
 */
export function showError(message, { actionLabel, onAction } = {}) {
  const $alert = $(
    '<div class="alert alert-danger alert-dismissible d-flex align-items-center gap-3 mb-0" role="alert">',
  ).append(
    '<i class="bi bi-exclamation-triangle-fill flex-shrink-0" aria-hidden="true"></i>',
    $('<div class="flex-grow-1">').text(message),
  );
  if (actionLabel) {
    $alert.append(
      $('<button type="button" class="btn btn-sm btn-danger text-nowrap">')
        .text(actionLabel)
        .on("click", () => {
          clearError();
          onAction?.();
        }),
    );
  }
  $alert.append(
    '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Dismiss"></button>',
  );
  $("#notices").empty().append($alert);
}

export function clearError() {
  $("#notices").empty();
}

const signInNow = () => $("#authorize_button").trigger("click");

export function apiError(error) {
  if (error?.status === 401) {
    setAuthState("danger");
    showError("Your Google session has expired.", {
      actionLabel: "Sign in again",
      onAction: signInNow,
    });
    return;
  }
  const message = error?.error?.message || error?.message || String(error);
  console.error(message);
  showError(`Search Console API error: ${message}`);
}

// ── chart & table states ─────────────────────────────────────────────────────

const chartStates = {
  loading: { spinner: true, text: "Loading data…", table: null },
  signedOut: {
    icon: "bi-person-lock",
    text: "Sign in with your Google account to load Search Console data.",
    actionLabel: "Sign in",
    onAction: signInNow,
    table: "Sign in to load data",
  },
  noProperty: {
    icon: "bi-globe2",
    text: "Choose a Search Console property to get started.",
    actionLabel: "Choose property",
    onAction: () => $("#propertyBtn").trigger("click"),
    table: "Choose a property to load data",
  },
  noData: {
    icon: "bi-inbox",
    text: "No data for this selection. Try another search type, timeframe or URL filter.",
    table: "No data for this selection",
  },
  error: {
    icon: "bi-exclamation-circle",
    text: "Couldn’t load data — see the message above.",
    actionLabel: "Reload",
    onAction: () => location.reload(),
    table: "Couldn’t load data",
  },
  selectPages: {
    icon: "bi-check2-square",
    text: "Tick one or more pages in the table below, then choose “Draw”.",
    table: null,
  },
};

let tableEmptyText = null;
// Read at render time by every bootstrap-table (see defaults below).
$.extend($.fn.bootstrapTable.defaults, {
  formatNoMatches: () => tableEmptyText ?? "No matching rows",
});

/**
 * Overlay over the chart for loading and empty states, with the next step as a
 * button. kind: one of chartStates, or null to hide. Empty tables follow suit.
 */
export function showChartState(kind) {
  const $el = $("#chart-state");
  const state = chartStates[kind];
  $el.attr("data-state", kind ?? "");
  if (!state) {
    $el.addClass("d-none").empty();
  } else {
    $el.removeClass("d-none").empty();
    $el.append(
      state.spinner
        ? '<div class="spinner-border text-primary" role="status" aria-hidden="true"></div>'
        : `<i class="bi ${state.icon}" aria-hidden="true"></i>`,
      $("<p>").text(state.text),
    );
    if (state.actionLabel) {
      $el.append(
        $('<button type="button" class="btn btn-primary">')
          .text(state.actionLabel)
          .on("click", state.onAction),
      );
    }
  }
  if (state?.table !== undefined && state.table !== tableEmptyText) {
    tableEmptyText = state.table;
    // Re-render empty tables so their placeholder row picks up the new text.
    $(".bootstrap-table table[id]").each(function () {
      const $t = $(this);
      if (!$t.bootstrapTable("getData", { unfiltered: true }).length) {
        $t.bootstrapTable("load", []);
      }
    });
  }
}

export function chartState() {
  return $("#chart-state").attr("data-state") || null;
}

/** Chart colours from the theme tokens in searchanalytics.css. */
export function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    clicks: v("--sa-clicks"),
    impressions: v("--sa-impressions"),
    ctr: v("--sa-ctr"),
    palette: v("--sa-series-palette")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  };
}

// ── auth ─────────────────────────────────────────────────────────────────────

export function setAuthState(state) {
  // state: "unknown" | "success" | "danger"
  const labels = {
    unknown: ["bi-hourglass-split", "Checking sign-in…"],
    success: ["bi-person-check-fill", "Signed in"],
    danger: ["bi-box-arrow-in-right", "Sign in"],
  };
  const [icon, text] = labels[state] ?? labels.unknown;
  $("#auth_dropdown")
    .removeClass(
      "btn-outline-primary btn-outline-secondary btn-outline-success btn-outline-danger btn-danger",
    )
    .addClass(
      {
        unknown: "btn-outline-secondary",
        success: "btn-outline-success",
        danger: "btn-outline-danger",
      }[state] ?? "btn-outline-secondary",
    )
    .empty()
    .append(`<i class="bi ${icon}" aria-hidden="true"></i>`, document.createTextNode(text));
  $("#authorize_button").text(
    state === "success" ? "Refresh sign-in" : "Sign in with Google",
  );
  $("#signout_button").toggleClass("d-none", state !== "success");
}

function getAuthToken(interactive) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const error = chrome.runtime.lastError;
      if (error || !token) {
        resolve({ token: null, error: error?.message });
        return;
      }
      // Newer Chrome versions may return { token, grantedScopes }.
      resolve({ token: typeof token === "string" ? token : token.token });
    });
  });
}

/**
 * Wires the auth dropdown and silent re-auth on tab focus.
 * @param {object} settings  view settings; settings.auth.token is kept current
 * @param {object} hooks     onSignIn(): load data; onSignOut(): clear view
 */
export function initAuth(settings, { onSignIn, onSignOut }) {
  // `initial`: the first silent check on page load. Only then (or after an explicit
  // sign-out) does a failure replace the chart with the sign-in prompt; a failed
  // re-check on tab focus just flags the button.
  const signIn = async (interactive, initial = false) => {
    const { token, error } = await getAuthToken(interactive);
    if (!token) {
      setAuthState("danger");
      if (interactive) {
        showError(`Sign-in failed${error ? `: ${error}` : "."}`, {
          actionLabel: "Try again",
          onAction: signInNow,
        });
      }
      if (initial) showChartState("signedOut");
      return false;
    }
    setAuthState("success");
    settings.auth.token = token;
    if (chartState() === "signedOut") showChartState(null);
    if (interactive) clearError();
    return true;
  };

  $("#authorize_button").on("click", async (e) => {
    e.preventDefault();
    if (await signIn(true)) onSignIn();
  });

  $("#signout_button").on("click", (e) => {
    e.preventDefault();
    chrome.identity.clearAllCachedAuthTokens(() => {
      settings.auth.token = null;
      settings.properties = [];
      $("#properties-list").empty();
      setAuthState("danger");
      onSignOut();
      showChartState("signedOut");
      showNotice("Signed out");
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") signIn(false);
  });

  setAuthState("unknown");
  signIn(false, true).then((ok) => ok && onSignIn());
}

// ── Search Console API ───────────────────────────────────────────────────────

async function apiFetch(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function gscQuery(siteUrl, token, body) {
  return apiFetch(
    `${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    token,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Pages through a query until fewer than rowLimit rows come back. */
export async function gscQueryAll(siteUrl, token, body, maxRows = 200000) {
  const rowLimit = body.rowLimit ?? 25000;
  let startRow = 0;
  let rows = [];
  let metadata;
  for (;;) {
    const data = await gscQuery(siteUrl, token, { ...body, rowLimit, startRow });
    metadata ??= data.metadata;
    const page = data.rows ?? [];
    rows = rows.concat(page);
    if (page.length < rowLimit || rows.length >= maxRows) break;
    startRow += rowLimit;
  }
  return { rows, metadata };
}

/** Sorted list of the user's properties (domain properties ordered by reversed host). */
export async function fetchProperties(token) {
  const data = await apiFetch(`${API_BASE}/sites`, token, { method: "GET" });
  const sortKey = (siteUrl) => {
    try {
      const url = new URL(siteUrl.replace("sc-domain:", "sc-domain://"));
      return `${url.host.split(".").reverse().join(".")} ${url.pathname.toLowerCase()}`;
    } catch {
      return siteUrl;
    }
  };
  return (data?.siteEntry ?? [])
    .map((entry) => entry.siteUrl)
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

/** Loads properties into settings.properties and the #properties-list datalist. */
export async function loadProperties(settings) {
  if (!settings.auth.token) return;
  try {
    settings.properties = await fetchProperties(settings.auth.token);
    $("#properties-list").html(
      settings.properties
        .map((p) => `<option value="${escapeHtml(p)}"></option>`)
        .join(""),
    );
  } catch (err) {
    apiError(err);
  }
}

// ── URL state ────────────────────────────────────────────────────────────────

export function addFilter(name, value) {
  const u = new URL(document.location.href);
  u.searchParams.set(name, value);
  history.pushState(null, "", u.search);
}

/** Sets several URL params in one history entry. */
export function addFilters(values) {
  const u = new URL(document.location.href);
  Object.entries(values).forEach(([name, value]) => u.searchParams.set(name, value));
  history.pushState(null, "", u.search);
}

export function removeFilter(name) {
  const u = new URL(document.location.href);
  u.searchParams.delete(name);
  history.pushState(null, "", u.search || document.location.pathname);
}

export const dimensionsFilterOperators = {
  "*": "contains",
  "-": "notContains",
  "=": "equals",
  "!": "notEquals",
  "~": "includingRegex",
  _: "excludingRegex",
};

/** Decodes the `page` URL param (operator prefix + expression) into API filters. */
export function assemblePageFilters(page) {
  if (!page || page.length < 2) return [];
  const operator = dimensionsFilterOperators[page[0]];
  if (!operator) return [];
  return [{ dimension: "page", operator, expression: page.slice(1) }];
}

// ── formatting ───────────────────────────────────────────────────────────────

export function parseTimestamp(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

export function ctrFormat(value) {
  const num = Number(value);
  if (!isFinite(num) || num === 0) return "0.0%";
  return `${(num * 100).toFixed(1)}%`;
}

const numberFormatter = new Intl.NumberFormat();
/** Thousands separators for clicks/impressions (tables, tooltips, axes). */
export function numberFormat(value) {
  if (value == null || value === "") return "–";
  const num = Number(value);
  return Number.isFinite(num) ? numberFormatter.format(num) : String(value);
}

export function getLocalISOStringSlice(ts) {
  const d = new Date(ts);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeFilename(input) {
  return String(input ?? "").replace(/[\\/:*?"<>|\x00-\x1F]/g, "_");
}

/** e.g. sc-domain_example.com-web-2026-11-08T00_00-2026-11-08T23_00-pages */
export function generateFilename(settings, name) {
  const part = (v) =>
    typeof v === "number" ? getLocalISOStringSlice(v) : (v ?? "");
  return [settings.siteUrl, settings.type, part(settings.from), part(settings.to), name]
    .map(sanitizeFilename)
    .join("-");
}

// ── clipboard & export ───────────────────────────────────────────────────────

export async function setClipboard(text, message = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    showNotice(message);
  } catch (err) {
    showNotice(`Could not copy: ${err.message}`, 4000);
  }
}

function getNestedProperty(obj, path) {
  return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

/**
 * Visible columns + all rows that pass the current search (all pages), as plain text.
 * Honors bootstrap-table's suppressExport (skip column) and suppressFormatterExport
 * (export the raw value instead of the formatted one).
 */
export function tableRows(table) {
  const columns = table.columns.filter(
    (col) => col.visible && col.field && !col.checkbox && !col.suppressExport,
  );
  const stripTags = (v) =>
    String(v ?? "")
      .replace(/<[^>]*>/g, "")
      .trim();
  const header = columns.map((col) => col.title);
  const rows = table.data.map((row) =>
    columns.map((col) => {
      const value = getNestedProperty(row, col.field);
      if (!col.formatter || col.suppressFormatterExport) return stripTags(value);
      return stripTags(col.formatter(value, row));
    }),
  );
  return { header, rows };
}

export function toTsv(table) {
  const { header, rows } = tableRows(table);
  const clean = (v) => v.replace(/[\t\r\n]+/g, " ");
  return [header, ...rows].map((r) => r.map(clean).join("\t")).join("\n");
}

export function toCsv(table) {
  const { header, rows } = tableRows(table);
  const quote = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...rows].map((r) => r.map(quote).join(",")).join("\r\n");
}

export function downloadFile(content, filename, type = "text/csv;charset=utf-8") {
  // BOM so Excel opens UTF-8 CSVs with the right encoding.
  const blob = new Blob(["﻿", content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Toolbar buttons shared by every table. `name` becomes the CSV filename suffix. */
export function exportButtons(settings, name) {
  return {
    btnGSheetClipboard: {
      text: "Copy for Google Sheets",
      icon: "bi-clipboard-data",
      event: function () {
        setClipboard(toTsv(this), "Table copied — paste it into Google Sheets");
      },
      attributes: {
        title: "Copy table for Google Sheets",
        "aria-label": "Copy table for Google Sheets",
      },
    },
    btnCsv: {
      text: "Download CSV",
      icon: "bi-download",
      event: function () {
        downloadFile(toCsv(this), `${generateFilename(settings, name)}.csv`);
      },
      attributes: {
        title: "Download table as CSV",
        "aria-label": "Download table as CSV",
      },
    },
  };
}

// ── UI ───────────────────────────────────────────────────────────────────────

/**
 * Accessible tabs: <ul role="tablist"> with <button role="tab" data-id="x"> and
 * panels #xTab. Supports click and arrow/Home/End keys.
 */
export function initTabs(onChange) {
  const $tabs = $('[role="tab"]');
  const select = ($tab) => {
    $tabs
      .removeClass("active")
      .attr({ "aria-selected": "false", tabindex: "-1" });
    $tab.addClass("active").attr({ "aria-selected": "true", tabindex: "0" });
    $(".tab").addClass("d-none");
    $(`#${$tab.data("id")}Tab`).removeClass("d-none");
    onChange?.($tab.data("id"));
  };
  $tabs.on("click", function () {
    select($(this));
  });
  $tabs.on("keydown", function (e) {
    const i = $tabs.index(this);
    const next = {
      ArrowRight: (i + 1) % $tabs.length,
      ArrowLeft: (i - 1 + $tabs.length) % $tabs.length,
      Home: 0,
      End: $tabs.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const $next = $tabs.eq(next);
    $next.trigger("focus");
    select($next);
  });
}

/** Property picker: button swaps to a datalist-backed input; Escape cancels. */
export function initPropertyPicker() {
  const $btn = $("#propertyBtn");
  const $input = $("#property");
  const close = () => {
    $input.addClass("d-none").removeClass("d-block");
    $btn.removeClass("d-none").addClass("d-block");
  };
  $btn.on("click", () => {
    $btn.removeClass("d-block").addClass("d-none");
    $input.removeClass("d-none").addClass("d-block").trigger("focus");
    // Show the datalist immediately instead of waiting for typing (needs the click's
    // user activation; unsupported browsers just keep the focused input).
    try {
      $input[0].showPicker?.();
    } catch {
      /* ignore */
    }
  });
  $input.on("blur", close);
  $input.on("keydown", (e) => {
    if (e.key === "Escape") {
      $input.val("");
      $btn.trigger("focus");
    }
  });
}

/** Sets the property button label and validity state. */
export function showProperty(siteUrl, valid = true) {
  const $btn = $("#propertyBtn");
  if (siteUrl || valid) {
    $btn.empty().append(
      '<i class="bi bi-globe2 me-1" aria-hidden="true"></i>',
      $("<span>").text(siteUrl || "Select property"),
      ' <i class="bi bi-chevron-down small ms-1" aria-hidden="true"></i>',
    );
    $("#property").attr("placeholder", siteUrl || "Search properties");
  }
  $("#property").toggleClass("is-invalid", !valid);
  $btn
    .toggleClass("btn-outline-danger", !valid)
    .toggleClass("btn-outline-secondary", valid);
}

const filterOperatorLabels = {
  "*": "containing",
  "-": "not containing",
  "=": "equal to",
  "!": "not equal to",
  "~": "matching",
  _: "not matching",
};

/**
 * URL filter button: "URL filter" when inactive; when active it reads e.g.
 * "URLs containing “news”" and an × button next to it clears the filter.
 * @param {string|null} page  settings.page (operator prefix + expression)
 */
export function showPageFilter(page) {
  const active = Boolean(page && page.length > 1);
  const $label = $("#pageFilterLabel");
  if (active) {
    const value = page.slice(1);
    $label.text(`URLs ${filterOperatorLabels[page[0]] ?? ""} “${value}”`);
    $("#pageFilter").attr("title", `URL filter: ${filterOperatorLabels[page[0]] ?? ""} ${value} — click to edit`);
  } else {
    $label.text("URL filter");
    $("#pageFilter").attr("title", "Filter all data by URL");
  }
  $("#pageFilter")
    .toggleClass("btn-primary", active)
    .toggleClass("btn-outline-secondary", !active)
    .attr("aria-pressed", active ? "true" : "false");
  $("#pageFilter .bi")
    .toggleClass("bi-funnel-fill", active)
    .toggleClass("bi-funnel", !active);
  $("#clearPageFilter").toggleClass("d-none", !active);
}

/** Puts a filter (settings.page format) into the dialog fields and the filter chip. */
export function syncPageFilterUi(page) {
  const active = Boolean(page && page.length > 1);
  $("#urlFilterMode").val(active ? page[0] : "*");
  $("#floatingPageFilterInput").val(active ? page.slice(1) : "");
  updateFilterInputHint();
  showPageFilter(active ? page : null);
}

/**
 * Filter value for "filter the whole view by this page": rows aggregated by an ID
 * filter on the ID fragment (contains); a plain URL filters on exactly that URL.
 */
export function pageFilterFor(url, fragment = url) {
  return fragment && fragment !== url ? `*${fragment}` : `=${url}`;
}

/** Row actions shown on hover in a page cell: filter the view by it, copy it. */
export function pageActionButtons(url, id = url) {
  const u = escapeHtml(url);
  return `<button type="button" data-url="${u}"
    class="action-icon clipboard-icon btn btn-transparent float-end"
    title="Copy URL" aria-label="Copy URL"></button><button type="button"
    data-url="${u}" data-id="${escapeHtml(id)}"
    class="action-icon filter-page-icon bi-funnel btn btn-transparent float-end"
    title="Filter the whole view by this page" aria-label="Filter the whole view by this page"></button>`;
}

/** Wires the row filter buttons; onFilter(url, id) receives the raw strings. */
export function initPageFilterActions(onFilter) {
  $(document).on("click", ".filter-page-icon", function (e) {
    e.stopPropagation();
    onFilter(this.getAttribute("data-url"), this.getAttribute("data-id"));
  });
}

/**
 * Back/forward: URL state is written with history.pushState, so re-read it when the
 * user navigates. Updates the shared controls (search type, property, URL filter) and
 * returns the search params for the view-specific ones; the view then reloads.
 */
export function initHistory(onNavigate) {
  window.addEventListener("popstate", () => {
    $(".modal.show").each(function () {
      bootstrap.Modal.getInstance(this)?.hide();
    });
    onNavigate(new URL(document.location.href).searchParams);
  });
}

export function readSharedUrlState(settings, params) {
  settings.type = params.get("type") || "discover";
  settings.siteUrl = params.get("property") || null;
  settings.page = params.get("page") || null;
  $("#type").val(settings.type);
  showProperty(settings.siteUrl);
  syncPageFilterUi(settings.page);
}

function updateFilterInputHint() {
  const regex = ["~", "_"].includes($("#urlFilterMode").val());
  $("#floatingPageFilterInput").attr(
    "placeholder",
    regex ? "/news/[0-9]+/" : "https://www.example.com/",
  );
  $('label[for="floatingPageFilterInput"]').text(
    regex ? "Regular expression (RE2 syntax)" : "URL or part of a URL",
  );
}

/** Enter in the filter input applies it; the × on the filter button clears it. */
export function initPageFilterModal(onApply) {
  $("#applyPageFilter").on("click", onApply);
  $("#clearPageFilter").on("click", () => {
    $("#floatingPageFilterInput").val("");
    onApply();
    $("#pageFilter").trigger("focus");
  });
  $("#urlFilterMode").on("change", updateFilterInputHint);
  updateFilterInputHint();
  $("#floatingPageFilterInput").on("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onApply();
    }
  });
  $("#pageFilterModal").on("shown.bs.modal", () =>
    $("#floatingPageFilterInput").trigger("focus"),
  );
}

// ── navigation, presets, keyboard ────────────────────────────────────────────

/**
 * View switcher links keep the shared state (property, search type, URL filter)
 * so switching views doesn't drop the selection. Also wires the Options item.
 */
export function initViewSwitcher() {
  const shared = ["property", "type", "page"];
  const update = () => {
    const current = new URL(document.location.href).searchParams;
    $("[data-view-link]").each(function () {
      const url = new URL(this.getAttribute("href"), document.location.href);
      shared.forEach((key) => {
        if (current.get(key)) url.searchParams.set(key, current.get(key));
        else url.searchParams.delete(key);
      });
      this.setAttribute("href", url.pathname + url.search);
    });
  };
  // URL state changes via history.pushState (addFilter/removeFilter), so refresh
  // the links whenever the menu opens.
  $("#viewSwitch").on("show.bs.dropdown", update);
  update();
  $("#openOptions").on("click", () => {
    if (chrome.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open("/html/options.html", "_blank");
  });
}

/**
 * Fills the quick-range dropdown ([data-range-presets]) with presets.
 * @param {{label: string, range: () => {from: *, to: *}}[]} presets
 * @param {(range: {from: *, to: *}) => void} onPick
 */
export function initRangePresets(presets, onPick) {
  const $menu = $("[data-range-presets]");
  presets.forEach((preset) => {
    $("<li>")
      .append(
        $('<button type="button" class="dropdown-item">')
          .text(preset.label)
          .on("click", () => onPick(preset.range())),
      )
      .appendTo($menu);
  });
}

/** "/" focuses the search box of the visible table (like GitHub, Gmail, …). */
export function initKeyboardShortcuts() {
  $(document).on("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($(e.target).is("input, textarea, select, [contenteditable]")) return;
    if ($(".modal.show").length) return;
    const $search = $(".tab:not(.d-none) .search-input:visible").first();
    if (!$search.length) return;
    e.preventDefault();
    $search.trigger("focus").trigger("select");
  });
}

export function initClipboardIcons() {
  $(document).on("click", ".clipboard-icon", function () {
    setClipboard($(this).data("url"), "URL copied to clipboard");
  });
}
