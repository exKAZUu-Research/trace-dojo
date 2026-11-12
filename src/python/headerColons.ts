import type { SourceDiagnostic } from '../interpreter/diagnostics';
import type { IndentationError, LogicalLine } from './indentation';

/**
 * The error CPython reports before another error of a source, since it reports the first one it reads: the colon
 * missing from the header of a compound statement, or the syntax errors of the code before that header or before the
 * indentation error.
 *
 * @param syntaxErrorsOf The syntax errors of a text that has no indentation error.
 */
export function findFirstSyntaxError(
  source: string,
  lines: LogicalLine[],
  syntaxErrorsOf: (text: string) => SourceDiagnostic[],
  indentationError?: IndentationError
): SourceDiagnostic[] | undefined {
  const before = lines.slice(0, indentationError?.lineIndex);
  for (const [index, line] of before.entries()) {
    const header = headerWithoutColon(source, line, lines[index + 1]);
    if (!header) continue;
    const completed = source.slice(0, header.end) + ':\n' + body(source, line);
    const errors = syntaxErrorsOf(completed + closeTryStatements(source, before.slice(0, index + 1)));
    if (errors.length === 0) return [{ row: header.row, message: header.message }];
    if (Math.min(...errors.map((error) => error.row)) < line.row) return errors;
  }
  const last = before.at(-1);
  if (!indentationError || !last) return undefined;
  const errors = syntaxErrorsOf(codeBefore(source, lines, before));
  // An error found only in the completion is one of the last line.
  for (const error of errors) error.row = Math.min(error.row, last.endRow);
  return errors.length > 0 ? errors : undefined;
}

interface Header {
  /** The offset where the colon belongs. */
  end: number;
  row: number;
  message: string;
}

const HEADER_PATTERN =
  /^(?<keyword>if|elif|else|for|while|def|class|with|try|except|finally|async|match|case)(?![\p{L}\p{N}_])/u;
/** A clause keyword that only a colon may follow, followed by something else. */
const BARE_CLAUSE_PATTERN = /^(?:else|try|finally)[ \t]*(?![:#\\])\S/;
/** `match` followed by what cannot continue an expression that starts with a variable of that name. */
const MATCH_STATEMENT_PATTERN = /^match[ \t]+[\p{L}\p{N}_'"]/u;

/** A logical line that may be the header of a compound statement written without its colon. */
function headerWithoutColon(source: string, line: LogicalLine, next: LogicalLine | undefined): Header | undefined {
  const text = source.slice(line.start, line.end);
  const keyword = HEADER_PATTERN.exec(text)?.groups?.keyword;
  if (keyword === undefined) return undefined;
  if (BARE_CLAUSE_PATTERN.test(text)) {
    const message = `「${keyword}」のすぐ後に「:」が足りません。`;
    return { end: line.start + keyword.length, row: line.row, message };
  }
  if (line.hasColon) return undefined;
  const isIndentedNext = next !== undefined && next.indent.column > line.indent.column;
  if (keyword === 'match' && !isIndentedNext && !MATCH_STATEMENT_PATTERN.test(text)) return undefined;
  return { end: line.end, row: line.endRow, message: `「${keyword}」で始まる行の終わりに「:」が足りません。` };
}

/** The source before the lines after `before`, completed so that only an error it already had remains. */
function codeBefore(source: string, lines: LogicalLine[], before: LogicalLine[]): string {
  const next = lines.at(before.length);
  const text = next ? source.slice(0, next.offset) : `${source}\n`;
  return text + completion(source, before.at(-1) as LogicalLine) + closeTryStatements(source, before);
}

/** What the statement a line starts still needs after the line. */
function completion(source: string, line: LogicalLine): string {
  if (source[line.start] === '@') return `${indentation(source, line)}def f():\n${body(source, line)}`;
  return line.opensBlock ? body(source, line) : '';
}

/** A body for the block a header opens. */
function body(source: string, header: LogicalLine): string {
  return `${indentation(source, header)} pass\n`;
}

/** `finally` clauses for the `try` statements whose handlers come after the last of the lines. */
function closeTryStatements(source: string, lines: LogicalLine[]): string {
  const open: LogicalLine[] = [];
  for (const line of lines) {
    while (open.length > 0 && line.indent.column <= (open.at(-1) as LogicalLine).indent.column) {
      const isHandler = /^(?:except|finally)(?![\p{L}\p{N}_])/u.test(source.slice(line.start, line.end));
      const closed = open.pop() as LogicalLine;
      if (isHandler && line.indent.column === closed.indent.column) break;
    }
    if (/^try(?![\p{L}\p{N}_])/u.test(source.slice(line.start, line.end))) open.push(line);
  }
  return open
    .toReversed()
    .map((line) => `${indentation(source, line)}finally:\n${body(source, line)}`)
    .join('');
}

function indentation(source: string, line: LogicalLine): string {
  return source.slice(line.offset, line.start);
}
