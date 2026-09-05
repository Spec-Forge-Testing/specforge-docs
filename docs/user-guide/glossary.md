# Glossary

Every term Spec Forge uses, in one sentence. Where a plain term has a precise engineering
name, that name follows in `code font`.

| Term | In one sentence |
| --- | --- |
| **OpenAPI spec** | The machine-readable description of your API — its endpoints, requests and responses — that Spec Forge reads first. |
| **Contract** | Everything Spec Forge knows an endpoint must obey: its schema from the spec, plus any inferred business rules, merged together. |
| **Endpoint** | One path in your API, such as `/articles`. |
| **Operation** | One HTTP method on an endpoint, such as `POST /articles`; the unit Spec Forge fuzzes. |
| **Property-based testing** | Generating many inputs from a description and checking a rule that must always hold, instead of writing examples by hand. |
| **Generator** | The thing that produces test inputs matching a schema (`strategy`, a Hypothesis strategy). |
| **Phase** | Which kind of input a request carries: `valid`, `boundary`, `invalid` or `attack`. |
| **Invariant / rule** | A statement about the API that must always be true; a request that breaks it is a finding (`invariant`, the oracle). |
| **Finding** | A single request (or sequence) that broke a rule. |
| **Crash** | A confirmed, distinct defect left after shrinking and de-duplication. |
| **Shrinking / minimal reproducer** | Repeatedly simplifying a failing input to the smallest one that still fails. |
| **Flaky** | A finding that could not be reproduced on a second try, so it is dropped. |
| **Unique crashes** | The count of genuinely distinct defects a run found — its bottom line. |
| **Identity** | A named set of request headers (credentials) requests can be sent under, declared in a TOML file. |
| **Execution mode** | How the fuzzer explores the API: `stateless`, `stateful`, `performance` or `resilience` (`--mode`). |
| **Stateless** | Fuzzing each operation on its own, one request at a time. |
| **Stateful** | Chaining requests into sequences to find order-dependent bugs. |
| **Performance / latency SLA** | A mode that sustains load and fails endpoints slower than a threshold you set (`--latency-sla-ms`). |
| **Resilience** | A mode that sends malformed-transport requests and flags endpoints that fail instead of refusing cleanly. |
| **Replay** | Re-sending a saved run's recorded requests verbatim, to check whether a bug is still there. |
| **Trace** | The ordered list of requests a run actually sent, recorded so the run can be replayed. |
| **Trace (static)** | Reading the API's source code without running it to locate an endpoint's handler and the code it calls (`core_ast`). |
| **Project / analysis / run** | The three storage levels: the API you test, a replayable recipe, and one execution of that recipe. |
| **Artifact** | A file a run leaves on disk — its reports and the trace file — indexed in storage. |
| **Fidelity** | How closely a replay reproduced the original run, i.e. how much to trust its result. |
| **Strategy family** | Which set of generators the engine uses: `default` (schema-only) or `hacker` (widened toward adversarial values). |
| **Producer contract** | An extra per-endpoint contract you supply (`--contracts`) that enriches the run beyond the OpenAPI schema. |
| **State link** | A data dependency between operations derived from the spec, letting a stateful sequence carry a value from one request into the next. |
| **Handler** | The function in your source code that serves an endpoint. |
| **Coverage of declared endpoints** | Which endpoints a run actually tested and which it left out (targeted, excluded or filtered). |
