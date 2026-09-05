# CLI Reference

The CLI is the interactive entry point to Spec Forge. It coordinates contract
validation, static tracing, LLM-ready context extraction and API fuzzing.

## Commands summary

| Command | Category | Description |
| :--- | :--- | :--- |
| **`doctor`** | Diagnostics | Checks environment, pipeline dependencies, and LLM setup. |
| **`doctor --fix`** | Diagnostics | Guided automated installation and dependency fixes. |
| **`trace`** | Analysis | Static code tracing from an OpenAPI endpoint. |
| **`ast-extract`** | Analysis | Inspects extracted code structures and LLM context. |
| **`fuzz`** | Execution | Compiles strategies from schema and fuzzes a live API. |
| **`replay`** | Execution | Re-sends an analysis's recorded trace and rules a verdict per defect. |
| **`history`** | History | Browses persisted projects, analyses and runs, with filters. |
| **`inspect`** | History | Shows one run in full (metrics, latency, crashes, artifacts), or one crash in full (payload, headers, response body). |
| **`compare`** | History | Diffs two runs' defect sets — appeared, persisted, possibly resolved — marking a pair that is not directly comparable. |
| **`!`** | System | Executes system shell commands directly from REPL. |
| **`theme`** | Settings | Switches the CLI UI color theme. |

## Running

```bash
specforge          # launch the interactive REPL
```

Inside the REPL, type `help` to list commands or `help <command>` for details —
any command invoked with `--help`/`-h` renders the same panel.

## Commands

??? "`doctor` — environment & dependency diagnostics"

    ```text
    SpecForge ❯ doctor
    ```

    `doctor` checks that the local environment is ready to run the whole pipeline and
    prints a categorized report. For each check it shows a status, a detail and — when
    something is wrong — a concrete fix.

    It validates:

    - **Runtime** — the Python interpreter version and the CLI's own dependencies.
    - **Pipeline modules** — Contract Engine, AST parser, LLM integration, execution
      engine, storage and the shared contracts, probed by import without executing them.
    - **Test runtime** — `pytest` / `pytest-cov`.
    - **LLM configuration** — the module-local `lib/semantic_inference/.env.local`,
      `LLM_MODEL`, and the provider credential the configured model needs (presence
      only — credential *values* are never read or shown).

    Findings are split into two levels:

    - **critical** (✖) — the interpreter, the CLI runtime, or a pipeline stage wired
      into a working command today (the Contract Engine, the AST parser, the execution
      engine). The environment is *not ready* while any critical check fails.
    - **warning** (⚠) — a not-yet-wired pipeline stage, the test runtime, or missing LLM
      configuration. These degrade a capability but don't block the CLI.

??? "`doctor --fix` — guided installation"

    ```text
    SpecForge ❯ doctor --fix          # plan, confirm, install, re-check
    SpecForge ❯ doctor --fix --yes    # skip the confirmation (CI / non-interactive)
    ```

    `--fix` installs the missing components. It runs **only** the catalog's install
    commands — never arbitrary input — as `python -m pip install -e <target>` in the
    **current interpreter**, ordered so the shared contracts land before the engines
    that import them. It is read-only until confirmation: it prints the plan, asks for
    approval (skipped by `--yes`), streams each install, then **re-runs the diagnosis**
    to show the resulting state. Manual fixes (the `.env.local` file, `LLM_MODEL`,
    credentials) are listed but never auto-applied. Honors `SPECFORGE_SYSTEM_COMMANDS`:
    when system commands are disabled, the plan is shown but nothing is executed.

    > Like the rest of the Rich UI, `doctor` emits status glyphs (✔ ⚠ ✖). On a
    > legacy Windows console these require a UTF-8 capable terminal; redirecting output
    > to a non-UTF-8 pipe can raise an encoding error (a pre-existing, app-wide trait of
    > the Rich presentation layer, not specific to this command).

