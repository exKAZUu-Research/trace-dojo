import { stripVTControlCharacters } from 'node:util';

import { ArrayOps } from './arrayOps';
import { inspectValue, OutputBudget, stringWidth } from './inspect';
import { type CollectionEntry, CollectionIterator } from './realmCollections';
import type { Runtime } from './runtime';
import { arrayIndexOf, isObject, JsArray, JsFunction, JsObject, JsThrow, type Key, type Value } from './values';

/** The text `console.table` prints for its arguments, or undefined when it prints them as `console.log` does. */
export function formatTable(runtime: Runtime, data: Value, properties: Value): string | undefined {
  if (properties !== undefined && !(properties instanceof JsArray)) invalidProperties(runtime, properties);
  if (!(data instanceof JsObject) || data instanceof JsFunction) return undefined;
  const budget = new OutputBudget();
  const selection = properties instanceof JsArray ? new ArrayOps(runtime, properties) : undefined;
  const collectionTable = formatCollectionTable(runtime, data, budget);
  if (collectionTable !== undefined) return collectionTable;
  const columns = new Map<Key, string[]>();
  const values: string[] = [];
  let hasPrimitives = false;
  const rowKeys = runtime.ownEnumerableKeys(data);
  for (const [row, rowKey] of rowKeys.entries()) {
    runtime.spend();
    const item = runtime.get(data, rowKey);
    if (selection) {
      addSelectedCells(runtime, columns, selection, item, row, budget);
      continue;
    }
    if (!isObject(item)) {
      hasPrimitives = true;
      values[row] = inspectCell(runtime, item, budget);
      continue;
    }
    addOwnCells(runtime, columns, item, row, budget);
  }
  const { head, body } = tableColumns(columns, rowKeys);
  if (hasPrimitives) {
    head.push('Values');
    body.push(values);
  }
  return renderTable(runtime, head, body);
}

function invalidProperties(runtime: Runtime, value: Value): never {
  const received = receivedArgument(runtime, value);
  const error = runtime.newNodeError(
    'TypeError',
    'ERR_INVALID_ARG_TYPE',
    `The "properties" argument must be an instance of Array. Received ${received}`
  );
  throw new JsThrow(error);
}

function receivedArgument(runtime: Runtime, value: Value): string {
  if (value === null) return 'null';
  if (value instanceof JsFunction) return `function ${functionName(runtime, value)}`;
  if (value instanceof JsObject) {
    const constructor = runtime.get(value, 'constructor');
    const name = constructor === null || constructor === undefined ? undefined : runtime.get(constructor, 'name');
    return typeof name === 'string' && name.length > 0
      ? `an instance of ${name}`
      : inspectValue(runtime, value, undefined, -1);
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
  const header = head.map(tableCell);
  const widths = header.map((cell) => cell.width);
  const rowCount = Math.max(...columns.map((column) => column.length));
  const rows: ReturnType<typeof tableCell>[][] = Array.from({ length: rowCount }, () => []);
  for (const [columnIndex, column] of columns.entries()) {
    for (let row = 0; row < rowCount; row++) {
      runtime.spend();
      const cell = tableCell(Object.hasOwn(column, row) ? (column[row] ?? '') : '');
      rows[row][columnIndex] = cell;
      widths[columnIndex] = Math.max(widths[columnIndex], cell.width);
    }
  }
  const budget = new OutputBudget();
  const borderLength = widths.reduce((sum, width) => sum + width + 2, 1) + widths.length;
  budget.charge(3 * borderLength + rowCount + 3);
  const chargeRow = (cells: ReturnType<typeof tableCell>[]): void => {
    budget.charge(cells.reduce((sum, cell, index) => sum + cell.text.length + widths[index] - cell.width + 3, 1));
  };
  chargeRow(header);
  for (const row of rows) chargeRow(row);
  const renderRow = (cells: ReturnType<typeof tableCell>[]): string =>
    `│ ${cells.map((cell, index) => cell.text + ' '.repeat(widths[index] - cell.width)).join(' │ ')} │`;
  const divider = widths.map((width) => '─'.repeat(width + 2));
  return [
    `┌${divider.join('┬')}┐`,
    renderRow(header),
    `├${divider.join('┼')}┤`,
    ...rows.map((row) => renderRow(row)),
    `└${divider.join('┴')}┘`,
  ].join('\n');
}

function tableCell(text: string): { text: string; width: number } {
  return { text, width: stringWidth(stripVTControlCharacters(text)) };
}

/** Fills a row's cells for the own enumerable properties of an object. */
function addOwnCells(
  runtime: Runtime,
  columns: Map<Key, string[]>,
  item: JsObject,
  row: number,
  budget: OutputBudget
): void {
  for (const key of runtime.ownEnumerableKeys(item)) {
    runtime.spend();
    const column = columns.get(key) ?? [];
    columns.set(key, column);
    column[row] =
      runtime.getOwnProperty(item, key) === undefined ? '' : inspectCell(runtime, runtime.get(item, key), budget);
  }
}

/**
 * Fills a row's cells for the selected properties as Node.js does, converting a selector to a key at each use, as its
 * `map[key] ??= []`, `hasOwnProperty`, and `map[key][i] = _inspect(item[key])` do.
 */
function addSelectedCells(
  runtime: Runtime,
  columns: Map<Key, string[]>,
  selection: ArrayOps,
  item: Value,
  row: number,
  budget: OutputBudget
): void {
  for (let index = 0; index < selection.length; index++) {
    runtime.spend();
    const selector = selection.get(index);
    const key = (): Key => runtime.toPropertyKey(selector);
    if (!columns.has(key())) columns.set(key(), []);
    const cell = (): string[] =>
      columns.get(key()) ?? runtime.throwError('TypeError', `Cannot set properties of undefined (setting '${row}')`);
    if (!(item instanceof JsObject) || runtime.getOwnProperty(item, key()) === undefined) {
      cell()[row] = '';
      continue;
    }
    const column = cell();
    column[row] = inspectCell(runtime, runtime.get(item, key()), budget);
  }
}

/** The table's columns: a column a symbol selected stays out, as Node.js lists the columns with `Object.keys`. */
function tableColumns(columns: Map<Key, string[]>, rowKeys: string[]): { head: string[]; body: string[][] } {
  const ordered = [...columns.keys()]
    .filter((key): key is string => typeof key === 'string')
    .toSorted(byObjectKeyOrder);
  return {
    head: ['(index)', ...ordered],
    body: [rowKeys, ...ordered.map((key) => columns.get(key) as string[])],
  };
}

/** Orders keys as an object lists them: integer-like ones first, in ascending order, then the rest as they came. */
function byObjectKeyOrder(a: string, b: string): number {
  const left = arrayIndexOf(a);
  const right = arrayIndexOf(b);
  if (left === undefined || right === undefined) return left === undefined ? (right === undefined ? 0 : 1) : -1;
  return left - right;
}
