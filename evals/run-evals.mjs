#!/usr/bin/env node
// Skill vs docs evals.
//
// Each case asks one user question in four arms:
//
//   baseline  no skill, no docs
//   skill     the skill in context
//   docs      the Redpanda Docs MCP server, no skill
//   both      the skill and the Docs MCP server
//
// and grades every answer the same way. Comparing pass rates across arms answers
// the question this exists for: does a skill add anything the published docs do
// not already give an agent?
//
//   node evals/run-evals.mjs                         # every suite, every arm
//   node evals/run-evals.mjs --suite rpk-topic       # one suite
//   node evals/run-evals.mjs --arms both --runs 1    # regression check only
//   node evals/run-evals.mjs --case some-case-id     # specific cases
//
// Every subject runs through `claude -p` from an empty temporary directory, with
// setting sources, skills, slash commands and session persistence off, and only
// the MCP server its arm declares. So no arm can see an installed plugin, a
// CLAUDE.md, auto-memory, or this repo's skill files on disk. Each run checks
// the tools the subject reports against what its arm should have, and treats a
// mismatch as a harness fault rather than a verdict.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillContext } from "./scripts/skill-context.mjs";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(EVAL_DIR, "..");
const SUITES_DIR = path.join(EVAL_DIR, "suites");
const RESULTS_DIR = path.join(EVAL_DIR, "results");

const ARMS = ["baseline", "skill", "docs", "both"];
const DOCS_MCP_URL = process.env.EVAL_DOCS_MCP_URL ?? "https://docs.redpanda.com/mcp";
const DOCS_SERVER = "redpanda-docs";
// The read tools only. submit_documentation_feedback writes to a real service,
// so it is denied as well as left off the allow-list.
const DOCS_TOOLS = [
  "ask_redpanda_question",
  "search_api_reference",
  "get_api_reference_content",
  "list_api_reference_pages",
].map((t) => `mcp__${DOCS_SERVER}__${t}`);
const DOCS_DENIED = [`mcp__${DOCS_SERVER}__submit_documentation_feedback`];
// Anonymous callers get a handful of tool calls a day per network address, which
// one suite exhausts. A trusted client key is not metered, and attributes the
// traffic to a named service rather than to a person.
const DOCS_CLIENT_KEY = process.env.EVAL_DOCS_CLIENT_KEY;
// With no tools at all, `claude -p` can stall after its first thinking block.
// CronList lists scheduled jobs and reads nothing, so it is safe to give every arm.
const INERT_BUILTIN = "CronList";

// Told to the docs arms only. Without it, whether the docs arm consults the docs
// at all is the model's choice, and a run that never looked would be scored as
// "the docs were not enough". A softer "use them to ground your answer" was
// ignored on a question the model thought it knew: 0 lookups in 2 runs.
const DOCS_NUDGE =
  "The Redpanda documentation is available through the redpanda-docs tools. Before you answer, " +
  "look the question up with them, then answer from what the documentation says.";

const CASE_TIMEOUT_MS = Number(process.env.EVAL_CASE_TIMEOUT_MS ?? 600_000);
const JUDGE_TIMEOUT_MS = Number(process.env.EVAL_JUDGE_TIMEOUT_MS ?? 180_000);

// An answer that knows nothing. Every case must fail it, or the case cannot
// fail at all. Graded once per case, before any subject runs.
const NULL_ANSWER = "I'm not sure. Check the Redpanda documentation for details.";

