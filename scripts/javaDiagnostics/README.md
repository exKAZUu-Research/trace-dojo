# Local Java diagnostic corpus

Install the repository's pinned tools with `mise install`, then run:

```sh
mise exec -- fnox run -P test -- bun scripts/collectJavaDiagnostics.ts
```

The command compiles all checked-in examples with the real grading wrapper and writes `.tmp/javaDiagnostics/report.json`. No grading API is called and no generated program runs. The compiler helper is for trusted developer examples only; it is not a sandbox or a production grading backend. Generated source and class files are removed after each compilation.

To select examples, pass their stable IDs. Selection preserves corpus order:

```sh
mise exec -- fnox run -P test -- bun scripts/collectJavaDiagnostics.ts method semicolon
```

Unknown, empty-string, and duplicate IDs fail. Each run replaces the local report. Do not run collectors concurrently in the same working directory. Raw output in the developer report may contain generated names and local paths; only normalized diagnostics are suitable for learners.

The Zod-validated report records the exact `javac` version, argument array, source, expected result, process output, exit status, normalized diagnostics and observation classifications. Counts distinguish selected, attempted and completed examples, expected failures, unexpected successes, unexpected compile failures and tool failures. A version-probe failure produces an incomplete report with zero attempts. Unexpected outcomes and tool failures exit nonzero; expected compilation errors do not.

`translated` means a recognized diagnostic received a family-specific explanation and safe reference. `neutral` covers a recognized category without a trusted symbol, or locationless wrapper/entry/delimiter guidance. `unsupported` uses the generic Japanese fallback without a reference. These are observations, not distinct categories or a measure of learner comprehension. Multiple compiler errors can follow from one mistake, and normalized duplicate messages collapse.

The 59 examples cover the course's basic writing, names, calls, values, arrays, loops, returns, classes, encapsulation, static members, switch, and exception topics. Alternative causes and contexts explain why the corpus is larger than a simple family list: semicolons inside loop headers, missing methods with different receivers, conversion errors in conditions/calls/indexes, and return paths versus return values. Inheritance override feedback stays general because the header alone does not establish whether the return value or access rules caused the mismatch. Generic and qualified type forms, unusual overload continuations, advanced inheritance and version-dependent language features may also receive neutral feedback. This is practical coverage, not coverage of all javac messages.

The local Temurin JDK 21 patch version differs from the primary provider's `openjdk-jdk-21+35`, and the fallback uses JDK 25. English UTF-8 default diagnostics are collected without `-XDrawDiagnostics` or verbose diagnostic mode. Existing provider regression tests remain real API calls; the full repository suite is not offline.

When adding an example, use a minimal learner source with a stable descriptive ID and an explicit expected outcome. Compile it locally first. Read every actual diagnostic and compare its cause with the Japanese explanation, including cascades and source locations. Only accept bounded grammar and source-proven names before translating or exposing a secondary reference. Do not add raw-message fallbacks, suggested casts/access changes, translation snapshot tables, or execute learner programs. Inspect the completed report's counts and audit unsupported observations explicitly.

Compiler behavior reference: [Oracle JDK 21 javac documentation](https://docs.oracle.com/en/java/javase/21/docs/specs/man/javac.html).
