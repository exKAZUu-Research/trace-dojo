import type { TextReader } from '../interpreter/programIo';
import { isVariableReference } from './arithmetic';
import { parseBuiltinOptions } from './builtinOptions';
import { rejectControlVariable, rejectUnsupportedFeature } from './capabilities';
import { DeadlockError } from './runtime';
import type { Shell } from './shell';
import type { Builtin } from './turtle';
import { isIdentifier } from './variables';

const READ_USAGE =
  'read [-Eers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]';
const MAPFILE_USAGE =
  'mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]';
const DEFAULT_IFS = ' \t\n';
/** How many lines `mapfile -C` reads between calls of its callback when `-c` does not say. */
const DEFAULT_CALLBACK_QUANTUM = 5000;

/** What `read` read: its characters, which of them a backslash quoted, and whether it reached its delimiter. */
interface ReadText {
  readonly chars: string[];
  readonly escaped: boolean[];
  readonly complete: boolean;
  /** Whether `read -t` timed out before the input ended, keeping what it read so far. */
  readonly timedOut?: boolean;
}

/**
 * `read`, which reads a line, or up to a delimiter or a count of characters, and splits it among names by `IFS`.
 * Input never comes from a terminal here, so `-p` shows no prompt and `-e`, `-i`, and `-s` change nothing.
 */
// code-gauge-allow functionCognitiveComplexity -- Validates names, count, descriptor, and timeout before reading, then assigns by the form Bash's `read` was given.
// code-gauge-allow functionNcss -- Validates names, count, descriptor, and timeout before reading, then assigns by the form Bash's `read` was given.
export const readBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'read', args, 'a:d:i:n:N:p:t:u:Eers', READ_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { options, operands: names } = parsed;
  const arrayName = options.get('a');
  // `-a` takes a plain name, while the other names may be array elements.
  const invalid =
    arrayName !== undefined && !isIdentifier(arrayName) ? arrayName : names.find((name) => !isVariableReference(name));
  if (invalid !== undefined) {
    shell.reportError(`read: \`${invalid}': not a valid identifier`);
    return 1;
  }
  const count = readCount(shell, options.get('N') ?? options.get('n'));
  if (count === 'invalid') return 1;
  const reader = inputReader(shell, 'read', options.get('u'));
  if (!reader) return 1;
  if (!options.has('t')) rejectControlVariable(shell.store.readScalar('TMOUT'), 'TMOUT', 'read の待ち時間');
  const timeoutStatus = zeroTimeoutStatus(shell, options.get('t'), reader);
  if (timeoutStatus !== undefined) return timeoutStatus;
  // Reading no characters still assigns the empty text read, as Bash does.
  if (count === 0) {
    if (arrayName !== undefined) return shell.assignIndexedArray(arrayName, [], 'read') ? 0 : 1;
    return assignAll(shell, names.length === 0 ? ['REPLY'] : names, []);
  }
  const delimiter = options.has('d') ? (options.get('d') as string).slice(0, 1) || '\0' : '\n';
  const text = readText(reader, {
    delimiter: options.has('N') ? undefined : delimiter,
    count,
    raw: options.has('r'),
    timesOut: options.get('t') !== undefined,
  });
  const ifs = shell.store.readScalar('IFS') ?? DEFAULT_IFS;
  let status: number;
  if (arrayName !== undefined) status = shell.assignIndexedArray(arrayName, splitAll(text, ifs), 'read') ? 0 : 1;
  else if (names.length === 0) status = shell.assignVariable('REPLY', text.chars.join('')) ? 0 : 1;
  else if (options.has('N')) status = assignAll(shell, names, [text.chars.join('')]);
  else status = assignAll(shell, names, splitAmong(text, ifs, names.length));
  // Bash saves the partial input of a `read -t` that times out and returns 142.
  if (text.timedOut) return 142;
  return status !== 0 ? status : text.complete ? 0 : 1;
};

/**
 * The status of `read -t`, which ends `read` only for a zero timeout, testing for input: all input is present before
 * the program starts, so no other timeout can pass. Reports a timeout that is not a number.
 */
function zeroTimeoutStatus(shell: Shell, timeout: string | undefined, reader: TextReader): number | undefined {
  if (timeout === undefined) return undefined;
  if (!/^\d*\.?\d*$/.test(timeout) || timeout === '' || timeout === '.') {
    shell.reportError(`read: ${timeout}: invalid timeout specification`);
    return 1;
  }
  if (Number(timeout) !== 0) return undefined;
  // Bash polls the descriptor: a file, `/dev/null`, or a here-document is ready at its end too, while a pipe whose
  // text is all read waits for its writer, which has mostly not ended yet when Bash polls it.
  return reader.readyToPoll ? 0 : 1;
}

/**
 * Assigns the values to the names in order, returning the status: Bash stops at the first name it cannot assign, with
 * status 1 when it is the last name and 2 otherwise, leaving the names after it as they were.
 */
