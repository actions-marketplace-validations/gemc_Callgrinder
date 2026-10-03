// Rendering of the per-profile summary and aggregation for report mode.

const fs = require("node:fs");
const path = require("node:path");
const { cest, isNamedRoutine } = require("./callgrind");
const { collectRows, inclByName, selfByName } = require("./categories");
const { callerInfo } = require("./callers");
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
function renderProfile({ title, config, inclTotal, inclRows, selfRows, callGraph, callsByFunc }) {
  callsByFunc = callGraph?.callsByFunc || callsByFunc || new Map();
  const totalCest = cest(inclTotal);
  const categoryRows = collectRows(config, inclRows, selfRows);
  const inclByFunc = inclByName(inclRows);
  const sourcesByFunc = new Map();
  for (const [func, , metadata] of [...selfRows, ...inclRows]) {
    if (metadata?.source) {
      if (!sourcesByFunc.has(func)) {
        sourcesByFunc.set(func, new Set());
      }
      sourcesByFunc.get(func).add(metadata.source);
    }
  }
  const callersOf = callerInfo(callGraph, config);
  const metadataOf = (names) => {
    const routines = [...new Set(names)];
    const sources = new Set(routines.flatMap((func) => [...(sourcesByFunc.get(func) || [])]));
    return {
      source: [...sources].sort().join(", ") || null,
      calls: routines.every((func) => callsByFunc.has(func))
        ? routines.reduce((sum, func) => sum + callsByFunc.get(func), 0) : null,
      ...callersOf(routines),
    };
  };
  const rows = categoryRows.map((row) => ({ ...row, ...metadataOf(row.routines) }));
  const routines = topRoutines(selfRows, config.top_routines || 10)
    .map(([routine, self]) => ({
      routine,
      self,
      incl: inclByFunc.get(routine) ?? self,
      categories: rows.filter((row) => row.routines.includes(routine)).map((row) => row.label),
      ...metadataOf([routine]),
    }))
    .sort((a, b) => b.incl - a.incl);

  // Both tables share the renderer so their columns, units, and formatting always agree.
  const table = (entries) => {
    const lines = [
      "| # | Category | Source / package | Routine / entry symbol(s) | Inclusive (Mcycles) | " +
        "Self (Mcycles) | % of run | Self % | Calls | Direct callers (calls) | Nearest project caller |",
      "|---|----------|------------------|---------------------------|--------------------:|" +
        "---------------:|---------:|-------:|------:|------------------------|------------------------|",
    ];
    entries.forEach((row, index) => {
      const category = row.label || row.categories.join(", ") || "—";
      const source = row.source ? `\`${escapePipes(row.source)}\`` : "—";
      const direct = row.direct_callers.map((caller) =>
        `\`${shorten(caller.routine)}\` (${caller.calls.toLocaleString("en-US")})`).join("<br>") || "—";
      const project = row.nearest_project_callers.map((caller) =>
        `\`${shorten(caller.routine)}\` (${caller.distance} ${caller.distance === 1 ? "hop" : "hops"})`
      ).join("<br>") || "—";
      lines.push(
        `| ${index + 1} | ${escapePipes(category)} | ${source} | ` +
          `\`${shorten(row.routine || row.symbol)}\` | ${mcycles(row.incl)} | ${mcycles(row.self)} | ` +
          `${percent(row.incl, totalCest)}% | ${percent(row.self, totalCest)}% | ` +
          `${row.calls === null ? "—" : row.calls.toLocaleString("en-US")} | ${direct} | ${project} |`,
      );
    });
    return lines;
  };

  const lines = [`### ${title}`, ""];
  lines.push(
    `Program totals: **${mcycles(totalCest)} Mcycles** (CEst), ${mcycles(inclTotal.Ir || 0)} Minstr (Ir). ` +
      "Percentages describe estimated CPU cycles, not elapsed time.",
  );
  lines.push("");
  lines.push(
    "Both tables use the same columns. Categories group the configured entry routines; the top table " +
      "lists individual routines. **% of run** includes callees and overlaps, so it must not be added. " +
      "**Self %** counts only direct work; overlapping category patterns can repeat that work.",
    "Source / package shows filenames without paths, falling back to binary or library names. " +
      "**Calls** sums recorded incoming calls, including recursion. **Direct callers** lists each caller " +
      "with its recorded calls. **Nearest project caller** walks upstream past runtime functions " +
      "and shows the first project caller on each branch, with its distance in call-graph hops. " +
      "Project ownership is inferred from runtime names or configured with project_callers; " +
      "— means no match or unavailable data.",
    "",
  );
  lines.push(...table(rows));
  lines.push("");
  lines.push(`### Top ${routines.length} routines by self cost, ordered by inclusive cost (CEst)`, "");
  lines.push(
    "Selected by highest **Self %**, then ordered by **% of run**, largest first " +
      "(inclusive: routine + callees). " +
      "Inclusive shares overlap and must not be added. **Self %** counts only cycles executed " +
      "directly in each routine; those shares sum to at most 100% (apart from rounding).",
  );
  lines.push("");
  lines.push(...table(routines));
  lines.push("");
  const listedCost = routines.reduce((sum, row) => sum + row.self, 0);
  lines.push(
    `Self cost of listed routines: **${percent(listedCost, totalCest)}%** of the run. ` +
      `Self cost of remaining routines: **${percent(totalCest - listedCost, totalCest)}%**.`,
    "",
  );

  const structured = {
    total: { cest: totalCest, ir: inclTotal.Ir || 0 },
    categories: rows,
    top_routines: routines,
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
