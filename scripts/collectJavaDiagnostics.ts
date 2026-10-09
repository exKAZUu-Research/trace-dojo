import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { javaDiagnosticExamples } from './javaDiagnostics/examples';
import { compileJavaProgram, compilerArguments, readJavaCompilerVersion } from './javaDiagnostics/localCompiler';

import { genericCompilerMessage } from '../src/problems/fillInBlank/compilerMessages';
import { normalizeCompilerDiagnostics } from '../src/problems/fillInBlank/compilerDiagnostics';
import { javaDiagnosticsSchema } from '../src/problems/fillInBlank/javaDiagnostics';
import { buildJavaJudgeProgram } from '../src/problems/fillInBlank/javaProgram';

const observationSchema = z.object({
  diagnostic: javaDiagnosticsSchema.element,
  classification: z.enum(['translated', 'neutral', 'unsupported']),
});
const resultSchema = z.object({
  id: z.string().min(1),
  tier: z.number().int().min(0).max(2),
  topic: z.string().min(1),
  source: z.string().min(1),
  expected: z.enum(['compiled', 'compileError']),
  outcome: z.enum(['valid', 'expectedCompileError', 'unexpectedSuccess', 'unexpectedCompileError', 'toolError']),
  exitCode: z.number().int().optional(),
  stdout: z.string().max(131_072),
  stderr: z.string().max(131_072),
  failure: z.string().optional(),
  observations: z.array(observationSchema).max(20),
});
const reportSchema = z.object({
  compiler: z.object({
    command: z.literal('javac'),
    version: z.string().min(1).optional(),
    arguments: z.array(z.string()),
    failure: z.string().optional(),
  }),
  counts: z.object({
    selected: z.number().int(),
    attempted: z.number().int(),
    completed: z.number().int(),
    expectedFailures: z.number().int(),
    unexpectedSuccesses: z.number().int(),
    unexpectedCompileErrors: z.number().int(),
    toolFailures: z.number().int(),
    translated: z.number().int(),
    neutral: z.number().int(),
    unsupported: z.number().int(),
  }),
  results: z.array(resultSchema),
});

async function collect(): Promise<void> {
  const ids = process.argv.slice(2);
  if (
    ids.some((id) => !javaDiagnosticExamples.some((example) => example.id === id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Specify unique known sample IDs, or no arguments for the entire corpus.');
  const selected = javaDiagnosticExamples.filter((example) => ids.length === 0 || ids.includes(example.id));
  if (selected.length === 0) throw new Error('No samples selected.');
  const compiler: z.infer<typeof reportSchema>['compiler'] = { command: 'javac', arguments: compilerArguments };
  const results: z.infer<typeof resultSchema>[] = [];
  try {
    compiler.version = await readJavaCompilerVersion();
  } catch (error) {
    compiler.failure = String(error);
  }
  if (!compiler.failure)
    for (const example of selected) {
      try {
        const program = buildJavaJudgeProgram(example.source, '__TRACE_DOJO_RESULT_local_corpus__');
        const compiled = await compileJavaProgram(program.program);
        const outcome =
          compiled.kind === 'toolError'
            ? 'toolError'
            : compiled.kind === 'compiled'
              ? example.expected === 'compiled'
                ? 'valid'
                : 'unexpectedSuccess'
              : example.expected === 'compileError'
                ? 'expectedCompileError'
                : 'unexpectedCompileError';
        const diagnostics =
          compiled.kind === 'compileError' ? normalizeCompilerDiagnostics(compiled.stderr, program) : [];
        results.push({
          ...example,
          ...compiled,
          outcome,
          observations: diagnostics.map((diagnostic) => ({
            diagnostic,
            classification: diagnostic.originalMessage
              ? diagnostic.originalMessage === 'cannot find symbol'
                ? 'neutral'
                : 'translated'
              : diagnostic.message === genericCompilerMessage
                ? 'unsupported'
                : 'neutral',
          })),
        });
      } catch (error) {
        results.push({
          ...example,
          outcome: 'toolError',
          stdout: '',
          stderr: '',
          failure: String(error),
          observations: [],
        });
      }
    }
  const observations = results.flatMap((result) => result.observations);
  const report = reportSchema.parse({
    compiler,
    counts: {
      selected: selected.length,
      attempted: results.length,
      completed: results.filter((result) => result.outcome !== 'toolError').length,
      expectedFailures: results.filter((result) => result.outcome === 'expectedCompileError').length,
      unexpectedSuccesses: results.filter((result) => result.outcome === 'unexpectedSuccess').length,
      unexpectedCompileErrors: results.filter((result) => result.outcome === 'unexpectedCompileError').length,
      toolFailures: results.filter((result) => result.outcome === 'toolError').length + (compiler.failure ? 1 : 0),
      translated: observations.filter((item) => item.classification === 'translated').length,
      neutral: observations.filter((item) => item.classification === 'neutral').length,
      unsupported: observations.filter((item) => item.classification === 'unsupported').length,
    },
    results,
  });
  await mkdir('.tmp/javaDiagnostics', { recursive: true });
  await writeFile('.tmp/javaDiagnostics/report.json', `${JSON.stringify(report, undefined, 2)}\n`);
  console.log(JSON.stringify(report.counts));
  console.log('Report: .tmp/javaDiagnostics/report.json');
  if (report.counts.toolFailures || report.counts.unexpectedSuccesses || report.counts.unexpectedCompileErrors)
    process.exitCode = 1;
}

try {
  await collect();
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
