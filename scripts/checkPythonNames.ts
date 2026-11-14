// Looks up in this grader every name CPython has in the modules it implements and in some builtin and library values,
// and prints the names that raise AttributeError (or name another module than CPython's) instead of working or raising
// the unsupported error, or that fail otherwise, then the names left unsupported per module:
//   bun scripts/checkPythonNames.ts .tmp/pythonNames.json [--unsupported]
// The JSON comes from scripts/pythonData/generateModuleNames.py.
import { readFileSync } from 'node:fs';

import { getAttribute, isExceptionOf } from '../src/python/objects';
import { parsePython } from '../src/python/parse';
import { runModule } from '../src/python/run';
import { Runtime } from '../src/python/runtime';
import { UnsupportedFeatureError } from '../src/python/unsupported';
import { PyError, PyModule, PyObject, type PyValue } from '../src/python/values';

interface Reference {
  /** Each module's names, mapped to the name of the module the name holds or to ''. */
  modules: Record<string, Record<string, string>>;
  /** Each expression's `dir()`, with a leading '!' on the names whose reading raises AttributeError. */
  values: Record<string, string[]>;
}

type Status = 'ok' | 'unsupported' | 'missing' | 'wrongModule' | 'unexpected';

interface NameResult {
  owner: string;
  name: string;
  status: Status;
  detail: string;
}

const VALUE_MODULES =
  'array, collections, contextvars, datetime, decimal, enum, fractions, functools, io, ipaddress, itertools, ' +
  'operator, pathlib, queue, random, re, statistics, string, sys, threading, time, types, typing, uuid, weakref';

if (import.meta.main) {
  const reference = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Reference;
  const results = [...checkModules(reference.modules), ...checkValues(reference.values)];
  for (const result of results) {
    if (result.status !== 'ok' && result.status !== 'unsupported') {
      console.log(`${result.status}\t${result.owner}\t${result.name}\t${result.detail}`);
    }
  }
  if (process.argv.includes('--unsupported')) {
    for (const result of results) {
      if (result.status === 'unsupported')
        console.log(`unsupported\t${result.owner}\t${result.name}\t${result.detail}`);
    }
  }
  const counts = Object.groupBy(results, (result) => result.status);
  console.log(
    Object.entries(counts)
      .map(([status, list]) => `${status}: ${list?.length}`)
      .join(', ')
  );
}

/** Looks up each module's names in a run that imports only that module, as CPython's reference did. */
export function checkModules(modules: Record<string, Record<string, string>>): NameResult[] {
  return Object.entries(modules).flatMap(([module, names]) => {
    const results: NameResult[] = [];
    const run = runProgram(`import ${module}`, (runtime) => {
      const value = runtime.modules.get(module);
      if (!value) return;
      for (const [name, held] of Object.entries(names)) results.push(lookUp(module, value, name, held));
    });
    if (results.length === 0) results.push({ owner: module, name: '', status: 'missing', detail: `import: ${run}` });
    return results;
  });
}

/** Looks up each value's names, evaluating each value in a run of its own. */
export function checkValues(values: Record<string, string[]>): NameResult[] {
  return Object.entries(values).flatMap(([expression, names]) => {
    const results: NameResult[] = [];
    const run = runProgram(`import ${VALUE_MODULES}\nvalue = ${expression}`, (runtime, globals) => {
      const value = globals.get('value');
      if (value === undefined) return;
      for (const name of names) results.push(lookUpValueName(expression, value, name));
    });
    if (results.length === 0) results.push({ owner: expression, name: '', status: 'missing', detail: `run: ${run}` });
    return results;
  });
}

/** Looks up a name of a value, which must raise AttributeError when CPython's does, as for an unset slot. */
function lookUpValueName(expression: string, value: PyValue, name: string): NameResult {
  if (!name.startsWith('!')) return lookUp(expression, value, name, '');
  const result = lookUp(expression, value, name.slice(1), '');
  return { ...result, status: result.status === 'missing' ? 'ok' : 'unexpected' };
}

function runProgram(source: string, inspect: (runtime: Runtime, globals: Map<string, PyValue>) => void): string {
  const runtime = new Runtime();
  const run = runModule(runtime, parsePython(source), (frame) => inspect(runtime, frame.globals));
  return run.uncaughtException ?? 'ok';
}

function lookUp(owner: string, value: PyValue, name: string, heldModule: string): NameResult {
  try {
    const found = getAttribute(value, name);
    if (found instanceof PyObject && found.cls.name === 'unavailable') {
      return { owner, name, status: 'unsupported', detail: 'unavailable value' };
    }
    const expected = heldModule.replace(/^module:/, '');
    if (expected && !(found instanceof PyModule && found.name === expected)) {
      return { owner, name, status: 'wrongModule', detail: `expected module ${expected}` };
    }
    return { owner, name, status: 'ok', detail: '' };
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) return { owner, name, status: 'unsupported', detail: error.message };
    if (error instanceof PyError) {
      const status = isExceptionOf(error, 'AttributeError') ? 'missing' : 'unexpected';
      return { owner, name, status, detail: error.exception.cls.name };
    }
    return { owner, name, status: 'unexpected', detail: String(error) };
  }
}
