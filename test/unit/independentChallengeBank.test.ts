import { expect, test } from 'vitest';

import { challengeBases } from '../../src/problems/catalog/java/definitions';
import { stripJavaTraceAnnotations } from '../../src/problems/fillInBlank/javaSource';
import { courseIdToLectureIndexToProblemIds } from '../../src/problems/problemData';
import { instantiateRegularChallenge } from '../../src/problems/regular/instantiateChallenge';

test('all independent regular challenges render bounded traces', () => {
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
    expect(problem.uncaughtException, base.id).toBeUndefined();
    expect(problem.traceItems.length - 1, base.id).toBeGreaterThan(0);
    expect(problem.traceItems.length - 1, base.id).toBeLessThanOrEqual(30);
    expect(courseIdToLectureIndexToProblemIds[base.courseId].flat(), base.id).not.toContain(base.id);
  }
});

test('display cleanup preserves Java literals and ordinary comments including marker-like textblock lines', () => {
  const source = String.raw`class Main {
  String quoted = "escaped \" // atomic";
  String text = """
// atomic
""";
  /* // atomic */
  void run() { // atomic
  }
  void note() { // remark stays // atomic
  }
  int x = 1; // atomic explanation stays
}`.replaceAll('\n', '\r\n');
  const expected = String.raw`class Main {
  String quoted = "escaped \" // atomic";
  String text = """
// atomic
""";
  /* // atomic */
  void run() {
  }
  void note() { // remark stays
  }
  int x = 1; // atomic explanation stays
}`.replaceAll('\n', '\r\n');
  expect(stripJavaTraceAnnotations(source)).toBe(expected);
});
