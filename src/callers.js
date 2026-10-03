// Caller attribution from the observed call graph, independent of any application or framework.
const path = require("node:path");

const SYSTEM_OBJECT =
  /^(?:lib(?:c|m|mvec|pthread|dl|rt|gcc_s|stdc\+\+|c\+\+|c\+\+abi|System|objc)(?:[.-]|$)|ld[.-])/;
const SYSTEM_SYMBOL = /^(?:std::|__gnu_cxx::|__cxxabiv1::|_dl_|0x)/;
const SYSTEM_SOURCE = /^\/(?:usr\/include|usr\/src\/(?:glibc|gcc)|build\/glibc)(?:\/|$)/;
const known = (value) => value && value !== "???" && value !== "??";

// Demangled templates may include a return type. Classify the callable's namespace rather than
// treating an application function returning std::string as part of the C++ runtime.
function callableName(routine) {
  let depth = 0;
  let start = 0;
  let end = routine.length;
  for (let index = 0; index < routine.length; index += 1) {
    const char = routine[index];
    if (char === "<") {
      depth += 1;
    } else if (char === ">" && depth > 0) {
      depth -= 1;
    } else if (char === "(" && depth === 0) {
      if (routine.slice(start, index).endsWith("operator") && routine.slice(index, index + 2) === "()") {
        index += 1;
        continue;
      }
      end = index;
      break;
    } else if (/\s/.test(char) && depth === 0 && !routine.slice(start, index).includes("operator")) {
      start = index + 1;
    }
  }
  return routine.slice(start, end).trim();
}

function callerInfo(callGraph, config = {}) {
  const nodes = callGraph?.nodes || new Map();
  const patterns = config.project_callers?.map((pattern) => new RegExp(pattern));
  const byRoutine = new Map();
  for (const [id, node] of nodes) {
    if (!byRoutine.has(node.routine)) {
      byRoutine.set(node.routine, []);
    }
    byRoutine.get(node.routine).push(id);
  }
  const isProject = (node) => {
    if (patterns) {
      const fields = [node.routine, node.object, ...node.files];
      return patterns.some((pattern) => fields.some((field) => pattern.test(field)));
    }
    if (!known(node.routine) || SYSTEM_SYMBOL.test(callableName(node.routine))) {
      return false;
    }
    if (known(node.object)) {
      return !SYSTEM_OBJECT.test(path.basename(node.object));
    }
    return [...node.files].some((file) => !SYSTEM_SOURCE.test(file));
  };

  // Each branch stops at its first project caller. A visited set bounds recursion and runtime cycles.
  // Distances describe observed graph edges; aggregate profiles do not establish dynamic stack traces.
  const nearestCache = new Map();
  const nearest = (routine) => {
    if (nearestCache.has(routine)) {
      return nearestCache.get(routine);
    }
    const targets = byRoutine.get(routine) || [];
    const visited = new Set(targets);
    const queue = targets.flatMap((id) => [...nodes.get(id).callers.keys()].map((caller) => [caller, 1]));
    const result = [];
    for (let index = 0; index < queue.length; index += 1) {
      const [id, distance] = queue[index];
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const node = nodes.get(id);
      if (isProject(node)) {
        const source = known(node.object) ? node.object : [...node.files].sort()[0] || "";
        result.push({ routine: node.routine, source: path.basename(source) || null, distance });
      } else {
        for (const caller of node.callers.keys()) {
          queue.push([caller, distance + 1]);
        }
      }
    }
    nearestCache.set(routine, result);
    return result;
  };

  return (routines) => {
    const direct = new Map();
    const project = new Map();
    for (const routine of new Set(routines)) {
      for (const id of byRoutine.get(routine) || []) {
        for (const [caller, count] of nodes.get(id).callers) {
          if (count === 0) {
            continue;
          }
          const name = nodes.get(caller).routine;
          direct.set(name, (direct.get(name) || 0) + count);
        }
      }
      for (const entry of nearest(routine)) {
        const key = JSON.stringify([entry.routine, entry.source]);
        if (!project.has(key) || entry.distance < project.get(key).distance) {
          project.set(key, entry);
        }
      }
    }
    return {
      direct_callers: [...direct].map(([routine, calls]) => ({ routine, calls }))
        .sort((a, b) => b.calls - a.calls || a.routine.localeCompare(b.routine)),
      nearest_project_callers: [...project.values()]
        .sort((a, b) => a.distance - b.distance || a.routine.localeCompare(b.routine) ||
          String(a.source).localeCompare(String(b.source))),
    };
  };
}

module.exports = { callableName, callerInfo };