??? "`trace` — static code tracing from an OpenAPI endpoint"

    ```text
    SpecForge > trace --contract openapi.yaml --project /path/to/project --operation-id create_user
    ```

    `trace` connects the OpenAPI contract with the source code of the project being tested. It reads the contract, selects one or more endpoints, locates the handler function in the target repository and asks `core_ast` to extract only the relevant AST context for that endpoint.

    The command prints:

    - **Endpoint** — the HTTP method and path found in the OpenAPI contract.
    - **Controller** — the source file where the endpoint handler was located.
    - **Target function** — the function extracted as the entry point for the endpoint.
    - **Trace mode** — whether the dependency trace was surgical, hybrid or fallback.
    - **Processed functions** — each file/function pair visited while resolving local calls and imports.
    - **Fallback / hybrid files** — extra files selected when the tracer cannot resolve enough dependencies surgically.

    `--operation-id` is the OpenAPI `operationId` of the endpoint. In many APIs this matches the handler function name, so it gives the AST locator a precise target:

    ```yaml
    paths:
      /users:
        post:
          operationId: create_user
    ```

    With that contract, `--operation-id create_user` means: "trace the `POST /users` endpoint whose OpenAPI operation is named `create_user`".

    If the contract has no `operationId`, use the endpoint coordinates instead:

    ```text
    SpecForge > trace -c openapi.yaml -p /path/to/project --path /users --method post
    ```

??? "`ast-extract` — inspect the extracted code and the LLM context"

    ```text
    SpecForge ❯ ast-extract -c openapi.yaml -p /path/to/project --operation-id create_user --code
    ```

    Where `trace` reports *which* files and functions were visited, `ast-extract`
    shows the *actual content*: the function `core_ast` surgically extracts and the
    context that would be sent to the LLM. It accepts the same endpoint selectors as
    `trace` (`-c/--contract`, `-p/--project`, `--operation-id`, or `--path`/`--method`)
    plus three mode flags:

    - **`--code`** (default) — the extracted controller and each dependency function,
      syntax-highlighted with their real line numbers. Use it to verify the AST cut is
      correct.
    - **`--payload`** — the packaged context the inference engine would receive, parsed
      into sections (primary controller, dependencies, fallback files and any missing
      context) plus its estimated token count and a complete/partial flag.
    - **`--raw`** — the *literal* `system_context` XML the LLM actually receives,
      verbatim (the `<source_context>` block with its `<primary_controller>`,
      `<dependencies>` and `CDATA` sections), for auditing the exact prompt input.

    They can be combined (e.g. `--code --payload`, or `--payload --raw`). Even when the
    dependency trace degrades to *hybrid* or *fallback* mode, `--payload`/`--raw` still
    show the primary controller and the selected fallback files, so there is always
    something to inspect.

