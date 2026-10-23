import { expect, test } from 'vitest';
import { z } from 'zod';

import { extractBlanks, fillBlanks } from '../../src/problems/fillInBlank/blanks';
import { javaChallengeDefinitions } from '../../src/problems/javaChallenges/definitions';
import { instantiateJavaChallenge } from '../../src/problems/javaChallenges/instantiate';
import {
  courseIdToLectureIndexToExerciseProblemIds,
  courseIdToLectureIndexToProblemIds,
  problemIdToLanguageIdToProgram,
} from '../../src/problems/problemData';

const courses = ['tuBeginner1', 'tuBeginner2'] as const;
const deferred = new Set([
  'garbageCollection1',
  'garbageCollection2',
  'garbageCollection3',
  'garbageCollection4',
  'garbageCollection5',
  'garbageCollection6',
  'constructor4',
  'withEncapsulation3',
  'withEncapsulation6',
  'twoDimensionalArray5',
  'exception2',
  'exception5',
  'package1',
  'package2',
  'package3',
]);
const provenanceSchema = z
  .object({
    sourceProblemId: z.string().trim().min(1).optional(),
    authoringSeed: z.string().trim().min(1).optional(),
  })
  .refine((value) => Boolean(value.sourceProblemId) === Boolean(value.authoringSeed), 'Source and seed must be paired');
const sources = courses.flatMap((courseId) =>
  courseIdToLectureIndexToProblemIds[courseId].flatMap((ids, lectureIndex) =>
    ids
      .filter((id) => {
        const program = problemIdToLanguageIdToProgram[id]?.java;
        return program && extractBlanks(program).answers.length === 0;
      })
      .map((sourceProblemId) => ({ courseId, lectureIndex, sourceProblemId }))
  )
);
const supported = sources.filter((source) => !deferred.has(source.sourceProblemId));
const entries = Object.entries(javaChallengeDefinitions).map(([id, definition]) => ({
  id,
  definition,
  ...provenanceSchema.parse(definition),
}));

test('the curriculum inventory accounts explicitly for supported and deferred ordinary sources', () => {
  expect(sources).toHaveLength(168);
  expect(supported).toHaveLength(153);
  expect(
    new Set(sources.filter((source) => deferred.has(source.sourceProblemId)).map((source) => source.sourceProblemId))
  ).toEqual(deferred);
});

test.each(supported)('$sourceProblemId retains two distinct historical source-derived blanks', (source) => {
  const membership = courseIdToLectureIndexToExerciseProblemIds[source.courseId][source.lectureIndex];
  const variants = entries.filter(
    (entry) => entry.sourceProblemId === source.sourceProblemId && entry.definition.problemFormat === 'fillInBlank'
  );
  expect(variants.length, `${source.sourceProblemId}: no source-attributable blank coverage`).toBeGreaterThanOrEqual(2);
  const visible = new Set<string>();
  for (const { id, definition, authoringSeed } of variants) {
    expect(membership, id).not.toContain(id);
    expect(definition.courseId, id).toBe(source.courseId);
    expect(definition.lectureIndex, id).toBe(source.lectureIndex);
    expect(authoringSeed, id).toEqual(expect.any(String));
    const parsed = extractBlanks(definition.starterProgram);
    expect(parsed.answers.length, id).toBeGreaterThan(0);
    expect(
      parsed.answers.every((answer) => answer.trim().length > 0),
      id
    ).toBe(true);
    expect(fillBlanks(definition.starterProgram, parsed.answers).trim(), id).toBe(definition.correctProgram.trim());
    const rendered = instantiateJavaChallenge(id, 'fillInBlank');
    expect(rendered.displayProgram, id).toBe(parsed.programWithPlaceholders);
    expect(rendered.finalBoard, id).toBe(definition.finalBoard);
    expect(rendered.finalTurtles, id).toEqual(definition.finalTurtles);
    expect(rendered.displayProgram, id).not.toMatch(/@\[|<(\d+)-(\d+)>/);
    visible.add(rendered.displayProgram.replaceAll(/\s+/g, ' ').trim());
  }
  expect(visible.size, `${source.sourceProblemId}: duplicate visible placements`).toBe(variants.length);
});

test('every attributed definition points to its actual supported ordinary source and lecture', () => {
  const attributed = entries.filter((entry) => entry.sourceProblemId !== undefined);
  expect(attributed.length, 'No attributed source definitions').toBeGreaterThan(0);
  for (const { id, definition, sourceProblemId, authoringSeed } of attributed) {
    expect(supported, id).toContainEqual({
      sourceProblemId,
      courseId: definition.courseId,
      lectureIndex: definition.lectureIndex,
    });
    expect(authoringSeed, id).toEqual(expect.any(String));
    expect(courseIdToLectureIndexToExerciseProblemIds[definition.courseId][definition.lectureIndex], id).not.toContain(
      id
    );
  }
});

test.each(supported)(
  '$sourceProblemId retains two distinct historical source-derived bugs sharing its accepted blank model',
  (source) => {
    const membership = courseIdToLectureIndexToExerciseProblemIds[source.courseId][source.lectureIndex];
    const sourceEntries = entries.filter((entry) => entry.sourceProblemId === source.sourceProblemId);
    const blanks = sourceEntries.filter((entry) => entry.definition.problemFormat === 'fillInBlank');
    const bugs = sourceEntries.filter((entry) => entry.definition.problemFormat === 'bugFix');
    expect(bugs.length, `${source.sourceProblemId}: no source-attributable bug coverage`).toBeGreaterThanOrEqual(2);
    expect(blanks.length, `${source.sourceProblemId}: accepted blank model missing`).toBeGreaterThanOrEqual(2);
    const modelOf = (entry: (typeof entries)[number]): unknown => ({
      sourceProblemId: entry.sourceProblemId,
      authoringSeed: entry.authoringSeed,
      correctProgram: entry.definition.correctProgram,
      finalBoard: entry.definition.finalBoard,
      finalTurtles: entry.definition.finalTurtles,
    });
    const acceptedModel = modelOf(blanks[0]);
    for (const entry of blanks)
      expect(modelOf(entry), `${entry.id}: inconsistent accepted blank models`).toEqual(acceptedModel);
    const visible = new Set<string>();
    for (const entry of bugs) {
      const { id, definition } = entry;
      expect(membership, id).not.toContain(id);
      expect(definition.courseId, id).toBe(source.courseId);
      expect(definition.lectureIndex, id).toBe(source.lectureIndex);
      expect(modelOf(entry), `${id}: bug changed accepted source model`).toEqual(acceptedModel);
      expect(['logical', 'syntax'], `${id}: defect classification`).toContain(definition.bugKind);
      const rendered = instantiateJavaChallenge(id, 'bugFix');
      expect(rendered, id).toEqual({
        displayProgram: definition.starterProgram,
        finalBoard: definition.finalBoard,
        finalTurtles: definition.finalTurtles,
      });
      expect(rendered.displayProgram, id).not.toMatch(/@\[|【\d+】|<(\d+)-(\d+)>/);
      const normalized = rendered.displayProgram.replaceAll(/\s+/g, ' ').trim();
      expect(normalized, `${id}: unchanged repair`).not.toBe(definition.correctProgram.replaceAll(/\s+/g, ' ').trim());
      visible.add(normalized);
    }
    expect(visible.size, `${source.sourceProblemId}: duplicate visible bugs`).toBe(bugs.length);
  }
);
