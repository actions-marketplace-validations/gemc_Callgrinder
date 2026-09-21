// Category configuration and aggregation.
//
// The config is JSON (native, zero-dependency, and it quotes regex backslashes cleanly). A category
// is either fixed or discovered:
//   { "label": "Track swimming", "match": "G4PropagatorInField::ComputeStep" }
//   { "family": "Digitization",  "discover": "([A-Za-z_]\\w*)::digitizeHit" }
// A `match` names one entry symbol. A `discover` regex captures a class in group 1, producing one row
// per class found (e.g. every detector's digitization plugin), each labelled "<family>: <class>".

const fs = require("node:fs");
const { cest } = require("./callgrind");

const DEFAULT_CONFIG = { cost: "CEst", top_routines: 10, categories: [] };

function loadConfig(source) {
  if (!source) {
    return { ...DEFAULT_CONFIG };
  }
  const text = source.trim().startsWith("{") ? source : fs.readFileSync(source, "utf8");
  const parsed = JSON.parse(text);
  const config = { ...DEFAULT_CONFIG, ...parsed };
  if (!Array.isArray(config.categories)) {
    throw new Error("config.categories must be an array");
  }
  for (const category of config.categories) {
    if (!category.match && !category.discover) {
      throw new Error(`category needs a "match" or "discover" pattern: ${JSON.stringify(category)}`);
    }
  }
  return config;
}

// Return [{ label, symbol, incl, self }, ...] for each category found in the profile, sorted by
// inclusive cost. Inclusive cost (entry + callees) overlaps between categories; self cost (cycles
// directly in the entry function(s)) is non-overlapping. Both use the same matched symbols.
function collectRows(config, inclRows, selfRows) {
  const selfByFunc = new Map();
  for (const [func, counts] of selfRows) {
    selfByFunc.set(func, (selfByFunc.get(func) || 0) + cest(counts));
  }
  const selfOf = (funcs) => funcs.reduce((sum, func) => sum + (selfByFunc.get(func) || 0), 0);

  const table = [];
  for (const category of config.categories) {
    if (category.match) {
      const pattern = new RegExp(category.match);
      const matched = inclRows.filter(([func]) => pattern.test(func));
      const incl = matched.reduce((sum, [, counts]) => sum + cest(counts), 0);
      const self = selfOf(matched.map(([func]) => func));
      table.push({ label: category.label || category.match, symbol: category.match, incl, self });
    } else {
      const pattern = new RegExp(category.discover);
      const family = category.family || "Discovered";
      const inclByClass = new Map();
      const funcsByClass = new Map();
      for (const [func, counts] of inclRows) {
        const found = func.match(pattern);
        if (found && found[1]) {
          const klass = found[1];
          inclByClass.set(klass, (inclByClass.get(klass) || 0) + cest(counts));
          if (!funcsByClass.has(klass)) {
            funcsByClass.set(klass, []);
          }
          funcsByClass.get(klass).push(func);
        }
      }
      // Display method: an explicit `method` (useful when `discover` uses regex alternation) or the
      // text after "::" in the pattern.
      const method =
        category.method || category.discover.split("::").slice(1).join("::").replace(/\\b/g, "") || category.discover;
      for (const [klass, incl] of [...inclByClass.entries()].sort((a, b) => b[1] - a[1])) {
        table.push({
          label: `${family}: ${klass}`,
          symbol: `${klass}::${method}`,
          incl,
          self: selfOf(funcsByClass.get(klass)),
        });
      }
    }
  }
  table.sort((a, b) => b.incl - a.incl);
  return table;
}

module.exports = { DEFAULT_CONFIG, collectRows, loadConfig };
