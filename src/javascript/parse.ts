import type { Node } from '@willbooster/web-tree-sitter';

import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from './ast';
import { ProgramConverter } from './parseProgram';

// The Script goal matches how learners' files run: no `import`, and `await` is an ordinary name.
const parser = await loadParser('@willbooster/tree-sitter-javascript/tree-sitter-javascript_script.wasm');

/**
 * Parses a script, throwing a `CompileError` for invalid or unsupported syntax.
 *
 * @param stepIdByRow The `// step` rows of a model program, which every statement on them records.
 */
export function parseJavaScript(source: string, stepIdByRow: ReadonlyMap<number, number> = new Map()): Program {
  return parseSource(parser, source, { identifier: '名前' }, (root) =>
    new ProgramConverter(source, stepIdByRow).convert(root)
  );
}

/** The `// step` and `// caller` annotations of a script, read from its comment tokens. */
export function findJavaScriptTraceAnnotations(source: string): TraceAnnotation[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The JavaScript parser returned no tree');
  try {
    const comments: TraceAnnotation[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'comment' && node.text.startsWith('//')) {
        comments.push({ index: node.startIndex, text: node.text });
      }
      for (const child of node.children) if (child) visit(child);
    };
    visit(tree.rootNode);
    return traceAnnotationsIn(comments);
  } finally {
    tree.delete();
  }
}