??? "`fuzz` — compile strategies from the schema and fuzz a live API"

    ```text
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000 --mode stateful
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000 --identities identities.toml
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000 --strategy hacker --contracts contracts/
    ```

    `fuzz` runs the execution engine end to end **without the LLM or source analysis**:
    it parses the contract, compiles Hypothesis strategies straight from the schema,
    fuzzes the live API at `--base-url`, groups the failures by symptom and shrinks one
    representative per symptom to its minimal reproducer. The schema constraints alone
    (`type`, `minimum`, `enum`, `pattern`, …) are enough to surface `5xx` crashes and
    undeclared responses. Two flags widen that baseline: `--strategy` picks the
    strategy family the engine compiles, and `--contracts` feeds it producer-written
    contracts on top of the schema — both described below.

    The command prints:

    - **Run summary** — the exploration requests, the requests shrinking sent apart
      from them, and the finding funnel: raw → confirmed (one representative per
      symptom, still failing after shrinking) → collapsed (same symptom as a
      confirmed one, never shrunk) → unverified (never attempted — the run was cut
      before shrinking started, or the strategy could not produce a candidate to
      try) → flaky → unique after de-duplication.
      `raw == confirmed + flaky + collapsed + unverified` always holds. A stateful
      run has no separate shrink phase, so its report shows neither shrink requests
      nor collapsed or unverified findings.
    - **Category breakdown** — requests grouped by outcome, labeled in plain
      English: successful response, 4xx client error, 5xx server error, contract
      violation, request timed out, target unreachable, and `unsendable request
      (refused by the engine; never sent)` for values the engine refused to put
      on the wire — counted as requests, but they never reached the target.
    - **Crashes** — a summary line first, tallying the unique crashes by invariant
      and status (`33 unique crashes: 2 × 5xx server error (500), 28 × wrong
      Content-Type (401), …`), then one row per minimal reproducer, **most severe
      first**: 5xx server errors lead, contract violations follow, and within an
      invariant the crash representing more raw findings comes first — the same
      order `report.json` sorts its defects, so the screen and the document never
      disagree. Each row: method, endpoint, phase, how many
      prior steps set it up (a dash for a single request), the violated invariant,
      the status code, how many raw findings the crash stands for (`Represents`;
      stateless runs only), the identity it was found under (`Identity`; only shown
      when at least one crash in the run recorded one) and the smallest failing
      payload.

    A run the target's liveness probe found dead is cut **before** shrinking, so
    its findings were collected but never confirmed. The report never calls that a
    clean run: it shows the **Unverified** count instead of the usual "No crashes
    found" — the same distinction `inspect --run <id>` shows later.

    Narrow the run with `--endpoint <path>` and/or `--method <verb>`, and tune execution
    with `--timeout` / `--max-concurrency`. The target API must already be running;
    infrastructure failures (server down, timeout) are reported, never fatal.

    `fuzz` accounts for every endpoint the spec declares, not only the ones that
    ran — see *[Coverage and the run's signal](#coverage-and-the-runs-signal)*
    below. A selection that compiles nothing at all never runs: it fails with a
    **Nothing to Fuzz** panel naming every rejection, before a single request.

    `--identities <file>.toml` declares who the requests are sent as — a TOML list
    of labelled credential sets, any of them possibly anonymous (a label with no
    headers):

    ```toml
    [[identities]]
    label = "anonymous"

    [[identities]]
    label = "alice"
    [identities.headers]
    Authorization = "Bearer alice-token"
    ```

    Labels must be unique — they key findings, crash reports and replays. Each
    endpoint phase's example budget is split evenly across the declared identities
    (the remainder to the first ones, and one the budget cannot reach gets no
    share), and a finding is shrunk under the identity that found it, never
    re-drawn. A stateful sequence draws one identity when it starts and keeps it
    for every step, since a sequence is a session. The same symptom found under two
    identities is two findings, never one — so the crash tables gain the
    **Identity** column above. The label is persisted with the crash and the run's
    trace; the credentials never are (see below).

    `--mode` selects how the engine explores the endpoints: `stateless` (the
    default) fuzzes each operation alone; `stateful` chains requests into
    sequences; `performance` sustains load and, with `--latency-sla-ms <ms>`,
    enforces that threshold as a latency oracle; `resilience` sends a fixed battery
    of malformed-transport requests and flags an endpoint that answers `5xx`, hangs
    or crashes instead of degrading gracefully. `--latency-sla-ms` is refused with
    any other mode.

    `--mode stateful` switches to [stateful fuzzing](../modules/custom-schemathesis/execution-modes.md#stateful):
    requests are **chained into sequences** instead of each operation being fuzzed on
    its own, which surfaces order-dependent failures — a resource created, deleted,
    then read. `--endpoint`/`--method` still narrow the sequences to the matching
    operations, and the run is saved like any other. The data flow between
    requests — an id returned by one call feeding the next — is derived from the
    spec over the full declared endpoint list, not only the selected ones: native
    OpenAPI `links` first, then a conservative convention that pairs a `POST`/`PUT`
    on a collection with its immediate by-id sibling whenever a `2xx` body exposes
    an id-like field. That convention reads only the **top-level** properties of the
    response schema, so an enveloped response (`{"article": {"slug": ...}}`) needs a
    native `links` entry to get a deterministic capture. A stateful run is markedly
    slower than a stateless one. A stateful finding is reported by the step that failed; the **Prior
    steps** column says how many requests set it up, which is the cue to open
    `inspect --crash <id>` for the sequence. A transition the API answered with an
    unexpected status shows as `unexpected transition status`. The run is cut short
    and reported as `aborted` when the target stops answering, or when a state link —
    the declared hand-off from one request's response into the next request — cannot
    be honored; the engine's diagnosis is reported with it.

    `--strategy {default,hacker}` selects which **strategy family** the engine
    compiles, orthogonally to `--mode`: `default` (the default) is schema-only —
    the `valid`, `boundary` and `invalid` phases; `hacker` adds the `attack` phase
    and widens generation toward adversarial values. The two words are the
    engine's own `StrategyMode` values, so a new mode needs no second list here.

    `--contracts <dir>` supplies **producer-written contracts**. Every `*.json`
    file directly under the directory is one kernel `EndpointContract` — `method`,
    `path_url`, `parameters` and `body` as JSON Schema, plus the optional `risk`,
    `attack`, `transitions` and `semantic_properties` sections (see
    [Spec Forge Contracts](../modules/contracts/index.md)). Files are indexed by
    the `method`/`path_url` they declare, so the file name is a label and nothing
    more. For each selected endpoint that has a contract, it is fused over the
    OpenAPI base with the Contract Engine's `fuse_contract` — the producer's
    invariants win on conflict, the base fills the gaps — and the result replaces
    the bare schema in the compile; an endpoint with no file stays schema-only.
    A trimmed fixture:

    ```json
    {
      "method": "post",
      "path_url": "/articles",
      "body": {
        "type": "object",
        "required": ["article"],
        "properties": {
          "article": {
            "type": "object",
            "required": ["title", "body"],
            "properties": {
              "title": {"type": "string", "minLength": 1, "maxLength": 200},
              "body": {"type": "string", "minLength": 1}
            }
          }
        }
      },
      "risk": {"risk_score": 65, "criticality": "medium", "write_operation": true},
      "attack": {
        "attack_profiles": ["injection", "auth_bypass"],
        "focus_fields": ["title", "body"],
        "aggressiveness": 6,
        "field_hints": {
          "body.article.title": {
            "attack_profiles": ["xss", "sql_injection"],
            "include_encoded_variants": true
          }
        }
      },
      "transitions": [
        {
          "bundle": "slug",
          "follow_up_method": "get",
          "follow_up_path": "/articles/{slug}",
          "target_field": "slug",
          "target_zone": "path",
          "expected_statuses": [200],
          "echoed_fields": ["title", "body"],
          "trigger_statuses": [201]
        }
      ]
    }
    ```

    What each section becomes in the run: the enriched `parameters`/`body` shape
    the strategies. `risk` and `attack`'s endpoint-level fields ride along to the
    engine as they are — nothing in the engine consumes them yet, so they do not
    change a run today. Each `field_hints["zone.field"]` entry promotes the
    addressed parameter or dotted body field to the engine's per-value hacker
    contract with the hint's payload families and toggles, **under `--strategy
    hacker` only** — `default` ignores the hints. Each `transitions` entry is
    attached to the endpoint's stateful state link, bound to the deterministic
    capture (from the spec's `links` or the sibling convention above) whose bundle
    name or captured field matches its `bundle`. `semantic_properties` are
    validated against the endpoint's declared fields and carried, unconsumed.

    The producer is strict, and every problem stops the run **before a single
    request**. A path that is not a directory, a malformed or invalid file (the
    kernel rejects unknown keys), two files declaring the same endpoint, a contract
    served for an endpoint other than the one it declares, or a fusion the Contract
    Engine rejects all render a **Contract Producer Error** panel naming the file
    or endpoint and the reason (error code `fuzz_contract_producer` under
    `--json-output`). A hint on a zone or field the endpoint does not declare, and
    a transition whose `bundle` matches no deterministic capture — or more than
    one — are reported as an **Unsupported Schema Construct** instead, naming the
    endpoint and the offending hint or bundle. The produced contracts are not
    persisted with the analysis: the run's trace is recorded and replayable as
    usual, but the enriched recipe itself is not stored.

    Every run is **saved by default** through the [storage engine](../modules/storage/index.md):
    a project → analysis → run hierarchy with metrics, per-endpoint stats, crash
    reports and the execution trace as a critical artifact, written in one atomic
    transaction — a mid-write failure rolls the whole run back. `--no-save` opts out;
    `--project` overrides the stored project name (default: the spec's `info.title`,
    falling back to the file stem). The report always renders before persisting, so a
    storage failure surfaces as a warning without losing the run's output, and a
    missing `storage` install degrades gracefully.

    The saved run is a **shareable reproducible recipe**, so no credential value is
    ever stored — not even redacted: the execution config keeps header *names* only,
    any `user:pass@` in the base URL is stripped, and the declared identities are
    dropped whole, labels aside — a crash keeps the label it was found under, the
    trace keeps the label each request was sent under, and a replay re-supplies the
    values from `--identities <file>.toml`. The run also records its outcome `status`
    (`completed`/`truncated`/`aborted`), the replay `fidelity` when it is one, and the
    engine version as provenance. The analysis records whether the run was stateful
    and, when it was, the effective budget it ran with (`stateful_config`: examples,
    steps per sequence and distinct bugs per sequence).

??? "`history` — browse persisted projects, analyses and runs"

    ```text
    SpecForge ❯ history
    SpecForge ❯ history --project 1
    SpecForge ❯ history --analysis 3
    SpecForge ❯ history --analysis 3 --status truncated --since 2026-08-01 --limit 5
    ```

    Navigates everything the fuzzer has persisted, in the three levels the storage
    schema is built around: with no flags it lists every **project** (with its
    analysis count); `--project <id>` lists that project's **analyses** — the
    replayable recipes, each with its label, strategy mode, whether it was stateful,
    engine version, run count and an **Endpoints** column (`targeted/declared`, plus
    `(+N excl)` when the compiler excluded any — see *[Coverage and the run's
    signal](#coverage-and-the-runs-signal)*); `--analysis <id>` lists that
    analysis's **runs** in ordinal order.

    The run listing is where the model pays off: an **original** run (`●`) is
    visually distinct from a **replay** (`↺`), and a run whose counters would
    mislead if compared against another's carries a **not-comparable mark** with
    its reason — `truncated` (it stopped early against its own limits, so its counters
    are a budget prefix), `aborted` (a fault stopped it: the target stopped responding,
    or a state link could not be honored), `reduced fidelity` (the replay ran against a
    changed environment), or an unknown status vocabulary from an older database.

    `--status`, `--since <YYYY-MM-DD>` (UTC), `--endpoint <path>` ("runs that
    exercised this endpoint") and `--limit <n>` filter the run listing and require
    `--analysis`. Identifiers are always the numeric ids the previous level shows —
    project names are not unique, ids are.

    Filesystem paths in the tables (a project's repo path, an artifact's path)
    are clipped from the left to their tail (`…package/src/main.py`), so a deep
    path never wraps its row.

    Without the `storage` install the command warns and returns instead of failing.

??? "`inspect` — the full detail of one run, or of one crash"

    ```text
    SpecForge ❯ inspect --run 7
    SpecForge ❯ inspect --crash 12
    ```

    `--run <id>` renders one run in full: a **header** with its
    context (project, analysis, ordinal, origin, execution time, duration, status —
    plus, when the run was cut short, **why and where** — fidelity and the
    comparability mark); its declared-endpoint **coverage** and **signal** (see
    *[Coverage and the run's signal](#coverage-and-the-runs-signal)* — skipped for
    a replay); the **metrics** funnel (requests, raw → confirmed → unique
    → flaky → **Unverified** findings — never shrunk)
    with the per-phase and per-category breakdowns (category tokens labeled in
    plain English, as in the fuzz report); **per-endpoint stats** including
    the latency percentiles (p50/p95/max — a dash when the endpoint was never
    timed); every recorded **crash** — under the same per-invariant summary line
    and in the same severity-first order as the fuzz report, with its id, the
    same plain-English invariant
    labels the fuzz report uses, the identity it was found under (**Identity**;
    shown when at least one crash recorded one), and the **minimal payload that
    reproduces it**, so a saved run shows no less than the report printed when the
    fuzzing finished; and the run's **artifacts** — the execution trace plus the
    `report.json`/`report.html` pair every save now leaves (see
    [Run report](reports.md)).

    `--crash <id>` answers *what actually failed*, taking the id from the crash
    table above. It shows the request's **minimal payload** broken down by zone,
    its **sanitized headers**, the **identity it was found under**, and the
    **body the API responded with** — which is usually where the error message
    lives. When the crash carries them, it also shows the **stack trace** and the
    **transition sequence**: the chain of requests that produced a stateful
    finding. The two flags are mutually exclusive.

    Payload values keep the spelling they travelled the wire with (`null` and
    `true`, not Python's `None` and `True`), so anything copied out of the CLI is
    still valid JSON.

    Two rules keep the output readable no matter what the API returned:

    - An **empty response body is reported as such** — never as the `—` that
      means "no data recorded" everywhere else. An API answering `500` with no
      message is a different fact from a field that was never saved, and telling
      them apart is often the first clue.
    - **Long values never flood the terminal.** Each one is cut to a bounded
      length, and the block's footer says how many characters it is hiding, so a
      truncated body is never mistaken for a short one.

??? "`replay` — re-send an analysis's recorded trace against a live API"

    ```text
    SpecForge ❯ replay --analysis 3
    SpecForge ❯ replay --analysis 3 --no-save
    SpecForge ❯ replay --analysis 3 --no-preserve-timing
    SpecForge ❯ replay --analysis 3 --identities identities.toml
    SpecForge ❯ replay --analysis 3 --base-url https://user:pass@staging.example.com
    ```

    Re-sends the exact requests recorded in an analysis's execution trace —
    verbatim: no regeneration, no shrinking, no seed. The trace is the
    **analysis's recipe** (all of its runs share it), which is why the command
    takes an analysis id, not a run id; `inspect --run <id>` shows the analysis
    id in its header, and `history --project <id>` lists them.

    Every request that violated an invariant when recorded gets its own
    **verdict**:

    - **present** (✖) — the API answered with the same status, or a different
      one that still violates (a `500` turned `502` is still broken).
    - **possibly resolved** (✓) — the response changed cleanly *and* the replay
      ran with **exact** fidelity: every other request answered as recorded.
    - **inconclusive** (⚠) — the response changed, but the surrounding trace
      diverged (reduced fidelity) or the request got no response at all.

    "Possibly resolved" is never "resolved", by design. A replay re-sends one
    recorded stimulus: a clean answer proves *this request* no longer triggers
    the defect, not that the defect's class is gone. And the negative claim
    needs a clean context — under **reduced fidelity** the environment
    observably changed, so a defect that stopped answering `500` is
    *inconclusive*, never resolved; the report states this explicitly.

    The verdict table shows **one row per distinct verdict** with its count
    (`×29`), in first-occurrence order: a defect recorded 29 times renders as
    one `POST /users/login invalid 500 → 500 present ×29` row instead of 29
    identical ones, and a mixed outcome (25 `present` + 4 `possibly resolved`
    for the same defect) stays two rows, never averaged. The grouping is
    presentation only — the saved document and `--json-output` keep one
    verdict per request.

    The command refuses recipes it cannot replay whole, **before sending a
    single request**: an empty trace, a missing or tampered trace artifact
    (content is hash-verified on read), a trace recorded under an identity label
    that `--identities <file>.toml` does not declare — the stored recipe keeps
    labels only, never credentials, so the check comes first — and, once every
    label resolves, traces that still need a credential header value no declared
    identity carries; stored recipes keep header *names* only, never values.
    Header values set for the whole run (`config.headers`) cannot be re-supplied
    yet — only an `--identities` file can. The same applies to a recorded URL's
    `user:pass@` userinfo, which the recipe keeps the host of but never the
    credential: a trace that needs it without one supplied is a **Missing URL
    Credentials** refusal, and a `--base-url <url>` that targets a different host
    than the one recorded is a **Target Mismatch** refusal — a replay cannot be
    pointed at a different host.

    `--identities <file>.toml` re-supplies the identities the run was recorded
    under, from the same file shape `fuzz` reads. A missing label surfaces as a
    **Missing Identities** panel naming every label the trace needs, before
    anything is sent. `--base-url <url>` re-supplies the recorded target's
    userinfo the same way — the recipe keeps its host but never a `user:pass@`
    it carried.

    `--save` (default on) appends the replay to the same analysis as a new run
    with the next ordinal, so `history --analysis <id>` shows original and
    replays side by side. `--no-preserve-timing` skips the recorded pacing
    between requests, which can change the outcome of timing-sensitive defects.

??? "`compare` — diff two runs' defects"

    ```text
    SpecForge ❯ compare --before 3 --after 7
    ```

    Pairs every defect from `--before <id>` and `--after <id>` by **symptom** —
    method, path, invariant, status code and identity, five of the six terms
    the engine dedups a single run's crashes on, deliberately without the
    sixth, the minimal payload: shrinking runs again each time against a
    target that may have changed between the two runs, so a defect that never
    actually left can still shrink to a different reproducer. `compare` shows
    the payload alongside each defect as its counterexample instead, and flags
    a pairing whose two reproducers differ ("same symptom, different
    reproducer"). Phase is in neither key — the generator's intention, not a
    property of the defect — but the **Phase** column still shows each crash's
    own (the later side's, falling back to the earlier one).

    Each pairing gets one of four verdicts:

    - **new** — found only in `--after`.
    - **persisted** — found in both.
    - **possibly resolved** — found only in `--before`, and nothing taints the
      comparison.
    - **inconclusive** — found only in `--before`, but a caveat taints
      `--after` or the pair itself: a different engine version, a different
      spec revision, or either run being `truncated`, `aborted` or of
      **reduced fidelity** — the same not-comparable signal `history` and
      `inspect` already show.

    A fresh appearance is never downgraded by a caveat — it is reported as
    **new** regardless — and the diff is never blocked by a caveat either: it
    is still produced, with every reason listed in a "Not directly comparable"
    panel. A defect seen more than once on either side shows its
    `before → after` occurrence count instead of silently collapsing to a
    single representative. The two runs can belong to the same analysis or to
    two different ones.

??? "`prune` — retain, compress and collect the artifact store"

    ```text
    SpecForge ❯ prune                                  # report the store; touch nothing
    SpecForge ❯ prune --compress                       # gzip what shrinks; never asks
    SpecForge ❯ prune --keep-last 2 --dry-run          # show the plan and stop
    SpecForge ❯ prune --keep-last 2                    # delete old run reports, after asking
    SpecForge ❯ prune --keep-last 2 --include-traces   # also old traces — the named consent
    SpecForge ❯ prune --collect-orphans                # sweep files no artifact row names
    ```

    `prune` is the only command that deletes anything, and it never acts
    without showing its plan first. Bare `prune` only reports the store:
    total size, artifacts by kind and by level, and any orphan files.

    Rules **protect**; what no rule protects is a candidate, and adding a
    rule can only ever save more, never condemn more:

    - `--keep-last <n>` protects the n most recent analyses of each project,
      with everything they produced.
    - `--older-than <YYYY-MM-DD>` protects every analysis created on or
      after that UTC date. An analysis with no date is always protected.
    - `--max-size-mb <n>` is a budget, not a rule: it deletes candidates
      oldest-first only until the store fits, and reports the shortfall when
      it cannot get there. It cannot be combined with `--compress` — the
      budget is computed on current sizes and cannot know what compression
      will save, so compress first, then prune with the budget.

    The consent ladder: compressing is free (`--compress` gzips any artifact
    it shrinks without changing its digest or its directory — a compressed
    trace still replays, still verified). Deleting regenerable run reports
    asks once, with the plan on screen; `--yes` skips the prompt. Deleting a
    recorded trace needs `--include-traces` **and** the confirmation — `--yes`
    alone never reaches one — and the prompt names every analysis that stops
    being replayable. A terminal that cannot answer is a no: without a TTY
    and without `--yes`, the plan is shown and nothing is applied. There is
    no default policy — `prune` with no flags deletes nothing, ever.

    History, metrics and crash reports are never touched — they live in the
    database, not the artifact store — and `history --project` shows a
    **Replayable** column derived from the trace's presence, so a consented
    trace deletion is visible the moment it happens.

??? "`!` — run system commands"

    ```text
    SpecForge ❯ !git status
    SpecForge ❯ !pytest -q
    ```

    Prefix any line with `!` to run it as a system command from the same session.
    The escape is **explicit on purpose**: a line without `!` is always resolved as
    an internal command (and a typo gets a fuzzy suggestion, never an accidental
    system call), so internal-vs-system resolution stays unambiguous.

    - **Streaming output.** `stdout` and `stderr` are shown live as the command
      runs, so long commands (`pytest`, `docker build`) show progress instead of
      going silent. `stderr` is visually differentiated and a non-zero exit code is
      reported clearly.
    - **Shared working directory.** Commands run in the REPL's current directory, so
      the internal `cd` and `!ls` / `!git` stay in sync.
    - **Never breaks the loop.** A missing executable, an unparsable line or a
      failing command are reported and the REPL keeps going. The child's stdin is
      closed, so an interactive program gets EOF instead of hanging the session.
    - **Disable in CI/CD.** Set `SPECFORGE_SYSTEM_COMMANDS=0` (or `false` / `no` /
      `off`) to turn the escape off in non-interactive environments.

    > Scope: the primary target is Linux/Docker (Windows is best-effort). v1 runs a
    > single program without a shell (no pipes, redirection or built-ins like `dir`)
    > and is not interactive (no `vim` / `rebase -i`); a PTY-backed executor for full
    > interactivity is a planned follow-up.

??? "`theme` — switch the UI color theme"

    ```text
    SpecForge ❯ theme          # list themes, marking the active one
    SpecForge ❯ theme mono     # switch at runtime
    ```

    Switching the theme re-skins **everything** — console output, the banner and the
    REPL prompt. Bundled themes: `default`, `mono`, `nord`, `dracula`, `solarized`,
    `matrix`; the theme can also be chosen at startup with `SPECFORGE_THEME=<name>`.

## Coverage and the run's signal

`fuzz` accounts for every endpoint the spec declares, not only the ones that ran.
Each falls into exactly one of three buckets: **targeted** (selected and
compiled), **excluded** (selected, but the compiler rejected it, and says why),
or **filtered** (never selected, by `--endpoint`/`--method`). The close line
names the partition — `Fuzzed 87 of 88 declared endpoint(s) (1 excluded)` — with
the excluded endpoints and their reasons listed under it, capped so a large
corpus doesn't flood the close. A selection that compiles nothing at all never
runs: it fails before a single request, as a **Nothing to Fuzz** panel naming
every rejection.

On top of the partition, a run earns a **signal**: `clean` unless one of three
things degrades it — no request reached the target at all (every attempt was an
availability, timeout or unsendable-request failure), a declared endpoint was
excluded, or a targeted endpoint never received a request. `filtered` never
degrades a run — narrowing the selection is the caller's own choice, not a gap.
A degraded run never closes as a plain success and never claims "No crashes
found"; an empty crash table says its evidence is degraded instead, and the
close line and every excluded endpoint print as warnings.

`inspect --run <id>` shows the same partition and signal for a saved run,
between the header and the metrics — skipped for a replay, which never compiles
and so has neither. `history --project <id>` shows the partition too, as an
**Endpoints** column (`targeted/declared`, plus `(+N excl)` when any were
excluded) on each analysis row. `--json-output` carries the same facts in
`data.coverage` and `data.run.signal`/`data.run.signal_causes` — see
*[Machine-readable output](#machine-readable-output-json-output)* below.

## Machine-readable output (`--json-output`)

`fuzz`, `replay`, `inspect`, `history`, `compare` and `prune` all accept
`--json-output`, which replaces every panel with exactly one JSON object on
stdout. Every human-readable message — panels, spinners, warnings — is
written to stderr instead, so piping or redirecting a command's stdout
captures the document and nothing else.

The envelope is the same shape for every command and every outcome:

```json
{"schema_version": "1.1", "command": "fuzz", "status": "ok", "data": { ... }, "error": null, "warnings": []}
{"schema_version": "1.1", "command": "fuzz", "status": "error", "data": null, "error": {"code": "...", "message": "..."}, "warnings": []}
```

`status` is `ok` or `error`, never both, and every key is present regardless
of outcome — set to `null` or an empty list when unused — so a consumer can
always index into a known shape. `data` is the [run report](reports.md)
document for `fuzz`/`replay`/`inspect --run`, one crash's own defect shape
for `inspect --crash`, the listed rows for `history`, and the comparison
document for `compare`, and the prune plan or outcome for `prune` (every
`prune` envelope carries an `applied` boolean; without `--yes` the plan is
emitted with `applied: false` and nothing is touched). A `fuzz` document's
`data.coverage` and `data.run.signal`/`data.run.signal_causes` carry the same
declared-endpoint partition and signal the terminal close shows (see
*[Coverage and the run's signal](#coverage-and-the-runs-signal)*); a replay's
document carries neither. A run whose fuzzing
or replay succeeded but whose save to storage failed still emits an `ok`
envelope carrying the full document (`run.id` left `null`), with the failure
riding along as a `warnings` entry rather than being lost. A degraded `fuzz`
run's `ok` envelope carries that signal the same way, as a `warnings` entry
(`degraded_signal`) naming the cause — alongside a save failure's, if there is
one.

One deliberate exception to "`error` means no `data`": a `prune` pass that
fails **after** its destructive phase emits `status: error` with `data`
still carrying `{"applied": true, "outcome": ...}`, so a consumer is never
left unable to tell "nothing happened" from "N artifacts are gone".

Full envelope shape, the `report.json`/`report.html` artifacts and the error
code registry are documented in [Run report](reports.md).

## Example workspace

Want to see every command against one consistent project? See the
[Example Walkthrough](example-walkthrough.md) — a self-contained Dummy Bank API
that exercises `trace`, `ast-extract` and `fuzz` end to end.
