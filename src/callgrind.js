// Parsing and running for Valgrind's callgrind tool. Ported from the tested GEMC profile_summary.py.
//
// Cost is reported as CEst (cycle estimation), the derived event KCachegrind / qcachegrind show:
//     CEst = Ir + 10 * (I1mr + D1mr + D1mw) + 100 * (ILmr + DLmr + DLmw)
// so callgrind must be run with --cache-sim=yes. Without the cache events CEst falls back to Ir.

const { spawnSync } = require("node:child_process");

const CACHE_L1 = ["I1mr", "D1mr", "D1mw"];
const CACHE_LL = ["ILmr", "DLmr", "DLmw"];

const DEFAULT_CALLGRIND_ARGS = [
  "--dump-instr=yes",
  "--collect-jumps=yes",
  "--skip-plt=yes",
  "--cache-sim=yes",
  "--branch-sim=yes",
];

// Cycle estimation from raw callgrind event counts.
function cest(counts) {
  const l1 = CACHE_L1.reduce((sum, event) => sum + (counts[event] || 0), 0);
  const ll = CACHE_LL.reduce((sum, event) => sum + (counts[event] || 0), 0);
  return (counts.Ir || 0) + 10 * l1 + 100 * ll;
}

// Reduce a callgrind "file:function (Nx) [object]" location to a readable routine name. Trailing
// [object] and the call-count (12,345x) suffix are removed, and an unresolved bare address is
// labelled with its object instead of a bare hex.
function parseLocation(location) {
  let object = null;
  let previous = null;
  while (previous !== location) {
    previous = location;
    const match = location.match(/\s*\[([^\]]*)\]\s*$/);
    if (match) {
      if (object === null) {
        object = match[1];
      }
      location = location.slice(0, match.index);
    }
    location = location.replace(/\s*\(\s*[\d,]+x\s*\)\s*$/, "").replace(/\s+$/, "");
  }

  // The location is 'file:function'. File paths carry no '::', while the function may, so the
  // separator is the first ':' that is not part of a '::' token.
  let func = location;
  let file = null;
  for (let index = 0; index < location.length; index += 1) {
    if (location[index] !== ":") {
      continue;
    }
    const before = index > 0 ? location[index - 1] : "";
    const after = index + 1 < location.length ? location[index + 1] : "";
    if (before !== ":" && after !== ":") {
      file = location.slice(0, index).trim();
      func = location.slice(index + 1);
      break;
    }
  }
  func = func.trim();

  if (/^0x[0-9a-fA-F]+$/.test(func)) {
    func = object ? `${func} in ${object.split("/").pop()}` : `${func} (unresolved)`;
  }
  const known = (value) => value && value !== "???" && value !== "??";
  const source = known(file) ? file.split("/").pop() : known(object) ? object.split("/").pop() : null;
  return { func, source };
}

function locationToFunc(location) {
  return parseLocation(location).func;
}

// Read incoming call arcs, retaining object identities so walking callers cannot connect unrelated
// copies of a symbol. Compressed name IDs are shared between caller/callee records of the same kind.
function parseCallGraph(text) {
  const functions = new Map();
  const objects = new Map();
  const files = new Map();
  const calls = new Map();
  const nodes = new Map();
  let object = "";
  let file = "";
  let caller = null;
  let calleeObject = null;
  let calleeFile = null;
  let callee = null;
  const resolve = (value, names) => {
    const match = value.match(/^\((\d+)\)(?:\s+(.*))?$/);
    if (!match) {
      return value;
    }
    if (match[2] !== undefined) {
      names.set(match[1], match[2]);
    }
    if (!names.has(match[1])) {
      throw new Error(`undefined Callgrind name ID: ${value}`);
    }
    return names.get(match[1]);
  };
  // Raw fn/cfn records contain only a symbol. Supply a file separator so single colons inside
  // demangled symbols (e.g. [abi:cxx11]) cannot be mistaken for a source-file separator.
  const name = (func, owner) => locationToFunc(`???:${func}${owner ? ` [${owner}]` : ""}`);
  const node = (func, owner, source) => {
    const routine = name(func, owner);
    const id = JSON.stringify([owner, routine]);
    if (!nodes.has(id)) {
      nodes.set(id, { routine, object: owner, files: new Set(), callers: new Map() });
    }
    if (source && source !== "???" && source !== "??") {
      nodes.get(id).files.add(source);
    }
    return id;
  };
  for (const line of text.split("\n")) {
    const match = line.match(/^(ob|cob|fl|fi|fe|cfl|cfi|cfe|fn|cfn|calls)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key === "ob") {
      object = resolve(value, objects);
    } else if (key === "cob") {
      calleeObject = resolve(value, objects);
    } else if (["fl", "fi", "fe", "cfl", "cfi", "cfe"].includes(key)) {
      const source = resolve(value, files);
      if (key === "fl") {
        file = source;
      } else if (key === "cfl") {
        calleeFile = source;
      }
    } else if (key === "fn") {
      caller = node(resolve(value, functions), object, file);
      const func = nodes.get(caller).routine;
      if (!calls.has(func)) {
        calls.set(func, 0);
      }
      callee = null;
      calleeObject = null;
      calleeFile = null;
    } else if (key === "cfn") {
      callee = resolve(value, functions);
    } else if (callee !== null) {
      const count = value.match(/^\d+/);
      if (!count) {
        throw new Error(`invalid Callgrind call count: ${value}`);
      }
      const target = node(callee, calleeObject ?? object, calleeFile);
      const entry = nodes.get(target);
      const callCount = Number(count[0]);
      calls.set(entry.routine, (calls.get(entry.routine) || 0) + callCount);
      if (caller !== null && callCount > 0) {
        entry.callers.set(caller, (entry.callers.get(caller) || 0) + callCount);
      }
    }
  }
  return { nodes, callsByFunc: calls };
}

