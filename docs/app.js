/* Korea open-data viewer — generic, data-driven table + chart.
   Reads whatever columns each dataset JSON declares, so it adapts to any
   dataset without code changes. */

"use strict";

const DATASETS = [
  { key: "customs_velvet", label: "Customs — deer-velvet trade" },
  { key: "medicine",       label: "Medicine — production & import" },
  { key: "herbal_inspection", label: "Herbal resource — inspection failures" },
];

const cache = {};        // key -> loaded JSON
const state = {};        // key -> {sortCol, sortDir, filters, view, chart config}
let current = DATASETS[0].key;
let chartObj = null;

const $ = (id) => document.getElementById(id);

// ---- helpers --------------------------------------------------------------

function isNumeric(data, col) {
  let seen = 0;
  for (const r of data.rows) {
    const v = r[col];
    if (v === "" || v === null || v === undefined) continue;
    if (typeof v === "number") { seen++; if (seen >= 3) return true; continue; }
    return false;
  }
  return seen > 0;
}

function distinct(data, col) {
  const set = new Set();
  for (const r of data.rows) {
    const v = r[col];
    if (v !== "" && v !== null && v !== undefined) set.add(String(v));
  }
  return [...set].sort();
}

function fmt(v, numeric) {
  if (v === "" || v === null || v === undefined) return "";
  if (numeric && typeof v === "number") return v.toLocaleString("en-GB");
  return String(v);
}

function label(data, col) {
  return (data.labels && data.labels[col]) || col;
}

// ---- data loading ---------------------------------------------------------

async function loadDataset(key) {
  if (cache[key]) return cache[key];
  try {
    const resp = await fetch(`data/${key}.json`, { cache: "no-store" });
    if (!resp.ok) throw new Error(resp.status);
    const json = await resp.json();
    json.rows = json.rows || [];
    json.columns = json.columns || (json.rows[0] ? Object.keys(json.rows[0]) : []);
    json._numericCols = json.columns.filter((c) => isNumeric(json, c));
    cache[key] = json;
  } catch (e) {
    cache[key] = { title: "", columns: [], rows: [], _numericCols: [],
      note: "This dataset has not been loaded yet. Run the refresh workflow "
        + "in the repository to fetch the data." };
  }
  return cache[key];
}

// ---- filtering / sorting --------------------------------------------------

function filteredRows(key) {
  const data = cache[key];
  const st = state[key];
  let rows = data.rows;
  const f = st.filters;

  if (f.search) {
    const q = f.search.toLowerCase();
    rows = rows.filter((r) => data.columns.some(
      (c) => String(r[c] ?? "").toLowerCase().includes(q)));
  }
  for (const [col, val] of Object.entries(f.pick)) {
    if (val) rows = rows.filter((r) => String(r[col]) === val);
  }
  if (f.periodCol && (f.from || f.to)) {
    rows = rows.filter((r) => {
      const p = String(r[f.periodCol]);
      if (f.from && p < f.from) return false;
      if (f.to && p > f.to) return false;
      return true;
    });
  }
  if (st.sortCol) {
    const num = data._numericCols.includes(st.sortCol);
    rows = [...rows].sort((a, b) => {
      let x = a[st.sortCol], y = b[st.sortCol];
      if (num) { x = +x || 0; y = +y || 0; return st.sortDir * (x - y); }
      return st.sortDir * String(x).localeCompare(String(y));
    });
  }
  return rows;
}

// ---- rendering: controls --------------------------------------------------

