# Operations

`describe` publishes **32 operations in eight families**, derived from the
core's own façade. Each operation declares what must be open before it is called
(`requires`), whether it can be watched (`emits_progress`), whether it can be
stopped (`cancellable`), and whether it destroys what cannot be undone
(`destructive`). The tables below group them by family; the authoritative,
machine-readable form is whatever `describe` returns from the build in hand.

`requires` is one of:

| Value | What must be arranged first |
| --- | --- |
| `none` | Nothing. |
| `project` | A project must be open. |
| `contract` | A contract must also be loaded — which implies a project. |
| `analysis` | An `analyze_endpoints` must have run in the same session — which implies a contract. Without it the call is refused `NO_STATIC_ANALYSIS`. |

`destructive` is `true` on exactly two operations, `apply_fix_plan` and
`apply_prune_plan`, which delete or rewrite what cannot be undone. A frontend
confirms those before sending, reading the flag instead of keeping its own list.

## `session`

| Operation | `requires` | Notes |
| --- | --- | --- |
| `open_project` | none | Opens or switches the active project; not counted by the busy guard |
| `project_state` | project | The open project's state |
| `close_project` | none | Releases everything the project held; not counted by the busy guard |
| `init_project` | none | Creates a project's `.specforge` and `specforge.toml` without opening it; see [below](#init-project) |

### `init_project` { #init-project }

| Parameter | Default |
| --- | --- |
| `path` | The directory to scaffold; the core's working directory. |
| `name` | The directory's name. |
| `openapi_spec` | The first of `openapi.yaml`, `openapi.yml`, `openapi.json` found in the project root, else `openapi.yaml`. |
| `base_url` | `http://localhost:8000`. |
| `overwrite` | `false`. Giving `name`, `openapi_spec` or `base_url` while a `specforge.toml` exists needs it. |

`name`, `openapi_spec` and `base_url` are what the file declares. A value given
empty, one UTF-8 cannot encode, an `openapi_spec` that names no file, or a value
given over an existing file without `overwrite`, is refused `INVALID_PARAMS`
(`data.reason`, `data.settings`) before anything is written. The result carries
`settings`, what `specforge.toml` declares afterwards in the shape
`open_project` answers with, and `spec_found`, whether that spec exists.

## `contract`

| Operation | `requires` | Events |
| --- | --- | --- |
| `load_contract` | project | `started`, `finished` |
| `get_contract` | contract | — |
| `list_endpoints` | contract | — |
| `get_endpoint` | contract | — |

## `analysis`

| Operation | `requires` | Events |
| --- | --- | --- |
| `analyze_endpoints` | contract | emits progress and is cancellable |
| `get_static_analysis` | analysis | |
| `get_endpoint_static_analysis` | analysis | |
| `get_llm_payload` | analysis | |

## `execution`

| Operation | `requires` | Events |
| --- | --- | --- |
| `estimate_inference` | contract | none; prices what inferring the selection's contracts would cost, per endpoint and in total, with an `approval_token`; calls no model ([fields](#estimate-inference)) |
| `fuzz` | contract | emits progress and is cancellable |
| `replay` | project | emits progress and is cancellable |
| `run_pipeline` | none | composes the four stages; emits progress and is cancellable |

