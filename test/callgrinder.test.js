const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cest, isNamedRoutine, locationToFunc, parseAnnotate } = require("../src/callgrind");
const { collectRows, loadConfig } = require("../src/categories");
const { renderProfile, topRoutines } = require("../src/report");
const { summarizeCallgrind } = require("../src/profile");

// A synthetic callgrind_annotate --inclusive output, with the (NN%) percentages callgrind adds.
const ANNOTATE = `Events shown:     Ir I1mr D1mr D1mw ILmr DLmr DLmw
--------------------------------------------------------------------------------
1,000,000,000 (100.0%)  0  0  0  0  0  0  PROGRAM TOTALS
--------------------------------------------------------------------------------
  400,000,000 (40.0%)  0  0  0  0  0  0  /o/G4PropagatorInField.cc:G4PropagatorInField::ComputeStep(G4FieldTrack&)
  120,000,000 (12.0%)  0  0  0  0  0  0  /o/gfield.cc:GField_AsciiMapFactory::GetFieldValue(double const*, double*) const (5,539,090x)
   80,000,000 (8.0%)  0  0  0  0  0  0  /o/flux.cc:GFluxDigitization::digitizeHit(GHit*, unsigned long) [/o/flux.gplugin]
    2,000,000 (0.2%)  0  0  0  0  0  0  events annotated
   50,000,000 (5.0%)  0  0  0  0  0  0  0x0000000009fe6140 (20x)
`;

test("cest applies the KCachegrind cache formula", () => {
  assert.equal(cest({ Ir: 100, I1mr: 1, D1mr: 1, ILmr: 1 }), 100 + 10 * 2 + 100 * 1);
});

test("percentages, call counts, objects, and unresolved addresses are cleaned", () => {
  assert.equal(locationToFunc("a.cc:Foo::Bar(int) const (5,539,090x)"), "Foo::Bar(int) const");
  assert.equal(locationToFunc("0x00000000118e8b70 (99x) [/o/libG4.so]"), "0x00000000118e8b70 in libG4.so");
  assert.equal(locationToFunc("0x0000000009fe6140 (20x)"), "0x0000000009fe6140 (unresolved)");
});

test("summary artifacts are filtered from routine lists", () => {
  assert.equal(isNamedRoutine("events annotated"), false);
  assert.equal(isNamedRoutine("__ieee754_atan2_fma"), true);
  assert.equal(isNamedRoutine("Foo::Bar(int, int)"), true);
});

test("parseAnnotate tolerates percentages and finds totals + rows", () => {
  const { total, rows } = parseAnnotate(ANNOTATE);
  assert.equal(cest(total), 1_000_000_000);
  const funcs = rows.map(([func]) => func);
  assert.ok(funcs.includes("G4PropagatorInField::ComputeStep(G4FieldTrack&)"));
  assert.ok(funcs.some((f) => f.startsWith("0x0000000009fe6140")));
});

test("category table reports inclusive and self costs from the two passes", () => {
  const incl = parseAnnotate(ANNOTATE).rows;
  const self = [
    ["GField_AsciiMapFactory::GetFieldValue(double const*, double*) const", { Ir: 40_000_000 }],
    ["G4PropagatorInField::ComputeStep(G4FieldTrack&)", { Ir: 1_000_000 }],
  ];
  const config = loadConfig(
    JSON.stringify({
      categories: [
        { label: "Track swimming", match: "G4PropagatorInField::ComputeStep" },
        { family: "Field evaluation", discover: "(GField_[A-Za-z0-9_]*)::GetFieldValue" },
        { family: "Digitization", discover: "([A-Za-z_]\\w*)::digitizeHit" },
      ],
    }),
  );
  const rows = collectRows(config, incl, self);
  const field = rows.find((r) => r.label.startsWith("Field evaluation"));
  assert.equal(field.incl, 120_000_000);
  assert.equal(field.self, 40_000_000);
  const swim = rows.find((r) => r.label === "Track swimming");
  assert.equal(swim.self, 1_000_000);
  assert.ok(rows.some((r) => r.label === "Digitization: GFluxDigitization"));
});

test("a symbol in several objects stays bounded: inclusive is max, self is summed", () => {
  // The same demangled symbol lives in two objects (a COMDAT template copy / per-plugin
  // instantiation), so it appears in two rows. Their inclusive subtrees overlap, so the per-symbol
  // inclusive is the dominant copy (max), never the sum (which would exceed 100%). Self instructions
  // are disjoint, so self is summed.
  const incl = [
    ["Dispatch::run()", { Ir: 850_000_000 }],
    ["Dispatch::run()", { Ir: 800_000_000 }],
  ];
  const self = [
    ["Dispatch::run()", { Ir: 200_000_000 }],
    ["Dispatch::run()", { Ir: 150_000_000 }],
  ];
  const config = loadConfig(JSON.stringify({ categories: [{ label: "Dispatch", match: "Dispatch::run" }] }));
  const [row] = collectRows(config, incl, self);
  assert.equal(row.incl, 850_000_000); // max, not the 1.65e9 sum
  assert.equal(row.self, 350_000_000); // sum of disjoint self costs
  assert.ok(row.self <= row.incl);
});

test("renderProfile emits both tables and excludes the artifact routine", () => {
  const { total, rows } = parseAnnotate(ANNOTATE);
  const config = loadConfig(JSON.stringify({ categories: [{ family: "F", discover: "(GField_\\w+)::GetFieldValue" }] }));
  const { markdown } = renderProfile({ title: "t", config, inclTotal: total, inclRows: rows, selfRows: rows });
  assert.match(markdown, /\| Category \| Entry symbol\(s\) \| CEst \(Mcycles\) \| % of run \| Self % \|/);
  assert.match(markdown, /Top \d+ routines by self time/);
  assert.doesNotMatch(markdown, /events annotated/);
});

test("topRoutines ranks by self cost and drops artifacts", () => {
  const rows = parseAnnotate(ANNOTATE).rows;
  const ranked = topRoutines(rows, 10).map(([func]) => func);
  assert.equal(ranked[0], "G4PropagatorInField::ComputeStep(G4FieldTrack&)");
  assert.ok(!ranked.includes("events annotated"));
});

test("summarizeCallgrind degrades gracefully when annotate fails", () => {
  // callgrind_annotate is not available in the test environment, so both passes fail; the summary
  // must be a visible diagnostic (with the file size), not a thrown error.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callgrinder-test-"));
  const file = path.join(dir, "callgrind.out.x");
  fs.writeFileSync(file, "");
  const result = summarizeCallgrind({
    name: "empty",
    callgrindFile: file,
    config: JSON.stringify({ categories: [] }),
    outputDirectory: dir,
  });
  assert.match(result.markdown, /Profile summary unavailable/);
  assert.match(result.markdown, /0 bytes/);
  assert.ok(fs.existsSync(result.partialFile));
});