function parseCallCounts(text) {
  return parseCallGraph(text).callsByFunc;
}

// Drop callgrind_annotate summary artifacts (e.g. "events annotated") that are not routines.
function isNamedRoutine(func) {
  if (func.includes("::") || func.includes("(") || func.includes("0x")) {
    return true;
  }
  return !func.trim().includes(" ");
}

// Parse callgrind_annotate output into { total, rows: [[func, counts, { source }], ...] }.
function parseAnnotate(text) {
  // callgrind_annotate may print a percentage after each count (e.g. "12,345 (6.7%)"); drop those.
  text = text.replace(/\(\s*[\d.]+%\)/g, " ");

  let events = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("Events shown:")) {
      events = line.slice("Events shown:".length).trim().split(/\s+/).filter(Boolean);
      break;
    }
  }
  if (!events || events.length === 0) {
    throw new Error("no 'Events shown:' header in callgrind_annotate output");
  }

  const numeric = /^[\d,]+$|^\.$/;
  let total = null;
  let inFunctionTable = false;
  const rows = [];
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens[events.length] === "file:function") {
      inFunctionTable = true;
      continue;
    }
    // Only read the flat function table. Later source annotations contain both direct instruction
    // costs and inclusive call-site costs; treating those as routines double counts execution.
    if (inFunctionTable && rows.length > 0 && !numeric.test(tokens[0] || "")) {
      break;
    }
    if (tokens.length <= events.length) {
      continue;
    }
    const countTokens = tokens.slice(0, events.length);
    if (!countTokens.every((token) => numeric.test(token))) {
      continue;
    }
    const counts = {};
    events.forEach((event, index) => {
      const token = countTokens[index];
      counts[event] = token === "." ? 0 : parseInt(token.replace(/,/g, ""), 10);
    });
    const location = tokens.slice(events.length).join(" ");
    if (location.endsWith("PROGRAM TOTALS")) {
      total = counts;
      continue;
    }
    if (inFunctionTable) {
      const { func, source } = parseLocation(location);
      rows.push([func, counts, { source }]);
    }
  }
  if (total === null) {
    throw new Error("no 'PROGRAM TOTALS' row in callgrind_annotate output");
  }
  if (!inFunctionTable) {
    throw new Error("no 'file:function' table in callgrind_annotate output");
  }
  return { total, rows };
}

// Run callgrind_annotate and return its stdout. inclusive=true adds callee costs to each function
// (category totals); inclusive=false gives self cost only (hottest individual routines).
function annotate(file, { inclusive = true } = {}) {
  const args = [
    `--inclusive=${inclusive ? "yes" : "no"}`,
    "--auto=no",
    "--tree=none",
    "--threshold=100",
    file,
  ];
  const result = spawnSync("callgrind_annotate", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`callgrind_annotate exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

// Run a command under callgrind, writing the profile to outFile. The command is a shell string
// (properly quoted by the caller); `exec` makes bash replace itself so callgrind profiles the
// target binary directly rather than the shell.
function runCallgrind({ command, outFile, extraArgs = [], workingDirectory = ".", timeoutSeconds = 0 }) {
  if (process.platform === "win32") {
    throw new Error("Callgrinder profiling requires a POSIX shell (Valgrind is not available on Windows)");
  }
  // bash execs valgrind, which runs the command's program as its direct child, so ONLY that program is
  // profiled — not the launching shell, and not the program's own child processes (valgrind does not
  // trace children by default). The command is a shell string so bash parses its quoted arguments; it
  // must therefore be a program invocation, e.g. `gemc card.yaml -n 100` (not a wrapper that execs it).
  const valgrind = [
    "valgrind",
    "--tool=callgrind",
    `--callgrind-out-file=${outFile}`,
    ...DEFAULT_CALLGRIND_ARGS,
    ...extraArgs,
  ].join(" ");
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", `exec ${valgrind} ${command}`], {
    cwd: workingDirectory,
    stdio: "inherit",
    timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`command failed under valgrind (exit ${result.status}): ${command}`);
  }
  return outFile;
}

module.exports = {
  DEFAULT_CALLGRIND_ARGS,
  annotate,
  cest,
  isNamedRoutine,
  locationToFunc,
  parseAnnotate,
  parseCallCounts,
  parseCallGraph,
  runCallgrind,
};
