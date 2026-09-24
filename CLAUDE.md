## Project Information

- Name: `trace-dojo`
- Package Manager: bun

## General Instructions

- If on `main`, create a new branch; otherwise work on the current branch.
- Run `git` commands one at a time to avoid `index.lock` conflicts.
- Unless instructed otherwise, write every artifact except your conversational replies and product-facing text in English.
- Write a test only when explicitly requested, or when a behavior is likely to regress and no existing automatic check (type checking, linting, an existing test or CI check) would catch the breakage. Never add a test that merely restates a mapping from conditions to constant outputs (it fails only on intentional edits) or that only confirms an external fact (a library's behavior, whether a version fixes an issue); verify those once manually.
- Test externally observable behavior (e.g., emitted files, CLI output, rendered results) at the system boundary, not implementation details: do not mirror production logic, assert that a branch is taken, or feed hand-assembled internal objects to internal functions.
- Prefer actual API calls over mocks, unless actual calls are impractical, have unintended side effects, or mocks are explicitly requested.
- Ensure tests are idempotent and independent (e.g., reset persistent data) so they can run repeatedly or in parallel.
- Avoid fixed waits in E2E tests; wait for conditions instead.
- When fixing issues (including test failures), investigate the root cause first (e.g., via debug logs or screenshots) and fix it instead of applying workarounds.
- After making changes, run `bun run verify` (type checking and linting; up to 10 minutes), or `bun run verify-full` (all tests; up to 1 hour) if you changed runtime behavior or tests. Fix errors and re-run until it passes.
  - Wait for it to finish without restarting it: prefer completion notifications, otherwise the longest permitted wait; no output does not mean it has stopped. If the displayed excerpt is insufficient, read the indicated log file before rerunning. If the environment kills long-running commands, run them detached with a saved log and exit status.
- Once verified, commit and push to the current (non-main) branch, and create a PR via `gh` if none exists for the branch.
  - Follow the Conventional Commits format (e.g., `feat:`, `fix:`).
  - Always create new commits; avoid `--amend`.
- In any explanatory text (commit messages, PR descriptions, documentation, code comments, etc.), describe only the current implementation: drop any statement naming an identifier, feature, or concept you cannot confirm exists in the final diff or the current codebase (e.g., one added and later removed or renamed along the way). Whenever documentation or comments no longer match the current implementation (removed options, deprecated usage, outdated behavior), delete or rewrite them, even in files you are not otherwise changing. Mention a past state only where it is needed to understand why the current design is as it is, or when explicitly asked; files that record history by design (e.g., a changelog) are exempt.
- Use heredoc for multi-line command input (e.g., `git commit -F -`, `gh pr create --body-file -`, `gh issue create --body-file -`).
- Put temporary files in `.tmp`; use `/tmp` only for files that must live outside the repo.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/general.mdc`, and `.gemini/styleguide.md` are generated from `AGENTS_EXTRA.md` and overwritten on every `wbfy` run; to change agent instructions, edit only `AGENTS_EXTRA.md`.
- Tool versions (e.g., node) are pinned in `mise.toml`; run `mise install` after changing it and never install those tools globally instead.
- `bunfig.toml` uses Bun's isolated linker, so only declared dependencies resolve. If an import fails to resolve, declare that package in the `package.json` that imports it; never switch `linker` to `hoisted` or add to `publicHoistPattern` to work around it.
- Environment variables and secrets live in `fnox.toml` (mise + fnox); never create `.env`, `.env.*`, or `.dev.vars` files. Run commands through `bun wb ...` or `fnox run -P <profile> -- <command>`. Profile secrets load only when a profile is selected: mode-aware wb commands (e.g. `wb start`, `wb test`) and `wb dotenv` select it themselves (`wb dotenv` uses `WB_ENV`, else `FNOX_PROFILE`, else `NODE_ENV`, else the development profile; `WB_ENV` accepts only `development`/`test`/`staging`/`production`, so use `FNOX_PROFILE` for any other profile), while bare `fnox run` needs an explicit `-P <profile>`.

## Coding Style

- Use camelCase file names for JavaScript/TypeScript (PascalCase for React components).
- Simplify code as much as possible to eliminate redundancy.
- Design modules and directories with high cohesion and low coupling; split large modules when needed.
- Place calling functions above the functions they call (top-down order); place variable and type declarations above their usage.
- Comments and JSDoc: every reader has the source, so never restate what the code, its names, or its types already say (e.g., `@param name The name`). Write one only when a plausible edit would break something without that knowledge and no type check, lint rule, or test would catch it; first encode the knowledge in code (a name, a type, an `assert`, a test) and comment only what cannot be encoded: an odd-looking workaround, a dependency on a fact outside the repository, or a rejected alternative and why. Put a contract of the declared symbol in JSDoc and line-specific knowledge in an inline comment. Delete comments that fail this test in files you touch. Exception: the exported API of a package published to npm may carry JSDoc describing what it does and how to call it, because its users read it without the source.
- Never explain how WillBooster's in-house tools (e.g., `wb`, `wbfy`) work in code comments or documents outside the tool's own package, except in instructions for AI agents (e.g., do not note that `PORT` is unset because `wb` picks a free port).
- If lint errors or warnings cannot be fixed, use ignore comments with reasons (e.g., `// oxlint-disable-next-line <rule> -- <reason>`).
- Prefer `undefined` over `null` unless required by APIs or libraries.
- Validate JavaScript objects (e.g., parsed JSON, API responses) with `zod` whenever possible instead of hand-written checks or type assertions.
- Build prompts as a single template literal instead of `join()` on a pre-computable array of strings.
- Assume all environment variables are defined; if validation is needed, `assert` them at startup to fail fast.
- Assume local tools such as `git`, `gh`, and `ghq` are installed and authenticated.
- Prefer lambda over `function` for React components, e.g., `const Button: React.FC = () => {`.
- Prefer `useImmer` over `useState` for arrays and objects.
- Use `autoFocus` where it reduces user effort.
- This project uses the React Compiler, so `useCallback` and `useMemo` are unnecessary for performance.
- Assume a single server instance.