function parseArgs(argv) {
  const opts = {
    suites: [],
    cases: [],
    arms: ARMS,
    runs: 3,
    concurrency: 4,
    model: process.env.EVAL_MODEL ?? "claude-sonnet-5-5",
    judgeModel: process.env.EVAL_JUDGE_MODEL ?? "claude-opus-5-5",
    judge: true,
    out: undefined,
    report: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === "--suite") opts.suites.push(...next().split(","));
    else if (a === "--case") opts.cases.push(...next().split(","));
    else if (a === "--arms") opts.arms = next().split(",");
    else if (a === "--runs") opts.runs = Number(next());
    else if (a === "--concurrency") opts.concurrency = Number(next());
    else if (a === "--model") opts.model = next();
    else if (a === "--judge-model") opts.judgeModel = next();
    else if (a === "--no-judge") opts.judge = false;
    else if (a === "--out") opts.out = next();
    else if (a === "--report") opts.report.push(...next().split(","));
    else die(`unknown argument: ${a}`);
  }
  const bad = opts.arms.filter((a) => !ARMS.includes(a));
  if (bad.length) die(`unknown arm(s): ${bad.join(", ")}. Arms: ${ARMS.join(", ")}`);
  if (!(opts.runs >= 1)) die("--runs must be at least 1");
  if (!(opts.concurrency >= 1)) die("--concurrency must be at least 1");
  return opts;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function loadSuites(names) {
  const files = fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith(".eval.json"))
    .sort();
  const picked = names.length
    ? names.map((n) => {
        const exact = files.find((f) => f === `${n}.eval.json` || path.join(SUITES_DIR, f) === path.resolve(n));
        if (!exact) die(`no suite matches --suite ${n}`);
        return exact;
      })
    : files;
  return picked.map((f) => {
    const suite = JSON.parse(fs.readFileSync(path.join(SUITES_DIR, f), "utf-8"));
    if (!fs.existsSync(path.join(REPO_ROOT, "skills", suite.skill, "SKILL.md"))) {
      die(`${f}: skill "${suite.skill}" has no skills/${suite.skill}/SKILL.md`);
    }
    return suite;
  });
}

// ---------------------------------------------------------------------------
// Running claude

function runClaude(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`));
      else resolve(out);
    });
  });
}

function baseArgs(prompt, model) {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
  ];
}

function parseStream(raw) {
  const run = { text: "", toolCalls: [], toolResults: [], tools: undefined, cost: 0, sawResult: false, isError: false };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "system" && e.subtype === "init") {
      run.tools = e.tools ?? [];
      run.skills = e.skills ?? [];
      run.slashCommands = e.slash_commands ?? [];
      run.plugins = e.plugins ?? [];
    }
    if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        run.toolResults.push(body);
      }
    }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use") run.toolCalls.push({ name: c.name, input: c.input });
      }
    }
    if (e.type === "result") {
      run.sawResult = true;
      run.isError = Boolean(e.is_error);
      run.text = e.result ?? "";
      run.cost = e.total_cost_usd ?? 0;
      // Tokens, not just dollars: what a user pays depends on their plan, and
      // cache reads are billed far below fresh input.
      const u = e.usage ?? {};
      run.usage = {
        input: u.input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      };
    }
  }
  return run;
}

async function runSubject(suite, testCase, arm, model) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "skill-eval-"));
  try {
    const args = baseArgs(testCase.query, model);
    const withSkill = arm === "skill" || arm === "both";
    const withDocs = arm === "docs" || arm === "both";
    const prompt = [];
    if (withSkill) prompt.push(skillContext(REPO_ROOT, suite.skill));
    if (withDocs) prompt.push(DOCS_NUDGE);
    if (prompt.length) {
      // A file, not an argument: Linux caps one argv element at 128 KiB and
      // some skills with their references are close to that.
      const f = path.join(work, "system-prompt.md");
      fs.writeFileSync(f, prompt.join("\n\n---\n\n"));
      args.push("--append-system-prompt-file", f);
    }
    const expected = [INERT_BUILTIN];
    if (withDocs) {
      const cfg = path.join(work, "mcp.json");
      const server = { type: "http", url: DOCS_MCP_URL };
      if (DOCS_CLIENT_KEY) server.headers = { "x-client-key": DOCS_CLIENT_KEY };
      fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { [DOCS_SERVER]: server } }));
      args.push("--mcp-config", cfg, "--allowed-tools", DOCS_TOOLS.join(","));
      args.push("--disallowed-tools", DOCS_DENIED.join(","));
      expected.push(...DOCS_TOOLS);
    }
    args.push("--tools", INERT_BUILTIN);

    const run = parseStream(await runClaude(args, work, CASE_TIMEOUT_MS));
    if (!run.sawResult) throw new Error("no result event in transcript");
    if (run.isError) throw new Error("claude reported is_error on the result event");
    // Proof, not intent. A built-in the arm was not given means a no-skill arm
    // might read SKILL.md off disk; an MCP tool in a no-docs arm means the docs
    // leaked in. Missing docs tools means the server did not connect, and the
    // docs arm would be scored on an answer that never had the docs.
    const available = new Set(run.tools ?? []);
    const extra = [...available].filter((t) => !expected.includes(t) && !DOCS_DENIED.includes(t));
    const missing = expected.filter((t) => !available.has(t));
    if (extra.length) throw new Error(`subject had tools its arm should not: ${extra.join(", ")}`);
    if (missing.length) throw new Error(`subject lacked tools its arm needs: ${missing.join(", ")}`);
    // The quota refusal comes back as an ordinary tool result, so the subject
    // answers from memory and says it could not check. Scored, that run would
    // count general knowledge as "the docs".
    if (run.toolResults.some((r) => r.includes("anonymous_quota_exhausted"))) {
      throw new Error("docs server refused: anonymous quota exhausted (set EVAL_DOCS_CLIENT_KEY)");
    }
    // The same proof for knowledge the subject could load without a tool: a
    // skill, a slash command, or a plugin that is not Claude Code's own.
    // Built-in plugins ship inside the CLI and carry no Redpanda content.
    const leaked = [
      ...run.skills.map((x) => `skill ${typeof x === "string" ? x : x.name}`),
      ...run.slashCommands.map((x) => `command ${typeof x === "string" ? x : x.name}`),
      ...run.plugins.filter((x) => x.path !== "builtin").map((x) => `plugin ${x.name}`),
    ];
    if (leaked.length) throw new Error(`subject loaded what its arm should not: ${leaked.join(", ")}`);
    run.docsCalls = run.toolCalls.filter((c) => c.name.startsWith(`mcp__${DOCS_SERVER}__`)).length;
    return run;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Grading

function regex(p) {
  return new RegExp(p, "i");
}

const VERDICT_INSTRUCTIONS = `Reply with exactly this JSON object and nothing else, no prose, no code fence:
{"passed": true or false, "reason": "one sentence"}`;

async function judge(inv, testCase, response, judgeModel) {
  const prompt = `You are grading one answer against one rule. Judge only the rule, not overall quality.

User question:
<question>
${testCase.query}
</question>

Answer to grade:
<answer>
${response}
</answer>

Rule "${inv.name}". The answer FAILS when:
${inv.failure_condition}

${VERDICT_INSTRUCTIONS}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "skill-eval-judge-"));
  try {
    const args = [...baseArgs(prompt, judgeModel), "--tools", INERT_BUILTIN];
    const run = parseStream(await runClaude(args, work, JUDGE_TIMEOUT_MS));
    const m = run.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`judge returned no JSON for ${inv.name}`);
    const v = JSON.parse(m[0]);
    if (typeof v.passed !== "boolean") throw new Error(`judge verdict for ${inv.name} has no boolean "passed"`);
    return { passed: v.passed, reason: String(v.reason ?? ""), cost: run.cost };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Cheapest first; the first failure decides.
