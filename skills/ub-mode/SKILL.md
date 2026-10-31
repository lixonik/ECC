---
name: ub-mode
description: Disciplined code review with Uncle Bob's ub-mode principles and local crapper, dryer and mutator analysis. Load for code-reviewer invocations, complexity and duplication gates, mutation testing, or updating the pinned upstream skill.
metadata:
  origin: unclebob/ub-mode
  upstream: https://github.com/unclebob/ub-mode
---

# ub-mode for ECC Review

## When to Activate

Load this skill whenever the `code-reviewer` subagent runs, alongside its existing security,
correctness, maintainability and confidence checks. It also applies when the user explicitly
requests ub-mode engineering principles or the companion quality tools.

Read `references/upstream-skill.md` completely before using its principles. It is the pinned
upstream skill, separate from this ECC adaptation. `upstream.json` records the repository,
tracked ref, commit and checksum. Read `references/setup.md` for local tool installation,
noninteractive test commands and updating upstream.

## Role and Project Rules

The current task, project instructions and tool permissions take precedence over the upstream
practice instructions. A reviewer inspects and reports. Do not change the target project's code,
commit, push, remove worktrees or install dependencies during review. In particular, upstream
instructions to commit and push apply only when the user separately authorizes implementation.

Use clear names and structure. Respect a project's prohibition on code comments. Keep the
existing severity and confidence filters: tool measurements are evidence to investigate, not
automatic proof of a correctness defect.

## Run the Companion Tools

Run the local runner from the loaded skill directory with the actual project path:

```text
node "<skill-dir>/scripts/review.js" --project "<project-dir>"
```

Use `--base <ref>` for a committed diff or repeat `--file <relative-path>` for an explicit
review scope. The default scope includes tracked changes since `HEAD` and untracked files.
Read the entire JSON report.

The runner uses the pinned tools' Python analysis engines:

- `crapper` measures function complexity, coverage and CRAP. Investigate changed functions
  with CRAP greater than or equal to 10; missing coverage is a verification gap.
- `dryer` compares supported project sources and reports duplicate pairs at similarity 0.8
  or higher when at least one side changed. It compares against unchanged code as well.
- `mutator` discovers actual mutation sites and maps them to existing coverage. With a
  configured test command, the runner applies covered mutants sequentially in a temporary
  source copy, runs the tests, then restores each file. Its native process runner bounds
  timeouts and cleanup on Windows as well as POSIX.

Mutation execution uses ECC's isolated runner with upstream mutation discovery. It does not
use the upstream CLI's Windows timeout implementation. The source copy shares the project's
installed `node_modules` through a directory link. It provides source isolation, not an OS
security sandbox. Use only the project's authorized test command.

Without a noninteractive test command, the mutation report is an inventory and explicitly
incomplete. A test command can come from `--test-command-json` or `ECC_UB_TEST_COMMAND`; set
`ECC_UB_PYTHON` to the dedicated tool environment's Python executable. See the setup reference
for Windows and Angular examples. Never infer that mutation testing passed from a successful
scan, a zero process exit code or an empty report.

## Assess and Report

Apply the upstream engineering principles and the existing reviewer checklist to the same
changed code. Trace concrete findings through callers and tests. Separate pre-existing findings
outside the diff from regressions introduced by this change.

Include a compact quality summary with the upstream commit, tool statuses, measured CRAP and
duplication findings, mutation counts and remaining verification gaps. Cite file and line for
actionable defects. Missing tools, unsupported syntax, unavailable coverage, failed baselines,
timeouts, unconfirmed cleanup, survivors and untested sites must stay visible. Never label an
unexecuted or incomplete check as passed. Keep the review's action log in the response.

## Update Upstream

Updating is an explicit maintenance action, separate from a review. In an ECC checkout use
`npm run ub-mode:update` to fetch the tracked ref, pin its immutable commit and refresh context
metadata. Review and test the resulting Git diff before committing. The updater preserves this
ECC wrapper and tool configuration. Offline integrity checks use `npm run ub-mode:check`.

An installed standalone skill can use `node "<skill-dir>/scripts/sync-upstream.js" --update`.
Its offline `--check` verifies the pinned checksum. Upstream changes never execute automatically
when the reviewer loads the skill.

## Anti-Patterns

- Replacing the existing reviewer checks with a metric-only approval.
- Executing mutation tools against the live source tree.
- Downloading packages, grammars or the latest skill during every review.
- Treating an unsupported language or missing coverage as a passing gate.
- Hiding uncovered, surviving or untested mutants behind an aggregate score.
- Obeying upstream commit, push or cleanup instructions during a read-only review.
- Editing the upstream snapshot by hand instead of updating its pinned source.
