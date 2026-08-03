# Integration Tests — `core_ast`

A single integration suite for manual/local testing against real repositories.

## Quick summary

- The only test file is `test_pipeline_stages.py`. Edit `REPO_CONFIG` in that file
  to point at any local repo and endpoint you want to test.
- Alternatively, export the `INTEGRATION_REPO` environment variable to override the
  repo path when running `pytest`.
- The test writes one file per stage to `tests/integration/output/`
  (`01_locator.txt` ... `05_quality.txt`) plus the final bundle, `output.py`.

## Configuring the target repo

1. Edit `lib/core_ast/tests/integration/test_pipeline_stages.py` and set
   `REPO_CONFIG["repo_path"]` to the absolute path of your local repo.
2. Or skip editing the file and export the environment variable instead:

```bash
export INTEGRATION_REPO=/home/you/projects/my-service
pytest -m integration -q
```

## Output location

- Per-stage files: `lib/core_ast/tests/integration/output/01_locator.txt`, ...
- Final bundle: `lib/core_ast/tests/integration/output/output.py`

## Notes

- These tests are manual and not part of CI. They're meant for fast local iteration
  and debugging against real projects.
