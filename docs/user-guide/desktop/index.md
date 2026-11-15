# Desktop app

Spec Forge Desktop is a window onto the same core the [CLI](../specforge-cli.md) drives. It
starts the core for you, talks to it over the same JSON-RPC protocol, and shows each step of a
run as a screen: what will be sent, what it will cost, and what came back. Everything it offers
comes from what the core publishes, so a newer core shows up in the app without a new release.

The app runs in one of two modes, chosen on first launch and switched at any time:
**Simple**, the essentials in plain words, and **Developer**, which adds custom runs, every core
option, raw requests, JSON and LLM prompts. Both show the same screens; see
[Simple and Developer mode](modes.md).

## The screens

The sidebar groups the screens by what you are doing.

| Group | Screen | What it is for |
| --- | --- | --- |
| Project | Workspace | The open project, its environment status and its recent runs |
| Project | Contract | The OpenAPI contract, endpoint by endpoint; reload it, swap it or generate it from the code |
| Project | Code | Static analysis: each endpoint traced to its handler in your code |
| Project | Fuzz | The [new-run screen](new-run.md): choose a test, review it, start it |
| Investigation | Runs | Saved runs; each opens its [run detail](run-detail.md) |
| Investigation | Compare | Two runs side by side, and what changed between them |
| Investigation | Replay | Re-send a run's recorded requests and read what still fails |
| Environment | Storage | What the store takes on disk, and pruning it after a preview |
| Environment | Doctor | Whether this machine is ready: core, LLM, target API and store |
| Environment | Settings | The mode, theme, LLM provider and key, and the defaults of a new run |

## Pages in this section

- [Simple and Developer mode](modes.md): choosing and switching the mode, and what Simple leaves
  out on each screen.
- [New run](new-run.md): the steps of the Fuzz screen, presets, the review, the run map and
  chains of runs.
- [Your presets](saved-presets.md): saving a Custom setup as a preset, editing and deleting it,
  and side effects a preset saved.
- [LLM rules and side effects](llm-rules-and-side-effects.md): what LLM rules read, how their cost
  is estimated and approved, the cost cap, what the safety guard holds back, and the price of
  generating a contract.
- [Run detail](run-detail.md): the header and what to do about each warning, Run again, when a run
  reads clean, load steps of a performance run, and endpoints that ran without an LLM contract.

## Core versions

The app works with older cores and shows what each one offers. A few features need a core that
speaks protocol `0.2.7` or later; an older core simply does not show them.

| Feature | With an older core |
| --- | --- |
| [Your presets](saved-presets.md) | Only the built-in tests are offered (a core without a store offers no saved presets either) |
| [The price of a contract generation](llm-rules-and-side-effects.md#generating-a-contract-with-the-llm) | No estimate before generating; the cap still holds |
| [The preset a run came from](run-detail.md#the-header), and Run again with the run's setup | Runs are named by mode and strategy; Run again starts from those |
| The **Recommended** mark from the core | The app marks Standard check |
| [**No defects** on a row of the Runs list](run-detail.md#clean) | Rows read their status; the run detail still gives the verdict |
| What to do about each warning, in the core's words | The app's own sentence |

For the words a run uses (mode, strategy, finding, degraded), see
[Core Concepts](../concepts.md) and the [Glossary](../glossary.md).
