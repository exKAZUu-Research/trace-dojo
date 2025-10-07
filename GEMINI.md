## Project Information

- Name: trace-dojo
- Description: undefined
- Package Manager: yarn

## General Instructions

- After making code changes, run `yarn check-all-for-ai` to execute all tests (note: this may take up to 30 minutes), or run `yarn check-for-ai` for type checking and linting only.
  - If you are confident your changes won't break any tests, you may use `check-for-ai`.
- Once you have verified your changes, commit them to the current branch using the `--no-verify` option. Ensure you add a new line at the end of your commit message with: `Co-authored-by: WillBooster (Gemini CLI) <agent@willbooster.com>`.

## Coding Style

- When adding new functions or classes, define them below any functions or classes that call them to maintain a clear call order.
- Since this project uses the React Compiler, you do not need to use `useCallback` or `useMemo` for performance optimization.
