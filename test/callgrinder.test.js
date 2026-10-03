const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  cest, isNamedRoutine, locationToFunc, parseAnnotate, parseCallCounts, parseCallGraph,
} = require("../src/callgrind");
const { callerInfo } = require("../src/callers");
const { collectRows, loadConfig } = require("../src/categories");
const { createReport, renderProfile, topRoutines } = require("../src/report");
const { summarizeCallgrind } = require("../src/profile");

// A synthetic callgrind_annotate --inclusive output, with the (NN%) percentages callgrind adds.
const ANNOTATE = `Events shown:     Ir I1mr D1mr D1mw ILmr DLmr DLmw
--------------------------------------------------------------------------------
1,000,000,000 (100.0%)  0  0  0  0  0  0  PROGRAM TOTALS
--------------------------------------------------------------------------------
Ir I1mr D1mr D1mw ILmr DLmr DLmw file:function
--------------------------------------------------------------------------------
  400,000,000 (40.0%)  0  0  0  0  0  0  /o/G4PropagatorInField.cc:G4PropagatorInField::ComputeStep(G4FieldTrack&)
  120,000,000 (12.0%)  0  0  0  0  0  0  /o/gfield.cc:GField_AsciiMapFactory::GetFieldValue(double const*, double*) const (5,539,090x)
   80,000,000 (8.0%)  0  0  0  0  0  0  /o/flux.cc:GFluxDigitization::digitizeHit(GHit*, unsigned long) [/o/flux.gplugin]
    2,000,000 (0.2%)  0  0  0  0  0  0  events annotated
   50,000,000 (5.0%)  0  0  0  0  0  0  0x0000000009fe6140 (20x)
`;

// Project -> C++ runtime -> C runtime, with a second project caller, recursion, and a runtime cycle.
const CALL_GRAPH = `ob=(1) /home/demo/myapp
fl=(1) /home/demo/app.cc
fn=(1) Demo::load()
cob=(2) /usr/lib/libstdc++.so.6
cfl=(2) /usr/include/c++/istream
cfn=(2) std::__istream_extract()
calls=20 1
1 20
ob=(2)
fl=(2)
fn=(2)
cfn=(3) void std::helper<char>()
calls=20 1
1 20
fn=(3)
fi=(3) /build/glibc/stdlib/strtod_l.c
cfl=(3)
cob=(3) /lib/libc.so.6
cfn=(4) ____strtod_l_internal
calls=30 1
1 30
ob=(3)
fl=(3)
fn=(4)
cfn=(4)
calls=2 1
1 2
cob=(2)
cfn=(2)
calls=1 1
1 1
ob=(4) /opt/physics/libPhysics.so
fl=(4) /home/physics/model.cc
fn=(5) Physics::load()
cob=(3)
cfn=(4)
calls=5 1
1 5
fn=(6) unusedCaller
cfn=(4)
calls=0 1
1 0
`;

test("direct caller counts and nearest project callers follow separate runtime branches", () => {
  const graph = parseCallGraph(CALL_GRAPH);
  const info = callerInfo(graph)(["____strtod_l_internal"]);
  assert.equal(graph.callsByFunc.get("____strtod_l_internal"), 37);
  assert.deepEqual(info.direct_callers, [
    { routine: "void std::helper<char>()", calls: 30 },
    { routine: "Physics::load()", calls: 5 },
    { routine: "____strtod_l_internal", calls: 2 },
  ]);
  assert.deepEqual(info.nearest_project_callers, [
    { routine: "Physics::load()", source: "libPhysics.so", distance: 1 },
    { routine: "Demo::load()", source: "myapp", distance: 3 },
  ]);
  assert.deepEqual(callerInfo(graph)(["std::__istream_extract()"]).nearest_project_callers, [
    { routine: "Demo::load()", source: "myapp", distance: 1 },
    { routine: "Physics::load()", source: "libPhysics.so", distance: 2 },
  ]);
});

