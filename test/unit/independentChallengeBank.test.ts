import { expect, test } from 'vitest';
import { challengeBases } from '../../src/problems/challenge/definitions';
import { challengeMetadata } from '../../src/problems/challenge/metadata';
import { instantiateRegularChallenge } from '../../src/problems/challenge/regular';
import { challengeRegularPrograms } from '../../src/problems/challenge/regularPrograms';
import { courseIdToLectureIndexToProblemIds } from '../../src/problems/problemData';

test('all independent regular challenges render bounded traces with mapped displayed statements and calls', () => {
  expect(challengeBases).toHaveLength(160);
  for (const courseId of ['tuBeginner1', 'tuBeginner2'])
    for (let lectureIndex = 0; lectureIndex < 8; lectureIndex++)
      expect(
        challengeBases.filter((base) => base.courseId === courseId && base.lectureIndex === lectureIndex),
        `${courseId}/${lectureIndex}`
      ).toHaveLength(10);
  const seen = new Set<string>();
  for (const base of challengeBases) {
    expect(seen.has(base.id), base.id).toBe(false);
    seen.add(base.id);
    const problem = instantiateRegularChallenge(base.id);
    if (!problem) throw new Error(`Missing regular projection: ${base.id}`);
    expect(problem.traceItems.length - 1, base.id).toBeGreaterThan(0);
    expect(problem.traceItems.length - 1, base.id).toBeLessThanOrEqual(30);
    const lineCount = problem.displayProgram.split('\n').length;
    for (const line of [...problem.sidToLineIndex.values(), ...problem.callerIdToLineIndex.values()]) {
      expect(line, base.id).toBeGreaterThanOrEqual(1);
      expect(line, base.id).toBeLessThanOrEqual(lineCount);
    }
    for (const item of problem.traceItems.slice(1)) {
      expect(problem.sidToLineIndex.has(item.sid), `${base.id}: statement ${item.sid}`).toBe(true);
      for (const caller of item.callStack)
        expect(problem.callerIdToLineIndex.has(caller), `${base.id}: caller ${caller}`).toBe(true);
    }
    expect(courseIdToLectureIndexToProblemIds[base.courseId].flat(), base.id).not.toContain(base.id);
  }
});

test('generated browser projections remain current and contain only regular source or public metadata', () => {
  expect(Object.keys(challengeRegularPrograms).toSorted()).toEqual(challengeBases.map(({ id }) => id).toSorted());
  for (const base of challengeBases) {
    expect(challengeRegularPrograms[base.id]).toEqual({ java: base.java, instrumented: base.instrumented });
    for (const [id, item] of Object.entries(challengeMetadata).filter(
      ([id]) => id === base.id || id.startsWith(`${base.id}Blank`) || id.startsWith(`${base.id}Bug`)
    )) {
      expect(Object.keys(item).toSorted(), id).toEqual(['courseId', 'lectureIndex', 'problemFormat', 'title']);
      expect(item).toMatchObject({ title: base.title, courseId: base.courseId, lectureIndex: base.lectureIndex });
    }
    expect(
      Object.keys(challengeMetadata).filter(
        (id) => id === base.id || id.startsWith(`${base.id}Blank`) || id.startsWith(`${base.id}Bug`)
      )
    ).toHaveLength(1 + base.blanks.length + base.bugs.length);
  }
});
