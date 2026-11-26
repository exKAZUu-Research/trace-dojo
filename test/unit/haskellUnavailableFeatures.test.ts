import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { GENERIC_NODES, UNSUPPORTED_NODES } from '../../src/haskell/convert';
import { KNOWN_EXTENSIONS, SYNONYMS, UNGATED_EXTENSIONS, UNSUPPORTED_EXTENSIONS } from '../../src/haskell/extensions';
import { FEATURES } from '../../src/haskell/features';

interface NodeType {
  type: string;
  named: boolean;
  subtypes?: { type: string }[];
  fields?: Record<string, { types: { type: string }[] }>;
}

const require = createRequire(import.meta.url);
const grammarDir = path.dirname(require.resolve('@willbooster/tree-sitter-haskell/package.json'));
const nodeTypes = JSON.parse(fs.readFileSync(path.join(grammarDir, 'src/node-types.json'), 'utf8')) as NodeType[];
const frontEnd = ['convert.ts', 'dialect.ts', 'parse.ts', 'thSplice.ts', 'thQuote.ts']
  .map((file) => fs.readFileSync(path.join(import.meta.dirname, '../../src/haskell', file), 'utf8'))
  .join('\n');
const named = (word: string): boolean => frontEnd.includes(`'${word}'`);
/**
 * Whether the converter dispatches on a node type: a `case` label, a comparison with a node's type, or a member of a
 * list or set it tests a node's type against. A quoted name elsewhere (a message, a field) does not count.
 */
const dispatched = (type: string): boolean => {
  const quoted = `'${type}'`.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(case |[!=]== |\[|, |\(|Set\(\[)${quoted}`).test(frontEnd);
};

test('every node type of the grammar is converted, reached through a field, or listed as unsupported', () => {
  const supertypes = new Set(nodeTypes.filter((node) => node.subtypes).map((node) => node.type));
  const subtypes = new Set(nodeTypes.flatMap((node) => (node.subtypes ?? []).map((subtype) => subtype.type)));
  // A field the converter reads by name reaches the node types it holds, which the converter then reads by field.
  const reached = new Set(
    nodeTypes.flatMap((node) =>
      Object.entries(node.fields ?? {}).flatMap(([name, field]) => (named(name) ? field.types.map((t) => t.type) : []))
    )
  );
  const unaccounted = nodeTypes
    .filter((node) => node.named && !supertypes.has(node.type))
    .map((node) => node.type)
    .filter(
      (type) =>
        !dispatched(type) &&
        !Object.hasOwn(UNSUPPORTED_NODES, type) &&
        !Object.hasOwn(GENERIC_NODES, type) &&
        // A subtype of a supertype is dispatched by its type, so being reached is not enough for it.
        !(reached.has(type) && !subtypes.has(type))
    );
  expect(unaccounted).toEqual([]);
});

test('every extension GHC knows has a feature, is accepted without one, or is listed as unsupported', () => {
  const gated = new Set(
    Object.values(FEATURES).flatMap((gate) => [
      ...('any' in gate ? gate.any : []),
      ...('all' in gate ? (gate as { all: readonly string[] }).all : []),
    ])
  );
  const unaccounted = [...KNOWN_EXTENSIONS]
    .filter((name) => !Object.hasOwn(SYNONYMS, name))
    .filter(
      (name) => !gated.has(name) && !UNGATED_EXTENSIONS.has(name) && !Object.hasOwn(UNSUPPORTED_EXTENSIONS, name)
    );
  expect(unaccounted).toEqual([]);
  for (const name of gated) expect(KNOWN_EXTENSIONS.has(name), name).toBe(true);
  for (const name of UNGATED_EXTENSIONS) {
    expect(gated.has(name) || Object.hasOwn(UNSUPPORTED_EXTENSIONS, name), name).toBe(false);
  }
});

test('CPU and OS dependent code, CPP outside its subset, and MagicHash values are reported as unavailable', async () => {
  const { executeProgram } = await import('../../src/interpreter/program');
  for (const source of [
    '{-# LANGUAGE CPP #-}\n#ifdef linux_HOST_OS\nx = 1\n#endif\nmain :: IO ()\nmain = print 0\n',
    '{-# LANGUAGE CPP #-}\n#define F(x) x\nmain :: IO ()\nmain = print 0\n',
    '{-# LANGUAGE CPP #-}\n#if __GLASGOW_HASKELL__ + 1 > 900\nx = 1\n#endif\nmain :: IO ()\nmain = print 0\n',
    '{-# LANGUAGE MagicHash #-}\nimport GHC.Exts\nmain :: IO ()\nmain = print (I# 3#)\n',
  ]) {
    const result = executeProgram('haskell', source);
    expect(result.kind).toBe('compileError');
    expect(JSON.stringify(result)).toContain('この採点環境では使えません');
  }
});
