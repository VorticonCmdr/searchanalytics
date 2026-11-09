import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.min.css";
import "../css/searchanalytics.css";

const INCIDENTS_URL = "https://status.search.google.com/incidents.json";

// ── ID regex with live validation and a tester ───────────────────────────────

const $regex = document.getElementById("idRegex");
const $regexError = document.getElementById("idRegexError");
const $sample = document.getElementById("sampleUrl");
const $sampleResult = document.getElementById("sampleResult");
const $status = document.getElementById("status");
let savedRegex = "";

function compile(source) {
  if (!source) return { regex: null };
  try {
    return { regex: new RegExp(source) };
  } catch (err) {
    return { error: err.message };
  }
}

// Same rule as getIdentifier() in gsc-hourly.js: group 1, else the whole match.
function renderRegexState() {
  const source = $regex.value;
  const { regex, error } = compile(source);
  $regex.classList.toggle("is-invalid", Boolean(error));
  $regexError.textContent = error ?? "";
  document.getElementById("save").disabled = Boolean(error) || source === savedRegex;
  if (source !== savedRegex) $status.textContent = "";

  const url = $sample.value.trim();
  $sampleResult.className = "form-text";
  if (!url) {
    $sampleResult.textContent = "";
  } else if (error) {
    $sampleResult.textContent = "";
  } else if (!regex) {
    $sampleResult.textContent = "Aggregation is off — every URL is its own row.";
  } else {
    const match = url.match(regex);
    if (match) {
      $sampleResult.textContent = `ID: ${match[1] || match[0]}`;
      $sampleResult.classList.add("text-success");
    } else {
      $sampleResult.textContent = "No match — this URL keeps its own row.";
    }
  }
}

chrome.storage.sync.get({ idRegex: "" }, (items) => {
  savedRegex = items.idRegex;
  $regex.value = items.idRegex;
  renderRegexState();
});

$regex.addEventListener("input", renderRegexState);
$sample.addEventListener("input", renderRegexState);

document.getElementById("aggregationForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const regex = $regex.value;
  if (compile(regex).error) return;
  chrome.storage.sync.set({ idRegex: regex }, () => {
    savedRegex = regex;
    renderRegexState();
    $status.innerHTML =
      '<i class="bi bi-check-circle-fill me-1" aria-hidden="true"></i>Saved — reload open views to apply it.';
  });
});

// ── Google Search Status import ──────────────────────────────────────────────

const $fetchBtn   = document.getElementById("fetchEvents");
const $importBtn  = document.getElementById("importEvents");
const $importMsg  = document.getElementById("importStatus");
const $preview    = document.getElementById("importPreview");

let fetchedEvents = [];

// Events are day-granular (the chart is by day), so keep YYYY-MM-DD like manually added events.
function incidentToEvent(incident) {
  const from = incident.begin.slice(0, 10);
  const to = incident.end ? incident.end.slice(0, 10) : "";
  return {
    id: incident.id,
    from,
    to: to !== from ? to : "",
    title: incident.external_desc,
    // Ranking incidents are algorithm updates; serving/crawling/indexing ones are outages.
    category: incident.service_name === "Ranking" ? "update" : "issue",
    property: "all",
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function renderPreview(events, existingIds) {
  if (!events.length) {
    $preview.innerHTML = "";
    return;
  }
  const rows = events.map((ev) => {
    const isNew = !existingIds.has(ev.id);
    const badge = isNew
      ? '<span class="badge bg-success ms-1">new</span>'
      : '<span class="badge bg-secondary ms-1">already imported</span>';
    const to = ev.to ? ` → ${ev.to}` : "";
    return `<tr class="${isNew ? "" : "text-body-tertiary"}">
      <td class="text-nowrap">${ev.from}${to}</td>
      <td>${escapeHtml(ev.title)}${badge}</td>
    </tr>`;
  });
  $preview.innerHTML = `
    <table class="table table-sm">
      <thead><tr><th>Date</th><th>Event</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

$fetchBtn.addEventListener("click", async () => {
  $fetchBtn.disabled = true;
  $importBtn.disabled = true;
  $importMsg.className = "mt-2 text-body-secondary small";
  $importMsg.textContent = "Fetching events from Google…";
  $preview.innerHTML = "";
  fetchedEvents = [];

  try {
    const res = await fetch(INCIDENTS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const incidents = await res.json();
    fetchedEvents = incidents.map(incidentToEvent);

    chrome.storage.local.get(["events"], (result) => {
      const existing = Array.isArray(result.events) ? result.events : [];
      const existingIds = new Set(existing.map((e) => e.id));
      const newCount = fetchedEvents.filter((e) => !existingIds.has(e.id)).length;

      $importMsg.textContent =
        `Found ${fetchedEvents.length} events — ${newCount} new, ${fetchedEvents.length - newCount} already imported.`;
      $importBtn.textContent = newCount ? `Import ${newCount} new event${newCount === 1 ? "" : "s"}` : "Nothing new to import";
      renderPreview(fetchedEvents, existingIds);
      $importBtn.disabled = newCount === 0;
    });
  } catch (err) {
    $importMsg.textContent = `Could not fetch events: ${err.message}`;
    $importMsg.className = "mt-2 text-danger small";
  } finally {
    $fetchBtn.disabled = false;
  }
});

$importBtn.addEventListener("click", () => {
  chrome.storage.local.get(["events"], (result) => {
    const existing = Array.isArray(result.events) ? result.events : [];
    const existingIds = new Set(existing.map((e) => e.id));
    const toAdd = fetchedEvents.filter((e) => !existingIds.has(e.id));
    const merged = [...existing, ...toAdd];

    chrome.storage.local.set({ events: merged }, () => {
      const existingIds2 = new Set(merged.map((e) => e.id));
      $importMsg.textContent = `Imported ${toAdd.length} events — ${merged.length} events in total. Reload “Property by day” to see them.`;
      $importBtn.disabled = true;
      $importBtn.textContent = "Imported";
      renderPreview(fetchedEvents, existingIds2);
    });
  });
});
