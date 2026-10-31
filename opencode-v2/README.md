# ECC for OpenCode V2

Full ECC for OpenCode 2.x: the Claude Code hook graph, all ECC agents, commands and skills.

OpenCode 2.0 replaced the plugin API, the config format and the file layout, so the
`.opencode/` layer in this repository (written for OpenCode 1.x) does not load there.
This directory is a separate, V2-native integration. It does not change `.opencode/`.

| ECC in Claude Code | ECC in OpenCode V2 |
| --- | --- |
| `hooks/hooks.json` (27 hooks: GateGuard, config protection, quality gates, hookify, memory persistence, continuous learning, cost tracking, notifications) | Executed unchanged by the bridge plugin through the Claude Code hook protocol |
| 71 agents (`agents/*.md`) | OpenCode subagents (`agents/*.md`), Claude `tools` allowlists become `deny` permissions |
| 97 commands (`commands/*.md`) | OpenCode slash commands (`commands/*.md`), `$ARGUMENTS` and `$1..$n` work as-is |
| 311 skills (`skills/*/SKILL.md`) | Registered by the plugin, loaded with the `skill` tool |
| `${CLAUDE_PLUGIN_ROOT}` in commands and skills | Set in the environment of every OpenCode shell command |

## Requirements

- OpenCode 2.0.32 or newer (`opencode --version`). The V2 plugin API is still marked beta.
- Node.js 20 or newer on `PATH`. ECC hook scripts run on Node, not on the OpenCode runtime.
- A clone of this repository. Hooks, skills and the plugin are read from the clone, so `git pull` updates them.
- No `npm install` is needed at runtime: the plugin and the hook scripts use only Node built-ins.

## Install

```bash
git clone https://github.com/lixonik/ECC
cd ECC
node opencode-v2/install.js
```

This writes into the OpenCode global config directory (`$OPENCODE_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`):

- `agents/<name>.md` for every ECC agent
- `commands/<name>.md` for every ECC command
- `plugins/ecc/` - a two-file entry that imports `opencode-v2/plugin/ecc.js` from the clone with your options
- `ecc-opencode-v2.install.json` - the list of files the installer owns, with hashes

Your `opencode.json(c)` is never edited. Restart OpenCode after installing.

For one project only:

```bash
node opencode-v2/install.js --scope project --project path/to/project
```

The plugin entry points at the clone by absolute path, so run the installer again if you move
the clone. After `git pull`, just restart OpenCode: on startup the plugin refreshes the generated
agents and commands from the clone with the options you installed with (`--no-auto-sync` turns
this off). Files you edited or deleted after install, and files the installer did not create, are
left alone; `--force` on the installer overwrites or restores them.

```bash
node opencode-v2/install.js status
node opencode-v2/install.js uninstall
```

### Options

