# LLM rules and side effects

Two choices on the [review](new-run.md#step-2-review) of the new-run screen change what a run
costs and what it may do to the target: rules deduced by an LLM, and side effects. The LLM also
costs money when it generates a contract from your code; that cost is
[priced before it runs](#generating-a-contract-with-the-llm).

## LLM rules { #llm-rules }

With **LLM reads your code**, a model reads your API's source and deduces, endpoint by endpoint,
its business rules, who may call it, and whether it writes or reaches outside the API. Those
rules turn on the business-rule checks, give the `auth` mode access policies to test, and tell
the safety guard which endpoints to hold back. How the core produces them is described in
[Inference](../../modules/core/inference.md).

### The code folder

LLM rules read the code folder stored for the project: the **Source repository** you gave when
you opened or edited the project, or the project folder itself when none is stored. The
new-run screen does not change it; edit the project to point it elsewhere.

If none of the contract's endpoints is found in that folder, the estimate says so ("There is no
code to read in …") and the run cannot start with LLM rules. Choose spec rules, or open a project
that has the code.

### Model and key

The model and its provider key are set in **Settings**. A plan with LLM rules and no key cannot
start: the footer says "The LLM has no key yet." with **Open Settings**. In Developer, the
review's **Cost** row also shows the model in use, with **Change**, or, without a key, which
environment variable the core looks for.

### The estimate

As soon as the plan uses LLM rules, the app asks the core for an estimate. Estimating is free: the
core reads your code and calls no model. The review's **Cost** row shows it beside the cap
(`Estimate ~USD 0.08`), and **Cost details** opens it run by run:

| Column | Meaning |
| --- | --- |
| Inferred | Endpoints whose rules the model will be asked for |
| Cached | Endpoints whose rules are already cached and cost nothing |
| USD | That run's share, rounded up to the cent |

Runs of a chain that read the same rules share them: the first pays and the others read them as
cached, so a chain's LLM cost is one total. Every cost the app shows is rounded up, never down; a
cost below one cent reads `under USD 0.01`. A model with no known price reads `unpriced`, never
`USD 0.00`.

The estimate is the expected cost. Its **hard ceiling** is the most the plan can bill: no call
hits the cache, every retry happens and the fallback model answers. When the ceiling shows higher
than the estimate, the estimate reads with a `~`, and Cost details names the ceiling.

The estimate is made for the plan as it stands: its paid runs, the cap, the model and the code
folder. Change any of them and the app estimates again before you can approve ("Something changed
since the estimate").

### Approval

Nothing is billed before you approve, and the start button names what it approves:

| Start button | What pressing it approves |
| --- | --- |
| Approve USD X and start | Exactly that estimate |
| Approve ~USD X and start | The estimate, up to its hard ceiling, said under the button ("Starting approves this estimate up to its hard ceiling of USD Y.") |
| Approve up to USD X (your cap) and start | Your cap and no more, when the ceiling passes it |
| Review and start | A model without a price: the review says you approve with no ceiling |

The start stays closed, with the reason in the footer and a **Try again** where it can help, when:

- the estimate failed (the core's reason is shown);
- the code folder has none of the endpoints;
- a run could not be estimated, or the core asked for an approval and gave nothing to approve;
- the model, or a fallback model, has no price and a cost cap is set, because a cap cannot be
  applied without a price.

If a run of a chain still asks for an approval when it starts, the app shows it with the run's
place in the chain and what is left of the cap. Declining it stops the chain there.

### The cost cap

**Your cap, USD** on the review is optional and starts with the default set in **Settings**
(**Default inference cost cap (USD)**, USD 0.50 unless you change it). Beside it, a note says what
it does: billing stops at the cap, and past it the remaining endpoints run with spec rules only;
with no cap, approving allows up to the hard ceiling. The estimate can be low either way.

The cap is one limit for the whole chain: each run gets what the runs before it left. Rules
already cached still apply past it. When the estimate is above the cap, the footer says so and
the cost details mark the run where the cap runs out. A run that starts with the cap already spent
says "cap reached", and the chain's summary never reads green because of it.

## Side effects { #side-effects }

A fuzzer that writes can create, change or delete real data, and an endpoint that sends email or
charges a card reaches past the API. The **safety guard** holds such endpoints back. Which
endpoints it holds depends on the rules: an LLM contract or your own rule file marks an endpoint
as writing, or as having effects outside the API.

**Allow side effects**, on the review, is one switch for every run of the plan. Its note says what
it does as it stands:

| Switch | What the runs do |
| --- | --- |
| Off | Endpoints the rules mark as writing (`POST`, `PUT`, `PATCH`, `DELETE`) are held back from `performance` and `resilience` runs. Endpoints with effects outside the API are held back from every run |
| Off, with Spec only | No rule marks any endpoint, so none is held back for its rules |
| Off, with a core that holds unjudged writes | Whatever the rule source, endpoints that change data are not sent under load or broken traffic unless a producer judged they don't (the reason reads **Assumed write**), and endpoints marked as having effects outside the API are never called. This replaces the two rows above |
| On | Write endpoints get real requests in every run; the note names the API they write to. The start opens a review that says so: use a test environment |

A held endpoint is never sent a request; the run detail's **Endpoints** tab shows it as
**Held back**, with the reason and, when another endpoint's flag decided it, which one. The core's
side of this is described in [ADR-058](../../modules/specforge-engine/adr/engine.md#adr-058) and [ADR-196](../../modules/specforge-engine/adr/engine.md#adr-196).

Side effects a run allowed before are never taken as a yes now. A
[saved preset](saved-presets.md#side-effects-saved-in-a-preset) that allows them asks again on
every run, with one unchecked box per run, and [Run again](run-detail.md#run-again) on a run made
with them asks before it sends them again.

### The default in Settings

Each new plan starts with the switch where **Settings > Allow side effects by default** leaves it,
**off** unless you turn it on. Turn it on only for test environments: every new run then starts
with writes allowed, and you still review before the start. The review shows the default beside
the switch ("Default for new runs: off") with a **Change in Settings** link. Changing the switch
on the review changes only the plan you are building.

## Generating a contract with the LLM

A project with no OpenAPI file can get one from its code: **Generate contract from code**, on the
Contract screen, scans the source for routes and writes `openapi.generated.yaml`. The scan is free.
**Complete with an LLM** adds a paid part: the model finds the routes the scan misses and infers
their parameters, bodies and responses. It is never sent without a **Cost cap (USD)**, and every
LLM call is held against that cap.

With a core that prices a generation before it runs, the dialog shows the **Estimated cost**
beside the cap as soon as the LLM is on, and again after you change the cap or the source folder.
Nothing runs until it is shown. When the worst case shows higher than the estimate, it is said
beside it, since the cap is judged on it: `Estimated ~USD 0.12 · up to USD 0.31`.

| What the dialog shows | What it means |
| --- | --- |
| `Estimated ~USD X`, and the button **Approve ~USD X and generate** | The project asks before it spends: pressing the button approves that estimate |
| `Estimated ~USD X`, and the button **Generate contract** | Approval is off in Settings: the generation spends without asking, up to the cap |
| "Above the cap of USD X: raise the cap to generate with the LLM." | The generation may pass the cap; the button stays closed |
| "The model has no price, so its cost cannot be estimated: choose a priced model in Settings." | No estimate is possible; the button stays closed |
| "No cost estimate, so nothing can be generated with the LLM: *reason*" | The estimate failed; the button stays closed |

If refining what the LLM found costs more than first estimated, the core asks again partway, and
the app shows that estimate and waits for your answer. Declining leaves nothing generated.

!!! note "Version"
    The estimate before a generation needs a core that speaks protocol `0.2.7` or later. With an
    older core, the dialog shows no estimate: the LLM's part still holds to the cap, and asks
    first when the project requires approval. The core's side is described in
    [`estimate_contract_generation`](../../modules/core/protocol/operations.md#estimate-contract-generation).
