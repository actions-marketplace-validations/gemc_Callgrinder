// Rendering of the per-profile summary and aggregation for report mode.

const fs = require("node:fs");
const path = require("node:path");
const { cest, isNamedRoutine } = require("./callgrind");
const { collectRows, inclByName, selfByName } = require("./categories");
const { ensureDirectory, walkJsonFiles } = require("./utils");

const mcycles = (value) =>
  (value / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = (value, total) => (total ? (100 * value) / total : 0).toFixed(2);
const escapePipes = (text) => text.replace(/\|/g, "\\|");

function shorten(name, width = 90) {
  const escaped = escapePipes(name);
  return escaped.length <= width ? escaped : `${escaped.slice(0, width - 1)}…`;
}

// Select the top N routines by direct work, summing self costs across repeated names.
function topRoutines(selfRows, count) {
  const byFunc = selfByName(selfRows.filter(([func]) => isNamedRoutine(func)));
  return [...byFunc.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
}

// Full markdown section for one profile: category table + top-routines table.
function renderProfile({ title, config, inclTotal, inclRows, selfRows }) {
  const totalCest = cest(inclTotal);
  const rows = collectRows(config, inclRows, selfRows);
  const inclByFunc = inclByName(inclRows);
  const routines = topRoutines(selfRows, config.top_routines || 10)
    .map(([func, self]) => [func, inclByFunc.get(func) ?? self])
    .sort((a, b) => b[1] - a[1]);
  const selfByFunc = selfByName(selfRows);

  const lines = [`### ${title}`, ""];
  lines.push(
    `Program totals: **${mcycles(totalCest)} Mcycles** (CEst), ${mcycles(inclTotal.Ir || 0)} Minstr (Ir). ` +
      "Percentages describe estimated CPU cycles, not elapsed time.",
  );
  lines.push("");
  lines.push(
    "Category **Inclusive %** includes callees, so the same work can appear in several rows. " +
      "These rows are not a partition of the run and must not be added. **Entry self %** counts only " +
      "work directly in the matched entry routines; category patterns can also overlap.",
    "",
  );
  lines.push("| Category | Entry symbol(s) | Inclusive (Mcycles) | Inclusive % (overlapping) | Entry self % |");
  lines.push("|----------|-----------------|--------------------:|--------------------------:|-------------:|");
  for (const row of rows) {
    lines.push(
      `| ${row.label} | \`${row.symbol}\` | ${mcycles(row.incl)} | ` +
        `${percent(row.incl, totalCest)}% | ${percent(row.self, totalCest)}% |`,
    );
  }
  lines.push("");
  lines.push(`### Top ${routines.length} routines by self cost, ordered by inclusive cost (CEst)`, "");
  lines.push(
    "Selected by highest **Self %**, then ordered by **% of run**, largest first " +
      "(inclusive: routine + callees). " +
      "Inclusive shares overlap and must not be added. **Self %** counts only cycles executed " +
      "directly in each routine; those shares sum to at most 100% (apart from rounding).",
  );
  lines.push("");
  lines.push("| # | Routine | Self (Mcycles) | % of run | Self % |");
  lines.push("|---|---------|---------------:|---------:|-------:|");
  routines.forEach(([func, incl], index) => {
    const self = selfByFunc.get(func) || 0;
    lines.push(
      `| ${index + 1} | \`${shorten(func)}\` | ${mcycles(self)} | ` +
        `${percent(incl, totalCest)}% | ${percent(self, totalCest)}% |`,
    );
  });
  lines.push("");
  const listedCost = routines.reduce((sum, [func]) => sum + (selfByFunc.get(func) || 0), 0);
  lines.push(
    `Self cost of listed routines: **${percent(listedCost, totalCest)}%** of the run. ` +
      `Self cost of remaining routines: **${percent(totalCest - listedCost, totalCest)}%**.`,
    "",
  );

  const structured = {
    total: { cest: totalCest, ir: inclTotal.Ir || 0 },
    categories: rows,
    top_routines: routines.map(([routine, incl]) => ({
      routine,
      self: selfByFunc.get(routine) || 0,
      incl,
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
