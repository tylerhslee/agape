// Adversarial "implement a feature against the SPEC, then validate against the conformance suite" workflow.
//
// Mirrors the spec-review structure (fan-out → adversarial verify → synthesize), but for IMPLEMENTATION:
//   Plan (spec-grounded)  →  Implement (sequential, iterate to green)  →  Validate (3 independent skeptics)
//   →  Repair (fix confirmed defects, re-validate; bounded rounds).
//
// The conformance suite is the ORACLE (spec-derived) and is never edited to pass. The skeptics default to
// finding fault: a clean verdict requires actively trying to break the implementation and failing.
//
// Invoke per feature:
//   Workflow({ scriptPath: ".../agape-ts/conformance/implement-and-validate.workflow.js", args: {
//     feature: "tools",
//     sections: ["13_governance", "07_ledger"],
//     spec: "§6 (tool seam), §8, §13 (consequential perform)",
//     goal: "tool/read/write decls + ToolStarted/ToolResolved pairs; read-tool result settled; write-tool needs settled input; ungranted use → AuthorityViolation.",
//     maxRepairRounds: 2
//   }})

export const meta = {
  name: 'implement-and-validate',
  description: 'Implement an Agape feature against SPEC.md, then adversarially validate it against the conformance suite (spec-faithfulness / regression-and-false-accept / kernel-safety skeptics), repairing confirmed defects until clean.',
  phases: [
    { title: 'Plan', detail: 'read spec + tests + runtime → a precise, spec-grounded implementation plan (no code yet)' },
    { title: 'Implement', detail: 'apply the plan; iterate to green on the target sections + kernel tests + typecheck, no regressions' },
    { title: 'Validate', detail: 'three independent skeptics try to refute: spec-faithfulness, regression/false-accept, kernel-safety' },
    { title: 'Repair', detail: 'fix confirmed real defects at the root and re-validate, up to maxRepairRounds' },
  ],
}

const UNC = String.raw`\\wsl.localhost\ubuntu-24.04\home\tylerhyun\_projects\agape\.claude\worktrees\naughty-mestorf-6d8b25`
const WSL = '/home/tylerhyun/_projects/agape/.claude/worktrees/naughty-mestorf-6d8b25'

const feature = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const NAME = feature.feature || 'unnamed-feature'
const SECTIONS = feature.sections || []
const SPEC = feature.spec || '(locate the relevant clauses in SPEC.md)'
const GOAL = feature.goal || 'Implement the feature exactly as SPEC.md describes.'
const MAX_ROUNDS = feature.maxRepairRounds ?? 2

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    specSummary: { type: 'string' },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, what: { type: 'string' } }, required: ['file', 'what'] } },
    newErrorClasses: { type: 'array', items: { type: 'string' } },
    ledgerEvents: { type: 'array', items: { type: 'string' } },
    edgeCases: { type: 'array', items: { type: 'string' } },
    suiteDivergences: { type: 'array', items: { type: 'string' } },
  },
  required: ['feature', 'specSummary', 'changes'],
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    beforeTotal: { type: 'number' },
    afterTotal: { type: 'number' },
    sectionResults: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { section: { type: 'string' }, before: { type: 'number' }, after: { type: 'number' } }, required: ['section', 'before', 'after'] } },
    typecheckClean: { type: 'boolean' },
    kernelTestsPass: { type: 'boolean' },
    noRegressions: { type: 'boolean' },
    residualFailures: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
  },
  required: ['summary', 'filesChanged', 'beforeTotal', 'afterTotal', 'typecheckClean', 'kernelTestsPass', 'noRegressions'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['clean', 'defects'] },
    defects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
      test: { type: 'string' },
      description: { type: 'string' },
      isRealBug: { type: 'boolean' },
    }, required: ['severity', 'description', 'isRealBug'] } },
  },
  required: ['lens', 'verdict', 'defects'],
}

