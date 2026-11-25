import type { KObject} from '../values';
import { indexedItems, type Value } from '../values';
import { defineTraceShape, fieldValue } from './registry';

/*
 * How the prelude's TreeMap and TreeSet, and the views a TreeMap gives, show in traces: as the Java interpreter shows
 * java.util.TreeMap and TreeSet, a map keyed by its keys and arrays of elements, not as the fields that implement them.
 */

/** The entries of a TreeMap, in its order, from the sorted list it keeps them in. */
function entriesOf(map: Value): { key: Value; value: Value }[] {
  const nodes = fieldValue(map as KObject, 'nodes') as KObject;
  return (indexedItems(nodes) ?? []).map((node) => ({
    key: fieldValue(node as KObject, 'key'),
    value: fieldValue(node as KObject, 'value'),
  }));
}

defineTraceShape('java.util.TreeMap', (map) => ({ kind: 'map', entries: entriesOf(map) }));
defineTraceShape('java.util.TreeSet', (set) => ({
  kind: 'array',
  items: entriesOf(fieldValue(set, 'map')).map((entry) => entry.key),
}));
defineTraceShape('java.util.TreeMapKeys', (keys) => ({
  kind: 'array',
  items: entriesOf(fieldValue(keys, 'map')).map((entry) => entry.key),
}));
defineTraceShape('java.util.TreeMapValues', (values) => ({
  kind: 'array',
  items: entriesOf(fieldValue(values, 'map')).map((entry) => entry.value),
}));
defineTraceShape('java.util.TreeMapEntries', (entries) => ({
  kind: 'array',
  items: (indexedItems(fieldValue(fieldValue(entries, 'map') as KObject, 'nodes') as KObject) ?? []) as Value[],
}));
// An entry shows as the pair the Java interpreter shows a Map.Entry as.
defineTraceShape('java.util.TreeMapEntry', (entry) => ({
  kind: 'array',
  items: [fieldValue(entry, 'key'), fieldValue(entry, 'value')],
}));
