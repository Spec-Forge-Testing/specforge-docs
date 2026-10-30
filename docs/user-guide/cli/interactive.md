# Interactive use

This page covers the two interactive surfaces of the packaged `specforge` client. For one-shot calls in scripts and CI, see [Scripts and CI](scripts-and-ci.md).

## The full-screen interface

When both stdin and stderr are real terminals, `TERM` is not `dumb` and `SPECFORGE_TUI`
is not turned off, `specforge` takes over the screen: a banner and the conversation
above, one input line anchored at the bottom between two rules, and the current folder
(plus the open project, when it lives elsewhere) under it. The interface draws to
stderr, so stdout stays reserved for machine output. When any of those conditions fails,
the [text REPL](#the-text-repl) opens instead; `--json-output`, `--ci` and every
one-shot call never use the full-screen interface.

The banner says which core you are connected to and shows the CLI's version, the
folder you started in, tips, and your last few commands under *Recent activity* (kept
per project, in `.specforge/shell_history`). On a narrow terminal it drops to a
compact form without the box, and under 24 columns to a single line; nothing it
prints ever wraps.

### Typing a command

Commands are written as operation names with `key=value` pairs; there is no `/`
prefix. As you type, a menu lists the commands that match, each with what it does:
`↑`/`↓` move through it, `Enter` takes the highlighted entry (and, for a command that
needs nothing else — `help`, `clear`, `exit`, or an operation with no parameters —
runs it), `Esc` closes it. A first word the CLI does not know shows a notice with the
closest commands; `Enter` still sends it, and the core answers like any other error.

| Local command | What it does |
| --- | --- |
| `help [group\|operation]` | Opens a panel with a tab per [group of commands](#finding-a-command-with-help), the commands in it, and each operation's parameters. `←`/`→` change tab, `↑`/`↓` choose, `Enter` shows the details, `Esc` closes it. |
| `clear` | Clears the screen, leaving the banner and the input. A run still going keeps going. |
| `approve` | Approves what the core just asked to be approved. |
| `credentials [file.env]` | Saves your LLM API key: pick a provider and paste the key, or give it a `.env` of your own to copy from. |
| `model [id]` | Chooses the LLM model: pick one from your provider's list, or name it (`provider/model`). It is saved as `LLM_MODEL` in the same env file as the key, and `get_config` shows it as `llm.primary_model` from the `environment` layer. |
| `!<command>` | Runs a [system command](#system-commands-with). |
| `exit`, `quit` | Leaves. |

### Reading what comes back

What you typed is shown on a shaded line; what the core answers sits under it, and an
error hangs from it with a `└`. A long run shows one live line (a spinner, what it is
doing, the latest counters) and keeps its detailed progress folded: click the line, or
press `Ctrl-O`, to open it while it runs or once it finished; `Ctrl-O` again closes
every fold. The same finding reported again and again is shown once, followed by `×N`.
A table of more than 50 rows opens in a viewer (click it, or press `Ctrl-T`; `↑`/`↓`,
`PgUp`/`PgDn` to move, `Esc` to close) instead of flooding the conversation.

For the meaning of the sections and counts in a run, see the
[Run Report](../reports.md).

### Keys

| Key | Effect |
| --- | --- |
| `Enter` | Sends the line (or takes the highlighted menu entry). |
| `Esc` | Closes the menu, a panel or a viewer, or drops a selection. |
| `Ctrl-C` | Copies the selection if there is one; otherwise cancels the runs in flight (the core answers with what they produced). |
| `Ctrl-D` | Leaves, on an empty input line. |
| `Ctrl-L` | Clears the screen. |
| `Ctrl-O` / `Ctrl-T` | Opens or closes the folded progress / opens the last long table. |
| `Ctrl-V` | Pastes from the system clipboard, as a single line. |
| `PgUp` / `PgDn`, mouse wheel | Scroll the conversation. |

Dragging with the mouse selects text and copies it when you let go (to the system
clipboard, and through the terminal's own clipboard escape where the system one is
not reachable). With `SPECFORGE_MOUSE=0` the terminal's native selection works
instead; in many terminals `Shift`+drag does the same without turning anything off.

### Questions

When something needs your say, a question takes the place of the input and the conversation
stays in view above it. Three kinds come up:

- **An approval** (a destructive operation, a run that would pay for LLM inference, a replay
  with side effects): the question and what would be sent. Only `y` approves; `n`, `Enter`,
  `Esc`, `Ctrl-C` and `Ctrl-D` decline, and a declined call says *not approved; nothing was
  sent*. Other keys do nothing, and a `y` typed before the question appeared is ignored, so
  typing ahead never approves anything. For an inference cost or a replay, run the call, read
  the estimate or the reason, and type `approve` to get the question.
- **Trusting the folder.** Opening `specforge` in a folder that is not a project asks
  *Do you trust this folder?* and lists what trusting allows: creating `specforge.toml` and a
  `.specforge/` folder, reading the source code, and saving the spec when you give a URL. Only
  `y` trusts; nothing is written to the folder before that.
- **The spec.** In a trusted folder with no `openapi.yaml`, `.yml` or `.json`, a line asks for
  the spec as a file path or a URL (a URL is downloaded into the folder). A path with no file,
  or a URL that cannot be fetched, says why and asks again; an empty line or `Esc` cancels.

### Finding a command with `help`

`help` groups what can be typed the way a session goes, not the way the core's code is
organized. A command that sets the LLM up sits with the other setup commands, whether the CLI
answers it itself (`credentials`, `model`) or the core does (`list_llm_models`).

| Group | What it holds |
| --- | --- |
| `project` | Create, open, close and switch projects, and list the ones saved. |
| `contract` | Load the OpenAPI spec, explore its endpoints and analyze the code behind them. |
| `run` | Fuzz the API, estimate inference cost, replay runs and browse their history. |
| `finding` | Read a finding, have it explained, and have a fix proposed and applied. |
| `setup` | Set up the LLM (`credentials`, `model`, `list_llm_models`), the options and the environment. |

`help` lists the groups, `help setup` lists the commands of one, and `help <operation>` shows an
operation's parameters. The names `help` used before (`results`, `execution`, `config`, and the
rest of the core's families) still answer, saying which group their operations are in now.
`help` is a command of the interactive session; from a shell, `specforge --help` lists the
operations.

## The text REPL

The fallback interface: a prompt (`❯`), one line at a time, results printed in
your terminal's scrollback. It takes the same lines and the same local commands as
the full-screen interface, and the same completion (below), and it is what you get
over a pipe, in a `dumb` terminal, on Git Bash without a pseudo-terminal, or with
`SPECFORGE_TUI=0`. A destructive call, an inference cost or a replay with side
effects is confirmed inline (see [Approvals and cost estimates](scripts-and-ci.md#approvals-and-cost-estimates)).

While an operation that reports progress runs, a live line under the prompt says what is
running — a spinner, the operation and the latest counters (`120 sent · 3 with problems · 4.2s
elapsed`) — and goes away when it ends. With several running at once it shows the newest and
counts the rest (`(+1 more)`). The prompt stays usable meanwhile. Events that are not counters
(a finding, an endpoint starting) are still printed above it. The line needs a terminal that can
redraw it: over a pipe, in a `dumb` terminal or with `--json-output` there is none, and every
progress event is printed as its own line instead.

## Two ways to write a call

**Inside the interactive session**, a line is `<operation> [key=value ...]`:

```text
❯ open_project path=/home/dev/my-api
❯ fuzz base_url=http://localhost:8000 execution=stateful
```

Each value is parsed as JSON when it looks like JSON (`42`, `true`,
`{"a":1}`), and as a plain string otherwise — so quoting is only needed for a
string that happens to look like a number or a keyword.

A value with spaces goes in quotes right after the `=`. Double quotes are taken
literally, so a Windows path needs no escaping; single quotes are read like an
unquoted value, which is how a JSON object with spaces is quoted. An object or
array can also span spaces unquoted:

```text
❯ open_project path="C:\Users\Ana Perez\my-api"
❯ fuzz base_url=http://localhost:8000 load={"latency_sla_ms": 500}
```

**From your shell**, a flag is `--<name-with-dashes> <value>`, derived from the
same parameter name with underscores turned to dashes:

```bash
specforge fuzz --base-url http://localhost:8000 --execution stateful
```

A boolean parameter is a flag with no value, with an automatic negated form:
`--save` / `--no-save`. An `object`-typed parameter (`load`, `producer` on
`fuzz`/`run_pipeline`) takes one flag carrying a JSON literal, the same
convention the interactive session uses for a line's own `key=value`:

```bash
specforge fuzz --base-url http://localhost:8000 \
  --producer '{"kind": "fixture", "contracts_dir": "contracts/"}'
```

A path flag you type in the shell is resolved against the directory you ran the
command from, including a path inside a JSON flag (`producer.source_repo`). The
core would otherwise read a relative path from the project root.

A required parameter you omit, an enum value outside the declared list, or an
integer outside its declared range is caught **before** the request reaches
the core, in both forms — the message names the parameter and, for an enum,
every admissible value. Everything else (does the project exist, is the
contract loaded) is the core's call alone; the CLI never second-guesses it.

## Interactive niceties

The prompt completes as you type, in order: the operation name first, then
`<parameter>=` for one of that operation's parameters, then — for an `enum`
parameter — the admissible values after the `=`. All of it is derived from the
catalog, so a parameter the core adds later completes without a CLI release.

The history (`.specforge/shell_history`, kept only once the folder is a project) never stores a credential in
plain text. A line that mentions `headers` (the option where an `Authorization`
header would go) is not written to the file at all, though the up arrow still
recalls it during the session. Any `user:pass@host` userinfo embedded in a URL
(e.g. a `base_url=` with inline credentials) is redacted to `user:***@host`.
Nothing is scrubbed from what the core itself logs or persists, and a secret
passed as a shell argument stays in your shell's own history: this only protects
the history file.

### System commands with `!`

Prefix a line with `!` to run it as a system command without leaving the
session:

```text
❯ !git status
❯ !pytest -q
```

The escape is explicit on purpose: a line without `!` is always an operation call,
so a typo in an operation name never turns into an accidental system call. A `!`
line never reaches the core; the CLI runs it locally.

- **Streaming output.** `stdout` is shown as the command runs and `stderr` in the
  error colour, so a long command shows progress. A non-zero exit code is reported.
- **Working directory.** Commands run in the directory the CLI was started in. `!cd
  <dir>` moves the session there, so the commands that follow run in the new
  directory; `!cd` with no argument prints the current one. A directory that does
  not exist is reported and the session stays where it was. `!cd` does not change how
  operations resolve a relative path: the core anchors those to the project root.
- **Output encoding.** Output is read as UTF-8 and, if it isn't valid UTF-8, in the
  console's own codepage, so native Windows tools (`help`, `ping`) show their accents
  correctly.
- **The prompt stays free.** The command runs off the prompt, like any operation,
  so you can keep typing while it runs.
- **Failures don't end the session.** A missing program, an unparsable line (such
  as an unbalanced quote) or a failing command is reported and the session carries on.
- **Disabling it.** Set `SPECFORGE_SYSTEM_COMMANDS=0` (or `false`, `no`, `off`) to
  turn the escape off, for example in a shared or non-interactive environment.
  `!` then answers that system commands are disabled.

A command is a single program run **without a shell**: no pipes, redirection or
shell built-ins such as `dir` or `ls` (`cd` is the exception, handled by the CLI
itself), and no interactive programs (its stdin is closed, so
`vim` or `git rebase -i` will not work). The `!` escape exists only in the interactive
session (full-screen or text); the argv form (`specforge <operation> ...`) runs your shell's own commands anyway.

When a program isn't found, the error suggests running it through a shell, which is
how to use a built-in:

```text
❯ !dir
✗  Command not found: dir
   │ It may be a shell built-in, and `!` runs programs directly, without a shell.
   │ Try: !powershell -c "dir"
```

On Linux and macOS the suggestion is `!sh -c "..."`.
