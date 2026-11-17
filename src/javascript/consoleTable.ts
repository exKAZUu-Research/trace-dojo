import { ArrayOps } from './arrayOps';
import { inspectValue, OutputBudget, stringWidth } from './inspect';
import { type CollectionEntry, CollectionIterator } from './realmCollections';
import type { Runtime } from './runtime';
import { arrayIndexOf, isObject, JsArray, JsFunction, JsObject, JsThrow, type Value } from './values';

/** The text `console.table` prints for its arguments, or undefined when it prints them as `console.log` does. */
// code-gauge-allow functionNcss 34 -- Keeps argument validation, row collection, and the shared formatting budget in table evaluation order.
// code-gauge-allow functionCognitiveComplexity 20 -- Preserves Node's validation order, collection dispatch, primitive rows, selected properties, and final layout.
export function formatTable(runtime: Runtime, data: Value, properties: Value): string | undefined {
  if (properties !== undefined && !(properties instanceof JsArray)) invalidProperties(runtime, properties);
  if (!(data instanceof JsObject) || data instanceof JsFunction) return undefined;
  const budget = new OutputBudget();
  const selection = properties instanceof JsArray ? new ArrayOps(runtime, properties) : undefined;
  const selected = selection
    ? Array.from({ length: selection.length }, (_, index) => runtime.toString(selection.get(index)))
    : undefined;
  const collectionTable = formatCollectionTable(runtime, data, budget);
  if (collectionTable !== undefined) return collectionTable;
  const columns = new Map<string, string[]>();
  const values: string[] = [];
  let hasPrimitives = false;
  const rowKeys = runtime.ownEnumerableKeys(data);
  for (const [row, rowKey] of rowKeys.entries()) {
    runtime.spend();
    const item = runtime.get(data, rowKey);
    if (selected === undefined && !isObject(item)) {
      hasPrimitives = true;
      values[row] = inspectCell(runtime, item, budget);
      continue;
    }
    const keys = selected ?? (item instanceof JsObject ? runtime.ownEnumerableKeys(item) : []);
    for (const key of keys) {
      runtime.spend();
      const column = columns.get(key) ?? [];
      columns.set(key, column);
      column[row] =
        item instanceof JsObject && runtime.getOwnProperty(item, key) !== undefined
          ? inspectCell(runtime, runtime.get(item, key), budget)
          : '';
    }
  }
  // Node.js collects the columns as an object's keys, which put integer-like keys first, in ascending order.
  const ordered = [...columns.keys()].toSorted(byObjectKeyOrder);
  const head = ['(index)', ...ordered];
  const body = [rowKeys, ...ordered.map((key) => columns.get(key) as string[])];
  if (hasPrimitives) {
    head.push('Values');
    body.push(values);
  }
  return renderTable(runtime, head, body);
}

function invalidProperties(runtime: Runtime, value: Value): never {
  const received = receivedArgument(runtime, value);
  const error = runtime.newError(
    'TypeError',
    `The "properties" argument must be an instance of Array. Received ${received}`
  );
  runtime.createDataProperty(error, 'code', 'ERR_INVALID_ARG_TYPE');
  throw new JsThrow(error);
}

function receivedArgument(runtime: Runtime, value: Value): string {
  if (value === null) return 'null';
  if (value instanceof JsFunction) return `function ${functionName(runtime, value)}`;
  if (value instanceof JsObject) {
    for (let prototype = value.proto; prototype; prototype = prototype.proto) {
      const constructor = prototype.properties.get('constructor');
      if (constructor && 'value' in constructor && constructor.value instanceof JsFunction)
        return `an instance of ${functionName(runtime, constructor.value)}`;
    }
    return inspectValue(runtime, value);
  }
  return `type ${typeof value} (${inspectValue(runtime, value)})`;
}

function functionName(runtime: Runtime, fn: JsFunction): string {
  const name = runtime.get(fn, 'name');
  return typeof name === 'string' ? name : '';
}

/**
 * The table of a Map, a Set, or an iterator over one: its keys and values for a Map or a Map's entries, its values for
 * the rest, an iterator's from where it has reached on.
 */