const ENV = `
ENVIRONMENT (a WSL filesystem exposed on a Windows share):
- Repo root for Read/Edit/Write tools (backslash UNC): ${UNC}
- Repo root for the Bash tool — run commands as: wsl bash -lc "cd '${WSL}/agape-ts' && <cmd>"
- SPEC.md (THE source of truth): ${UNC}\\SPEC.md
- Conformance suite (the ORACLE — tests are spec-derived; do NOT edit them): ${UNC}\\agape-conformance\\tests
- Implementation source: ${UNC}\\agape-ts\\src\\{lexer,parser,ast,errors,check,interp,runtime,config}.ts
- Architecture + current scorecard: ${UNC}\\agape-ts\\CONFORMANCE.md
- Commands (always from agape-ts):
    typecheck:              wsl bash -lc "cd '${WSL}/agape-ts' && npm run typecheck"
    kernel tests:           wsl bash -lc "cd '${WSL}/agape-ts' && npm test"
    conformance, all:       wsl bash -lc "cd '${WSL}/agape-ts' && npx tsx conformance/run.mts"
    conformance, 1 section: wsl bash -lc "cd '${WSL}/agape-ts' && npx tsx conformance/run.mts --section <NN_section> --verbose"
    run one .ag program:    wsl bash -lc "cd '${WSL}/agape-ts' && npx tsx src/cli.ts run <file.ag>"
NON-NEGOTIABLE RULES:
- FIELD SYNTAX (authoritative, set by the project owner; ALREADY applied to SPEC.md, the suite, and the
  parser — do NOT revert it, "restore" name-first, or make the parser accept both forms): a STRUCT field
  is NAME-FIRST (\`name: T\`); an action/event/tool/function PARAMETER is TYPE-FIRST (\`T name\`). The parser
  enforces this split (parseStructField / parseParamField). If a test uses the wrong form it is a suite bug
  to report, never a reason to loosen the parser.
- Implement strictly to SPEC.md. If a conformance test contradicts SPEC.md, it is a SUITE BUG — report it, do not chase it.
- NEVER edit a conformance test or the runner (conformance/run.mts) to make a test pass. That is cheating the oracle.
- Do NOT teach-to-the-test: no branching on a test id, file name, or magic literal. The checker/runtime must be generally correct.
- The static checker (src/check.ts) must stay CONSERVATIVE: it must never false-reject an 'accept' test.
- Preserve the trusted kernel: introduce no bypass of taint, authority, or endorsement, and keep replay deterministic.
`

phase('Plan')
const plan = await agent(
  `Plan the implementation of the Agape feature "${NAME}" strictly against SPEC.md — do NOT write code in this step.
Goal: ${GOAL}
Spec clauses: ${SPEC}
Most-affected conformance sections: ${SECTIONS.join(', ') || '(infer from the feature)'}.
${ENV}
Read the cited SPEC.md clauses, the relevant conformance tests (BOTH accept and reject) in the target sections, and
the current implementation source. Produce a precise, spec-grounded plan: the exact parser/checker/interp/runtime/ast
changes, any new error classes, the ledger events emitted, and the edge cases + kernel boundary each target test
exercises. Explicitly separate genuine implementation gaps from any place the SUITE diverges from SPEC.md.`,
  { schema: PLAN_SCHEMA, phase: 'Plan', label: `plan:${NAME}` },
)
if (!plan) return { feature: NAME, error: 'planning agent failed (no plan produced)' }

phase('Implement')
let impl = await agent(
  `Implement the Agape feature "${NAME}" per this plan and strictly per SPEC.md.
PLAN: ${JSON.stringify(plan)}
${ENV}
Procedure: (1) record the BEFORE scorecard by running the full conformance suite once; (2) edit the source files to
implement the feature; (3) iterate — after each change run typecheck, the kernel tests, and the target section(s),
fixing until the target sections improve AND nothing regresses (kernel tests green; no previously-passing conformance
test now fails; no 'accept' test false-rejected); (4) run the full suite again for the AFTER scorecard. Report exactly
what you changed and the before/after numbers. If a test cannot pass without a feature outside this one's scope, leave
it and record it in residualFailures with the reason — never hack the test or runner to force a pass.`,
  { schema: IMPL_SCHEMA, phase: 'Implement', label: `implement:${NAME}` },
)
if (!impl) return { feature: NAME, plan, error: 'implementation agent failed (no changes produced)' }

