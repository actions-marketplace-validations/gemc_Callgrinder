// Discover mode: turn a benchmarks list into a GitHub Actions job matrix (one job per benchmark).

function parseBenchmarks(source) {
  if (!source || !source.trim()) {
    return [];
  }
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error("benchmarks must be a JSON array");
  }
  return parsed.map((benchmark, index) => {
    if (!benchmark || typeof benchmark.command !== "string") {
      throw new Error(`benchmark ${index} needs a string "command"`);
    }
    return {
      name: benchmark.name || `profile-${index + 1}`,
      command: benchmark.command,
      events: benchmark.events === undefined ? "" : String(benchmark.events),
      config: benchmark.config || "",
      working_directory: benchmark.working_directory || ".",
      timeout_seconds: benchmark.timeout_seconds === undefined ? "" : String(benchmark.timeout_seconds),
    };
  });
}

function buildMatrix(benchmarks) {
  return { include: benchmarks };
}

module.exports = { buildMatrix, parseBenchmarks };