async function grade(testCase, response, opts) {
  for (const p of testCase.failure_patterns ?? []) {
    if (regex(p).test(response)) return { passed: false, reason: `matched failure pattern /${p}/`, cost: 0 };
  }
  for (const p of testCase.required_patterns ?? []) {
    if (!regex(p).test(response)) return { passed: false, reason: `missing required pattern /${p}/`, cost: 0 };
  }
  let cost = 0;
  if (opts.judge) {
    for (const inv of testCase.invariants ?? []) {
      const v = await judge(inv, testCase, response, opts.judgeModel);
      cost += v.cost;
      if (!v.passed) return { passed: false, reason: `invariant ${inv.name}: ${v.reason}`, cost };
    }
  }
  return { passed: true, reason: "", cost };
}

// ---------------------------------------------------------------------------
// Scheduling

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Reporting

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

function tally(rows) {
  const scored = rows.filter((r) => r.status !== "errored");
  return { passed: scored.filter((r) => r.status === "passed").length, scored: scored.length, errored: rows.length - scored.length };
}

// A case is informative only if the baseline mostly fails it. One a competent
// model already answers says nothing about the skill or the docs.
function caseVerdict(byArm) {
  const rate = (arm) => {
    const t = byArm[arm];
    return t && t.scored ? t.passed / t.scored : undefined;
  };
  const base = rate("baseline");
  if (base !== undefined && base > 1 / 3) return "uninformative: baseline already answers it";
  const both = rate("both");
  const docs = rate("docs");
  if (both === undefined || docs === undefined) return "";
  if (both - docs >= 0.34) return "skill adds value (docs gap)";
  if (docs >= 2 / 3 && docs >= both - 0.1) return "docs are enough";
  if (both < 2 / 3 && docs < 2 / 3) return "neither answers reliably";
  return "no clear difference";
}

