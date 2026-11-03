# Finding follow-up records

Five tables hold what happens to a finding after its run: an explanation, a
proposed fix and whether it is in the tree, the stack trace its server logged, what
a user pasted about it, and how each replay against a fix came out. Each row points
at its finding (`findings.id`, `ON DELETE CASCADE`), and several rows per finding
are allowed: the newest is the current one. Each table is exposed as a frozen
record and a repository on the unit of work, as the tables of the
[data model](data-model.md) are.

| Table | Record | `uow.` | Written by |
| --- | --- | --- | --- |
| `finding_explanations` | `FindingExplanationRecord` | `finding_explanations` | `explain_finding` |
| `finding_fixes` | `FindingFixRecord` | `finding_fixes` | `propose_fix`; `apply_finding_fix`, `revert_finding_fix` and `verify_finding_fix` stamp it |
| `finding_server_logs` | `FindingServerLogRecord` | `finding_server_logs` | `replay_finding`, `set_finding_trace` |
| `finding_notes` | `FindingNoteRecord` | `finding_notes` | `set_finding_trace`, for text with no stack frame |
| `finding_resolutions` | `FindingResolutionRecord` | `finding_resolutions` | `replay_finding`, while a fix is in the finding's tree |

## `finding_explanations` — `FindingExplanationRecord` { #finding_explanations }

| Column | Type | Null | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | no | — | Primary key. |
| `finding_id` | INTEGER | no | — | The finding. |
| `cache_key` | TEXT | no | — | Content, never values: an equivalent finding in a later run reuses the explanation instead of paying again. |
| `reused_from_id` | INTEGER | yes | — | The row it was reused from (`ON DELETE SET NULL`); a reused row records zero tokens. |
| `source` | TEXT | no | — | `model`, or `template` for a fixed text that needs no model. |
| `include_code` | INTEGER | no | `0` | Whether the handler's code was sent; always `0` for a template. |
| `explanation` | TEXT | no | — | What happened, in plain words. |
| `probable_cause`, `fix_suggestion` | TEXT | yes | — | Where the cause likely is, and how it could be fixed. |
| `code_refs` | TEXT | yes | — | JSON `[{file, start_line, end_line}]`, checked against the code sent. |
| `confidence` | TEXT | yes | — | `low`, `medium` or `high`. |
| `primary_model`, `answering_model`, `prompt_fingerprint` | TEXT | yes | — | The model asked first, the one that answered, and the prompt's identity; required for a `model` row, NULL for a template. |
| `input_tokens`, `output_tokens` | INTEGER | no | `0` | What the call consumed. |
| `cost_usd` | REAL | yes | — | Its cost; NULL when unpriced or a template. |
| `created_at` | DATETIME | yes | `CURRENT_TIMESTAMP` | When it was written. |

## `finding_fixes` — `FindingFixRecord` { #finding_fixes }

| Column | Type | Null | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id`, `finding_id`, `cache_key`, `reused_from_id` | | | | As in `finding_explanations`. A reused fix is a row of its own, so applying it never marks its source. |
| `rationale` | TEXT | yes | — | The model's reasoning. |
| `diff` | TEXT | no | — | The unified diff of the edits that apply, ready as a `.patch`. |
| `edits_json` | TEXT | no | — | JSON `[{file, search, replace}]`: the edits whose search text matched exactly once. |
| `discarded_json` | TEXT | yes | — | JSON `[{file, reason}]`: the edits that did not, and why. |
| `primary_model`, `prompt_fingerprint` | TEXT | no | — | The model asked first, and the prompt's identity. |
| `answering_model` | TEXT | yes | — | The model that answered. |
| `input_tokens`, `output_tokens` | INTEGER | no | — | What the call consumed. |
| `cost_usd` | REAL | yes | — | Its cost. |
| `created_at` | DATETIME | yes | `CURRENT_TIMESTAMP` | When it was proposed. |
| `applied_at` | DATETIME | yes | — | Set when `apply_finding_fix` applied all of it; cleared by a revert. |
| `build_output` | TEXT | yes | — | What the build last refused the applied fix with: the compiler's errors, else its last lines. Cleared once a build of it passes. |
| `build_failed_at` | DATETIME | yes | — | When that build failed. |

## `finding_server_logs` — `FindingServerLogRecord` { #finding_server_logs }

| Column | Type | Null | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id`, `finding_id` | INTEGER | no | — | Primary key, and the finding. |
| `source` | TEXT | no | — | Where the trace was read from, such as `docker:<container>`, or `manual` for a pasted one. |
| `stack_trace` | TEXT | no | — | The trace only, never the rest of the log; never empty. |
| `captured_at` | DATETIME | yes | `CURRENT_TIMESTAMP` | When it was kept. |

## `finding_notes` — `FindingNoteRecord` { #finding_notes }

| Column | Type | Null | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id`, `finding_id` | INTEGER | no | — | Primary key, and the finding. |
| `notes` | TEXT | no | — | The pasted text, its credentials blanked out; never empty. |
| `written_at` | DATETIME | yes | `CURRENT_TIMESTAMP` | When it was pasted. |

## `finding_resolutions` — `FindingResolutionRecord` { #finding_resolutions }

| Column | Type | Null | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id`, `finding_id` | INTEGER | no | — | Primary key, and the finding. |
| `fix_id` | INTEGER | no | — | The applied fix replayed against (`finding_fixes.id`, `ON DELETE CASCADE`): the finding's own, or another finding's over the same files. |
| `verdict` | TEXT | no | — | `present`, `possibly_resolved` or `inconclusive` (CHECK). |
| `acceptance_met` | BOOLEAN | yes | — | Whether a replayed crash answered a declared status; NULL when not judged. |
| `fix_applied_at` | DATETIME | yes | — | The fix's `applied_at` at the time, so a revert or a later apply leaves the row about another tree. |
| `replayed_at` | DATETIME | yes | `CURRENT_TIMESTAMP` | When the replay ran. |

A finding is resolved while its newest row passed (`possibly_resolved`, with the
acceptance met or not judged) and its fix still carries the same `applied_at`.
