/** A word as the parser read it, whose parts the shell expands when it runs the command holding it. */
export interface Word {
  parts: WordPart[];
  /** The 0-based row where the word starts. */
  row: number;
  /** The word's source text, which error messages quote. */
  text: string;
}

export type WordPart =
  /** Unquoted text, keeping its backslashes, which quote the character after each. */
  | { kind: 'literal'; text: string }
  /** The text between single quotes. */
  | { kind: 'single'; text: string }
  /** The decoded text of `$'...'`. */
  | { kind: 'ansiC'; text: string }
  /** Double-quoted parts; `$"..."` is the same in the C and UTF-8 locales without message catalogs. */
  | { kind: 'double'; parts: WordPart[] }
  | ParameterExpansion
  | { kind: 'commandSubstitution'; body: Statement[]; text: string; syntaxError?: BackquoteSyntaxError }
  | { kind: 'arithmeticExpansion'; expression: ArithmeticSource };

/** A syntax error in a backquoted body, which Bash reports when it runs the substitution, with the line it shows. */
export interface BackquoteSyntaxError {
  /** The 0-based row Bash reports. */
  row: number;
  /** The messages, which a conditional expression's error follows with the token Bash's parser stopped at. */
  messages: string[];
  /** The text of the line Bash prints after an unexpected token. */
  line?: string;
}

export interface ParameterExpansion {
  kind: 'parameter';
  /** A variable name, a positional parameter's digits, or a special parameter's character. */
  name: string;
  /** The subscript between the brackets of `${a[...]}`, whose parts expand as the variable's kind requires. */
  subscript?: Word;
  /** `#` for the length, `!` for indirection. */
  prefix?: '#' | '!';
  /** The operator after the parameter, such as `:-`, `#`, `/`, `:`, or `@`. */
  operator?: string;
  /** The parts after the operator, which each operator splits and expands itself. */
  argument: WordPart[];
  /** The source text of the expansion, which error messages quote. */
  text: string;
  /** Whether the expansion was written with braces, as `${x}`. */
  braced: boolean;
}

/**
 * The text of an arithmetic expression, whose expansions the shell substitutes before evaluating the resulting text,
 * as Bash does.
 */
export interface ArithmeticSource {
  pieces: (string | WordPart)[];
  row: number;
}

export interface Assignment {
  name: string;
  /** The subscript of `a[i]=x`. */
  subscript?: Word;
  append: boolean;
  /** A scalar value, or the words of a compound value `(a b c)`, or `undefined` for `x=`. */
  value: Word | undefined;
  array?: Word[];
  row: number;
  /** The source text, which errors quote. */
  text: string;
}

/** A redirection between standard output and standard error, the only ones a program can use here. */
export interface Redirect {
  /** The descriptor that the redirection changes. */
  fd: 1 | 2;
  /** The descriptor that it becomes a copy of. */
  target: 1 | 2;
}

export type TestExpression =
  | { kind: 'word'; word: Word }
  | { kind: 'unary'; operator: string; operand: Word }
  | { kind: 'binary'; operator: string; left: Word; right: Word }
  | { kind: 'regex'; left: Word; right: Word }
  | { kind: 'and' | 'or'; left: TestExpression; right: TestExpression }
  | { kind: 'not'; expression: TestExpression };

export interface CaseItem {
  patterns: Word[];
  body: Statement[];
  terminator: ';;' | ';&' | ';;&';
}

interface StatementBase {
  /** The 0-based row where the statement starts, which its step shows. */
  row: number;
  /** The row that `LINENO` and error messages report while the statement runs, as Bash's parser numbers it. */
  lineRow: number;
}

export type Statement = StatementBase &
  (
    | { kind: 'command'; assignments: Assignment[]; words: Word[]; redirects: Redirect[] }
    | {
        kind: 'declaration';
        name: string;
        assignments: Assignment[];
        /** Each argument in order, an assignment or a word. */
        args: (Word | Assignment)[];
        redirects: Redirect[];
      }
    | { kind: 'arithmetic'; expression: ArithmeticSource }
    | { kind: 'test'; expression: TestExpression; text: string }
    | { kind: 'if'; clauses: { condition: Statement[]; body: Statement[] }[]; elseBody: Statement[] | undefined }
    | { kind: 'while'; until: boolean; condition: Statement[]; body: Statement[] }
    | { kind: 'for'; variable: string; values: Word[] | undefined; body: Statement[] }
    | {
        kind: 'arithmeticFor';
        init: ArithmeticSource | undefined;
        condition: ArithmeticSource | undefined;
        update: ArithmeticSource | undefined;
        body: Statement[];
      }
    | { kind: 'case'; value: Word; items: CaseItem[] }
    | { kind: 'group'; body: Statement[] }
    | { kind: 'function'; name: string; body: Statement; isAtomic: boolean }
    | { kind: 'list'; operator: '&&' | '||'; left: Statement; right: Statement }
    | { kind: 'not'; body: Statement }
    | { kind: 'redirected'; body: Statement; redirects: Redirect[] }
  );

export interface Program {
  /** The top-level statements, grouped by the lines Bash reads and runs one at a time. */
  units: Statement[][];
  /** The row where each unit ends, the line Bash's parser is on when it runs the unit. */
  unitEndRows: number[];
}
