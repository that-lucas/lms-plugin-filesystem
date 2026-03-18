# AGENTS.md

Guidance for agents working in this repository.

## Project structure

- `src/index.ts` - plugin entrypoint
- `src/config.ts` - plugin config schematics
- `src/toolsProvider.ts` - tool definitions and tool-facing docs
- `src/utils.ts` - shared filesystem helpers
- `src/tools.test.ts` - tool-level tests
- `src/paths.test.ts` - path handling and boundary tests
- `src/utils.test.ts` - utility tests
- `README.md` - user-facing documentation

## Commands

Run from the repository root.

- `npm install` - install dependencies
- `npm test` - run the test suite
- `npm run typecheck` - run the TypeScript type checker without emitting files
- `npm run dev` - start local LM Studio plugin development
- `npm run install:local` - install plugin locally using a filtered temporary artifact
- `npm run push` - publish a filtered runtime-only artifact with `lms push`
- `npm run push -- --write-revision --description "..."` - publish the same filtered runtime-only artifact and update the Hub revision description when needed

## End-to-end tests

E2e tests live in `scripts/e2e-*.sh` and are driven by `scripts/e2e-runner.js`. They call the LM Studio API with a real model and the installed plugin, so they are expensive (each scenario is a full LLM inference round-trip).

- **Never run e2e tests unless explicitly requested.** They are not part of the normal development loop.
- Run one suite at a time — do not run e2e scripts in parallel. Each call loads the model and hits the API; parallel runs will compete for GPU and produce flaky results.
- The first suite run should install the plugin (`bash scripts/e2e-read.sh`). Subsequent suites in the same session can skip reinstall with `LMSTUDIO_E2E_SKIP_INSTALL=1`.
- Requires `LM_API_TOKEN` (stored in `.env`, gitignored). Source it before running: `source .env && export LM_API_TOKEN`.
- Available suites: `read`, `list`, `glob`, `grep`.

## Working rules

- Keep `README.md` and tool-facing docs in `src/toolsProvider.ts` aligned in context; tool docs may be more verbose by design, so wording does not need to match exactly
- Update tests when changing tool behavior or output contracts
- Assert on structured or data-bearing output over summary text whenever possible
