// code-gauge-allow-file fileNcss -- Keeps word, brace, tilde, parameter, arithmetic, and field-splitting expansions in one cohesive Expander class.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ArithmeticSource, BackquoteSyntaxError, ParameterExpansion, Word, WordPart } from './ast';
import { expandBraces } from './braces';
import { charactersOf } from './characters';
import { EMPTY_LIST, FIELD_BREAK, FieldSplitter, type Fragment, isFieldBreak, type Piece, STAR_BREAK } from './fields';
import { applyOperator } from './parameterOperators';
import { parseSubscriptWordParts } from './parse';
import { hasPatternCharacters, matchesPattern, quotePattern } from './pattern';
import { singleQuote } from './quoting';
import { ExitSignal, SCRIPT_NAME } from './runtime';
import type { CompoundElement, Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { isIdentifier } from './variables';

/** Marks a quoted part that expands to nothing, which still makes a field (`""`), unlike `"$@"` with no elements. */
const QUOTED_EMPTY: Fragment = { text: '', quoted: true, split: false };

/** A parameter's value before its operator: one string, or the elements of `$@`, `$*`, or `${a[@]}`. */
export type ParameterValue =
  | { kind: 'scalar'; value: string | undefined }
  | { kind: 'list'; values: string[]; star: boolean; positional?: boolean };

const SPECIAL_PARAMETERS = new Set(['@', '*', '#', '?', '-', '$', '!', '0', '_']);

/** Expands words as Bash does: braces, parameters, arithmetic, command substitutions, splitting, and quotes. */
export class Expander {
  /** The status of the last command substitution, which a command of assignments alone returns. */
  lastSubstitutionStatus = 0;
  private spacedStar = false;

  constructor(private readonly shell: Shell) {}

  private spend(cost = 1): void {
    this.shell.runtime.spend(cost);
  }

  // ---------------------------------------------------------------- whole words

  /** Expands words into fields, as for a command's arguments. */
  expandWords(words: Word[]): string[] {
    const fields: string[] = [];
    for (const word of words) {
      for (const parts of expandBraces(word.parts, () => this.spend())) {
        this.checkTilde(parts, false);
        for (const field of this.splitFields(this.expandParts(parts, false))) {
          fields.push(this.finishField(field));
          if (fields.length > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
        }
      }
    }
    return fields;
  }

  /** Expands a word to one string without splitting it, as for `case` and the operands of `[[`. */
  expandString(word: Word): string {
    this.checkTilde(word.parts, false);
    return this.joinPieces(this.expandParts(word.parts, false));
  }

  /** Expands an associative array's subscript, where Bash does not perform tilde expansion. */
  expandAssociativeKey(word: Word): string {
    return this.joinPieces(this.expandParts(word.parts, false));
  }

  /** Expands an assignment's value, which Bash neither splits nor matches against file names. */
  expandAssignmentValue(word: Word): string {
    this.checkTilde(word.parts, true);
    return this.joinPieces(this.expandParts(word.parts, false));
  }

  /** Expands a word into a pattern, quoting the characters that quotes protected. */
  expandPattern(word: Word): string {
    this.checkTilde(word.parts, false);
    return this.patternOf(this.expandParts(word.parts, false));
  }

  /** Expands the right side of `=~` into an extended regular expression, escaping what quotes protected. */
  expandRegex(word: Word): string {
    this.checkTilde(word.parts, false);
    return this.flatten(this.expandParts(word.parts, false))
      .map((fragment) =>
        fragment.quoted ? fragment.text.replaceAll(/[\\^$.|?*+()[\]{}]/g, String.raw`\$&`) : fragment.text
      )
      .join('');
  }

  /** The subscript of an indexed array, expanded as text that the arithmetic evaluator then reads. */
  expandSubscriptString(word: Word): string {
    return this.joinPieces(this.expandParts(word.parts, true));
  }

  /** Expands `$` expansions, command substitutions, and quotes in an associative subscript from arithmetic text. */
  expandSubscriptText(text: string): string {
    if (!/[$`'"\\]/.test(text)) return text;
    return this.joinPieces(this.expandParts(parseSubscriptWordParts(text), false));
  }

  matches(text: string, pattern: string): boolean {
    return matchesPattern(pattern, text, () => this.spend());
  }

  /** Expands the raw elements of `name=(...)` before destination subscript/integer evaluation. */
  expandRawCompoundItems(words: Word[]): CompoundElement[] {
    const elements: CompoundElement[] = [];
    for (const word of words) {
      const keyed = splitKeyedElement(word);
      if (keyed) {
        const key = this.joinPieces(this.expandParts(keyed.key, false));
        this.checkTilde(keyed.value, true);
        const value = this.joinPieces(this.expandParts(keyed.value, false));
        elements.push({ key, value, append: keyed.append, rawText: word.text });
        continue;
      }
      for (const field of this.expandWords([word])) {
        elements.push({ plain: field, rawText: word.text });
      }
    }
    return elements;
  }

  /**
   * The elements of `name=(...)` up to the first empty key of an associative array, which Bash reports after it
   * assigns the elements before it. A declaration builtin gets the elements quoted again, as its error shows them.
   */
  expandCompound(
    words: Word[],
    isAssociative: boolean,
    declared: boolean
  ): { elements: CompoundElement[]; error?: string } {
    return this.validateCompoundItems(this.expandRawCompoundItems(words), isAssociative, declared);
  }

  validateCompoundItems(
    items: CompoundElement[],
    isAssociative: boolean,
    declared: boolean
  ): { elements: CompoundElement[]; error?: string } {
    if (!isAssociative) return { elements: items };
    const elements: CompoundElement[] = [];
    for (const item of items) {
      if (typeof item !== 'string' && !('plain' in item) && item.key === '') {
        const text = declared ? `[${singleQuote(item.key)}]=${singleQuote(item.value)}` : (item.rawText ?? '');
        return { elements, error: `${text}: bad array subscript` };
      }
      elements.push(item);
    }
    return { elements };
  }

  /** The text of an arithmetic expression after its expansions, which the evaluator reads as Bash's does. */
  arithmeticText(source: ArithmeticSource): string {
    let text = '';
    for (const piece of source.pieces) {
      text += typeof piece === 'string' ? piece : this.joinPieces(this.expandPart(piece, true));
    }
    return text;
  }

  // ---------------------------------------------------------------- parts

  /** Expands parts in order; `inDouble` tells whether they are inside double quotes. */
  expandParts(parts: WordPart[], inDouble: boolean): Piece[] {
    const pieces: Piece[] = [];
    for (const part of parts) pieces.push(...this.expandPart(part, inDouble));
    return pieces;
  }

  // code-gauge-allow functionNcss -- Dispatches each WordPart variant during word expansion.
  private expandPart(part: WordPart, inDouble: boolean): Piece[] {
    this.spend();
    switch (part.kind) {
      case 'literal': {
        return inDouble
          ? [{ text: unescapeDoubleQuoted(part.text), quoted: true, split: false }]
          : literalFragments(part.text);
      }
      case 'single':
      case 'ansiC': {
        return [{ text: part.text, quoted: true, split: false }];
      }
      case 'double': {
        const inner = this.expandParts(part.parts, true);
        // `"$@"` and `@`-subscripted array expansions with no elements make no field; any other quoted text makes one.
        if (inner.length > 0 && inner.every((piece) => piece === EMPTY_LIST)) return [];
        const kept = inner.filter((piece) => piece !== EMPTY_LIST);
        if (kept.length === 0) return [QUOTED_EMPTY];
        if (kept.every((piece) => isFieldBreak(piece))) return kept;
        return [QUOTED_EMPTY, ...kept];
      }
      case 'parameter': {
        return this.expandParameter(part, inDouble);
      }
      case 'commandSubstitution': {
        if (part.syntaxError) return this.failBackquoted(part.syntaxError, inDouble);
        const { output, status } = this.shell.captureSubshell(part.body, part.row);
        this.lastSubstitutionStatus = status;
        this.shell.state.lastStatus = status;
        if (output.includes('\0')) this.shell.reportError('warning: command substitution: ignored null byte in input');
        return [{ text: output.replaceAll('\0', '').replace(/\n+$/, ''), quoted: inDouble, split: !inDouble }];
      }
      case 'arithmeticExpansion': {
        const value = this.shell.evaluate(part.expression, undefined);
        return [{ text: String(value), quoted: inDouble, split: !inDouble }];
      }
    }
  }

  checkTilde(parts: WordPart[], afterColon: boolean): void {
    let atPrefix = true;
    for (const [index, part] of parts.entries()) {
      if (part.kind !== 'literal') {
        atPrefix = false;
        continue;
      }
      const { text } = part;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') {
          atPrefix = false;
          i++;
          continue;
        }
        if (atPrefix && c === '~' && hasUnquotedTildePrefix(parts, index, i + 1, afterColon)) {
          throw new UnsupportedFeatureError('~ の展開');
        }
        atPrefix = afterColon && c === ':';
      }
    }
  }

  // ---------------------------------------------------------------- parameters

  expandParameter(expansion: ParameterExpansion, inDouble: boolean): Piece[] {
    const { name } = expansion;
    if (!expansion.braced) {
      return this.valuePieces(this.parameterValue(name, undefined, expansion), inDouble);
    }
    if (!isValidParameterName(name) || (expansion.prefix === '#' && expansion.operator !== undefined)) {
      this.shell.discard(`${expansion.text}: bad substitution`);
    }
    const subscript = expansion.subscript ? this.subscriptText(name, expansion.subscript) : undefined;
    if (expansion.prefix === '!') return this.expandIndirect(expansion, subscript, inDouble);
    if (expansion.prefix === '#' && subscript !== undefined && subscript !== '@' && subscript !== '*') {
      return this.valuePieces(this.elementLengthValue(expansion, subscript), inDouble);
    }
    const value = this.parameterValue(name, subscript, expansion);
    if (expansion.prefix === '#') return this.valuePieces(lengthOf(value), inDouble);
    if (expansion.operator === undefined) {
      if (expansion.argument.length > 0) this.shell.discard(`${expansion.text}: bad substitution`);
      return this.valuePieces(value, inDouble);
    }
    return applyOperator(this, this.shell, expansion, value, name, subscript, inDouble);
  }

  /** `${#a[i]}`: evaluates `i` once, abandons an invalid or empty subscript, and returns the element's length. */
  private elementLengthValue(expansion: ParameterExpansion, subscript: string): ParameterValue {
    if (expansion.subscript?.text === '') this.shell.discard(`${expansion.text}: bad substitution`);
    const resolved = this.shell.resolveName(expansion.name);
    if (this.shell.isAssociative(resolved)) {
      if (subscript === '') this.shell.discard(`[${expansion.subscript?.text}]: bad array subscript`);
      return lengthOf({ kind: 'scalar', value: this.shell.elementValue(resolved, subscript) });
    }
    const index = this.shell.arrayIndex(resolved, subscript === '' ? '0' : subscript);
    if (index === undefined) this.shell.discard(`[${subscript}]: bad array subscript`);
    return lengthOf({ kind: 'scalar', value: this.shell.elementAtIndex(resolved, index) });
  }

  /** The text of a subscript: `@` and `*` as written, an associative array's key, or an indexed one's expression. */
  private subscriptText(name: string, subscript: Word): string {
    const raw = subscript.text;
    if (raw === '@' || raw === '*') return raw;
    if (this.shell.isAssociative(this.shell.resolveName(name))) return this.expandAssociativeKey(subscript);
    return this.expandSubscriptString(subscript);
  }

  parameterValue(name: string, subscript: string | undefined, expansion?: ParameterExpansion): ParameterValue {
    const { shell } = this;
    if (subscript !== undefined) {
      const resolved = shell.resolveName(name);
      if (subscript === '@' || subscript === '*') {
        return { kind: 'list', values: shell.arrayValues(resolved), star: subscript === '*' };
      }
      if (subscript === '' && expansion) return this.emptySubscriptValue(expansion, resolved);
      return { kind: 'scalar', value: shell.elementValue(resolved, subscript) };
    }
    const special = this.specialParameterValue(name);
    if (special) return special;
    const resolved = shell.resolveNameOrUndefined(name);
    if (resolved === undefined) return { kind: 'scalar', value: undefined };
    const split = shell.splitSubscript(resolved);
    if (split && (split.subscript === '@' || split.subscript === '*')) {
      const arr = shell.resolveNameOrUndefined(split.name);
      return { kind: 'list', values: arr === undefined ? [] : shell.arrayValues(arr), star: split.subscript === '*' };
    }
    return { kind: 'scalar', value: shell.scalarValue(name) };
  }

  private specialParameterValue(name: string): ParameterValue | undefined {
    const { shell } = this;
    const positional = shell.state.positional.at(-1) as string[];
    switch (name) {
      case '@':
      case '*': {
        return { kind: 'list', values: [...positional], star: name === '*', positional: true };
      }
      case '#': {
        return { kind: 'scalar', value: String(positional.length) };
      }
      case '?': {
        return { kind: 'scalar', value: String(shell.state.lastStatus) };
      }
      case '-': {
        return { kind: 'scalar', value: 'hB' };
      }
      case '$': {
        throw new UnsupportedFeatureError('プロセス番号（$$）');
      }
      case '!': {
        throw new UnsupportedFeatureError('バックグラウンドのプロセス番号（$!）');
      }
      case '0': {
        return { kind: 'scalar', value: SCRIPT_NAME };
      }
      case '_': {
        if (shell.state.lastArgument === undefined) throw new UnsupportedFeatureError('Bash のパス（最初の $_）');
        return { kind: 'scalar', value: shell.state.lastArgument };
      }
    }
    if (/^[0-9]+$/.test(name)) return { kind: 'scalar', value: positional[Number(name) - 1] };
    return undefined;
  }

  /** `${a[$k]}` whose subscript expands to nothing: element 0 of an indexed array, and an error for an associative one. */
  private emptySubscriptValue(expansion: ParameterExpansion, resolved: string): ParameterValue {
    if (expansion.subscript?.text === '') this.shell.discard(`${expansion.text}: bad substitution`);
    if (!this.shell.isAssociative(resolved)) return { kind: 'scalar', value: this.shell.elementValue(resolved, '0') };
    this.shell.reportError(`${expansion.name}: bad array subscript`);
    return { kind: 'scalar', value: undefined };
  }

  /** `${!name}`, `${!name[@]}`, and `${!prefix*}`. */
  // code-gauge-allow functionCognitiveComplexity -- Bash's indirection forms: keys, names by prefix, name references, and indirect values.
  private expandIndirect(expansion: ParameterExpansion, subscript: string | undefined, inDouble: boolean): Piece[] {
    const { shell } = this;
    const { name } = expansion;
    if (subscript === '@' || subscript === '*') {
      if (expansion.operator !== undefined) shell.discard(`${expansion.text}: bad substitution`);
      return this.valuePieces(
        { kind: 'list', values: shell.arrayKeys(shell.resolveName(name)), star: subscript === '*' },
        inDouble
      );
    }
    if ((expansion.operator === '*' || expansion.operator === '@') && expansion.argument.length === 0) {
      return this.valuePieces(
        { kind: 'list', values: this.namesWithPrefix(name), star: expansion.operator === '*' },
        inDouble
      );
    }
    const variable = subscript === undefined ? shell.findOwnVariable(name) : undefined;
    if (variable?.attributes.has('n')) {
      const target = variable.value?.kind === 'scalar' ? variable.value.value : '';
      return this.finishIndirect(expansion, { kind: 'scalar', value: target }, target, undefined, inDouble);
    }
    const direct = this.parameterValue(name, subscript, expansion);
    const reference = direct.kind === 'scalar' ? direct.value : direct.values.join(' ');
    if (reference === undefined || reference === '') {
      if (expansion.operator === undefined) this.checkIndirectReference(name, subscript);
      return this.finishIndirect(expansion, { kind: 'scalar', value: undefined }, '', undefined, inDouble);
    }
    const target = this.indirectTarget(reference);
    return this.finishIndirect(
      expansion,
      this.parameterValue(target.name, target.subscript, expansion),
      target.name,
      target.subscript,
      inDouble
    );
  }

  private finishIndirect(
    expansion: ParameterExpansion,
    value: ParameterValue,
    targetName: string,
    targetSubscript: string | undefined,
    inDouble: boolean
  ): Piece[] {
    if (expansion.operator === undefined) return this.valuePieces(value, inDouble);
    return applyOperator(this, this.shell, expansion, value, targetName, targetSubscript, inDouble);
  }

  /** Bash rejects `${!x}` for an unset variable, but not for an unset element of an array that exists. */
  private checkIndirectReference(name: string, subscript: string | undefined): void {
    if (subscript === undefined) this.shell.discard(`${name}: invalid indirect expansion`);
    if (!this.shell.findVariable(name)) this.shell.discard(`${name}[${subscript}]: invalid indirect expansion`);
  }

  private indirectTarget(reference: string): { name: string; subscript: string | undefined } {
    const split = this.shell.splitSubscript(reference);
    if (split && isIdentifier(split.name) && split.subscript !== '') {
      const resolved = this.shell.resolveName(split.name);
      const raw = split.subscript;
      if (raw === '@' || raw === '*') return { name: split.name, subscript: raw };
      const expanded = this.shell.expandDynamicSubscript(raw);
      if (this.shell.isAssociative(resolved)) return { name: split.name, subscript: expanded };
      const normalized = expanded === '' ? '0' : expanded;
      const index = this.shell.arrayIndex(resolved, normalized);
      return { name: split.name, subscript: index === undefined ? normalized : String(index) };
    }
    if (!isValidParameterName(reference)) this.shell.discard(`${reference}: invalid variable name`);
    return { name: reference, subscript: undefined };
  }

  /** The names of the variables starting with a prefix, in byte order, as `${!prefix*}` lists them. */
  // code-gauge-allow functionCognitiveComplexity -- Collects user variables while rejecting the shell's own, whose list depends on the environment.
  private namesWithPrefix(prefix: string): string[] {
    const names = new Set<string>();
    for (const scope of this.shell.state.scopes) {
      for (const variable of scope.values()) {
        if (!variable.name.startsWith(prefix)) continue;
        if (variable.isSystem) throw new UnsupportedFeatureError(`シェルの変数の一覧（\${!${prefix}*}）`);
        if (variable.value || variable.attributes.size > 0) names.add(variable.name);
      }
    }
    if ('BASH'.startsWith(prefix) || prefix.startsWith('BASH') || 'RANDOM'.startsWith(prefix) || prefix === '') {
      throw new UnsupportedFeatureError(`シェルの変数の一覧（\${!${prefix}*}）`);
    }
    return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The pieces of a value: one fragment, or one per element with breaks between them. */
  // code-gauge-allow functionCognitiveComplexity -- Bash's rules for scalars, "$*", and "$@"-like lists, inside and outside quotes.
  valuePieces(value: ParameterValue, inDouble: boolean): Piece[] {
    if (value.kind === 'scalar') {
      return value.value === undefined || value.value === ''
        ? inDouble
          ? [QUOTED_EMPTY]
          : []
        : [{ text: value.value, quoted: inDouble, split: !inDouble }];
    }
    if (value.star && inDouble) {
      return value.values.length === 0
        ? [QUOTED_EMPTY]
        : [{ text: value.values.join(this.ifsJoiner()), quoted: true, split: false }];
    }
    if (inDouble && value.values.length === 0) return [EMPTY_LIST];
    const pieces: Piece[] = [];
    const separator = this.separatorOf(value);
    for (const [index, element] of value.values.entries()) {
      if (index > 0) pieces.push(separator);
      if (element !== '') pieces.push({ text: element, quoted: inDouble, split: !inDouble });
      else pieces.push(inDouble ? QUOTED_EMPTY : { text: '', quoted: false, split: true });
    }
    if (inDouble && value.values.length > 0) pieces.unshift(QUOTED_EMPTY);
    return pieces;
  }

  /** What separates a list's elements: one that joins as `"$*"` does where words are not split, or a plain break. */
  private separatorOf(value: Extract<ParameterValue, { kind: 'list' }>): Piece {
    if (!value.star) return FIELD_BREAK;
    return value.positional && this.spacedStar && this.ifsJoiner() === '' ? FIELD_BREAK : STAR_BREAK;
  }

  /**
   * Runs an expansion in which an unquoted `$*` joins with spaces when `IFS` is empty, as Bash 5.3 joins it in the
   * word of `${x:-word}` and `${x:+word}` and in a declaration builtin's assignment, though not `${a[*]}`.
   */
  withSpacedStar<T>(run: () => T): T {
    const saved = this.spacedStar;
    this.spacedStar = true;
    try {
      return run();
    } finally {
      this.spacedStar = saved;
    }
  }

  /** The first character of `IFS`, which joins the elements of `"$*"`: a space when unset, nothing when empty. */
  ifsJoiner(): string {
    const ifs = this.shell.scalarValue('IFS');
    if (ifs === undefined) return ' ';
    return charactersOf(ifs)[0] ?? '';
  }

  // ---------------------------------------------------------------- splitting and joining

  /** Joins pieces into one string, as an expansion that is not split gives: elements of `$@` joined by spaces. */
  joinPieces(pieces: Piece[]): string {
    let text = '';
    for (const piece of pieces) {
      if (piece === EMPTY_LIST) continue;
      text += piece === FIELD_BREAK ? ' ' : piece === STAR_BREAK ? this.ifsJoiner() : piece.text;
      if (text.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    }
    return text;
  }

  /** The fragments of pieces joined into one field, as patterns need. */
  flatten(pieces: Piece[]): Fragment[] {
    return pieces
      .filter((piece): piece is Exclude<Piece, typeof EMPTY_LIST> => piece !== EMPTY_LIST)
      .map((piece) =>
        isFieldBreak(piece)
          ? { text: piece === STAR_BREAK ? this.ifsJoiner() : ' ', quoted: true, split: false }
          : piece
      );
  }

  /** The pattern pieces make, with the quoted characters escaped. */
  patternOf(pieces: Piece[]): string {
    const pattern = this.flatten(pieces)
      .map((fragment) => (fragment.quoted ? quotePattern(fragment.text) : fragment.text))
      .join('');
    // `[[ == ]]` matches extended patterns even without `shopt -s extglob`, so they cannot pass as literal text.
    if (/(?<!\\)[?*+@!]\(/.test(pattern)) throw new UnsupportedFeatureError('拡張パターン（@( ... ) など）');
    return pattern;
  }

  /** Splits pieces into fields at `IFS` characters in unquoted expansions and at the breaks between elements. */
  splitFields(pieces: Piece[]): Fragment[][] {
    const splitter = new FieldSplitter(this.shell.scalarValue('IFS') ?? ' \t\n');
    for (const piece of pieces) splitter.add(piece);
    return splitter.finish();
  }

  /** Removes the quotes from a field, after checking that it would not expand into file names. */
  finishField(field: Fragment[]): string {
    const unquoted = field.map((fragment) => (fragment.quoted ? quotePattern(fragment.text) : fragment.text)).join('');
    if (hasPatternCharacters(unquoted)) {
      throw new UnsupportedFeatureError(
        `ファイル名の展開（引用符で囲まれていない * ? [ ]。文字として使うときは "${field.map((f) => f.text).join('')}" のように引用符で囲む）`
      );
    }
    return field.map((fragment) => fragment.text).join('');
  }

  /** A backquoted body Bash cannot parse: it reports the error as it runs the substitution, which gives nothing. */
  private failBackquoted(error: BackquoteSyntaxError, inDouble: boolean): Piece[] {
    const prefix = `${SCRIPT_NAME}: command substitution: line ${error.row + 1}: `;
    for (const message of error.messages) this.shell.state.fd2.write(`${prefix}${message}\n`);
    if (error.line !== undefined) this.shell.state.fd2.write(`${prefix}\`${error.line}'\n`);
    this.lastSubstitutionStatus = 2;
    this.shell.state.lastStatus = 2;
    return [{ text: '', quoted: inDouble, split: !inDouble }];
  }

  /** Exits the shell after an error of `${x:?}`, as a non-interactive Bash does. */
  failParameter(name: string, message: string): never {
    this.shell.reportError(`${name}: ${message}`);
    throw new ExitSignal(1);
  }
}

function isValidParameterName(name: string): boolean {
  return isIdentifier(name) || /^[0-9]+$/.test(name) || SPECIAL_PARAMETERS.has(name);
}

// code-gauge-allow functionCognitiveComplexity -- Scans literal word parts from a ~ to verify no backslash or expansion quotes the tilde prefix.
function hasUnquotedTildePrefix(parts: WordPart[], partIndex: number, from: number, afterColon: boolean): boolean {
  for (let p = partIndex; p < parts.length; p++) {
    const part = parts[p];
    if (part.kind !== 'literal') return false;
    for (let i = p === partIndex ? from : 0; i < part.text.length; i++) {
      const c = part.text[i];
      if (c === '\\') return false;
      if (c === '/' || (afterColon && c === ':')) return true;
    }
  }
  return true;
}

function lengthOf(value: ParameterValue): ParameterValue {
  if (value.kind === 'list') return { kind: 'scalar', value: String(value.values.length) };
  return { kind: 'scalar', value: String(charactersOf(value.value ?? '').length) };
}

/** The fragments of unquoted literal text: a backslash quotes the character after it. */
// code-gauge-allow functionCognitiveComplexity -- Bash's quote removal of backslashes, including the one that ends a word.
function literalFragments(text: string): Fragment[] {
  const fragments: Fragment[] = [];
  let plain = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Quote removal drops a backslash that ends a word, as one that brace expansion makes can, leaving the field.
    if (c === '\\' && i + 1 === text.length) {
      if (plain) fragments.push({ text: plain, quoted: false, split: false });
      fragments.push({ text: '', quoted: true, split: false });
      return fragments;
    }
    if (c === '\\') {
      if (plain) fragments.push({ text: plain, quoted: false, split: false });
      plain = '';
      const next = text.codePointAt(i + 1) as number;
      const char = String.fromCodePoint(next);
      if (char !== '\n') fragments.push({ text: char, quoted: true, split: false });
      i += char.length;
      continue;
    }
    plain += c;
  }
  if (plain) fragments.push({ text: plain, quoted: false, split: false });
  return fragments;
}

/** Removes the backslashes that quote `$`, `` ` ``, `"`, `\`, and newlines inside double quotes. */
export function unescapeDoubleQuoted(text: string): string {
  return text.replaceAll(/\\([$`"\\\n])/g, (_, c: string) => (c === '\n' ? '' : c));
}

/** Splits an array element written `[key]=value` or `[key]+=value` into its parts. */
// code-gauge-allow functionCognitiveComplexity -- Splits a word at its [key]= prefix across literal and expanded parts, as Bash scans the unexpanded word.
function splitKeyedElement(word: Word): { key: WordPart[]; value: WordPart[]; append: boolean } | undefined {
  const [first] = word.parts;
  if (first?.kind !== 'literal' || !first.text.startsWith('[')) return undefined;
  const key: WordPart[] = [];
  const depth = { value: 0 };
  for (const [index, part] of word.parts.entries()) {
    if (part.kind !== 'literal') {
      key.push(part);
      continue;
    }
    const text = index === 0 ? part.text.slice(1) : part.text;
    const close = closingBracket(text, depth);
    if (close === undefined) {
      if (text) key.push({ kind: 'literal', text });
      continue;
    }
    const after = text.slice(close + 1);
    const append = after.startsWith('+=');
    if (!append && !after.startsWith('=')) return undefined;
    if (close > 0) key.push({ kind: 'literal', text: text.slice(0, close) });
    const rest = after.slice(append ? 2 : 1);
    return {
      key,
      value: [...(rest ? [{ kind: 'literal' as const, text: rest }] : []), ...word.parts.slice(index + 1)],
      append,
    };
  }
  return undefined;
}

/** The index of the `]` in `text` that closes the subscript, counting brackets opened in earlier texts in `depth`. */
function closingBracket(text: string, depth: { value: number }): number | undefined {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '[') depth.value++;
    else if (c === ']' && depth.value === 0) return i;
    else if (c === ']') depth.value--;
  }
  return undefined;
}
