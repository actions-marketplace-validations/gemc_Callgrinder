// Rendering of the per-profile summary and aggregation for report mode.

const fs = require("node:fs");
const path = require("node:path");
const { cest, isNamedRoutine } = require("./callgrind");
const { collectRows } = require("./categories");
const { ensureDirectory, walkJsonFiles } = require("./utils");

const mcycles = (value) =>
  (value / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = (value, total) => (total ? (100 * value) / total : 0).toFixed(2);
const escapePipes = (text) => text.replace(/\|/g, "\\|");

function shorten(name, width = 90) {
  const escaped = escapePipes(name);
  return escaped.length <= width ? escaped : `${escaped.slice(0, width - 1)}…`;
}

// Ranked non-overlapping self-cost routines. Self costs are aggregated by name, so a symbol that
// appears in several objects (e.g. a per-detector plugin) is one row with its combined self cost.
function topRoutines(selfRows, count) {
  const byFunc = new Map();
  for (const [func, counts] of selfRows) {
    if (!isNamedRoutine(func)) {
      continue;
    }
    byFunc.set(func, (byFunc.get(func) || 0) + cest(counts));
  }
  return [...byFunc.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
}

// Full markdown section for one profile: category table + top-routines table.
function renderProfile({ title, config, inclTotal, inclRows, selfRows }) {
  const totalCest = cest(inclTotal);
  const rows = collectRows(config, inclRows, selfRows);
  const routines = topRoutines(selfRows, config.top_routines || 10);
  // Inclusive cost per routine (summed by name, like the self side), so the routines table can show
  // % of run (inclusive) next to Self %.
  const inclByFunc = new Map();
  for (const [func, counts] of inclRows) {
    inclByFunc.set(func, (inclByFunc.get(func) || 0) + cest(counts));
  }

  const lines = [`### ${title}`, ""];
  lines.push(
    `Program totals: **${mcycles(totalCest)} Mcycles** (CEst), ${mcycles(inclTotal.Ir || 0)} Minstr (Ir). ` +
      "**% of run** is inclusive (self + callees) and overlaps between categories, so it does not sum to " +
      "100%; **Self %** is the cycles executed directly in the entry function(s), which is non-overlapping.",
  );
  lines.push("");
  lines.push("| Category | Entry symbol(s) | CEst (Mcycles) | % of run | Self % |");
  lines.push("|----------|-----------------|---------------:|---------:|-------:|");
  for (const row of rows) {
    lines.push(
      `| ${row.label} | \`${row.symbol}\` | ${mcycles(row.incl)} | ` +
        `${percent(row.incl, totalCest)}% | ${percent(row.self, totalCest)}% |`,
    );
  }
  lines.push("");
  lines.push(`### Top ${routines.length} routines by self time (CEst)`, "");
  lines.push("Ranked by **Self %** (cycles executed directly in the routine); **% of run** is inclusive.");
  lines.push("");
  lines.push("| # | Routine | Self (Mcycles) | Self % | % of run |");
  lines.push("|---|---------|---------------:|-------:|---------:|");
  routines.forEach(([func, value], index) => {
    const incl = inclByFunc.has(func) ? inclByFunc.get(func) : value;
    lines.push(
      `| ${index + 1} | \`${shorten(func)}\` | ${mcycles(value)} | ` +
        `${percent(value, totalCest)}% | ${percent(incl, totalCest)}% |`,
    );
  });
  lines.push("");

  const structured = {
    total: { cest: totalCest, ir: inclTotal.Ir || 0 },
    categories: rows,
    top_routines: routines.map(([routine, value]) => ({
      routine,
      self: value,
      incl: inclByFunc.has(routine) ? inclByFunc.get(routine) : value,
    })),
  };
  return { markdown: lines.join("\n"), structured };
}

function qcachegrindGuide() {
  return [
    "### Reading a profile with qcachegrind",
    "",
    "Each run attaches its `callgrind.out.*` file. Open it with **qcachegrind** (Qt) or **kcachegrind** " +
      "(KDE). The profiles are dumped with `--dump-instr=yes` and `--collect-jumps=yes`, so per-line and " +
      "per-instruction annotation and jump/branch arrows are available.",
    "",
    "1. **Install a viewer.** macOS: `brew install qcachegrind graphviz`. Debian/Ubuntu: " +
      "`apt-get install kcachegrind graphviz`. Fedora/AlmaLinux: `dnf install kcachegrind graphviz`.",
    "2. **Open it:** `qcachegrind callgrind.out.<name>` (or File → Open).",
    "3. **Pick the cost type** in the toolbar. Cache and branch simulation are on, so **`CEst`** matches " +
      "the tables above; `Ir` is the simpler default. Each row shows `Incl.` (self + callees) and `Self`.",
    "4. **Find hotspots** in the **Flat Profile**: sort by `Self` for routines doing the work, or `Incl.` " +
      "for whole subtrees. Use the **Callers** panel to see who calls a hot routine.",
    "5. **Split by class or object** with **Grouping → Class / ELF Object** to separate libraries.",
    "",
    "Unresolved `0x…` routines come from objects without symbols; build those with debug symbols to name them.",
    "",
  ].join("\n");
}

// Report mode: merge the partial JSON files, write summary.md + a CSV, and return the paths.
function createReport({ inputDirectory, outputDirectory }) {
  ensureDirectory(outputDirectory);
  const partials = walkJsonFiles(inputDirectory)
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const sections = ["## Callgrinder profiles", ""];
  const csv = ["profile,category,symbol,cest,incl_percent,self_percent"];
  for (const partial of partials) {
    sections.push(partial.markdown, "");
    const total = partial.total && partial.total.cest ? partial.total.cest : 0;
    for (const row of partial.categories || []) {
      csv.push(
        [partial.name, row.label, row.symbol, row.incl, percent(row.incl, total), percent(row.self, total)]
          .map((field) => `"${String(field).replace(/"/g, '""')}"`)
          .join(","),
      );
    }
  }
  sections.push(qcachegrindGuide());

  const summaryFile = path.join(outputDirectory, "summary.md");
  const csvFile = path.join(outputDirectory, "categories.csv");
  const jsonFile = path.join(outputDirectory, "callgrinder.json");
  fs.writeFileSync(summaryFile, `${sections.join("\n")}\n`, "utf8");
  fs.writeFileSync(csvFile, `${csv.join("\n")}\n`, "utf8");
  fs.writeFileSync(jsonFile, `${JSON.stringify(partials, null, 2)}\n`, "utf8");
  return { summaryFile, csvFile, jsonFile, count: partials.length };
}

module.exports = { createReport, qcachegrindGuide, renderProfile, topRoutines };
