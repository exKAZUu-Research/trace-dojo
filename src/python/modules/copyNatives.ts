import { callValue, getAttribute, getItem, setItem } from '../objects';
import type { Runtime } from '../runtime';
import { classOf, nativeFunction, newDict, newList, newTuple, None } from '../types';
import { type Kwargs, PyDict, PyError, PyList, PySet, PyTuple, type PyValue } from '../values';
import { bindArguments, type PythonSignature } from './numberSupport';

const COPY: PythonSignature = { qualified: 'copy', params: ['x'], required: 1, isFunction: true };
const DEEPCOPY: PythonSignature = {
  qualified: 'deepcopy',
  params: ['x', 'memo', '_nil'],
  required: 1,
  isFunction: true,
};

/**
 * `copy.copy` and `copy.deepcopy`, which follow CPython's code: they copy the builtin containers themselves, as fast as
 * CPython does, and run the module's Python code for every other object, with the same memo dict.
 */
export function copyNatives(runtime: Runtime): Map<string, PyValue> {
  const globals = (): Map<string, PyValue> => runtime.modules.get('copy')?.dict ?? new Map();
  const global = (name: string): PyValue => globals().get(name) as PyValue;
  return new Map<string, PyValue>([
    [
      '_native_copy',
      nativeFunction('copy', (args, kwargs) => {
        const [x] = bindArguments(COPY, args, kwargs) as [PyValue];
        const cls = classOf(x);
        if (contains(global('_copy_atomic_types'), cls)) return x;
        if (contains(global('_copy_builtin_containers'), cls)) return callValue(getAttribute(cls, 'copy'), [x]);
        return callValue(global('_copy_python'), [x]);
      }),
    ],
    [
      '_native_deepcopy',
      nativeFunction('deepcopy', (args: PyValue[], kwargs: Kwargs) => {
        const [x, memo] = bindArguments(DEEPCOPY, args, kwargs);
        return deepcopy(runtime, global, x as PyValue, memo === undefined || memo === None ? undefined : memo);
      }),
    ],
  ]);
}

function contains(set: PyValue, value: PyValue): boolean {
  return set instanceof PySet && set.table.has(value);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows CPython's copy.deepcopy, one case per builtin container.
function deepcopy(
  runtime: Runtime,
  global: (name: string) => PyValue,
  x: PyValue,
  given: PyValue | undefined
): PyValue {
  const cls = classOf(x);
  if (contains(global('_atomic_types'), cls)) return x;
  const id = runtime.idOf(x);
  const memo = given ?? newDict();
  if (given !== undefined) {
    const known = memoGet(memo, id);
    if (known !== undefined) return known;
  }
  runtime.spend();
  const copier = dictGet(global('_deepcopy_dispatch'), cls);
  const copy = (item: PyValue): PyValue => deepcopy(runtime, global, item, memo);
  let y: PyValue;
  if (copier === global('_deepcopy_list') && x instanceof PyList) {
    const list = newList([]);
    setItem(memo, id, list);
    for (let index = 0; index < x.items.length; index++) list.items.push(copy(x.items[index]));
    y = list;
  } else if (copier === global('_deepcopy_tuple') && x instanceof PyTuple) {
    const items = x.items.map(copy);
    // The tuple is not in the memo, but a recursive structure inside it may have put it there.
    const recursive = memoGet(memo, id);
    if (recursive !== undefined) return recursive;
    y = items.every((item, index) => item === x.items[index]) ? x : newTuple(items);
  } else if (copier === global('_deepcopy_dict') && x instanceof PyDict) {
    const dict = newDict();
    setItem(memo, id, dict);
    for (const entry of x.store.ordered()) setItem(dict, copy(entry.key), copy(entry.value));
    y = dict;
  } else {
    y = callValue(copier ?? global('_deepcopy_other'), copier === undefined ? [x, memo, cls] : [x, memo]);
  }
  // As in CPython, an object that is its own copy is not memoized.
  if (y !== x) {
    setItem(memo, id, y);
    keepAlive(runtime, x, memo);
  }
  return y;
}

function memoGet(memo: PyValue, id: bigint): PyValue | undefined {
  if (memo instanceof PyDict && memo.cls.isBuiltin) return memo.store.get(id);
  const missing = newList([]);
  const value = callValue(getAttribute(memo, 'get'), [id, missing]);
  return value === missing ? undefined : value;
}

function dictGet(dict: PyValue, key: PyValue): PyValue | undefined {
  return dict instanceof PyDict ? dict.store.get(key) : undefined;
}

/** `_keep_alive`: keeps the original in a list at the memo's own id, as CPython does. */
function keepAlive(runtime: Runtime, x: PyValue, memo: PyValue): void {
  const key = runtime.idOf(memo);
  let kept: PyValue;
  try {
    kept = getItem(memo, key);
  } catch (error) {
    if (!(error instanceof PyError) || error.exception.cls.name !== 'KeyError') throw error;
    setItem(memo, key, newList([x]));
    return;
  }
  callValue(getAttribute(kept, 'append'), [x]);
}
