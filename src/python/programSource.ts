import type { ClassDef, FunctionDef, Module } from './ast';

// The source of the program, which `inspect.getsource()` reads as CPython reads the script's file through linecache.

/** The lines of a program's source, each with its newline, and the definitions its own text contains. */
export interface ProgramSource {
  lines: string[];
  definitions: WeakSet<object>;
}

export function programSourceOf(module: Module, source: string): ProgramSource {
  const definitions = new WeakSet<object>([module.scope]);
  collectDefinitions(module.body, definitions, new Set());
  return { lines: source.split(/(?<=\n)/), definitions };
}

/** Collects the function and class definitions anywhere in the AST, which other sources' definitions are not. */
function collectDefinitions(node: unknown, definitions: WeakSet<object>, seen: Set<object>): void {
  if (typeof node !== 'object' || node === null || seen.has(node)) return;
  seen.add(node);
  if (isDefinition(node)) {
    definitions.add(node);
    definitions.add(node.scope);
  }
  for (const value of Object.values(node)) collectDefinitions(value, definitions, seen);
}

function isDefinition(node: object): node is FunctionDef | ClassDef {
  return 'qualifiedName' in node && 'scope' in node && ('params' in node || 'bases' in node);
}

/** The row a definition starts at, which is its first decorator's, as `co_firstlineno` and `__firstlineno__` give. */
export function firstRowOf(def: FunctionDef | ClassDef): number {
  return def.decorators[0]?.row ?? def.row;
}

/**
 * The lines of the block starting at `lines[0]`, as `inspect.getblock` finds them with tokens: decorators and the
 * header, then the body while it is indented deeper than the header, up to its last statement or the last comment at
 * the body's indentation. A line that is not a definition, such as one with a lambda, is a block of one logical line.
 */
export function blockOf(lines: readonly string[]): string[] {
  let index = 0;
  while (index < lines.length && /^\s*@/.test(lines[index])) index = logicalLineEnd(lines, index) + 1;
  const header = lines[index] ?? '';
  const base = indentation(header);
  let last = logicalLineEnd(lines, index);
  if (!/^\s*(async\s+def|def|class)\b/.test(header)) return lines.slice(0, last + 1);
  let bodyIndent: number | undefined;
  for (let row = last + 1; row < lines.length; row++) {
    const line = lines[row];
    const text = line.trim();
    if (text === '') continue;
    const indent = indentation(line);
    if (text.startsWith('#')) {
      if (bodyIndent !== undefined && indent >= bodyIndent) last = row;
      continue;
    }
    if (indent <= base) break;
    bodyIndent ??= indent;
    row = logicalLineEnd(lines, row);
    last = row;
  }
  return lines.slice(0, last + 1);
}

/** `inspect.indentsize`: the width of a line's leading whitespace, with tabs expanded to multiples of 8. */
export function indentation(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width = (Math.floor(width / 8) + 1) * 8;
    else break;
  }
  return width;
}

/** The row a logical line starting at `start` ends on, past brackets, strings, and backslashes that continue it. */
function logicalLineEnd(lines: readonly string[], start: number): number {
  const scan: LineScan = { depth: 0, quote: undefined };
  for (let row = start; row < lines.length; row++) {
    const continued = scanLine(lines[row], scan);
    // A string in single quotes ends with its line.
    if (scan.quote !== undefined && scan.quote.length === 1) scan.quote = undefined;
    if (scan.depth <= 0 && scan.quote === undefined && !continued) return row;
  }
  return lines.length - 1;
}

/** How far a scan of the lines of a logical line has got: its open brackets and the quotes of an open string. */
interface LineScan {
  depth: number;
  quote: string | undefined;
}

/** Scans a line for brackets and strings, returning whether a backslash at its end continues it. */
function scanLine(line: string, scan: LineScan): boolean {
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (scan.quote !== undefined) {
      index = skipInString(line, index, scan);
      continue;
    }
    if (char === '#') break;
    if (char === '"' || char === "'") {
      scan.quote = line.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += scan.quote.length - 1;
    } else if ('([{'.includes(char)) scan.depth++;
    else if (')]}'.includes(char)) scan.depth--;
    else if (char === '\\' && /^\\\r?\n?$/.test(line.slice(index))) return true;
  }
  return false;
}

/** Steps over a character in a string, closing it at its quotes, and returns the index of the last character taken. */
function skipInString(line: string, index: number, scan: LineScan): number {
  const quote = scan.quote as string;
  if (line[index] === '\\') return index + 1;
  if (!line.startsWith(quote, index)) return index;
  scan.quote = undefined;
  return index + quote.length - 1;
}
