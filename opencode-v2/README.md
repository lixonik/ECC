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
the clone. Re-run the same command after `git pull` to refresh agents and commands. Files you edited
after install, and files the installer did not create, are left alone (`--force` overrides).

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
| `--no-context` | Do not add the short ECC tool-mapping note to the system prompt |
| `--node <path>` | Node.js executable for hook scripts (default `node` on `PATH`, or `$ECC_NODE`) |
| `--llm-summary` | Allow PreCompact/SessionEnd hooks to call the `claude` CLI for summaries (off by default) |
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
- ECC's LLM summaries call the `claude` CLI; they are skipped unless `--llm-summary` is set.
- The ECC skill catalog adds roughly 140k characters to the system prompt, as in Claude Code.
  Use `--skills` to keep only what you need on small-context models.
- Not ported: the Claude Code statusline script and the MCP server list (ECC only ships an
  optional `chrome-devtools` entry; add MCP servers in OpenCode's own `mcp` config).

## Verify after OpenCode upgrades

The V2 plugin API is beta, so check the bridge against the real binary after upgrading.
The smoke suite runs OpenCode in a throwaway sandbox (its own HOME and config) against a local
scripted model, so nothing leaves the machine and no API key is needed:

```bash
node opencode-v2/smoke/run.js --opencode "$(command -v opencode)"
```

It covers GateGuard, config protection, hookify bash/file/prompt/stop rules, patch
translation, compaction, a read-only ECC subagent, skill loading, slash command expansion and
SessionEnd. Unit and integration tests that need no OpenCode binary run with the rest of the
repository tests: `node tests/run-all.js opencode-v2`.
