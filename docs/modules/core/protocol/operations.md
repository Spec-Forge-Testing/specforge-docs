# Operations

`describe` publishes **31 operations in eight families**, derived from the
core's own façade. Each operation declares what must be open before it is called
(`requires`), whether it can be watched (`emits_progress`), and whether it can
be stopped (`cancellable`). The tables below group them by family; the
authoritative, machine-readable form is whatever `describe` returns from the
build in hand.

`requires` is one of `none`, `project` (a project must be open) or `contract` (a
contract must also be loaded — which implies a project).

## `session`

| Operation | `requires` | Notes |
| --- | --- | --- |
| `open_project` | none | Opens or switches the active project; not counted by the busy guard |
| `project_state` | project | The open project's state |
| `close_project` | none | Releases everything the project held; not counted by the busy guard |
| `init_project` | none | Creates a project's `.specforge` and `specforge.toml` without opening it |

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
| `get_static_analysis` | contract | |
| `get_endpoint_static_analysis` | contract | |
| `get_llm_payload` | contract | |

## `execution`

| Operation | `requires` | Events |
| --- | --- | --- |
| `fuzz` | contract | emits progress and is cancellable |
| `replay` | project | emits progress and is cancellable |
| `run_pipeline` | none | composes the four stages; emits progress and is cancellable |

`run_pipeline` frames each stage with `stage_started` / `stage_finished` over
`contract` / `static_analysis` / `inference` / `execution`, and a stage ends
`completed` / `failed` / `skipped` / `stopped`.

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