function summarize(suites, results, opts, meta) {
  const lines = [];
  lines.push(`# Skill vs docs eval results`, "");
  lines.push(`- Started: ${meta.started}`);
  lines.push(`- Subject model: ${opts.model}; judge model: ${opts.judge ? opts.judgeModel : "off"}`);
  lines.push(`- Runs per arm: ${opts.runs}; docs server: ${DOCS_MCP_URL}`);
  lines.push(`- Total cost: $${meta.cost.toFixed(2)}`, "");
  const verdicts = {};
  for (const suite of suites) {
    lines.push(`## ${suite.skill}`, "");
    lines.push(`| Case | ${opts.arms.join(" | ")} | Verdict |`);
    lines.push(`|---|${opts.arms.map(() => "---").join("|")}|---|`);
    const informative = { both: [0, 0], docs: [0, 0], skill: [0, 0] };
    for (const testCase of suite.test_cases) {
      const rows = results.filter((r) => r.suite === suite.name && r.case === testCase.id);
      if (!rows.length) continue;
      const byArm = {};
      for (const arm of opts.arms) byArm[arm] = tally(rows.filter((r) => r.arm === arm));
      const cells = opts.arms.map((arm) => {
        const t = byArm[arm];
        let cell = `${t.passed}/${t.scored}`;
        if (t.errored) cell += ` (${t.errored} err)`;
        if (arm === "docs" || arm === "both") {
          const unused = rows.filter((r) => r.arm === arm && r.status !== "errored" && r.docsCalls === 0).length;
          if (unused) cell += ` (${unused} no lookup)`;
        }
        return cell;
      });
      const v = caseVerdict(byArm);
      const origin = testCase.origin ?? "unspecified";
      verdicts[origin] ??= {};
      verdicts[origin][v] = (verdicts[origin][v] ?? 0) + 1;
      if (!v.startsWith("uninformative")) {
        for (const arm of Object.keys(informative)) {
          if (byArm[arm]) {
            informative[arm][0] += byArm[arm].passed;
            informative[arm][1] += byArm[arm].scored;
          }
        }
      }
      lines.push(`| \`${testCase.id}\` (${origin}) | ${cells.join(" | ")} | ${v} |`);
    }
    lines.push("");
    const [bp, bs] = informative.both;
    const [dp, ds] = informative.docs;
    const [sp, ss] = informative.skill;
    lines.push(
      `Informative cases only: skill ${pct(sp, ss)}, docs ${pct(dp, ds)}, both ${pct(bp, bs)}.`,
      ""
    );
  }
  // The two lists worth acting on. A docs gap is something the skill tells an
  // agent that the published docs do not: either document it, or it is the
  // reason the skill exists. A skill gap is the reverse: the docs answer it and
  // the skill gets it wrong or leaves it out.
  const rateOf = (rows, arm) => {
    const t = tally(rows.filter((r) => r.arm === arm));
    return t.scored ? t.passed / t.scored : undefined;
  };
  const gaps = { docs: [], skill: [] };
  for (const suite of suites) {
    for (const testCase of suite.test_cases) {
      const rows = results.filter((r) => r.suite === suite.name && r.case === testCase.id);
      const [base, skill, docs] = ["baseline", "skill", "docs"].map((a) => rateOf(rows, a));
      if (base !== undefined && base > 1 / 3) continue;
      const entry = `- \`${suite.skill}/${testCase.id}\`: ${testCase.why}`;
      if (skill >= 2 / 3 && docs <= 1 / 3) gaps.docs.push(entry);
      if (docs >= 2 / 3 && skill <= 1 / 3) gaps.skill.push(entry);
    }
  }
  if (gaps.docs.length) lines.push(`## Docs gaps: the skill answers it, the docs do not`, "", ...gaps.docs, "");
  if (gaps.skill.length) lines.push(`## Skill gaps: the docs answer it, the skill does not`, "", ...gaps.skill, "");
  // Per origin, never pooled: docs-cited cases can only show the docs finding
  // what they say, so mixing them in would overstate "docs are enough".
  lines.push(`## Case verdicts by origin`, "");
  for (const [origin, counts] of Object.entries(verdicts)) {
    lines.push(`**${origin}**`, "");
    for (const [v, n] of Object.entries(counts)) lines.push(`- ${v || "incomplete"}: ${n}`);
    lines.push("");
  }
  const failures = results.filter((r) => r.status !== "passed");
  if (failures.length) {
    lines.push(`## Why runs did not pass`, "");
    for (const r of failures) lines.push(`- \`${r.suite}/${r.case}\` ${r.arm} #${r.run}: ${r.status}. ${r.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

// Summarize runs already on disk, from one or more result directories, without
// running anything. Arms measured in separate runs land in one table.
function report(opts) {
  const rows = [];
  for (const dir of opts.report) {
    const f = path.join(dir, "runs.jsonl");
    if (!fs.existsSync(f)) die(`no runs.jsonl in ${dir}`);
    for (const line of fs.readFileSync(f, "utf-8").split("\n")) if (line.trim()) rows.push(JSON.parse(line));
  }
  const suites = loadSuites(opts.suites).filter((s) => rows.some((r) => r.suite === s.name));
  const arms = ARMS.filter((a) => rows.some((r) => r.arm === a));
  const cost = rows.reduce((n, r) => n + (r.cost ?? 0), 0);
  const started = `merged from ${opts.report.map((d) => path.basename(d)).join(", ")}`;
  console.log(summarize(suites, rows, { ...opts, arms, runs: "varies" }, { started, cost }));
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.report.length) return report(opts);
  const suites = loadSuites(opts.suites);
  const want = new Set(opts.cases);
  const selected = suites
    .map((s) => ({ ...s, test_cases: s.test_cases.filter((c) => !want.size || want.has(c.id)) }))
    .filter((s) => s.test_cases.length);
  if (want.size) {
    const found = new Set(selected.flatMap((s) => s.test_cases.map((c) => c.id)));
    const unknown = [...want].filter((id) => !found.has(id));
    if (unknown.length) die(`no case with id: ${unknown.join(", ")}`);
  }
  if (!selected.length) die("no cases selected");

  const started = new Date().toISOString();
  const outDir = opts.out ?? path.join(RESULTS_DIR, started.replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  const log = fs.createWriteStream(path.join(outDir, "runs.jsonl"));
  let cost = 0;

  console.log(`🧪 Skill vs docs evals: ${selected.length} suite(s), arms ${opts.arms.join(",")}, ${opts.runs} run(s) each`);
  console.log(`   subject ${opts.model}, judge ${opts.judge ? opts.judgeModel : "off"}, results in ${path.relative(process.cwd(), outDir)}\n`);

  // Negative control first: a case the know-nothing answer passes cannot fail,
  // so its results would mean nothing. Stop before spending on subjects.
  const cannotFail = [];
  await pool(
    selected.flatMap((suite) =>
      suite.test_cases.map((testCase) => async () => {
        const g = await grade(testCase, NULL_ANSWER, opts);
        cost += g.cost;
        if (g.passed) cannotFail.push(`${suite.name}/${testCase.id}`);
      })
    ),
    opts.concurrency
  );
  if (cannotFail.length) {
    die(`these cases pass an answer that says nothing, so they cannot fail:\n   ${cannotFail.join("\n   ")}`);
  }

  const tasks = [];
  for (const suite of selected) {
    for (const testCase of suite.test_cases) {
      for (const arm of opts.arms) {
        for (let run = 1; run <= opts.runs; run++) {
          tasks.push(async () => {
            const row = { suite: suite.name, skill: suite.skill, case: testCase.id, arm, run };
            try {
              const subject = await runSubject(suite, testCase, arm, opts.model);
              const g = await grade(testCase, subject.text, opts);
              Object.assign(row, {
                status: g.passed ? "passed" : "failed",
                reason: g.reason,
                docsCalls: subject.docsCalls,
                usage: subject.usage,
                cost: subject.cost + g.cost,
                response: subject.text,
                toolCalls: subject.toolCalls,
              });
            } catch (e) {
              // A timeout, a server that did not connect, a tool leak: a fault in
              // the harness, never a verdict on the skill or the docs.
              Object.assign(row, { status: "errored", reason: e.message, cost: 0 });
            }
            cost += row.cost;
            log.write(JSON.stringify(row) + "\n");
            const mark = { passed: "✅", failed: "❌", errored: "⚠️ " }[row.status];
            console.log(`${mark} ${suite.skill}/${testCase.id} ${arm} #${run}${row.status === "passed" ? "" : `: ${row.reason}`}`);
            return row;
          });
        }
      }
    }
  }
  const results = await pool(tasks, opts.concurrency);
  log.end();

  const summary = summarize(selected, results, opts, { started, cost });
  fs.writeFileSync(path.join(outDir, "summary.md"), summary);
  console.log(`\n${summary}`);

  const errored = results.filter((r) => r.status === "errored").length;
  if (errored === results.length) die("every run errored; nothing was measured");
  if (errored) console.log(`⚠️  ${errored} run(s) errored and were not scored.`);
}

main().catch((e) => die(e.stack ?? String(e)));
