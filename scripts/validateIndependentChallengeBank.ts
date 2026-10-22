import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { challengeBaseSchema } from '../src/problems/challenge/schema';
import type { ChallengeBase } from '../src/problems/challenge/types';
import { applyChallengeEdit } from '../src/problems/challenge/edits';
import { traceProgram } from '../src/problems/traceProgram';
import type { JavaExecutionResult } from '../src/problems/fillInBlank/javaExecutors';
import { extractBlanks, fillBlanks } from '../src/problems/fillInBlank/blanks';
import {
  buildJavaJudgeProgram,
  JAVA_JUDGE_CLASS_NAME,
  parseJavaJudgeOutput,
} from '../src/problems/fillInBlank/javaProgram';
import { localJavaExecutor } from '../test/helpers/localJavaExecutor';

const marker = '__TRACE_DOJO_RESULT_independent__';
const results: {
  id: string;
  sha256?: string;
  sourceFile?: string;
  title?: string;
  courseId?: string;
  lectureIndex?: number;
  steps?: number;
  blanks?: number;
  bugs?: number;
  target?: unknown;
  status: string;
  detail?: string;
}[] = [];
const output = resolve(process.argv[2] ?? '.tmp/independent-bank-validation.json');
const validationArguments = process.argv.slice(3);
const paths = validationArguments.filter((argument) => !argument.startsWith('--id='));
const requestedIds = new Set(
  validationArguments.filter((argument) => argument.startsWith('--id=')).map((argument) => argument.slice(5))
);
let challengeBases: ChallengeBase[];
if (paths.length > 0) {
  challengeBases = [];
  for (const path of paths) {
    const module = await import(resolve(path));
    challengeBases.push(...z.array(challengeBaseSchema).parse(Object.values(module).flat()));
  }
} else {
  const module = await import('../src/problems/challenge/definitions');
  challengeBases = module.challengeBases;
}
if (requestedIds.size > 0) {
  challengeBases = challengeBases.filter((base) => requestedIds.has(base.id));
  if (challengeBases.length !== requestedIds.size) throw new Error('Unknown requested challenge ID');
}
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(
  `${output}.sources.json`,
  JSON.stringify(
    challengeBases.map((base) => ({
      id: base.id,
      sha256: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
      base,
    })),
    undefined,
    2
  )
);
const execute = async (source: string): Promise<JavaExecutionResult> =>
  await localJavaExecutor.execute(buildJavaJudgeProgram(source, marker).program, JAVA_JUDGE_CLASS_NAME);
const record = async (): Promise<void> => {
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(results, undefined, 2));
};

for (const base of challengeBases) {
  try {
    const regular = traceProgram(base.instrumented, base.java, 'java');
    const steps = regular.traceItems.length - 1;
    if (steps < 1 || steps > 30) throw new Error(`Invalid answer count: ${steps}`);
    const lineCount = regular.displayProgram.split('\n').length;
    for (const line of [...regular.sidToLineIndex.values(), ...regular.callerIdToLineIndex.values()])
      if (line < 1 || line > lineCount) throw new Error(`Mapped line out of bounds: ${line}`);
    for (const item of regular.traceItems.slice(1)) {
      if (!regular.sidToLineIndex.has(item.sid)) throw new Error(`Unmapped statement: ${item.sid}`);
      for (const caller of item.callStack)
        if (!regular.callerIdToLineIndex.has(caller)) throw new Error(`Unmapped caller: ${caller}`);
    }
    const execution = await execute(base.java);
    if (execution.kind !== 'executed') throw new Error(JSON.stringify(execution));
    const state = parseJavaJudgeOutput(execution.stderr, marker);
    if (
      state?.exception ||
      !state ||
      JSON.stringify(state.board) !== JSON.stringify(regular.finalBoard) ||
      JSON.stringify(state.turtles) !== JSON.stringify(regular.finalTurtles)
    )
      throw new Error(
        `Java/trace mismatch: ${JSON.stringify({ state, board: regular.finalBoard, turtles: regular.finalTurtles })}`
      );
    results.push({
      id: base.id,
      sha256: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
      sourceFile: `src/problems/challenge/${base.courseId}/lecture${base.lectureIndex + 1}.ts`,
      title: base.title,
      courseId: base.courseId,
      lectureIndex: base.lectureIndex,
      steps,
      blanks: base.blanks.length,
      bugs: base.bugs.length,
      target: state,
      status: 'passed',
    });
    for (const variant of [
      ...base.blanks.map((edit) => ({
        id: `${base.id}Blank${edit.id}`,
        problemFormat: 'fillInBlank',
        starterProgram: applyChallengeEdit(base.java, edit),
        bugKind: undefined,
      })),
      ...base.bugs.map((edit) => ({
        id: `${base.id}Bug${edit.id}`,
        problemFormat: 'bugFix',
        starterProgram: applyChallengeEdit(base.java, edit),
        bugKind: edit.kind,
      })),
    ]) {
      const { id } = variant;
      try {
        if (variant.problemFormat === 'fillInBlank') {
          const extracted = extractBlanks(variant.starterProgram);
          if (fillBlanks(variant.starterProgram, extracted.answers).trim() !== base.java.trim())
            throw new Error(`Blank reconstruction: ${id}`);
        } else {
          const bug = await execute(variant.starterProgram);
          if (variant.bugKind === 'syntax') {
            if (bug.kind !== 'compileError' || !bug.message.trim())
              throw new Error(`Missing compile diagnostics: ${id} ${JSON.stringify(bug)}`);
          } else {
            if (bug.kind !== 'executed') throw new Error(`Logical bug did not run: ${id} ${JSON.stringify(bug)}`);
            const actual = parseJavaJudgeOutput(bug.stderr, marker);
            if (!actual || actual.exception || JSON.stringify(actual) === JSON.stringify(state))
              throw new Error(`Logical bug is abnormal or unchanged: ${id} ${JSON.stringify(actual)}`);
          }
        }
        results.push({ id, status: 'passed' });
      } catch (error) {
        results.push({ id, status: 'failed', detail: String(error) });
      }
      await record();
    }
  } catch (error) {
    results.push({ id: base.id, status: 'failed', detail: String(error) });
  }
  await record();
}
const failures = results.filter((item) => item.status === 'failed');
z.array(z.object({ id: z.string(), status: z.string() })).parse(results);
console.log(
  `${challengeBases.length} bases; ${results.length} results; ${failures.length} failures. Report: ${output}`
);
process.exitCode = failures.length > 0 ? 1 : 0;
