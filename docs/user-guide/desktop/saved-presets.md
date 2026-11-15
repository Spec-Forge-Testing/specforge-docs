# Your presets

A saved preset is a test of your own: a named sequence of one to five runs, kept on this machine
and offered in every project, beside the built-in tests. It keeps how each run is set up, never
the API it runs against, its users or its folders. The core stores it; the app lists, saves and
deletes it. How the core keeps them is described in
[Saved presets](../../modules/core/protocol/presets.md).

!!! note "Version"
    Saved presets need a core that speaks protocol `0.2.7` or later and has a store. With an older
    core, or one without a store, the new-run screen shows the built-in tests alone and says
    nothing about saved ones.

## Where they show

On the first step of the [new-run screen](new-run.md#step-1-choose-a-test), **Your presets**
follows the built-in tests. Each card is marked **Yours** and drawn like a built-in one, with its
name, its summary and its runs; Simple leaves out the mode chips, as it does for every card.
Choosing one is choosing a test: its runs start one after the other, as a
[chain](new-run.md#chains-of-runs), and each run records the preset it came from.

The section is absent when the store holds no saved preset. Two other states can show in it:

| State | What it says | What to do |
| --- | --- | --- |
| A preset that can't be read | The card is marked **Can't be read**: "This app can't read its runs, so it can't run it. You can delete it." | Delete it; a newer core may have written it |
| The store can't be reached | "Couldn't read your presets: *reason*. Built-in tests still work." | **Retry** |

A preset that can't be read is never chosen. It is still listed, so it can be deleted.

## Saving a setup as a preset

Saving is a Developer task. Build a Custom plan on the map, then press **Save as preset** under it.
The button explains itself while it is closed:

| Message | What it needs |
| --- | --- |
| Add a run to save it as a preset. | At least one run |
| A preset holds at most 5 runs. | Five runs or fewer |
| Choose a mode for every run to save it as a preset. | A mode on every run |
| Fix the settings marked on the map to save it as a preset. | No setting refused on the map |

The dialog asks for three things:

| Field | Rule |
| --- | --- |
| Name | Shown on its card. One line, 1 to 60 characters |
| Summary (optional) | One line under the name, up to 200 characters |
| Id | How Spec Forge tells it apart: lowercase letters and digits joined by single hyphens, up to 48 characters. It follows the name until you type one |

**Runs it keeps** lists the runs that go into the preset. A run the plan would save with side
effects allowed carries a box, **Saved with side effects allowed**, ticked: "Untick a run to save
it without them. A run saved with them still asks before every start." **Save preset** sends the
runs; the core checks each one as it would check a run about to start, and a refusal is shown on
the field or the run it is about. A saved preset appears under **Your presets** at once ("Saved
“*name*” in Your presets.").

What a saved run keeps:

| Kept | Not kept |
| --- | --- |
| Mode and strategy, requests per endpoint, load steps, latency limit and slow-down tolerance | The API's base URL, the users file, the rules folder and the code folder |
| Concurrency limit, request timeout and time limit, when set | **Repeatable run**, which holds for one plan only |
| The rules and LLM cap the review shows when you save | |
| Whether side effects were allowed, as the dialog's boxes leave it | |

## Starting a saved preset

Choosing a saved preset opens the review with the rules and the cap it was saved with. A plan
sends one rule source and one cap to all its runs, so a preset whose runs were saved with
different rules is made one: the LLM's when any run used it, else your rule files, else the spec
alone, under the largest cap its LLM runs saved. A saved run with no cap keeps the cap the review
already had. The review then says so under **Where the rules come from**, for example:

> This preset's runs were saved with different rules. Every run uses “LLM reads your code”, under
> the largest cap it saved (USD 2.00).

What you change on the review wins: the runs start with it, and saving the preset again keeps it.
The note goes away once the rules or the cap no longer follow the preset.

### An id already taken

Ids are unique across built-in tests and yours.

| The id belongs to | What happens |
| --- | --- |
| A built-in test | Refused on the field: "“*id*” is the id of a built-in test. Pick another id." |
| One of your presets | The app asks **Replace “*name*”?**: its name, summary and runs are overwritten, in every project on this machine, and this can't be undone. **Replace preset** overwrites it; cancelling keeps the one already saved |

## Editing a preset

In Developer, the menu on a saved card offers **Edit**. It opens the map with the preset's
runs as a Custom plan. Change them, then **Save as preset**: the dialog opens as **Save changes to
“*name*”**, filled with its name, summary and id.

Editing is replacing. Saving under the same id asks **Replace “*name*”?** first, and overwrites
the preset once you confirm. Saving under a new id keeps the original and adds a new preset.

## Deleting a preset

The card's menu offers **Delete** in both modes, for any saved preset, readable or not. The app
asks first, **Delete “*name*”?**: it disappears from New run in every project on this machine,
and runs you already made with it stay. **Delete preset** confirms.

After the delete, the message "Deleted “*name*”." offers **Undo**, which saves the same preset
again.
A preset that can't be read can't be brought back that way, and the message says so. A preset
already deleted elsewhere is taken off the list, and the message says that too.

## Side effects saved in a preset

A preset saved with side effects allowed is not a yes for the next time. On **Review and start**,
when the plan's **Allow side effects** switch is off, the app asks run by run, every time:

> This preset was saved with side effects allowed. That is not a yes: check each run you allow
> them in, this time only.

One checkbox follows per run that saved them (`Run 2 may change data: …`), **unchecked** on every
visit:

| Box | What the run does |
| --- | --- |
| Unchecked | It starts without side effects, held back as the switch's note describes |
| Checked | Its requests may create, change or delete data on the project's API; the start opens a review that says so |

The checks belong to that visit of the screen only. Going back to choose a test, changing a run,
or starting the preset again later asks again. The one exception is
[Run again](run-detail.md#run-again): when you answer **Allow side effects** there, the box of the
run you asked about opens checked, and only that one. Turning on **Allow side effects** for the whole
plan replaces the boxes, since every run is then allowed.

With every box left unchecked and nothing else to approve, the start reads **Start without side
effects**. The review before the start lists both sides when there is something to confirm:
"Side effects are allowed in run 2." and "Runs 1 and 3 start without side effects. The preset
allows them, but they were not checked on the review." See
[Side effects](llm-rules-and-side-effects.md#side-effects) for what the safety guard holds back.