const LENSES = [
  { key: 'spec-faithfulness', prompt: 'Independently re-read the cited SPEC.md clauses. Find any place the implementation diverges from the spec, OVERFITS (passes a test for the wrong reason, or branches on a test id / file name / magic literal), or implements behavior the spec does not describe. For a sample of the accept AND reject tests this feature now passes, confirm each passes for a spec-correct reason — not a coincidence.' },
  { key: 'regression-false-accept', prompt: 'Run the FULL conformance suite and the kernel tests. Confirm NO previously-passing test regressed and the kernel suite is green. Then hunt for FALSE ACCEPTS: a reject test now wrongly passing (it accepts, or rejects with the wrong error class), or an accept test passing only because a real error is silently swallowed. Read the diff of the changed source to check the static checker did not become unsound or start false-rejecting valid programs.' },
  { key: 'kernel-safety', prompt: 'Adversarially probe the trusted kernel. Confirm the change introduced no bypass of taint (a graded / bare-Decision / un-narrowed value reaching a consequential sink), authority (perform/reach/use without a grant), or endorsement (a subject reaching a sink without a committed-narrowed Endorsement), and did not break replay determinism. Actively try to construct a SHORT .ag program that slips an unsafe value through the new code path and run it; if it is accepted, that is a confirmed high-severity defect.' },
]

let round = 0
let verdicts = []
while (true) {
  phase(round === 0 ? 'Validate' : 'Repair')
  const tag = round === 0 ? 'validate' : `recheck#${round}`
  verdicts = (await parallel(LENSES.map((L) => () =>
    agent(
      `Adversarially validate the just-completed implementation of "${NAME}" through the ${L.key} lens.
Default to finding fault — a 'clean' verdict is only credible if you actively tried to break it and could not.
${L.prompt}
${ENV}
IMPLEMENTATION SUMMARY (claims to verify, not to trust): ${JSON.stringify(impl)}
For each defect, give severity and set isRealBug=true for any genuine spec violation, regression, false-accept, or
SOUNDNESS / kernel hole (any way a tainted, ungranted, or un-endorsed value can reach a sink) that is REACHABLE in the
code as it stands now — INCLUDING a pre-existing hole that this feature exposes or makes reachable, because the kernel
guarantee is absolute and must be closed regardless of which line introduced it. Set isRealBug=false ONLY for genuinely
out-of-scope unimplemented-feature gaps that are NOT soundness issues.`,
      { schema: VERDICT_SCHEMA, phase: round === 0 ? 'Validate' : 'Repair', label: `${tag}:${L.key}` },
    ),
  ))).filter(Boolean)

  const realDefects = verdicts.flatMap((v) => (v.defects || []).filter((d) => d.isRealBug))
  if (realDefects.length === 0) { log(`round ${round}: adversarial validation CLEAN`); break }
  if (round >= MAX_ROUNDS) { log(`round ${round}: ${realDefects.length} real defect(s) REMAIN after ${MAX_ROUNDS} repair round(s)`); break }
  log(`round ${round}: ${realDefects.length} real defect(s) → repairing`)
  const repaired = await agent(
    `Repair the implementation of "${NAME}". Independent adversarial validators found these REAL defects:
${JSON.stringify(realDefects)}
${ENV}
Fix each at its ROOT CAUSE, per SPEC.md (do not touch the tests or the runner). Re-run typecheck, the kernel tests,
and the full conformance suite, and confirm the defects are gone with no new regressions. Return the updated change
summary and before/after numbers.`,
    { schema: IMPL_SCHEMA, phase: 'Repair', label: `repair:${NAME}#${round + 1}` },
  )
  if (repaired) impl = repaired
  round++
}

return {
  feature: NAME,
  plan,
  implementation: impl,
  adversarialVerdicts: verdicts,
  outstandingRealDefects: verdicts.flatMap((v) => (v.defects || []).filter((d) => d.isRealBug)),
  repairRounds: round,
}