test("project caller patterns match arbitrary symbols, source paths, or owning objects", () => {
  const graph = parseCallGraph(CALL_GRAPH);
  for (const pattern of ["^Demo::", "/home/demo/app\\.cc$", "/home/demo/myapp$"]) {
    const config = loadConfig(JSON.stringify({ project_callers: [pattern] }));
    const info = callerInfo(graph, config)(["____strtod_l_internal"]);
    assert.deepEqual(info.nearest_project_callers, [{ routine: "Demo::load()", source: "myapp", distance: 3 }]);
    assert.equal(info.direct_callers.reduce((sum, row) => sum + row.calls, 0), 37);
  }
  assert.deepEqual(callerInfo(graph, { project_callers: [] })(["____strtod_l_internal"])
    .nearest_project_callers, []);
  assert.throws(() => loadConfig('{"project_callers":"Demo"}'), /array of regex strings/);
  assert.throws(() => loadConfig('{"project_callers":[7]}'), /array of regex strings/);
  assert.throws(() => loadConfig('{"project_callers":["["]}'), /Invalid regular expression/);
});

test("same-named functions in different objects do not create false upstream paths", () => {
  const graph = parseCallGraph(`ob=/o/app
fn=ProjectA::run()
cob=/o/libOne.so
cfn=helper
calls=3 1
1 3
fn=ProjectB::run()
cob=/o/libTwo.so
cfn=helper
calls=7 1
1 7
ob=/o/libOne.so
fn=helper
cob=/lib/libc.so.6
cfn=target
calls=3 1
1 3
ob=/o/libTwo.so
fn=helper
cob=/lib/libc.so.6
cfn=unrelated
calls=7 1
1 7
`);
  const info = callerInfo(graph, { project_callers: ["^Project"] })(["target"]);
  assert.deepEqual(info.direct_callers, [{ routine: "helper", calls: 3 }]);
  assert.deepEqual(info.nearest_project_callers, [{ routine: "ProjectA::run()", source: "app", distance: 2 }]);
});

test("project functions returning standard types remain project callers through inlined runtime code", () => {
  const graph = parseCallGraph(`ob=/o/app
fn=std::function<void()> App::read[abi:cxx11]()
cfn=void std::helper<char>()
calls=3 1
1 3
fn=void std::helper<char>()
cob=/lib/libc.so.6
cfn=target
calls=3 1
1 3
`);
  const info = callerInfo(graph)(["target"]);
  assert.deepEqual(info.direct_callers, [{ routine: "void std::helper<char>()", calls: 3 }]);
  assert.deepEqual(info.nearest_project_callers, [
    { routine: "std::function<void()> App::read[abi:cxx11]()", source: "app", distance: 2 },
  ]);
});

