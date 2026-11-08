## Correct programs

Define ordinary Java source templates in `src/problems/catalog/java/regular.ts`. Register each name and its lecture membership in `src/problems/courses/definitions.ts`.

A `<1-4>` placeholder selects an integer from 1 through 3 using the problem seed; the upper bound is exclusive. The Java interpreter under `src/java/` executes the instantiated source to produce its trace. Source programs do not need a trailing `.trim()` call.

The independent regular challenge bank lives in `src/problems/catalog/java/tuBeginner1/` and `tuBeginner2/`. Each lecture file defines correct programs with an ID, title, course, lecture index, and Java source. Regular challenge mode uses this bank for the curriculum courses. Generated blank and bug challenges can use both ordinary lecture programs and the independent bank.

## Generated exercises

Configure candidate selectors per course and lecture in `src/problems/courses/generationPolicies.ts`. The candidate contracts are documented beside `rules` in `src/problems/generation/languages/java/rules.ts`; selection and resource-limit contracts are documented in `src/problems/generation/generate.ts` and `candidates.ts`.

Do not write blank markers, starter programs, or per-problem replacement edits in the catalog. The generator derives one blank or one source-range mutation from a correct program, validates it with the interpreter, and derives the expected final turtle state. Programs that fail compilation, exceed execution limits, or terminate with an uncaught exception cannot serve as generated repair exercises. They can still serve as ordinary tracing problems when that behavior is intentional.

Generated sessions persist their displayed source and judging target in `ExerciseSession.generatedProblem`. Resuming or grading uses this snapshot even after a source or policy change. Historical fixed-definition sessions without a snapshot remain in the database but are not resumed as generated exercises. Submissions remain separate from ordinary progress in `ExerciseSubmission`.

## Trace annotations

Add `// atomic` at the end of a method or constructor declaration line, up to the line containing its opening brace, to hide its internal trace steps. For example:

```java
void turnTwice() { // atomic
    turtle.turnRight();
    turtle.turnRight();
}
```

The interpreter records traces using these rules:

- Expression statements and initialized local variables and fields record the resulting state. Constant static field initializers do not record a step because their values are already available before class initialization.
- A `for` loop records initialization and updates. An enhanced `for` loop records iteration-variable assignment; for reference values other than `String`, it records only when the observable board, turtles, or variables changed since the previous step.
- `return`, `if`, `while`, and declarations without initializers do not themselves record steps.
- A statement consisting only of a call or object creation normally omits its own step when execution inside that call already recorded the result. It records a resulting step when an atomic call is involved or observable state changed after the last internal step. Assigning a returned value to a local variable records the assignment as well.
- Atomic methods suppress steps inside their nested calls too. A call in an unrecorded statement, such as an `if` condition or a `return`, does not acquire an extra step merely because it is atomic. An atomic annotation outside a declaration is a compile error.
- Variable tables show in-scope locals except unnamed `_` variables, receiver fields, and nonconstant static fields. Objects and arrays expose their referenced contents. Turtles no longer reachable from variables disappear from the board.

## Validation

Run `bun run verify` and the relevant tests. `test/unit/problemData.test.ts` checks ordinary templates; intentional uncaught-exception examples are listed in its `problemsEndingWithException` set. `test/unit/javaChallengeCatalog.test.ts` checks generated exercises from the independent bank, and `test/unit/generatedChallenges.test.ts` checks generation behavior.

Open the applicable lecture and check both tracing and challenge displays. Verify the drawing, visible variables, stopping points, and whether the generated edit matches the lecture's learning objectives. Generation establishes executable behavior, not educational difficulty.