function formatCollectionTable(runtime: Runtime, data: JsObject, budget: OutputBudget): string | undefined {
  const iterator = data.hostIterator instanceof CollectionIterator ? data.hostIterator : undefined;
  const state = iterator?.state ?? data.collection;
  if (!state || state.isWeak) return undefined;
  const entries = iterator ? iterator.remainingEntries() : state.entries.filter((entry) => entry !== undefined);
  const indices = entries.map((_, index) => inspectCell(runtime, index, budget));
  const isMap = state.kind === 'Map';
  if (isMap && (!iterator || iterator.kind === 'entries')) {
    return renderTable(
      runtime,
      ['(iteration index)', 'Key', 'Values'],
      [
        indices,
        entries.map((entry) => inspectCell(runtime, entry.key, budget)),
        entries.map((entry) => inspectCell(runtime, entry.value as Value, budget)),
      ]
    );
  }
  const shown = (entry: CollectionEntry): Value[] => {
    if (isMap) return [iterator?.kind === 'values' ? (entry.value as Value) : entry.key];
    // A Set's entries are pairs of its value, which Node.js lists as rows of their own.
    return iterator?.kind === 'entries' ? [entry.key, entry.key] : [entry.key];
  };
  const values = entries.flatMap(shown);
  return renderTable(
    runtime,
    ['(iteration index)', 'Values'],
    [
      values.map((_, index) => inspectCell(runtime, index, budget)),
      values.map((value) => inspectCell(runtime, value, budget)),
    ]
  );
}

/** A cell as `console.table` inspects it: an object with more than two keys as `[Object]`, nested ones collapsed. */
function inspectCell(runtime: Runtime, value: Value, budget: OutputBudget): string {
  const depth =
    value instanceof JsObject && !(value instanceof JsArray) && runtime.ownEnumerableKeys(value).length > 2 ? -1 : 0;
  return inspectValue(runtime, value, budget, depth, { maxArrayLength: 3, breakLength: Number.POSITIVE_INFINITY });
}

/** Node.js's `cli_table`, which left-aligns each cell. */
function renderTable(runtime: Runtime, head: string[], columns: string[][]): string {
  const widths = head.map((title) => stringWidth(title));
  const rowCount = Math.max(...columns.map((column) => column.length));
  const rows: string[][] = Array.from({ length: rowCount }, () => []);
  for (const [columnIndex, column] of columns.entries()) {
    for (let row = 0; row < rowCount; row++) {
      runtime.spend();
      const cell = Object.hasOwn(column, row) ? (column[row] ?? '') : '';
      rows[row][columnIndex] = cell;
      widths[columnIndex] = Math.max(widths[columnIndex], stringWidth(cell));
    }
  }
  const budget = new OutputBudget();
  const borderLength = widths.reduce((sum, width) => sum + width + 2, 1) + widths.length;
  budget.charge(3 * borderLength + rowCount + 3);
  const chargeRow = (cells: string[]): void => {
    budget.charge(cells.reduce((sum, cell, index) => sum + cell.length + widths[index] - stringWidth(cell) + 3, 1));
  };
  chargeRow(head);
  for (const row of rows) chargeRow(row);
  const renderRow = (cells: string[]): string =>
    `│ ${cells.map((cell, index) => cell + ' '.repeat(widths[index] - stringWidth(cell))).join(' │ ')} │`;
  const divider = widths.map((width) => '─'.repeat(width + 2));
  return [
    `┌${divider.join('┬')}┐`,
    renderRow(head),
    `├${divider.join('┼')}┤`,
    ...rows.map((row) => renderRow(row)),
    `└${divider.join('┴')}┘`,
  ].join('\n');
}

/** Orders keys as an object lists them: integer-like ones first, in ascending order, then the rest as they came. */
function byObjectKeyOrder(a: string, b: string): number {
  const left = arrayIndexOf(a);
  const right = arrayIndexOf(b);
  if (left === undefined || right === undefined) return left === undefined ? (right === undefined ? 0 : 1) : -1;
  return left - right;
}