function buildControls(key) {
  const data = cache[key];
  const st = state[key];
  const box = $("controls");
  box.innerHTML = "";

  // Search
  const search = fieldEl("Search", "search", () => {
    st.filters.search = search.querySelector("input").value.trim();
    renderTable(key);
  });
  const inp = document.createElement("input");
  inp.type = "search";
  inp.placeholder = "Type to filter…";
  inp.value = st.filters.search || "";
  inp.addEventListener("input", () => { st.filters.search = inp.value.trim(); renderTable(key); });
  search.appendChild(inp);
  box.appendChild(search);

  // Period from / to
  const periodCol = data.columns.find((c) => /period|date|yy?mm|year/i.test(c)
    && !data._numericCols.includes(c));
  st.filters.periodCol = periodCol || null;
  if (periodCol) {
    const values = distinct(data, periodCol);
    box.appendChild(selectField("Period from", values, st.filters.from, (v) => {
      st.filters.from = v; renderTable(key);
    }, "Earliest"));
    box.appendChild(selectField("Period to", values, st.filters.to, (v) => {
      st.filters.to = v; renderTable(key);
    }, "Latest"));
  }

  // Categorical dropdowns (low-cardinality, non-numeric)
  for (const col of data.columns) {
    if (col === periodCol) continue;
    if (data._numericCols.includes(col)) continue;
    const values = distinct(data, col);
    if (values.length < 2 || values.length > 40) continue;
    box.appendChild(selectField(label(data, col), values, st.filters.pick[col] || "",
      (v) => { st.filters.pick[col] = v; renderTable(key); }, "All"));
  }

  // View toggle
  const toggle = document.createElement("div");
  toggle.className = "view-toggle";
  for (const view of ["table", "chart"]) {
    const b = document.createElement("button");
    b.textContent = view === "table" ? "Table" : "Chart";
    b.className = st.view === view ? "active" : "";
    b.onclick = () => { st.view = view; render(key); };
    toggle.appendChild(b);
  }
  box.appendChild(toggle);
}

function fieldEl(labelText, cls, _cb) {
  const d = document.createElement("div");
  d.className = "field";
  const l = document.createElement("label");
  l.textContent = labelText;
  d.appendChild(l);
  return d;
}

function selectField(labelText, values, selected, cb, allText) {
  const d = fieldEl(labelText);
  const s = document.createElement("select");
  const opt0 = document.createElement("option");
  opt0.value = ""; opt0.textContent = allText || "All";
  s.appendChild(opt0);
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    if (v === selected) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener("change", () => cb(s.value));
  d.appendChild(s);
  return d;
}

// ---- rendering: table -----------------------------------------------------