test("category and routine tables share costs and caller columns without duplicating matched calls", () => {
  const graph = parseCallGraph(CALL_GRAPH);
  const config = loadConfig(JSON.stringify({
    categories: [
      { label: "Input", match: "^____strtod_l_internal$|^std::__istream_extract" },
      { family: "Loading", discover: "(Demo|Physics)::load" },
      { label: "Missing", match: "^notInProfile$" },
    ],
  }));
  const rows = [
    ["____strtod_l_internal", { Ir: 100 }, { source: "strtod_l.c" }],
    ["____strtod_l_internal", { Ir: 50 }, { source: "gmp.h" }],
    ["std::__istream_extract()", { Ir: 40 }, { source: "libstdc++.so.6" }],
    ["Demo::load()", { Ir: 5 }, { source: "app.cc" }],
    ["Physics::load()", { Ir: 5 }, { source: "model.cc" }],
  ];
  const { markdown, structured } = renderProfile({
    title: "Matched tables", config, inclTotal: { Ir: 400 },
    inclRows: rows.map(([func, counts, metadata]) => [func, { Ir: counts.Ir * 2 }, metadata]),
    selfRows: rows, callGraph: graph,
  });
  const headers = markdown.split("\n").filter((line) => line.startsWith("| # |"));
  assert.equal(headers.length, 2);
  assert.equal(headers[0], headers[1]);
  assert.ok(markdown.includes("^____strtod_l_internal$\\|^std::__istream_extract"));
  const input = structured.categories.find((row) => row.label === "Input");
  assert.equal(input.incl, 280);
  assert.equal(input.self, 190);
  assert.equal(input.source, "gmp.h, libstdc++.so.6, strtod_l.c");
  assert.equal(input.calls, 58); // 37 strtod + 21 extract, including calls between matched routines.
  assert.equal(input.direct_callers.reduce((sum, caller) => sum + caller.calls, 0), input.calls);
  assert.deepEqual(input.nearest_project_callers, [
    { routine: "Demo::load()", source: "myapp", distance: 1 },
    { routine: "Physics::load()", source: "libPhysics.so", distance: 1 },
  ]);
  const strtod = structured.top_routines.find((row) => row.routine === "____strtod_l_internal");
  assert.equal(strtod.calls, 37);
  assert.deepEqual(strtod.categories, ["Input"]);
  const missing = structured.categories.find((row) => row.label === "Missing");
  assert.equal(missing.calls, 0);
  assert.equal(missing.source, null);
  assert.deepEqual(missing.direct_callers, []);
  assert.deepEqual(missing.nearest_project_callers, []);
});

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
  assert.equal(rows[0][2].source, "G4PropagatorInField.cc");
  assert.equal(rows[2][2].source, "flux.cc");
  assert.equal(rows.at(-1)[2].source, null);
});

test("source filenames fall back to the owning object when debug information is missing", () => {
  const text = ANNOTATE.replace(
    "/o/flux.cc:GFluxDigitization::digitizeHit(GHit*, unsigned long) [/o/flux.gplugin]",
    "???:GFluxDigitization::digitizeHit(GHit*, unsigned long) [/o/flux.gplugin]",
  );
  assert.equal(parseAnnotate(text).rows[2][2].source, "flux.gplugin");
});

test("incoming calls sum callers, recursion, and object copies using compressed names", () => {
  const calls = parseCallCounts(`events: Ir
ob=(1) /o/gemc
fn=(1) main
cob=(2) /o/libG4.so
cfn=(2) G4Step::run()
calls=1200 42
1 2400
cfn=(2)
calls=34 42
2 68
ob=(2)
fn=(2)
cfn=(2)
calls=6 42
42 12
ob=(1)
fn=(3) other
cob=(2)
cfn=(2)
calls=10 42
1 20
fn=(4) neverCalled
ob=(3) /o/plugin.so
fn=(2)
cfn=(2)
calls=2 42
42 4
cob=(2)
cfn=(5) 0xabc
calls=7 0
43 14
`);
  assert.equal(calls.get("G4Step::run()"), 1252);
  assert.equal(calls.get("main"), 0);
  assert.equal(calls.get("neverCalled"), 0);
  assert.equal(calls.get("0xabc in libG4.so"), 7);
  assert.throws(() => parseCallCounts("cfn=(99)"), /undefined Callgrind name ID/);
});

