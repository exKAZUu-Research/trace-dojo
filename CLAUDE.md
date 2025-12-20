## Project Information

- Name: trace-dojo
- Description: undefined
- Package Manager: yarn

## Development Workflow

1. If the current branch is `main`, create a new branch.
   - Include unexpected changes since they are mine.
2. Make code changes as needed.
3. If possible, write e2e tests for your changes.
4. Run `yarn check-all-for-ai` to execute all tests (note: this may take up to 30 minutes), or run `yarn check-for-ai` for type checking and linting only.
   - If you are confident your changes will not break any tests, you may use `check-for-ai`.
5. Commit your changes to the current branch and push.
   - Follow conventional commits, i.e., your commit message should start with `feat:`, `fix:`, `test:`, etc.
   - Make sure to add a new line at the end of your commit message.
   - When pre-commit hooks prevent your changes, fix your code, then re-commit and re-push.
6. Create a pull request using `gh`.
   - The pull request title should match your commit message.
7. Repeat the following steps until all tests pass:
   1. Wait for CI to run all tests.
   2. If tests fail, identify the root causes by gathering debug information through logging and screenshots, then fix the code and/or tests.
   3. Fetch unresolved review comments from the pull request using `gh` and address them.
      - e.g., `gh api graphql -f query='{ repository(owner: "exKAZUu-Research", name: "trace-dojo") { pullRequest(number: 24) { reviewThreads(first: 100) { nodes { isResolved comments(first: 100) { nodes { body author { login } path line } } } } } } }' | jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'`
   4. Commit your changes and push.
   5. Write `/gemini review` in the pull request.

## Coding Style

- Write comments that explain "why" rather than "what". Avoid explanations that can be understood from the code itself.
- Use stderr for logging debug messages temporarily since stdout output is sometimes omitted.
- When adding new functions or classes, define them below any functions or classes that call them to maintain clear call order.
- Prefer `undefined` over `null` unless explicitly dealing with APIs or libraries that require `null`.
- Always perform existence checks on array due to `noUncheckedIndexedAccess: true`.
- Prefer `useImmer` for storing an array or an object to `useState`.
- Since this project uses the React Compiler, you do not need to use `useCallback` or `useMemo` for performance optimization.