| Option | Effect |
| --- | --- |
| `--hooks on\|off` | Run ECC hooks through the bridge (default `on`) |
| `--profile minimal\|standard\|strict` | ECC hook profile (default `standard`) |
| `--disable-hook <ids>` | Comma-separated ECC hook ids, for example `pre:bash:tmux-reminder,stop:desktop-notify` |
| `--shell auto\|Bash\|PowerShell` | Tool name ECC hooks see for OpenCode's `shell` tool (see Windows below) |
| `--model-map opus=p/m,sonnet=p/m,haiku=p/m` | Pin ECC agents' Claude tiers to your models. Without it agents inherit the session model |
| `--skills <ids>` / `--no-skills` | Register only some ECC skills, or none |
| `--skill-catalog full\|auto\|compact\|<ids>` | Which skills are described in the system prompt (see Skill catalog below). `full` (default) lists all, like Claude Code (~125k characters) |
| `--no-skill-suggestions` | Do not append per-prompt skill suggestions in non-`full` catalogs |
| `--no-context` | Do not add the short ECC tool-mapping note to the system prompt |
| `--rules <sets>` | Apply ECC rule sets from `rules/`, for example `common,typescript,angular` (see below). Off by default |
| `--review-gate` / `--review-agent <id>` | Before a turn that changed files ends, require an independent reviewer subagent pass (see Review gate below). Off by default |
| `--node <path>` | Node.js executable for hook scripts (default `node` on `PATH`, or `$ECC_NODE`) |
| `--llm-summary` | Allow PreCompact/SessionEnd hooks to call the `claude` CLI for summaries (off by default) |
| `--claude-shim` | Provide a `claude` CLI that runs through OpenCode for ECC features built on `claude -p` (see Claude CLI shim below) |
| `--data-home <dir>` | `ECC_AGENT_DATA_HOME` for hooks and shells (default: ECC's own default, `~/.claude`) |
| `--dry-run` | Print the plan only |

The same switches exist at runtime as environment variables, and the environment wins over
installer options, exactly as in Claude Code: `ECC_HOOKS_ENABLED`, `ECC_HOOK_PROFILE`,
`ECC_DISABLED_HOOKS`, `ECC_GATEGUARD=off`, and so on (see `hooks/README.md`).

## How the bridge works

`plugin/ecc.js` is an OpenCode V2 plugin (`export default { id, setup }`). It reads
`hooks/hooks.json` with `hooks/hooks.metadata.json`, and for every OpenCode event builds the
JSON a Claude Code hook receives, runs the matching ECC commands with `node` (no shell), and
maps the hook decisions back.

| Claude Code event | OpenCode V2 trigger | Decision mapping |
| --- | --- | --- |
| `PreToolUse` | `ctx.tool.hook("execute.before")` | deny / exit 2 rejects the call with the hook reason; `ask` opens an OpenCode permission prompt; `allow` pre-approves the call's own permission check; `updatedInput` rewrites the arguments; `additionalContext` is attached to the tool result |
| `PostToolUse` | `execute.after` (completed) | `block` reason and `additionalContext` are appended to the tool result in `<ecc-hook-feedback>` |
| `PostToolUseFailure` | `execute.after` (error) | feedback is delivered as a steering message |
| `UserPromptSubmit` | `ctx.session.hook("prompt")` | context is appended to the prompt; `block` replaces it with the reason |
| `SessionStart` | first prompt of a session (`startup`/`resume`), after compaction (`compact`) | context is injected into the system prompt of that session |
| `Stop` | `session.execution.succeeded` event | `block` resumes the session once with the reason; `stop_hook_active` is passed like in Claude Code |
| `PreCompact` | `ctx.session.hook("compaction")` | `trigger` is `manual` or `auto` |
| `SessionEnd` | `session.deleted` event and plugin shutdown | |

Matchers keep Claude Code semantics (`Edit|Write` is an exact list, `^mcp__` is a regex).
Hook ids and profiles are checked before spawning, so disabled hooks cost nothing.

Tool names and arguments are translated both ways:

| OpenCode tool | Claude Code tool seen by hooks |
| --- | --- |
| `shell` | `Bash` or `PowerShell` |
| `edit` (`path`, `oldString`, `newString`) | `Edit` (`file_path`, `old_string`, `new_string`) |
| `write` | `Write` |
| `patch` (GPT models) | `MultiEdit` per updated file, `Write` per added file |
| `read`, `glob`, `grep`, `webfetch`, `websearch` | `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch` |
| `subagent` | `Task` (`subagent_type`) |
| `skill` | `Skill` |
| `question` | `AskUserQuestion` |
| MCP tool `server_tool` | `mcp__server__tool` |

Hooks that read the Claude Code transcript (GateGuard turn scans, session summaries, continuous
learning, cost tracking, PreCompact) get a Claude-format JSONL mirror that the plugin writes
from OpenCode events: user prompts, tool calls and results, assistant text, token usage,
compaction boundaries.

Logs and transcript mirrors live in `$XDG_STATE_HOME/ecc-opencode` (default
`~/.local/state/ecc-opencode`). Set `ECC_OPENCODE_DEBUG=1` to log every OpenCode event the
plugin receives. ECC's own data (sessions, instincts, metrics) stays where ECC keeps it, so the
paths in ECC commands and skills remain correct.

## Skill catalog

What matters is that the right skill reaches the model: on a SkillsBench subset, having the
relevant skill raised DeepSeek V4-Flash pass rates by 18-26 points, while how the skill was
worded barely mattered ([arXiv:2605.31408](https://arxiv.org/abs/2605.31408)). Listing all 311
skills is the blunt way to get there and costs every request ~125k characters of attention.

- `full` - every skill described, as in Claude Code.
- `auto` - the core workflow skills (`tdd-workflow`, `verification-loop`, `security-review`, ...)
  plus the skills for the project's stack, detected with ECC's own project detection when OpenCode
  opens the project (for Angular: `angular-developer`, `frontend-*`, ...).
- `compact` - only `ecc-guide`.
- `<ids>` - exactly the listed skills.

Outside `full`, every other skill stays loadable by id, and all their ids are listed in one line.
Each prompt also gets up to three suggestions picked by ECC's local retrieval (BM25 plus hashed
vectors, no network), filtered by the project's stack and dropped when the match is weak. The
suggestions are appended to the user message rather than the system prompt, so the prompt prefix
stays stable for server-side prefix caching. The English retrieval index is supplemented by local
Russian intent aliases for accessibility, bug fixes, E2E tests, commit messages, refactoring,
Angular changes, verification and security review. Case, `ё` and mixed technical vocabulary are
normalized. These aliases use the same stack filter, catalog exclusions and three-suggestion
limit. They cover common requests rather than translating arbitrary prompts.

## Review gate

A model reviewing its own work in the same context tends to approve it. With `--review-gate`,
the bridge asks the model to run `code-reviewer` (or `--review-agent <id>`, for example
`typescript-reviewer`) in a fresh context and fix every CRITICAL and HIGH finding before finishing.
A reviewer counts only after its tool call completes successfully and the changes still match
the snapshot taken when that review started. Failed reviews and later edits require another review.

In Git projects, the gate compares working-tree contents with a baseline captured at the start of
the user turn, including untracked files. This also catches changes made by shell commands,
generators and formatters. Existing changes that remain untouched do not trigger a review.
Outside Git, it tracks successful edit, write and patch tool calls, including subagent edits.
Inspection is bounded to 2,000 files, 8 MiB per file and 32 MiB in total. Incomplete inspection
produces a diagnostic instead of recording a successful review.
The snapshot covers working-tree contents; index-only edits are not a separate review target.

The gate runs after ECC's own Stop hooks and shares their bounded continuation limit. It needs an
interactive session (TUI or `opencode serve`), since single-shot `opencode run` cannot resume a
finished turn. A completed reviewer call records that a review ran; the model remains responsible
for assessing and addressing its findings.

## Claude CLI shim

Some ECC features hand side work to the Claude Code CLI with `claude -p`: LLM session summaries
(PreCompact and SessionEnd), the continuous-learning observer that extracts instincts, the GAN
harness behind `/gan-build` and `/gan-design`, the `claw` REPL and `skill-comply`. Without Claude
Code those calls fail and the features stay off. `--claude-shim` puts a `claude` launcher first on
`PATH` for ECC hooks and OpenCode shell commands. It runs each request through
`opencode run --standalone` with your OpenCode model and answers in Claude's shapes:

- the prompt goes over stdin, so long transcripts are not limited by the command line;
- `--model opus|sonnet|haiku` follows `--model-map`; an unmapped tier uses the model and reasoning
  level of the session that triggered the call;
- `--output-format text|json|stream-json` are produced (tool calls appear as Claude `tool_use`);
- `--max-turns` stops the run; `--allowedTools` / `--disallowedTools` (including
  `Bash(git diff:*)`) are enforced by the plugin inside the nested run;
- hooks are off in the nested run and a nested `claude` call is refused.

Command-specific shell restrictions accept literal simple commands. Compound commands, pipelines,
redirections and executable substitutions are refused when these restrictions apply. A bare
`Bash` or `PowerShell` rule still grants unrestricted shell access unless a command restriction
also applies. The rules filter tool invocations; they do not sandbox the programs being called.

Each nested run has a five-minute wall-clock timeout. Set `ECC_CLAUDE_SHIM_TIMEOUT_MS` to a positive
integer in milliseconds to change it. Timeout and `--max-turns` termination stop the child process
tree; JSON output reports `error_timeout` or `error_max_turns`. Streamed text is decoded as UTF-8
across chunk boundaries, including Russian text.
On Windows, detached processes that outlive their parent can escape tree termination. Cleanup
failures are reported on stderr; the shim still returns within its bounded shutdown window.

LLM session summaries turn on together with the shim (`--llm-summary` is implied). Limits: every
call starts a private OpenCode server, which adds a few seconds; Python callers on native Windows
(`skill-comply`) cannot start a `.cmd` launcher; ECC's background observer only survives on Linux,
macOS and WSL2 (ECC issue #2489), and it is enabled in
`skills/continuous-learning-v2/config.json` (`observer.enabled`).

## One self-hosted model: reasoning levels

With a single model, its reasoning levels are OpenCode model variants (for example `low`,
`medium`, `high`, picked with the model in the TUI). Pick a level for the session and everything
ECC starts from it inherits that level: ECC subagents launched without their own model, and the
nested runs of the Claude CLI shim (LLM summaries, `/gan-build`). The smoke suite checks both. So
if you always work at your highest level, there is nothing to configure.

To deviate per agent, map ECC's Claude tiers to variants. The tiers are `opus` for planner,
architect, spec-miner and healthcare-reviewer, `haiku` for doc-updater, docs-lookup,
comment-analyzer, conversation-analyzer and the opensource pair, and `sonnet` for the rest. For
example, to answer lookups faster while everything else keeps the session level:

```bash
node opencode-v2/install.js --model-map haiku=company/deepseek-v4-flash#low
```

An unmapped tier follows the session; a mapped tier always uses its variant, also in the shim. If
your provider does not define variants yet, declare them on the model in `opencode.json`. The
request fields below are DeepSeek's public API; a self-hosted server may expose different ones,
so check with whoever runs it:

```json
{
  "providers": {
    "company": {
      "models": {
        "deepseek-v4-flash": {
          "variants": [
            { "id": "low", "body": { "thinking": { "type": "disabled" } } },
            { "id": "high", "body": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" } }
          ]
        }
      }
    }
  }
}
```

## Rules

The Claude Code plugin cannot ship ECC's `rules/`; in Claude Code they are installed into
`.claude/rules` separately. `--rules` brings them to OpenCode with the same scoping: a rule
without `paths` (all of `common/`) applies to every session, and a rule with `paths` (for
example `angular/` on `**/*.component.ts`) joins a session's system prompt once that session
reads or edits a matching file. `common` alone is about 19k characters.

## Windows

OpenCode V2 picks `pwsh`, then `powershell`, then Git Bash, then `cmd` for its shell tool,
unless `"shell"` is set in `opencode.json`. With `--shell auto` (default) the plugin reads that
setting and reports the tool to ECC hooks as `PowerShell` or `Bash` accordingly.

ECC's Bash hooks (commit quality checks, `--no-verify` blocking, push reminders, dev server
guard) only see `Bash`. Under PowerShell, ECC runs its PowerShell coverage instead: GateGuard
with PowerShell destructive-command checks, hookify, observation and governance capture.
ECC commands and skills are also written with bash syntax. For the closest match to Claude Code,
let OpenCode use Git Bash:

```json
{ "shell": "bash" }
```

## Differences from Claude Code

- `opencode run` is single-shot: when a Stop hook blocks, the session would resume, but the
  CLI has already exited. Interactive sessions (TUI, `opencode serve`) resume normally.
- `SessionEnd` fires when a session is deleted or the OpenCode server shuts down. A TUI
  window closing while the background service keeps running does not end the session.
- ECC's LLM summaries call the `claude` CLI; they are skipped unless `--claude-shim` (or a real
  `claude` plus `--llm-summary`) is set.
- The full ECC skill catalog adds roughly 125k characters to every request, as in Claude Code.
  On small-context or metered models use `--skill-catalog compact`, or `--skills` to drop skills.
- Not ported: the Claude Code statusline script and the MCP server list (ECC only ships an
  optional `chrome-devtools` entry; add MCP servers in OpenCode's own `mcp` config).

## Verify after OpenCode upgrades

The V2 plugin API is beta, so check the bridge against the real binary after upgrading.
The smoke suite runs OpenCode in a throwaway sandbox (its own HOME and config) against a local
scripted model, so nothing leaves the machine and no API key is needed:

```bash
node opencode-v2/smoke/run.js --opencode "$(command -v opencode)"
```

On native Windows, pass the actual executable, including when npm also installs an
`opencode.cmd` launcher:

```powershell
node opencode-v2/smoke/run.js --opencode "C:/tools/opencode/opencode.exe"
```

It covers GateGuard, config protection, hookify bash/file/prompt/stop rules, patch
translation, compaction, a read-only ECC subagent, skill loading, the compact skill catalog,
path-scoped rules, slash command expansion (including commands that must not run shell
interpolation), startup auto-sync, reasoning levels (per-tier variants and inheritance from the
session), the review gate, the Claude CLI shim
with its tool restrictions, and SessionEnd. Unit and integration tests that need no OpenCode
binary run with the rest of the repository tests: `node tests/run-all.js opencode-v2`.

## Diagnose a workstation or model endpoint

Run the doctor before the first session or after changing an installation:

```powershell
node opencode-v2/doctor.js --project "C:/repos/my-project"
node opencode-v2/doctor.js --project "C:/repos/my-project" --opencode "C:/tools/opencode/opencode.exe" --json
```

The default checks run locally. They inspect Node.js (20+), OpenCode (2.0.32+), Git, the selected
shell, the configured hook Node executable, JSONC syntax, hook and skill manifests, and installed
files against their ownership manifest. The doctor does not run ECC hooks or change files.
An absent installation is a warning; missing installed files are errors, and customized files
produce warnings. Use `--config-dir` for a nondefault installation. On native Windows, batch
launchers (`.cmd` or `.bat`) cannot be checked by the doctor; pass the native executable instead.

Endpoint requests require an explicit `--probe`. Use the endpoint's real model ID and, if it
requires authentication, the name of an environment variable containing its key:

```powershell
node opencode-v2/doctor.js --project "C:/repos/my-project" --probe --base-url "https://inference.example/v1" --model "deepseek-v4-flash" --api-key-env MODEL_API_KEY --thinking on --reasoning-effort high --timeout-ms 120000
```

The probe sends two synthetic OpenAI-compatible streaming requests. It checks streamed text,
fragmented tool arguments, a harmless local tool result and a second response that confirms a
fresh token from that result. It preserves `reasoning_content` across the tool round-trip when
the endpoint returns it. Repository contents are not sent. Reports omit credentials, endpoint
URLs and raw provider responses; redirects are refused, and a deadline and byte limit bound the
requests. An unauthenticated endpoint needs no `--api-key-env`.

`--thinking` and `--reasoning-effort` send DeepSeek's public request fields. A self-hosted server
may expose different fields. A successful probe verifies this direct API exchange, while the
smoke suite checks OpenCode's adapter. When thinking is requested but no reasoning is observed,
the doctor reports a warning; observing reasoning does not prove a particular effort level was
applied. Exit codes are `0` for passed checks with optional warnings, `1` for failed checks, and
`2` for invalid CLI arguments.

## Recommended setup for a self-hosted DeepSeek V4 Flash

With an unmetered in-house model, spend tokens on computation (reasoning, independent review,
side tasks) rather than on prompt size. Select your highest reasoning level for the session, and
install with:

```bash
node opencode-v2/install.js --skill-catalog auto --rules common,typescript,angular --review-gate --claude-shim
```

ECC subagents, the review pass and the shim then all run at the level you picked. Adjust the rule
sets to your stack. Run the local doctor, then the explicit endpoint probe, before relying on
the configured reasoning levels and tool round-trips.
