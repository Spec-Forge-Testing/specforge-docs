# LLM rules and side effects

Two choices on step 3 of the [new-run screen](new-run.md#step-3-rules-and-start) change what a
run costs and what it may do to the target: rules deduced by an LLM, and side effects.

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

The model and its provider key are set in **Settings**. Step 3 shows the model in use and, when
there is no key yet, which environment variable the core looks for, with a link to Settings.
A plan with LLM rules and no key cannot start.

### The estimate

As soon as the plan uses LLM rules, the app asks the core for an estimate. Estimating is free: the
core reads your code and calls no model. The footer shows the total, and **Cost details** opens it
run by run:

| Column | Meaning |
| --- | --- |
| Inferred | Endpoints whose rules the model will be asked for |
| Cached | Endpoints whose rules are already cached and cost nothing |
| USD | That run's share, rounded up to the cent |

Runs of a chain that read the same rules share them: the first pays and the others read them as
cached, so a chain's LLM cost is one total. Every cost the app shows is rounded up, never down; a
cost below one cent reads `under USD 0.01`. A model with no known price reads `unpriced`, never
`USD 0.00`.

The estimate is made for the plan as it stands: its paid runs, the cap, the model and the code
folder. Change any of them and the app estimates again before you can approve ("Something changed
since the estimate").

### Approval

Nothing is billed before you approve. With a priced estimate the start button reads **Approve USD X
and start**, and pressing it approves exactly that amount. With a model that has no price, the
start opens a review first, and you approve without a known amount.

The start stays closed, with the reason in the footer and a **Try again** where it can help, when:

- the estimate failed (the core's reason is shown);
- the code folder has none of the endpoints;
- a run could not be estimated, or the core asked for an approval and gave nothing to approve;
- the model has no price and a cost cap is set, because a cap cannot be applied without a price.

If a run of a chain still asks for an approval when it starts, the app shows it with the run's
place in the chain and what is left of the cap. Declining it stops the chain there.

### The cost cap

**Cost cap, USD** is optional and starts with the default set in **Settings** (**Default inference
cost cap**, USD 0.50 unless you change it). It is one limit for the whole chain: each run gets what
the runs before it left. Past the cap, the remaining endpoints run with spec rules only; rules
already cached still apply.

When the estimate is above the cap, the footer says so and the cost details mark the run where
the cap runs out. A run that starts with the cap already spent says "cap reached", and the chain's
summary never reads green because of it.

## Side effects { #side-effects }

A fuzzer that writes can create, change or delete real data, and an endpoint that sends email or
charges a card reaches past the API. The **safety guard** holds such endpoints back. Which
endpoints it holds depends on the rules: an LLM contract or your own rule file marks an endpoint
as writing, or as having effects outside the API.

**Allow side effects**, on step 3, is one switch for every run of the plan:

| Switch | What the runs do |
| --- | --- |
| Off | Endpoints the rules mark as writing (`POST`, `PUT`, `PATCH`, `DELETE`) are held back from `performance` and `resilience` runs. Endpoints with effects outside the API are held back from every run |
| Off, with Spec only | The spec marks no endpoint, so nothing is held back |
| On | Write endpoints get real requests in every run. The start opens a review that says so: use a test environment |

A held endpoint is never sent a request; the run detail's **Endpoints** tab shows it as
**Held back**, with the reason and, when another endpoint's flag decided it, which one. The core's
side of this is described in [ADR-058](../../modules/specforge-engine/adr/engine.md#adr-058).

### The default in Settings

Each new plan starts with the switch where **Settings > Allow side effects by default** leaves it,
**off** unless you turn it on. Turn it on only for test environments: every new run then starts
with writes allowed, and you still review before the start. Step 3 shows the default beside the
switch ("Default for new runs: off") with a **Change in Settings** link. Changing the switch on
step 3 changes only the plan you are building.
