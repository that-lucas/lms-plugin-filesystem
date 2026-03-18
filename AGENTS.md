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
- `npm run dev` - start local LM Studio plugin development
- `npm run install:local` - install plugin locally using a filtered temporary artifact
- `npm run push` - publish a filtered runtime-only artifact with `lms push`
- `npm run push -- --write-revision --description "..."` - publish the same filtered runtime-only artifact and update the Hub revision description when needed

## Working rules

- Keep `README.md` and tool-facing docs in `src/toolsProvider.ts` aligned in context; tool docs may be more verbose by design, so wording does not need to match exactly
- Update tests when changing tool behavior or output contracts
- Assert on structured or data-bearing output over summary text whenever possible