function renderTable(key) {
  const data = cache[key];
  const st = state[key];
  const rows = filteredRows(key);
  const cols = data.columns;

  const thead = $("thead");
  thead.innerHTML = "";
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = label(data, c);
    if (st.sortCol === c) {
      const a = document.createElement("span");
      a.className = "arrow";
      a.textContent = st.sortDir > 0 ? "▲" : "▼";
      th.appendChild(a);
    }
    th.onclick = () => {
      if (st.sortCol === c) st.sortDir *= -1;
      else { st.sortCol = c; st.sortDir = 1; }
      renderTable(key);
    };
    thead.appendChild(th);
  }

  const tbody = $("tbody");
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  const cap = 5000;
  rows.slice(0, cap).forEach((r) => {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      const num = data._numericCols.includes(c);
      if (num) td.className = "num";
      td.textContent = fmt(r[c], num);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);

  const shown = Math.min(rows.length, cap);
  $("rowcount").textContent = data.rows.length
    ? `Showing ${shown.toLocaleString("en-GB")} of ${rows.length.toLocaleString("en-GB")} matching row(s).`
      + (rows.length > cap ? " Narrow the filters to see the rest." : "")
    : "";
  $("note").textContent = data.note || "";
  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td class="empty">${data.note || "No data."}</td></tr>`;
  }
}

// ---- rendering: chart -----------------------------------------------------

function buildChartControls(key) {
  const data = cache[key];
  const st = state[key];
  const cats = data.columns.filter((c) => !data._numericCols.includes(c));
  const nums = data._numericCols;
  const box = $("chartControls");
  box.innerHTML = "";
  if (!nums.length || !cats.length) {
    box.innerHTML = '<div class="note">This dataset has no numeric column to chart.</div>';
    return;
  }
  st.chart = st.chart || {};
  st.chart.x = st.chart.x && cats.includes(st.chart.x) ? st.chart.x : cats[0];
  st.chart.y = st.chart.y && nums.includes(st.chart.y) ? st.chart.y : nums[0];
  st.chart.group = st.chart.group && cats.includes(st.chart.group) ? st.chart.group : "";
  st.chart.type = st.chart.type || "line";

  box.appendChild(selectField2("Category (X axis)", cats, st.chart.x,
    (v) => { st.chart.x = v; drawChart(key); }, data));
  box.appendChild(selectField2("Value (Y axis)", nums, st.chart.y,
    (v) => { st.chart.y = v; drawChart(key); }, data));
  const grpField = selectField("Group by", cats.filter((c) => c !== st.chart.x),
    st.chart.group, (v) => { st.chart.group = v; drawChart(key); }, "None");
  box.appendChild(grpField);

  const tf = fieldEl("Chart type");
  const ts = document.createElement("select");
  for (const t of ["line", "bar"]) {
    const o = document.createElement("option");
    o.value = t; o.textContent = t[0].toUpperCase() + t.slice(1);
    if (t === st.chart.type) o.selected = true;
    ts.appendChild(o);
  }
  ts.onchange = () => { st.chart.type = ts.value; drawChart(key); };
  tf.appendChild(ts);
  box.appendChild(tf);
}

function selectField2(labelText, cols, selected, cb, data) {
  const d = fieldEl(labelText);
  const s = document.createElement("select");
  for (const c of cols) {
    const o = document.createElement("option");
    o.value = c; o.textContent = label(data, c);
    if (c === selected) o.selected = true;
    s.appendChild(o);
  }
  s.onchange = () => cb(s.value);
  d.appendChild(s);
  return d;
}

const PALETTE = ["#0b5c8a", "#0e8a6b", "#c8621d", "#8a4fc0", "#c0304f",
  "#5b6b7b", "#2e8fbf", "#7aa61d", "#b5892a", "#4a4fb0"];

function drawChart(key) {
  const data = cache[key];
  const st = state[key];
  const rows = filteredRows(key);
  const { x, y, group, type } = st.chart;
  if (!x || !y) return;

  const xs = [...new Set(rows.map((r) => String(r[x])))].sort();
  const groups = group ? [...new Set(rows.map((r) => String(r[group])))].sort() : [""];

  const datasets = groups.map((g, i) => {
    const sums = {};
    for (const r of rows) {
      if (group && String(r[group]) !== g) continue;
      const xv = String(r[x]);
      sums[xv] = (sums[xv] || 0) + (+r[y] || 0);
    }
    const colour = PALETTE[i % PALETTE.length];
    return {
      label: group ? g : label(data, y),
      data: xs.map((xv) => sums[xv] || 0),
      borderColor: colour,
      backgroundColor: type === "bar" ? colour : colour + "22",
      borderWidth: 2,
      tension: 0.25,
      pointRadius: xs.length > 40 ? 0 : 2,
    };
  });

  if (chartObj) chartObj.destroy();
  chartObj = new Chart($("chart"), {
    type,
    data: { labels: xs, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: group !== "" || datasets.length > 1 },
        title: { display: true,
          text: `${label(data, y)} by ${label(data, x)}${group ? " — grouped by " + label(data, group) : ""}` },
      },
      scales: {
        y: { ticks: { callback: (v) => Number(v).toLocaleString("en-GB") } },
        x: { ticks: { maxRotation: 60, autoSkip: true } },
      },
    },
  });
}

// ---- view switch ----------------------------------------------------------

function render(key) {
  const st = state[key];
  buildControls(key);
  if (st.view === "chart") {
    $("tableView").classList.add("hidden");
    $("chartView").classList.remove("hidden");
    buildChartControls(key);
    drawChart(key);
  } else {
    $("chartView").classList.add("hidden");
    $("tableView").classList.remove("hidden");
    renderTable(key);
  }
}

async function selectTab(key) {
  current = key;
  [...$("tabs").children].forEach((b) =>
    b.classList.toggle("active", b.dataset.key === key));
  await loadDataset(key);
  if (!state[key]) {
    state[key] = { sortCol: null, sortDir: 1, view: "table",
      filters: { search: "", pick: {}, from: "", to: "", periodCol: null }, chart: {} };
  }
  const meta = cache[key].last_updated;
  $("updated").textContent = meta
    ? `Data last refreshed: ${new Date(meta).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} (your local time)`
    : "Data not yet refreshed.";
  render(key);
}

function init() {
  const tabs = $("tabs");
  DATASETS.forEach((d) => {
    const b = document.createElement("button");
    b.textContent = d.label;
    b.dataset.key = d.key;
    b.onclick = () => selectTab(d.key);
    tabs.appendChild(b);
  });
  selectTab(current);
}

document.addEventListener("DOMContentLoaded", init);