function assignAll(shell: Shell, names: readonly string[], values: readonly string[]): number {
  for (const [index, name] of names.entries()) {
    if (!shell.assignVariable(name, values[index] ?? '')) return index === names.length - 1 ? 1 : 2;
  }
  return 0;
}

function readCount(shell: Shell, text: string | undefined): number | undefined | 'invalid' {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) {
    shell.reportError(`read: ${text}: invalid number`);
    return 'invalid';
  }
  return Number(text);
}

/** The reader of the descriptor a builtin reads, reporting a descriptor that is closed or not open for reading. */
function inputReader(shell: Shell, builtin: string, fdText: string | undefined): TextReader | undefined {
  if (fdText !== undefined && !/^\d+$/.test(fdText)) {
    shell.reportError(`${builtin}: ${fdText}: invalid file descriptor specification`);
    return undefined;
  }
  const fd = fdText === undefined ? 0 : Number(fdText);
  const file = shell.fds.get(fd);
  if (!file && fdText !== undefined) {
    shell.reportError(`${builtin}: ${fd}: invalid file descriptor: Bad file descriptor`);
    return undefined;
  }
  if (!file?.input) {
    shell.reportError(`${builtin}: ${fd}: read error: Bad file descriptor`);
    return undefined;
  }
  return file.input;
}

/** Reads characters up to the delimiter, which it consumes, or up to `count` characters, or to the end. */
// code-gauge-allow functionCognitiveComplexity -- Handles counts, the delimiter, NULs, and backslash escapes and continuations as Bash's `read` does.
function readText(
  reader: TextReader,
  options: { delimiter: string | undefined; count: number | undefined; raw: boolean; timesOut?: boolean }
): ReadText {
  const chars: string[] = [];
  const escaped: boolean[] = [];
  try {
    return readTextInto(reader, options, chars, escaped);
  } catch (error) {
    // Input that would never come times a timeout out, as Bash's `read -t` does after waiting, keeping what it read.
    if (!(error instanceof DeadlockError) || !options.timesOut) throw error;
    return { chars, escaped, complete: false, timedOut: true };
  }
}

function readTextInto(
  reader: TextReader,
  { delimiter, count, raw }: { delimiter: string | undefined; count: number | undefined; raw: boolean },
  chars: string[],
  escaped: boolean[]
): ReadText {
  for (;;) {
    if (count !== undefined && chars.length >= count) return { chars, escaped, complete: true };
    const c = readCharacter(reader);
    if (c === undefined) return { chars, escaped, complete: false };
    // Bash drops NULs from the input unless a NUL is the delimiter, as with `-d ''`.
    if (c === '\0' && delimiter !== '\0') continue;
    if (!raw && c === '\\') {
      let next = readCharacter(reader);
      while (next === '\0' && delimiter !== '\0') next = readCharacter(reader);
      if (next === undefined) return { chars, escaped, complete: false };
      // A backslash before a newline continues the line, whatever the delimiter, and one before a NUL drops it.
      if (next === '\n' || next === '\0') continue;
      chars.push(next);
      escaped.push(true);
      continue;
    }
    if (c === delimiter) return { chars, escaped, complete: true };
    chars.push(c);
    escaped.push(false);
  }
}

/** The next character, joining a surrogate pair, as Bash reads a multibyte character in a UTF-8 locale. */
function readCharacter(reader: TextReader): string | undefined {
  const first = reader.read();
  if (first === undefined || !/[\uD800-\uDBFF]/.test(first) || reader.isAtEnd) return first;
  return first + (reader.read() as string);
}

class FieldScanner {
  position = 0;

  constructor(
    private readonly text: ReadText,
    private readonly ifs: string
  ) {}

  get atEnd(): boolean {
    return this.position >= this.text.chars.length;
  }

  private isDelimiter(index: number): boolean {
    return !this.text.escaped[index] && this.ifs.includes(this.text.chars[index]);
  }

  private isWhitespace(index: number): boolean {
    return this.isDelimiter(index) && DEFAULT_IFS.includes(this.text.chars[index]);
  }

  skipWhitespace(): void {
    while (!this.atEnd && this.isWhitespace(this.position)) this.position++;
  }

  /** The next field, consuming the delimiter after it: whitespace around at most one other `IFS` character. */
  nextField(): string {
    const start = this.position;
    while (!this.atEnd && !this.isDelimiter(this.position)) this.position++;
    const field = this.text.chars.slice(start, this.position).join('');
    this.skipWhitespace();
    if (!this.atEnd && this.isDelimiter(this.position) && !this.isWhitespace(this.position)) {
      this.position++;
      this.skipWhitespace();
    }
    return field;
  }

  /** The rest of the text without the `IFS` whitespace that ends it. */
  rest(): string {
    let end = this.text.chars.length;
    while (end > this.position && this.isWhitespace(end - 1)) end--;
    return this.text.chars.slice(this.position, end).join('');
  }
}

