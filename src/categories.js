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

// Self cost per function name, SUMMED across rows. Each executed instruction is counted in exactly one
// self row, so a name's self cost is the sum over all its rows and is bounded by the program total —
// even when the same demangled name lives in several objects (a per-detector plugin, a COMDAT copy).
function selfByName(selfRows) {
  const map = new Map();
  for (const [func, counts] of selfRows) {
    map.set(func, (map.get(func) || 0) + cest(counts));
  }
  return map;
}

// Inclusive cost per function name, taken as the MAX across rows, not the sum. The same demangled name
// can appear in several objects (COMDAT template copies, per-plugin instantiations); their inclusive
// subtrees overlap through shared callees, or nest (a task dispatcher calling itself deeper in the
// tree), so summing them double counts and pushes the inclusive share past 100%. The largest single
// row is the dominant subtree and is bounded by the program total.
function inclByName(inclRows) {
  const map = new Map();
  for (const [func, counts] of inclRows) {
    map.set(func, Math.max(map.get(func) || 0, cest(counts)));
  }
  return map;
}

// Return [{ label, symbol, incl, self }, ...] for each category found in the profile, sorted by
// inclusive cost. Inclusive cost (entry + callees) overlaps between categories; self cost (cycles
// directly in the entry function(s)) is non-overlapping. Both use the same matched symbols.
function collectRows(config, inclRows, selfRows) {
  const selfMap = selfByName(selfRows);
  const inclMap = inclByName(inclRows);
  const selfOf = (names) => [...new Set(names)].reduce((sum, name) => sum + (selfMap.get(name) || 0), 0);
  const inclOf = (names) => [...new Set(names)].reduce((sum, name) => sum + (inclMap.get(name) || 0), 0);

  const table = [];
  for (const category of config.categories) {
    if (category.match) {
      const pattern = new RegExp(category.match);
      const names = inclRows.filter(([func]) => pattern.test(func)).map(([func]) => func);
      table.push({
        label: category.label || category.match,
        symbol: category.match,
        incl: inclOf(names),
        self: selfOf(names),
      });
    } else {
      const pattern = new RegExp(category.discover);
      const family = category.family || "Discovered";
      const namesByClass = new Map();
      for (const [func] of inclRows) {
        const found = func.match(pattern);
        if (found && found[1]) {
          const klass = found[1];
          if (!namesByClass.has(klass)) {
            namesByClass.set(klass, []);
          }
          namesByClass.get(klass).push(func);
        }
      }
      // Display method: an explicit `method` (useful when `discover` uses regex alternation) or the
      // text after "::" in the pattern.
      const method =
        category.method || category.discover.split("::").slice(1).join("::").replace(/\\b/g, "") || category.discover;
      const rows = [...namesByClass.entries()].map(([klass, names]) => ({
        label: `${family}: ${klass}`,
        symbol: `${klass}::${method}`,
        incl: inclOf(names),
        self: selfOf(names),
      }));
      rows.sort((a, b) => b.incl - a.incl);
      table.push(...rows);
    }
  }
  table.sort((a, b) => b.incl - a.incl);
  return table;
}

module.exports = { DEFAULT_CONFIG, collectRows, inclByName, loadConfig, selfByName };
