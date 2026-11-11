// `reader.__next__` of CPython's `_csv` module (`Reader_iternext` and `parse_process_char` in `Modules/_csv.c`), run
// natively, since running its character loop in Python costs dozens of operations per character.
import { callValue, getAttribute, type NextFunction, nextOf } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { floatClass, newException, newList, None, objectClass, pyError, typeName } from '../types';
import { DONE, type PyClass, PyError, type PyList, type PyValue } from '../values';

const START_RECORD = 0;
const START_FIELD = 1;
const ESCAPED_CHAR = 2;
const IN_FIELD = 3;
const IN_QUOTED_FIELD = 4;
const ESCAPE_IN_QUOTED_FIELD = 5;
const QUOTE_IN_QUOTED_FIELD = 6;
const EAT_CRNL = 7;
const AFTER_ESCAPED_CRNL = 8;

const QUOTE_NONNUMERIC = 2n;
const QUOTE_NONE = 3n;
const QUOTE_STRINGS = 4n;
const QUOTE_NOTNULL = 5n;

/** The end of a line, which the parser handles as one more character. */
const EOL = Symbol('end of line');
type Char = string | typeof EOL;

interface Dialect {
  delimiter: PyValue;
  quotechar: PyValue;
  escapechar: PyValue;
  quoting: bigint;
  doublequote: boolean;
  skipinitialspace: boolean;
  strict: boolean;
}

/** `next(reader)`: the fields of the next record its input's lines hold. */
export function readerNext(self: PyValue): PyValue {
  const runtime = currentRuntime();
  const module = runtime.importModule('_csv').dict;
  const error = (message: string): PyError => new PyError(newException(module.get('Error') as PyClass, [message]));
  const { next, dialect } = readerState(self);
  const fields = newList([]);
  const parser = new LineParser(fields, dialect, module.get('_field_limit') as bigint);
  const counter = { lines: getAttribute(self, '_line_num') as bigint };
  try {
    readRecord(parser, next, (message) => error(message), counter);
  } finally {
    callValue(objectClass.dict.get('__setattr__') as PyValue, [self, '_line_num', counter.lines]);
  }
  runtime.allocate(fields.items.length + 1);
  return fields;
}

/** Reads the lines of one record into `parser`, counting them in `counter`. */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows Reader_iternext of CPython's _csv, line by line.
function readRecord(
  parser: LineParser,
  next: NextFunction,
  error: (message: string) => PyError,
  counter: { lines: bigint }
): void {
  const runtime = currentRuntime();
  do {
    const line = next();
    if (line === DONE) {
      if (parser.field.length === 0 && parser.state !== IN_QUOTED_FIELD) throw pyError('StopIteration');
      if (parser.dialect.strict) throw error('unexpected end of data');
      parser.save();
      break;
    }
    if (typeof line !== 'string') {
      throw error(`iterator should return strings, not ${typeName(line)} (the file should be opened in text mode)`);
    }
    counter.lines++;
    runtime.scan(line.length);
    try {
      for (const char of line) parser.process(char);
      parser.process(EOL);
    } catch (error_) {
      if (error_ instanceof ParseError) throw error(error_.message);
      throw error_;
    }
  } while (parser.state !== START_RECORD);
}

/** The input and the settings of each reader, which do not change, read once. */
const readerStates = new WeakMap<object, { next: NextFunction; dialect: Dialect }>();

function readerState(self: PyValue): { next: NextFunction; dialect: Dialect } {
  let state = readerStates.get(self as object);
  if (!state) {
    state = { next: nextOf(getAttribute(self, '_input')), dialect: dialectOf(getAttribute(self, '_dialect')) };
    readerStates.set(self as object, state);
  }
  return state;
}

/** The settings of a `_csv.Dialect` the parser reads, which the Python part keeps in its slots. */
function dialectOf(dialect: PyValue): Dialect {
  const read = (name: string): PyValue => getAttribute(dialect, name);
  return {
    delimiter: read('delimiter'),
    quotechar: read('quotechar'),
    escapechar: read('escapechar'),
    quoting: read('quoting') as bigint,
    doublequote: read('doublequote') as boolean,
    skipinitialspace: read('skipinitialspace') as boolean,
    strict: read('strict') as boolean,
  };
}

/** An error the parser stops at, which becomes a `_csv.Error`. */
class ParseError extends Error {}

class LineParser {
  state = START_RECORD;
  field: string[] = [];
  unquoted = true;

  constructor(
    private readonly fields: PyList,
    readonly dialect: Dialect,
    private readonly fieldLimit: bigint
  ) {}