/** Splits text among `count` names, where the last takes the rest of the line, as Bash's `read` does. */
function splitAmong(text: ReadText, ifs: string, count: number): string[] {
  const scanner = new FieldScanner(text, ifs);
  scanner.skipWhitespace();
  const values: string[] = [];
  while (values.length < count - 1 && !scanner.atEnd) values.push(scanner.nextField());
  if (scanner.atEnd) return values;
  // The last name takes a single remaining field without its delimiter, or else the rest of the line.
  const rest = scanner.rest();
  const field = scanner.nextField();
  values.push(scanner.atEnd ? field : rest);
  return values;
}

function splitAll(text: ReadText, ifs: string): string[] {
  const scanner = new FieldScanner(text, ifs);
  scanner.skipWhitespace();
  const fields: string[] = [];
  while (!scanner.atEnd) fields.push(scanner.nextField());
  return fields;
}

/** `mapfile` and `readarray`, which read lines into an indexed array. */
// code-gauge-allow functionCognitiveComplexity -- Reads records with skipping, counting, origin, and callbacks, as the options of Bash `mapfile` combine.
// code-gauge-allow functionNcss -- Reads records with skipping, counting, origin, and callbacks, as the options of Bash `mapfile` combine.
export const mapfileBuiltin: Builtin = (shell, args, name) => {
  const parsed = parseBuiltinOptions(shell, name, args, 'd:n:O:s:tu:C:c:', MAPFILE_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  const arrayName = operands[0] ?? 'MAPFILE';
  if (!isIdentifier(arrayName)) {
    shell.reportError(`${name}: \`${arrayName}': not a valid identifier`);
    return 1;
  }
  const numbers = mapfileNumbers(shell, name, options);
  if (!numbers) return 1;
  const reader = inputReader(shell, name, options.get('u'));
  if (!reader) return 1;
  if (shell.isAssociativeArray(arrayName)) {
    shell.reportError(`${name}: ${arrayName}: not an indexed array`);
    return 1;
  }
  const callback = callbackWords(options.get('C'));
  const delimiter = options.has('d') ? (options.get('d') as string).slice(0, 1) || '\0' : '\n';
  const lines: string[] = [];
  let skipped = 0;
  let lineCount = 1;
  while (numbers.count === 0 || lines.length < numbers.count) {
    const line = readRecord(reader, delimiter);
    if (line === undefined) break;
    if (skipped < numbers.skip) {
      skipped++;
      continue;
    }
    const value = options.has('t') && line.endsWith(delimiter) ? line.slice(0, -1) : line;
    if (callback && lineCount % numbers.quantum === 0) {
      shell.assignIndexedArray(arrayName, lines, 'mapfile', numbers.origin, options.has('O'));
      shell.invokeCommand(callback[0], [...callback.slice(1), String(numbers.origin + lines.length), value]);
    }
    lines.push(value);
    lineCount++;
  }
  return shell.assignIndexedArray(arrayName, lines, 'mapfile', numbers.origin, options.has('O')) ? 0 : 1;
};

function mapfileNumbers(
  shell: Shell,
  name: string,
  options: ReadonlyMap<string, string>
): { count: number; origin: number; skip: number; quantum: number } | undefined {
  const values: Record<string, number> = { n: 0, O: 0, s: 0, c: DEFAULT_CALLBACK_QUANTUM };
  for (const letter of ['n', 'O', 's', 'c']) {
    const text = options.get(letter);
    if (text === undefined) continue;
    const labels: Record<string, string> = {
      n: 'line count',
      O: 'array index',
      s: 'line count',
      c: 'callback quantum',
    };
    if (!/^\d+$/.test(text) || (letter === 'c' && Number(text) === 0)) {
      shell.reportError(`${name}: ${text}: invalid ${labels[letter]}`);
      return undefined;
    }
    values[letter] = Number(text);
  }
  return { count: values.n, origin: values.O, skip: values.s, quantum: values.c };
}

/** The words of a `mapfile -C` callback, which Bash evaluates as a command with the index and line appended. */
function callbackWords(callback: string | undefined): string[] | undefined {
  if (callback === undefined) return undefined;
  if (!/^[^\s'"`$\\;&|<>(){}]+( +[^\s'"`$\\;&|<>(){}]+)*$/.test(callback)) {
    rejectUnsupportedFeature('文字列の評価（mapfile -C の引数の解釈）');
  }
  return callback.split(/ +/);
}

/** The next record up to and including its delimiter, or the rest of the input, or `undefined` at the end. */
function readRecord(reader: TextReader, delimiter: string): string | undefined {
  if (reader.isAtEnd) return undefined;
  let line = '';
  for (let c = reader.read(); c !== undefined; c = reader.read()) {
    line += c;
    if (c === delimiter) break;
  }
  return line;
}
