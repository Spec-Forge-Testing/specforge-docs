# Desktop app

Spec Forge Desktop is a window onto the same core the [CLI](../specforge-cli.md) drives. It
starts the core for you, talks to it over the same JSON-RPC protocol, and shows each step of a
run as a screen: what will be sent, what it will cost, and what came back. Everything it offers
comes from what the core publishes, so a newer core shows up in the app without a new release.

## The screens

The sidebar groups the screens by what you are doing.

| Group | Screen | What it is for |
| --- | --- | --- |
| Project | Workspace | The open project, its environment status and its recent runs |
| Project | Contract | The OpenAPI contract, endpoint by endpoint; reload it, swap it or generate it from the code |
| Project | Code | Static analysis: each endpoint traced to its handler in your code |
| Project | Fuzz | The [new-run screen](new-run.md): choose a test, shape it, start it |
| Investigation | Runs | Saved runs; each opens its [run detail](run-detail.md) |
| Investigation | Compare | Two runs side by side, and what changed between them |
| Investigation | Replay | Re-send a run's recorded requests and read what still fails |
| Environment | Storage | What the store takes on disk, and pruning it after a preview |
| Environment | Doctor | Whether this machine is ready: core, LLM, target API and store |
| Environment | Settings | Theme, LLM provider and key, and the defaults of a new run |

## Pages in this section

- [New run](new-run.md): the three steps of the Fuzz screen, presets, the run map and chains of
  runs.
- [LLM rules and side effects](llm-rules-and-side-effects.md): what LLM rules read, how their cost
  is estimated and approved, the cost cap, and what the safety guard holds back.
- [Run detail](run-detail.md): load steps of a performance run, and endpoints that ran without an
  LLM contract.

For the words a run uses (mode, strategy, finding, degraded), see
[Core Concepts](../concepts.md) and the [Glossary](../glossary.md).
