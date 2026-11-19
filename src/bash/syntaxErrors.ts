import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';

/** The words that Bash reads as reserved words in a command's position, which then end a construct. */
export const CLOSING_RESERVED_WORDS = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}', 'in']);

/** The constructs whose opening word Bash names when the file ends before their closing word. */
const OPENING_WORDS = new Set(['if', 'while', 'until', 'for', 'select', 'case', '{']);

/** The word that closes each construct Bash names when the file ends inside it. */
const CLOSERS: Record<string, string> = {
  if: 'fi',
  while: 'done',
  until: 'done',
  for: 'done',
  select: 'done',
  case: 'esac',
  '{': '}',
};

/** The closing delimiters Bash looks for when the file ends inside a quote or a substitution. */
const MATCHING_DELIMITERS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '`': '`',
  ')': ')',
  '))': ')',
  ']': ']',
};

/** The message for learners that quotes Bash's own message. */
export function syntaxErrorMessage(bashMessage: string): string {
  return `構文エラーです（${bashMessage}）。`;
}

/** The message for a reserved word or an operator where Bash expects none. */
export function unexpectedTokenMessage(token: string): string {
  return syntaxErrorMessage(`syntax error near unexpected token \`${token}'`);
}

/** Bash's syntax error for the first error a tree shows, located at its row. */
export function syntaxErrorsOf(root: Node, source: string, isBenign: (node: Node) => boolean): SourceDiagnostic[] {
  if (!root.hasError || isExplainedBy(root, isBenign)) return [];
  const missing = firstNode(root, (node) => node.isMissing);
  const error = firstNode(root, (node) => node.isError);
  const first =
    missing && (!error || missing.startIndex < error.startIndex || isInside(missing, error)) ? missing : error;
  if (!first) return [{ row: 0, message: syntaxErrorMessage('syntax error') }];
  if (first.isMissing) return [missingDiagnostic(first, source)];
  return [errorDiagnostic(first, source)];
}

function isExplainedBy(node: Node, isBenign: (node: Node) => boolean): boolean {
  return (
    isBenign(node) ||
    (!node.isError &&
      !node.isMissing &&
      node.children.some((child) => child.hasError) &&
      node.children.every((child) => !child.hasError || isExplainedBy(child, isBenign)))
  );
}

function isInside(node: Node, container: Node): boolean {
  return node.startIndex >= container.startIndex && node.endIndex <= container.endIndex;
}

function firstNode(root: Node, predicate: (node: Node) => boolean): Node | undefined {
  const pending: Node[] = [root];
  let found: Node | undefined;
  while (pending.length > 0) {
    const node = pending.pop() as Node;
    if (predicate(node)) {
      if (!found || node.startIndex < found.startIndex) found = node;
      continue;
    }
    if (!node.hasError && !node.isMissing) continue;
    for (const child of node.children) pending.push(child);
  }
  return found;
}

function missingDiagnostic(node: Node, source: string): SourceDiagnostic {
  const delimiter = MATCHING_DELIMITERS[node.type];
  const lastRow = Math.max(0, source.replace(/\n$/, '').split('\n').length - 1);
  if (delimiter) {
    return {
      row: Math.min(node.startPosition.row, lastRow),
      message: syntaxErrorMessage(`unexpected EOF while looking for matching \`${delimiter}'`),
    };
  }
  if (node.type === ']]') return { row: node.startPosition.row, message: conditionalMessage(node) };
  if (node.type === '}' && node.parent?.type === 'expansion') {
    return {
      row: Math.min(node.startPosition.row, lastRow),
      message: syntaxErrorMessage("unexpected EOF while looking for matching `}'"),
    };
  }
  const opener = openerOf(node);
  if (opener) {
    return {
      row: opener.startPosition.row,
      message: syntaxErrorMessage(
        `syntax error: unexpected end of file from \`${opener.type}' command on line ${opener.startPosition.row + 1}`
      ),
    };
  }
  return {
    row: Math.min(node.startPosition.row, lastRow),
    message: syntaxErrorMessage('syntax error: unexpected end of file'),
  };
}

/** The opening word of the construct a missing closing word belongs to. */
function openerOf(node: Node): Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const opener = parent.children.find((child) => !child.isNamed && OPENING_WORDS.has(child.type));
    if (opener) return opener;
  }
  return undefined;
}

function conditionalMessage(node: Node): string {
  const test = node.parent?.children.find((child) => child.isNamed);
  if (test?.type === 'unary_test') return syntaxErrorMessage("unexpected argument `]]' to conditional unary operator");
  if (test?.type === 'binary_test')
    return syntaxErrorMessage("unexpected argument `]]' to conditional binary operator");
  return syntaxErrorMessage('syntax error in conditional expression');
}

const OPERATOR_PATTERN = /^(?:;;&|;;|;&|\|\||&&|\|&|;|&|\(\(|\)\)|\(|\)|\||<<<|<<-|<<|>>|<&|>&|<>|<|>|\{|\})/;

/** The diagnostic for text the parser could not read, naming the token Bash stops at. */
function errorDiagnostic(node: Node, source: string): SourceDiagnostic {
  const reserved = firstNode(node, (child) => child.type === 'command' && isReservedCommand(child));
  if (reserved) return { row: reserved.startPosition.row, message: unexpectedTokenMessage(commandWord(reserved)) };
  const opener = node.children.find((child) => !child.isNamed && OPENING_WORDS.has(child.type));
  const closer = opener ? CLOSERS[opener.type] : undefined;
  const closes = node.children.some(
    (child) => child.type === closer || (child.type === 'command' && commandWord(child) === closer)
  );
  if (opener && !closes) {
    return {
      row: opener.startPosition.row,
      message: syntaxErrorMessage(
        `syntax error: unexpected end of file from \`${opener.type}' command on line ${opener.startPosition.row + 1}`
      ),
    };
  }
  const leaf = firstLeaf(node);
  let start = leaf?.startIndex ?? node.startIndex;
  // An operator the parser split, such as the second `;` of `;;`, starts where the operator does.
  while (start > 0 && /[;&|]/.test(source[start - 1]) && /[;&|]/.test(source[start])) start--;
  const rest = source.slice(start);
  const token = OPERATOR_PATTERN.exec(rest)?.[0] ?? /^\S+/.exec(rest)?.[0] ?? 'newline';
  if (token.startsWith('$(') || token.startsWith('((') || token === '(') {
    return {
      row: (leaf ?? node).startPosition.row,
      message: syntaxErrorMessage("unexpected EOF while looking for matching `)'"),
    };
  }
  return { row: (leaf ?? node).startPosition.row, message: unexpectedTokenMessage(token) };
}

function firstLeaf(node: Node): Node | undefined {
  if (node.childCount === 0) return node;
  for (const child of node.children) {
    const leaf = firstLeaf(child);
    if (leaf) return leaf;
  }
  return undefined;
}

/** Whether a command's name is a closing reserved word, which Bash reads as that word rather than as a command. */
export function isReservedCommand(command: Node): boolean {
  const name = command.childForFieldName('name');
  if (!name || name.namedChildCount !== 1) return false;
  const word = name.namedChildren[0];
  return word?.type === 'word' && CLOSING_RESERVED_WORDS.has(word.text) && word.text !== 'in';
}

function commandWord(command: Node): string {
  return command.childForFieldName('name')?.text ?? command.text;
}