  process(c: Char): void {
    if (this.state === START_RECORD) {
      if (c === EOL) return;
      if (c === '\n' || c === '\r') {
        this.state = EAT_CRNL;
        return;
      }
      this.state = START_FIELD;
    }
    this.state = this.next(c);
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per state of CPython's parse_process_char.
  // code-gauge-allow functionNcss 40 -- One case per state of CPython's parse_process_char.
  private next(c: Char): number {
    const { dialect } = this;
    const isQuote = c === dialect.quotechar && dialect.quoting !== QUOTE_NONE;
    const endsLine = c === EOL || c === '\n' || c === '\r';
    switch (this.state) {
      case START_FIELD: {
        return this.startField(c, isQuote, endsLine);
      }
      case ESCAPED_CHAR: {
        if (c === '\n' || c === '\r') {
          this.add(c);
          return AFTER_ESCAPED_CRNL;
        }
        this.add(c === EOL ? '\n' : c);
        return IN_FIELD;
      }
      case AFTER_ESCAPED_CRNL:
      case IN_FIELD: {
        if (this.state === AFTER_ESCAPED_CRNL && c === EOL) return AFTER_ESCAPED_CRNL;
        return this.inField(c, endsLine);
      }
      case IN_QUOTED_FIELD: {
        if (c === EOL) return IN_QUOTED_FIELD;
        if (c === dialect.escapechar) return ESCAPE_IN_QUOTED_FIELD;
        if (isQuote) return dialect.doublequote ? QUOTE_IN_QUOTED_FIELD : IN_FIELD;
        this.add(c);
        return IN_QUOTED_FIELD;
      }
      case ESCAPE_IN_QUOTED_FIELD: {
        this.add(c === EOL ? '\n' : c);
        return IN_QUOTED_FIELD;
      }
      case QUOTE_IN_QUOTED_FIELD: {
        return this.afterQuote(c, isQuote, endsLine);
      }
      case EAT_CRNL: {
        if (c === EOL) return START_RECORD;
        if (c !== '\n' && c !== '\r') {
          throw new ParseError(
            "new-line character seen in unquoted field - do you need to open the file with newline=''?"
          );
        }
        return EAT_CRNL;
      }
      default: {
        return this.state;
      }
    }
  }

  private startField(c: Char, isQuote: boolean, endsLine: boolean): number {
    const { dialect } = this;
    if (endsLine) {
      this.save();
      return c === EOL ? START_RECORD : EAT_CRNL;
    }
    if (isQuote) {
      this.unquoted = false;
      return IN_QUOTED_FIELD;
    }
    if (c === dialect.escapechar) return ESCAPED_CHAR;
    if (c === ' ' && dialect.skipinitialspace) return START_FIELD;
    if (c === dialect.delimiter) {
      this.save();
      return START_FIELD;
    }
    this.add(c);
    return IN_FIELD;
  }

  private inField(c: Char, endsLine: boolean): number {
    if (endsLine) {
      this.save();
      return c === EOL ? START_RECORD : EAT_CRNL;
    }
    if (c === this.dialect.escapechar) return ESCAPED_CHAR;
    if (c === this.dialect.delimiter) {
      this.save();
      return START_FIELD;
    }
    this.add(c);
    return this.state;
  }

  private afterQuote(c: Char, isQuote: boolean, endsLine: boolean): number {
    const { dialect } = this;
    if (isQuote) {
      this.add(c);
      return IN_QUOTED_FIELD;
    }
    if (c === dialect.delimiter) {
      this.save();
      return START_FIELD;
    }
    if (endsLine) {
      this.save();
      return c === EOL ? START_RECORD : EAT_CRNL;
    }
    if (!dialect.strict) {
      this.add(c);
      return IN_FIELD;
    }
    throw new ParseError(`'${dialect.delimiter as string}' expected after '${dialect.quotechar as string}'`);
  }

  private add(c: Char): void {
    if (BigInt(this.field.length) >= this.fieldLimit) {
      throw new ParseError(`field larger than field limit (${this.fieldLimit})`);
    }
    this.field.push(c as string);
  }

  save(): void {
    const { quoting } = this.dialect;
    const { unquoted, field } = this;
    let value: PyValue;
    if (unquoted && field.length === 0 && (quoting === QUOTE_NOTNULL || quoting === QUOTE_STRINGS)) {
      value = None;
    } else {
      value = field.join('');
      if (unquoted && field.length > 0 && (quoting === QUOTE_NONNUMERIC || quoting === QUOTE_STRINGS)) {
        value = callValue(floatClass, [value]);
      }
    }
    this.fields.items.push(value);
    this.field = [];
    this.unquoted = true;
  }
}
