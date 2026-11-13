import { LIBRARY_ROW, type Module } from './ast';
import { Frame } from './frame';
import { parsePython } from './parse';
import { currentRuntime } from './runtimeContext';
import type { PyValue } from './values';

const parsedSources = new Map<string, Module>();

/**
 * Runs Python source that implements part of a standard library module, as CPython's pure-Python modules do, and
 * returns the namespace it fills, which starts from `globals`.
 *
 * Its code records no steps and its rows are `LIBRARY_ROW`, so that the trace shows the calls it makes back into the
 * program as made from the program's own line.
 */
export function runLibrarySource(
  moduleName: string,
  source: string,
  globals: Map<string, PyValue> = new Map()
): Map<string, PyValue> {
  let module = parsedSources.get(source);
  if (!module) {
    module = parsePython(source);
    markLibraryRows(module);
    parsedSources.set(source, module);
  }
  const runtime = currentRuntime();
  globals.set('__name__', moduleName);
  const frame = new Frame('module', globals, new Map(), globals, undefined, false, module.scope);
  runtime.pushFrame(frame);
  try {
    runtime.evaluator.runModule(module.body, frame);
  } finally {
    runtime.popFrame();
  }
  return globals;
}

/** Sets the row of every construct of a parsed module to `LIBRARY_ROW`. */
function markLibraryRows(node: unknown, visited = new WeakSet<object>()): void {
  if (typeof node !== 'object' || node === null || visited.has(node)) return;
  visited.add(node);
  if (Array.isArray(node)) {
    for (const item of node) markLibraryRows(item, visited);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.row === 'number') record.row = LIBRARY_ROW;
  for (const value of Object.values(record)) markLibraryRows(value, visited);
}
