# Local Tools and Upstream Maintenance

## Dedicated Python Environment

Use Python 3.11 or newer. The pinned parser wheels have been checked on native Windows with
Python 3.12. From an ECC checkout, create a dedicated environment outside the project:

```powershell
py -3.12 -m venv C:/Repos/ecc-ub-tools
C:/Repos/ecc-ub-tools/Scripts/python.exe -m pip install -r skills/ub-mode/requirements.txt
$env:ECC_UB_PYTHON = "C:/Repos/ecc-ub-tools/Scripts/python.exe"
```

For an installed skill, use its absolute `requirements.txt` path instead. Package installation
is an explicit setup step and may access the network. Copy the environment or prepare a local
wheelhouse using your organization's normal process when the workstation has no external
package access. The reviewer does not install dependencies.

`tools.json` records the three upstream tool commits and their 0BSD licenses. The requirements
pin their source archives and compatible parser dependencies. These pinned engines use a
process-local compatibility adapter: requests for grammars resolve to the bundled language
pack instead of downloading a grammar. An incompatible environment reports unavailable tools.

The `uml-viewer` companion is an optional visualization tool. Its GUI launcher is outside this
automated review workflow; the required quality engines are `crapper`, `dryer` and `mutator`.

## Mutation Test Command

Supply a noninteractive test command as a JSON argument array. The executable and each argument
are passed directly to a process, without shell interpolation. On Windows, use a native
executable such as `node` rather than a `.cmd` launcher.

For a project with a test entry point:

```powershell
$env:ECC_UB_TEST_COMMAND = '["node","tests/run-tests.mjs"]'
node skills/ub-mode/scripts/review.js --project C:/Repos/my-project --file src/example.ts
```

The command must produce coverage in a format supported by the pinned engines. For Angular
versions using the current unit-test builder, an example is:

```powershell
$env:ECC_UB_TEST_COMMAND = '["node","node_modules/@angular/cli/bin/ng.js","test","--watch=false","--coverage","--coverage-reporters=lcov"]'
node skills/ub-mode/scripts/review.js --project C:/Repos/my-project --base origin/main --timeout-ms 120000 --budget-ms 900000
```

Match the flags to the installed project's builder. Older Karma configurations can expose
different coverage options. See the [Angular test command reference](https://angular.dev/cli/test).
The runner does not invent a test command or infer a passing test suite from package metadata.

When a command is configured, the runner copies sources and configuration to a temporary
directory and links the installed `node_modules`. The baseline runs there before analysis,
so its coverage describes the copied sources. Each covered mutant is then applied, tested
and restored sequentially. Mutation sites and replacements come from the pinned upstream
`mutator` engine; ECC handles execution and process cleanup. The live source tree is not used
as the mutation target.

Defaults allow 20 mutants, 30 seconds per command and five minutes overall. Use `--max-mutants`,
`--timeout-ms` and `--budget-ms` to adjust them. Timeouts, output limits or unconfirmed process
cleanup leave the gate incomplete. Mutants beyond the selected limit remain untested rather
than passing. The source copy is bounded to 10,000 files and 64 MiB, excludes generated build
directories and skips symbolic-link sources. Analysis has separate limits of 2,000 sources,
8 MiB per source, 32 MiB total and 5,000 mutation sites.

Without a test command, all three engines still run their applicable static analysis. The
mutation section says `scan` and `incomplete`: no mutation test has passed. Missing coverage
also remains explicit. `dryer` at the pinned revision supports TypeScript but does not support
JavaScript; that unsupported check is reported as a gap. Documentation-only changes need no
language engine and receive explicit `not-applicable` statuses.

The CLI prints a JSON report. Exit codes are `0` for completed applicable gates with no
failures, `1` for findings, incomplete validation or runtime failure, and `2` for invalid
arguments. A metric finding still needs the reviewer's context and confidence assessment.

## Pull Changes From ub-mode

The upstream document is stored byte-for-byte at `references/upstream-skill.md`; `upstream.json`
records its source ref, immutable commit and SHA256. Its README directs users to copy the skill;
the pinned ub-mode repository has no separate license file. This provenance is independent of
the companion tools' licenses.

In an ECC Git checkout:

```powershell
npm run ub-mode:check
npm run ub-mode:update
npm run ub-mode:update -- --ref master --json
git diff -- skills/ub-mode manifests/context-packs/skill-triggers@1.json
```

The default tracked ref is `master`. A ref update resolves the current commit first, then
fetches `SKILL.md` at that immutable revision. The command updates only the owned upstream
snapshot and pin, then refreshes the context-registry digest and coverage counts. It preserves
the ECC wrapper, local tool configuration and curated skill triggers. Network errors, malformed
source and local checksum mismatches fail with a diagnostic. Review the resulting diff and run
repository validation before committing; updating is not an automatic approval of new instructions.

For a standalone installed skill without the ECC checkout metadata:

```powershell
node "<skill-dir>/scripts/sync-upstream.js" --check
node "<skill-dir>/scripts/sync-upstream.js" --update
```

Checks are offline. Updates are explicit and do not commit, push, install tools or execute
upstream instructions. Run `--check` after an interrupted update before retrying. Keep ECC
adaptations in the wrapper and setup reference rather than editing the checksum-protected copy.
