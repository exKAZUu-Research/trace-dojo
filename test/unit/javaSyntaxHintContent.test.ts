import { refractor } from 'refractor/all';
import { expect, test } from 'vitest';

import { getJavaSyntaxHint } from '../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/javaSyntaxHintContent';
import { challengeBases } from '../../src/problems/catalog/java/definitions';

test('explains every keyword and operator in normal-format challenges', () => {
  expect(challengeBases.length).toBeGreaterThan(0);
  const unexplained = new Set<string>();
  for (const { java } of challengeBases) {
    collectUnexplainedTokens(refractor.highlight(java, 'java'), [], unexplained);
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
