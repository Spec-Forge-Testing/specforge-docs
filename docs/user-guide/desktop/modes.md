# Simple and Developer mode

The app has two modes for the whole window: **Simple** and **Developer**. Both show the same
screens, in the same places, with the same results. Simple shows less on each one: the
essentials in plain words. Developer adds custom runs, every core option, raw requests, JSON and
LLM prompts. Nothing that makes a result unsafe to trust is hidden in Simple, and the LLM asks
before it spends in both.

## Choosing a mode

The first time the app starts and the core is up, it asks **How do you want to use Spec
Forge?** with one card per mode:

| Mode | What the card promises |
| --- | --- |
| Simple | The essentials, in plain words: ready-made tests, each with its drawing; results with severity, the bar and Fix; nothing that makes a result unsafe is hidden; the LLM always asks before it spends |
| Developer | Everything in Simple, plus: custom runs and the run map; every core option; raw requests, JSON and LLM prompts; phases, hits and latency percentiles; save and edit your own presets |

**Continue in Simple** or **Continue in Developer** keeps that choice. Closing the question keeps
Simple. Either way a message says where to switch later. The question is asked once per launch
until a mode is picked, and never again after that.

## Switching

The mode switches at once, with no restart, from any of these:

| Where | How |
| --- | --- |
| Top bar | The mode button names the mode on (`Mode: Simple`); a click switches to the other |
| Keyboard | `Ctrl+Shift+D` (`⌘ ⇧ D` on macOS) |
| Command palette | `Ctrl+K`, then **Switch to Developer mode** or **Switch to Simple mode** |
| Settings | **Preferences on this machine > Mode**, which applies right away |

The mode is a preference of this machine, not of a project: every project opens in the mode you
left.

## What Simple leaves out

Simple keeps every screen and every result. What it leaves out is detail only a developer reads.

| Screen | What Simple leaves out |
| --- | --- |
| Fuzz, choose a test | The Custom card and the mode chips under each preset. A plan built in Developer shows as one **Custom setup** card, with **Edit in Developer mode** |
| Fuzz, review | The rules folder field, the model line, and **Repeatable run**. **Rules you wrote** is offered only when the project already has a rules folder, or the plan already uses it |
| Fuzz, map | The whole step: Simple starts from the review, so there is no map to check |
| Your presets | Editing a saved preset. Deleting it works in both modes |
| Live run | The phase beside each endpoint; the event feed starts folded as **What's happening** |
| Run detail | The ordering menu, row numbers and hit counts, the identity column unless the findings came under more than one user, latency percentiles unless the run measured load, each endpoint's breakdown, the contract cache, **How the defects were counted**, and the requests spent shrinking findings |
| Finding inspector | The headers sent, the phase, the hits, the rule id, the switch between records of the same bug, and error codes |
| Fix | **View prompt**, pasting a server trace, and copying the rebuild command. **Propose fix**, **Apply** and **Revert** stay |
| Runs | The **Comparability** column and the mode filter; each run's setup reads in plain words |
| Compare | The line-by-line caveats; their summary stays |
| Contract | The screen is listed once the project has a contract. Generating again a contract the project already has, and each endpoint's **Developer** section (its command and the endpoint as the core returned it) |
| Settings | The project's `specforge.toml` keys and presets, and the switch that stops the core asking before it spends. The LLM provider, model and key, and the preferences of this machine stay |
| Command palette | **Change the LLM model**; Simple reaches the model through Settings |

!!! note "Fix is in both modes"
    A finding's Fix tab works the same in Simple: **Propose fix**, **Apply**, **Revert** and the
    replay that checks the fix. Simple only hides the prompt and the trace field.

## When a run was built in the other mode

A plan you built in Developer is kept when you switch to Simple. The first step then shows it as
**Custom setup**, `made in Developer`, with its run count, the preset it started from and how it
runs. **Choose** goes on to the review with it; **Edit in Developer mode** switches the mode and
opens the map. A plan open past the review when you switch to Simple shows the review, where it
can start.
