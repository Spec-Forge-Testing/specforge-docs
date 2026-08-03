# Storage Engine

`lib/storage` persists Spec Forge executions in SQLite so analyses can be audited,
compared and replayed. Its unit of organization is:

```text
Project → Analysis → Run
```

An analysis is the reproducible recipe (resolved contracts and execution settings);
a run is one execution of that recipe. Repositories encapsulate parameterized SQL,
Pydantic DTOs validate data at the boundary, and domain exceptions prevent SQLite
driver errors from leaking to callers.

## Read next

- [Data model](data-model.md): every persisted record, relationship and test setup.
- [Custom Schemathesis](../custom-schemathesis/index.md): producer of execution
  results and crash reports.