`run_pipeline` frames each stage with `stage_started` / `stage_finished` over
`contract` / `static_analysis` / `inference` / `execution`, and a stage ends
`completed` / `failed` / `skipped` / `stopped`. The execution stage's status
follows the run: a run that breached the safety guard ends it `failed`, a
cancelled one `stopped`. The pipeline's own status ranks a breach over a stop
request, and a stop request over a failure (see
[stage status](vocabularies.md#stage-status)).

What each stage of `run_pipeline` works on:

- **`contract`** runs the contract the session holds when `load_contract`
  loaded one, else the project's declared document.
- **`static_analysis`** traces `repo_root`, an optional path. Without it,
  `producer.source_repo` when the run has one, else the project root. A
  `repo_root` that names a different tree than `producer.source_repo`, or one
  given with `analyze` false, fails the stage `INVALID_PARAMS`.
- **`inference`**, with a `producer`, plans the run and produces every contract
  once; **`execution`** runs what that stage produced. A refusal met before the
  engine runs fails the `inference` stage, with the same code and `data` it
  would carry as an error, and the stages after it are not reported. Without a
  `producer` the stage ends `skipped`.

### The `producer` object { #producer }

`fuzz` and `run_pipeline` take an optional `producer`; `estimate_inference`
requires one. A relative path resolves against the project root.

| Field | Meaning |
| --- | --- |
| `kind` | `fixture` (hand-written contracts) or `inference` (contracts a model infers from the code). |
| `contracts_dir` | The directory of hand-written contracts, for `fixture`. |
| `source_repo` | The code to infer from, for `inference`. |
| `refresh` | Skip the inferred-contract cache and replace every entry this run infers. Default `false`. |
| `approval_token` | An approved estimate's token, required while inferences remain to pay for and `inference.require_approval` is on. A missing or stale one is refused `INFERENCE_APPROVAL_REQUIRED`. |
| `max_cost_usd` | The most the run may spend on inferences, in USD, greater than `0`. No inference starts once the spend would pass it; the endpoints left over run schema-only. |

`refresh`, `approval_token` and `max_cost_usd` apply to `inference` only; with
another `kind` they are refused `INVALID_PARAMS`.

### What `estimate_inference` answers { #estimate-inference }

`estimate_inference` takes the same selection as `fuzz` (`target`, `endpoint`,
`method`, `strategy`) and a `producer` of kind `inference`, and calls no model.

| Field | Meaning |
| --- | --- |
| `model` | The model the estimate priced. |
| `priced` | Whether the model has a price. `false` means the cost is unknown, never that it is free. |
| `token_basis` | `calibrated` (counted for that provider) or `approximate`. |
| `endpoints` | One row per endpoint: `method`, `path_url`, `source` (`cache` or `model`), `input_tokens`, `output_tokens`, `cost_usd`; `null` where nothing would be sent. |
| `untraced` | The endpoints whose code could not be traced (`method`, `path_url`, `reason`); they would run schema-only. |
| `cached`, `pending` | How many contracts the cache would serve, and how many the model would infer. |
| `input_tokens`, `output_tokens`, `cost_usd` | The totals; `cost_usd` is `null` when unpriced. |
| `max_cost_usd` | The `producer.max_cost_usd` echoed back, or `null`. |
| `exceeds_cap` | Whether the estimated cost passes that cap; `null` without a cap or when unpriced. |
| `approval_required` | Whether a run of this selection needs a token. |
| `approval_token` | The token a run passes as `producer.approval_token` to approve exactly this estimate. |

### Replay consent { #replay-consent }

`replay` takes an optional boolean `allow_side_effects` (default `false`). A
recording made with `allow_side_effects`, or one whose original run ended
`safety_breached`, is re-sent only when the call passes it: consent is given per
replay, never inherited from the recording. Without it the call is refused with
`SIDE_EFFECTS_CONSENT_REQUIRED` before any request is sent, and `data.reason`
says which case applies (`recorded_with_side_effects` or `safety_breached`). On
any other recording the parameter is accepted and does nothing. See
[consent to re-send](../../specforge-engine/execution-modes.md#consent-to-re-send).

## `results`

| Operation | `requires` | Events |
| --- | --- | --- |
| `list_projects` | none | — |
| `list_analyses` | none | — |
| `get_analysis` | none | — |
| `list_runs` | none | — |
| `get_run` | none | `started`, `finished` |
| `get_finding` | none | — |
| `compare_runs` | none | — |
| `prune_runs` | none | — |
| `apply_prune_plan` | none | — |

## `config`

| Operation | `requires` |
| --- | --- |
| `get_config` | none |
| `set_config` | project |
| `reset_config` | project |

## `environment`

| Operation | `requires` | Events |
| --- | --- | --- |
| `diagnose` | none | reports progress |
| `apply_fix_plan` | none | reports progress |

## `catalog`

| Operation | `requires` |
| --- | --- |
| `describe` | none |
| `describe_operations` | none |
