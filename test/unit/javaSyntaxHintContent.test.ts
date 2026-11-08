import { refractor } from 'refractor/all';
import { expect, test } from 'vitest';

import { getJavaSyntaxHint } from '../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/javaSyntaxHintContent';
import { challengeBases } from '../../src/problems/catalog/java/definitions';
import { practiceDefinitions } from '../../src/problems/practice/definitions';

test('explains every keyword and operator in normal-format challenges and practice', () => {
  expect(challengeBases.length).toBeGreaterThan(0);
  const unexplained = new Set<string>();
  for (const program of [...challengeBases.map(({ java }) => java), ...practiceDefinitions.map((d) => d.program)]) {
    collectUnexplainedTokens(refractor.highlight(program, 'java'), [], unexplained);
  }
  expect([...unexplained]).toEqual([]);
});

type Root = ReturnType<typeof refractor.highlight>;
type Node = Root | Root['children'][number];
type Element = Extract<Node, { type: 'element' }>;

const collectUnexplainedTokens = (node: Node, classes: string[], unexplained: Set<string>): void => {
  if (node.type === 'text') {
    const text = node.value.trim();
    if (
      text &&
      classes.some((name) => name === 'keyword' || name === 'operator') &&
      !getJavaSyntaxHint(text, classes)
    ) {
      unexplained.add(text);
    }
    return;
  }
  if (node.type !== 'root' && node.type !== 'element') return;
  const nested = node.type === 'element' ? [...classes, ...elementClasses(node)] : classes;
  for (const child of node.children) collectUnexplainedTokens(child, nested, unexplained);
};

const elementClasses = (element: Element): string[] => {
  const { className } = element.properties;
  return Array.isArray(className) ? className.map(String) : [];
};
