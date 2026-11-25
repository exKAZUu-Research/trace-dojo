import { Boxed, indexedItems, type KObject, NULL, type Value } from '../values';
import { defineTraceShape, fieldValue, type TraceShape } from './registry';

/*
 * How the prelude's TreeMap and TreeSet, and the views a TreeMap gives, show in traces: as the Java interpreter shows
 * java.util.TreeMap and TreeSet, a map keyed by its keys and arrays of elements, not as the fields that implement them.
 */

/** A key of natural order as a JavaScript value it compares as, or undefined for keys only Kotlin code compares. */
function naturalKey(key: Value): number | bigint | string | undefined {
  const raw = key instanceof Boxed ? key.value : key;
  return typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'string' ? raw : undefined;
}

/** Whether a key is within a view's bound, compared in natural order: undefined when only Kotlin code can tell. */
function withinBound(key: Value, bound: Value, isLow: boolean): boolean | undefined {
  if (bound === NULL) return true;
  const value = naturalKey(key);
  const limit = naturalKey(fieldValue(bound as KObject, 'key'));
  if (value === undefined || limit === undefined || typeof value !== typeof limit) return undefined;
  if (value === limit) return fieldValue(bound as KObject, 'inclusive') as boolean;
  return isLow ? value > limit : value < limit;
}

/**
 * The entries of a TreeMap or of a view of it, in its order, or undefined when telling the view's entries needs its
 * comparator, which only Kotlin code runs, so that the view shows as its fields instead.
 */
function nodesOf(map: Value): KObject[] | undefined {
  const store = fieldValue(map as KObject, 'store') as KObject;
  const nodes = (indexedItems(fieldValue(store, 'nodes') as KObject) ?? []) as KObject[];
  const low = fieldValue(map as KObject, 'low');
  const high = fieldValue(map as KObject, 'high');
  if (low === NULL && high === NULL) return nodes;
  if (fieldValue(map as KObject, 'order') !== NULL) return undefined;
  const inView = nodes.map((node) => {
    const key = fieldValue(node, 'key');
    const aboveLow = withinBound(key, low, true);
    const belowHigh = withinBound(key, high, false);
    return aboveLow === undefined || belowHigh === undefined ? undefined : aboveLow && belowHigh;
  });
  if (inView.includes(undefined)) return undefined;
  return nodes.filter((_node, index) => inView[index]);
}

function arrayOf(items: Value[] | undefined): TraceShape | undefined {
  return items && { kind: 'array', items };
}

defineTraceShape('java.util.TreeMap', (map) => {
  const nodes = nodesOf(map);
  return (
    nodes && {
      kind: 'map',
      entries: nodes.map((node) => ({ key: fieldValue(node, 'key'), value: fieldValue(node, 'value') })),
    }
  );
});
defineTraceShape('java.util.TreeSet', (set) => {
  const keys = nodesOf(fieldValue(set, 'map'))?.map((node) => fieldValue(node, 'key'));
  return arrayOf(keys && (fieldValue(set, 'isDescending') === true ? keys.toReversed() : keys));
});
defineTraceShape('java.util.TreeMapKeys', (keys) =>
  arrayOf(nodesOf(fieldValue(keys, 'map'))?.map((node) => fieldValue(node, 'key')))
);
defineTraceShape('java.util.TreeMapValues', (values) =>
  arrayOf(nodesOf(fieldValue(values, 'map'))?.map((node) => fieldValue(node, 'value')))
);
defineTraceShape('java.util.TreeMapEntries', (entries) => arrayOf(nodesOf(fieldValue(entries, 'map'))));
// An entry shows as the pair the Java interpreter shows a Map.Entry as.
defineTraceShape('java.util.TreeMapEntry', (entry) => ({
  kind: 'array',
  items: [fieldValue(entry, 'key'), fieldValue(entry, 'value')],
}));