test("ABI-tagged symbols retain their incoming calls and source basename in the summary", () => {
  const { total, rows } = parseAnnotate(`Events shown: Ir
100 PROGRAM TOTALS
Ir file:function
10 /build/sources/name.cc:Example::name[abi:cxx11]() [/build/objects/libExample.so]
`);
  const callsByFunc = parseCallCounts(`ob=(1) /build/objects/libExample.so
fn=(1) caller
cfn=(2) Example::name[abi:cxx11]()
calls=7 1
1 70
fn=(2)
cfn=(2)
calls=2 1
1 20
`);
  const { markdown, structured } = renderProfile({
    title: "ABI tags",
    config: loadConfig(),
    inclTotal: total,
    inclRows: rows,
    selfRows: rows,
    callsByFunc,
  });
  assert.equal(callsByFunc.get("Example::name[abi:cxx11]()"), 9);
  assert.match(markdown, /\| 1 \| — \| `name.cc` \| `Example::name\[abi:cxx11\]\(\)` \|.* \| 9 \|/);
  assert.doesNotMatch(markdown, /\/build\//);
  assert.equal(structured.top_routines[0].source, "name.cc");
  assert.equal(structured.top_routines[0].calls, 9);
});

test("source annotations and inclusive call-site costs never become self-cost routines", () => {
  const source = `
--------------------------------------------------------------------------------
-- Auto-annotated source: /o/run.cc
--------------------------------------------------------------------------------
Ir I1mr D1mr D1mw ILmr DLmr DLmw
  900,000,000 0 0 0 0 0 0 => ???:0x0000000004110690 (1x)
  900,000,000 0 0 0 0 0 0 => ???:0x000000000a05b040 (1x)
   80,000,000 0 0 0 0 0 0 => /o/flux.cc:GFluxDigitization::digitizeHit(GHit*, unsigned long) (1x)
   10,000,000 0 0 0 0 0 0 42 return work();
  990,000,000 0 0 0 0 0 0 events annotated
`;
  const { total, rows } = parseAnnotate(ANNOTATE + source);
  assert.deepEqual(rows, parseAnnotate(ANNOTATE).rows);
  const ranked = topRoutines(rows, 10);
  assert.ok(ranked.reduce((sum, [, value]) => sum + value, 0) <= cest(total));
  assert.ok(!ranked.some(([func]) => func.includes("0x0000000004110690")));
  // A real unresolved routine in the flat table must still be retained.
  assert.ok(ranked.some(([func]) => func.includes("0x0000000009fe6140")));
});

test("missing function-table headers produce a diagnostic instead of guessing at rows", () => {
  assert.throws(
    () => parseAnnotate(ANNOTATE.replace("Ir I1mr D1mr D1mw ILmr DLmr DLmw file:function", "")),
    /no 'file:function' table/,
  );
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
  const headers = markdown.split("\n").filter((line) => line.startsWith("| # |"));
  assert.equal(headers.length, 2);
  assert.equal(headers[0], headers[1]);
  assert.match(headers[0], /Inclusive \(Mcycles\).*Self \(Mcycles\).*Direct callers.*Nearest project caller/);
  assert.match(markdown, /Top \d+ routines by self cost, ordered by inclusive cost/);
  assert.doesNotMatch(markdown, /events annotated/);
});

test("top routines are selected by self cost before ordering by inclusive share", () => {
  const config = loadConfig(JSON.stringify({
    top_routines: 2,
    categories: [{ label: "A", match: "^A$" }, { label: "B", match: "^B$" }],
  }));
  const { markdown, structured } = renderProfile({
    title: "Overlapping calls",
    config,
    inclTotal: { Ir: 1_000_000 },
    inclRows: [["A", { Ir: 1_000_000 }], ["B", { Ir: 800_000 }], ["C", { Ir: 900_000 }]],
    selfRows: [["A", { Ir: 200_000 }], ["B", { Ir: 500_000 }], ["C", { Ir: 300_000 }]],
  });
  assert.match(markdown, /\| # \| Category \| Source \/ package \| Routine \/ entry symbol\(s\) \|/);
  assert.match(markdown, /Selected by highest \*\*Self %\*\*, then ordered by \*\*% of run\*\*/);
  assert.match(markdown, /\| 1 \| — \| — \| `C` \| 0.9 \| 0.3 \| 90.00% \| 30.00% \| — \|/);
  assert.match(markdown, /\| 2 \| B \| — \| `B` \| 0.8 \| 0.5 \| 80.00% \| 50.00% \| — \|/);
  assert.match(markdown, /Self cost of listed routines: \*\*80.00%\*\*/);
  assert.match(markdown, /Self cost of remaining routines: \*\*20.00%\*\*/);
  assert.match(markdown, /\| A \| — \| `\^A\$` \| 1.0 \| 0.2 \| 100.00% \| 20.00% \|/);
  assert.match(markdown, /\| B \| — \| `\^B\$` \| 0.8 \| 0.5 \| 80.00% \| 50.00% \|/);
  assert.deepEqual(structured.top_routines, [
    {
      routine: "C", incl: 900_000, self: 300_000, source: null, calls: null, categories: [],
      direct_callers: [], nearest_project_callers: [],
    },
    {
      routine: "B", incl: 800_000, self: 500_000, source: null, calls: null, categories: ["B"],
      direct_callers: [], nearest_project_callers: [],
    },
  ]);
});

test("routine metadata combines sources without double-counting the two annotation passes", () => {
  const rows = [
    ["Dispatch::run()", { Ir: 10 }, { source: "a.cc" }],
    ["Dispatch::run()", { Ir: 20 }, { source: "plugin.so" }],
    ["root", { Ir: 1 }, { source: "main.cc" }],
  ];
  const { markdown, structured } = renderProfile({
    title: "Metadata",
    config: loadConfig(),
    inclTotal: { Ir: 31 },
    inclRows: rows,
    selfRows: rows,
    callsByFunc: new Map([["Dispatch::run()", 1234], ["root", 0]]),
  });
  assert.match(markdown, /`a.cc, plugin.so` \| `Dispatch::run\(\)` \|.* \| 1,234 \|/);
  assert.match(markdown, /`main.cc` \| `root` \|.* \| 0 \|/);
  assert.equal(structured.top_routines[0].calls, 1234);
  assert.equal(structured.top_routines[0].source, "a.cc, plugin.so");
});

test("summarizeCallgrind reads raw call counts into Markdown and JSON", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callgrinder-counts-"));
  const file = path.join(dir, "callgrind.out.x");
  fs.writeFileSync(file, `events: Ir
ob=/o/gemc
fn=main
cfn=GField_AsciiMapFactory::GetFieldValue(double const*, double*) const
calls=5539090 1
1 120000000
`);
  const executable = path.join(dir, "callgrind_annotate");
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(ANNOTATE)});\n`);
  fs.chmodSync(executable, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = summarizeCallgrind({
    name: "counts", callgrindFile: file, outputDirectory: dir,
    config: JSON.stringify({ categories: [{ label: "Field", match: "^GField_" }] }),
  });
  assert.match(result.markdown, /`gfield.cc` \| `GField_/);
  assert.match(result.markdown, /\| 5,539,090 \|/);
  const partial = JSON.parse(fs.readFileSync(result.partialFile, "utf8"));
  const field = partial.top_routines.find((row) => row.routine.startsWith("GField_"));
  assert.equal(field.source, "gfield.cc");
  assert.equal(field.calls, 5539090);
  assert.deepEqual(field.direct_callers, [{ routine: "main", calls: 5539090 }]);
  assert.deepEqual(field.nearest_project_callers, [{ routine: "main", source: "gemc", distance: 1 }]);
  const category = partial.categories[0];
  assert.equal(category.source, field.source);
  assert.equal(category.calls, field.calls);
  assert.deepEqual(category.direct_callers, field.direct_callers);
  assert.deepEqual(category.nearest_project_callers, field.nearest_project_callers);
  assert.match(result.markdown, /`main` \(5,539,090\).*`main` \(1 hop\)/);
  const report = createReport({ inputDirectory: dir, outputDirectory: path.join(dir, "report") });
  const summary = fs.readFileSync(report.summaryFile, "utf8");
  assert.match(summary, /\| # \| Category \| Source \/ package \|.* \| Calls \| Direct callers/);
  assert.match(summary, /`gfield.cc` \| `GField_.* \| 5,539,090 \|/);
  assert.doesNotMatch(summary, /\/o\//);
  assert.deepEqual(JSON.parse(fs.readFileSync(report.jsonFile, "utf8")), [partial]);
});

test("topRoutines selects by self cost and drops artifacts", () => {
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
