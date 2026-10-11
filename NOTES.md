# Notes: mistakes and fixes

## 2026-10-11: MCP SDK imports would not resolve

**What happened:** Imports from the MCP SDK failed to resolve at compile time.
**Root cause:** The SDK ships an `exports` map, which needs `moduleResolution: node16`, and that setting in turn needs `module: node16` alongside it.
**Fix:** Set both `module` and `moduleResolution` to `node16` in `tsconfig.json`.
**What I would do differently:** When a package uses an `exports` map, set the module options to match it before writing code against it.

## 2026-10-11: CI "failed" in 3 seconds with no logs

**What happened:** The first CI runs went red in 2 to 3 seconds. `gh run view --log-failed` returned "log not found", which made it look like a broken workflow file.
**Root cause:** Not the code or the workflow. The run annotation said the job was not started because the GitHub account was locked over a billing issue, so no step ever ran.
**Fix:** Once the account lock was cleared, re-ran the checks. CI then passed on the same workflow with no changes to it.
**What I would do differently:** Read the run annotations (`gh run view <id>`) before touching the workflow. A red check that finishes in seconds with no logs is an account or runner problem, not a test failure.

