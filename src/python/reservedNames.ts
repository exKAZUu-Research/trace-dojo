import type { Node } from '@willbooster/web-tree-sitter';

import { rowOf } from './convertNodes';
import { fail } from './scopes';

/** The keywords the grammar still reads as names where they stand alone, which CPython reserves everywhere. */
const RESERVED_NAMES = new Set(['async', 'await']);

/** Refuses the first name anywhere in a module that is a keyword CPython reserves. */
export function refuseReservedNames(root: Node): void {
  const cursor = root.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (node.isNamed && node.type === 'identifier' && RESERVED_NAMES.has(node.text)) {
        fail(rowOf(node), `${node.text} はキーワードなので、名前には使えません。`);
      }
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}
