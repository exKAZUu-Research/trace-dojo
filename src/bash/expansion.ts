// code-gauge-allow-file fileNcss -- Keeps word, brace, tilde, parameter, arithmetic, and field-splitting expansions in one cohesive stateless Expander.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ArithmeticSource, BackquoteSyntaxError, ParameterExpansion, Word, WordPart } from './ast';
import { expandBraces } from './braces';
import { rejectUnsupportedExpansion, rejectUnsupportedPathnameExpansion } from './capabilities';
import { charactersOf } from './characters';
import {
  type BreakSegment,
  breakSegment,
  DEFAULT_WORD_CONTEXT,
  EMPTY_LIST_SEGMENT,
  isBreakSegment,
  QUOTED_EMPTY_SEGMENT,
  splitWordSegments,
  type TextSegment,
  textSegment,
  type WordContext,
  type WordSegment,
} from './fields';
import { applyOperator } from './parameterOperators';
import { parseSubscriptWordParts, rawArithmeticPieces } from './parse';
import { hasExtendedGlob, hasPatternCharacters, matchesPattern, quotePattern } from './pattern';
import { singleQuote } from './quoting';
import { ExitSignal, SCRIPT_NAME } from './runtime';
import type { Shell } from './shell';
import { readResolvedTarget, resolveSubscriptTarget, resolveTargetName } from './targets';
import { type CompoundElement, isIdentifier } from './variables';

/** A parameter's value before its operator: one string, or the elements of `$@`, `$*`, or `${a[@]}`. */
export type ParameterValue =
  | { kind: 'scalar'; value: string | undefined }
  | { kind: 'list'; values: string[]; star: boolean; positional?: boolean; transformed?: boolean };

/** An expanded parameter subscript, preserving whether `@` or `*` was written as a whole-array operator. */
export interface SubscriptRef {
  readonly text: string;
  readonly wholeArray: boolean;
  readonly rawText: string;
  readonly word?: Word;
}

const SPECIAL_PARAMETERS = new Set(['@', '*', '#', '?', '-', '$', '!', '0', '_']);

/**
 * Stateless per-word expander: passes immutable `WordContext` explicitly and emits typed `WordSegment` lists
 * split by the pure `splitWordSegments` function, while registering live builders in `Shell` for turtle GC.
 */
export class Expander {
  /** Status of the most recent command substitution within the current simple command. */
  lastSubstitutionStatus = 0;

  constructor(private readonly shell: Shell) {}

  private spend(cost = 1): void {
    this.shell.runtime.spend(cost);
  }

  // ---------------------------------------------------------------- whole words

  /** Expands words into split fields, as for a command's arguments or a `for` header. */
  expandWords(words: Word[]): string[] {
    const fields: string[] = [];
    return this.shell.withValuesRoot(fields, () => {
      for (const word of words) {
        for (const parts of expandBraces(word.parts, () => this.spend())) {
          this.checkTilde(parts, false);
          for (const field of this.splitFields(this.expandParts(parts, DEFAULT_WORD_CONTEXT))) {
            fields.push(this.finishField(field));
            if (fields.length > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
          }
        }
      }
      return fields;
    });
  }

  /** Expands a word to one string without splitting it, as for `case` and the operands of `[[`. */
  expandString(word: Word): string {
    this.checkTilde(word.parts, false);
    return this.joinSegments(this.expandParts(word.parts, DEFAULT_WORD_CONTEXT));
  }

  /** Expands an associative array's subscript, where Bash does not perform tilde expansion. */
  expandAssociativeKey(word: Word): string {
    return this.joinSegments(this.expandParts(word.parts, DEFAULT_WORD_CONTEXT));
  }

  /** Expands an assignment's subscript in a declaration word (`a[k]=v`), joining list breaks with each list's `IFS` or a space. */
  expandAssignmentSubscript(word: Word): string {
    return this.joinSegments(this.expandParts(word.parts, { inDouble: false, spacedStar: true }), true);
  }

  /** Expands an assignment's value, optionally joining `$*` with spaces when `IFS` is empty (`spacedStar`). */
  expandAssignmentValue(word: Word, spacedStar = false): string {
    this.checkTilde(word.parts, true);
    return this.joinSegments(this.expandParts(word.parts, { inDouble: false, spacedStar, inAssignmentValue: true }));
  }

  /** Expands a word into a glob pattern, quoting characters protected by quotes. */
  expandPattern(word: Word): string {
    this.checkTilde(word.parts, false);
    return this.patternOf(this.expandParts(word.parts, DEFAULT_WORD_CONTEXT));
  }

  /** Expands the right side of `=~` into an ERE, escaping characters protected by quotes. */
  expandRegex(word: Word): string {
    this.checkTilde(word.parts, false);
    let regex = '';
    const spend = (cost?: number): void => this.spend(cost);
    for (const fragment of this.flatten(this.expandParts(word.parts, DEFAULT_WORD_CONTEXT))) {
      const chunk = fragment.quoted ? fragment.text.replaceAll(/[\\^$.|?*+()[\]{}]/g, String.raw`\$&`) : fragment.text;
      regex = appendBounded(regex, chunk, spend);
    }
    return regex;
  }

  /** Expands an indexed array's subscript into text for arithmetic evaluation, preserving single-quote syntax. */
  expandSubscriptString(word: Word, unquoteAnsiC = false): string {
    const pieces = word.parts.map((part): string | WordPart => {
      if (part.kind === 'single') return `'${part.text}'`;
      if (part.kind === 'literal') return unescapeDoubleQuoted(part.text);
      return part;
    });
    return this.arithmeticText({ pieces, row: word.row }, unquoteAnsiC);
  }

  /** Expands `$` expansions, command substitutions, and double quotes in a runtime indexed subscript, keeping `'...'`. */
  expandIndexedSubscriptText(text: string): string {
    if (!/[$`"\\]/.test(text)) return text;
    return this.arithmeticText({ pieces: rawArithmeticPieces(text), row: this.shell.currentRow });
  }

  /** Expands `$` expansions, command substitutions, and quotes in a runtime associative key. */
  expandSubscriptText(text: string): string {
    if (!/[$`'"\\]/.test(text)) return text;
    return this.joinSegments(this.expandParts(parseSubscriptWordParts(text), DEFAULT_WORD_CONTEXT));
  }

  matches(text: string, pattern: string, extmatch = false): boolean {
    return matchesPattern(pattern, text, () => this.spend(), extmatch);
  }

  /** Expands raw compound items of `name=(...)` while keeping completed items rooted for turtle GC. */
  expandRawCompoundItems(words: Word[], isAssociative = false): CompoundElement[] {
    const roots: string[] = [];
    return this.shell.withValuesRoot(roots, () => {
      if (isAssociative && words.length > 0 && !splitKeyedElement(words[0])) {
        return words.map((word) => {
          const plain = this.expandAssignmentValue(word);
          roots.push(plain);
          return { plain, rawText: word.text };
        });
      }
      const elements: CompoundElement[] = [];
      for (const word of words) {
        const keyed = splitKeyedElement(word);
        if (keyed) {
          const key = this.joinSegments(this.expandParts(keyed.key, DEFAULT_WORD_CONTEXT));
          roots.push(key);
          this.checkTilde(keyed.value, true);
          const value = this.joinSegments(this.expandParts(keyed.value, DEFAULT_WORD_CONTEXT));
          roots.push(value);
          elements.push({ key, value, append: keyed.append, rawText: word.text });
          continue;
        }
        if (isAssociative) {
          const plain = this.expandAssignmentValue(word);
          roots.push(plain);
          elements.push({ plain, rawText: word.text });
          continue;
        }
        for (const field of this.expandWords([word])) {
          roots.push(field);
          elements.push({ plain: field, rawText: word.text });
        }
      }
      return elements;
    });
  }

  expandCompound(
    words: Word[],
    isAssociative: boolean,
    declared: boolean,
    reportedName = ''
  ): { elements: CompoundElement[]; error?: string } {
    if (isAssociative && !declared && words.length > 0) {
      return splitKeyedElement(words[0])
        ? this.expandKeyedAssociative(words, reportedName)
        : this.expandAlternatingAssociative(words);
    }
    return this.validateCompoundItems(
      this.expandRawCompoundItems(words, isAssociative),
      isAssociative,
      declared,
      reportedName
    );
  }

  expandAssociativeAppend(
    words: Word[],
    reportedName: string,
    onPair: (key: string, value: string, append: boolean) => boolean
  ): string | undefined {
    if (words.length === 0) return undefined;
    if (splitKeyedElement(words[0])) return this.expandKeyedAssociative(words, reportedName, onPair).error;
    this.expandAlternatingAssociative(words, onPair);
    return undefined;
  }

  private expandKeyedAssociative(
    words: Word[],
    reportedName: string,
    onPair?: (key: string, value: string, append: boolean) => boolean
  ): { elements: CompoundElement[]; error?: string } {
    const roots: string[] = [];
    return this.shell.withValuesRoot(roots, () => {
      const elements: CompoundElement[] = [];
      for (const word of words) {
        const outcome = this.expandOneKeyedPair(word, reportedName, roots);
        if ('error' in outcome) return { elements, error: outcome.error };
        if (!emitKeyedPair(elements, outcome, onPair)) return { elements };
      }
      return { elements };
    });
  }

  private expandOneKeyedPair(
    word: Word,
    reportedName: string,
    roots: string[]
  ): { key: string; value: string; append: boolean; rawText: string } | { error: string | undefined } {
    const keyed = splitKeyedElement(word);
    if (!keyed) {
      return { error: compoundItemValidationError({ plain: word.text, rawText: word.text }, false, reportedName) };
    }
    const key = this.joinSegments(this.expandParts(keyed.key, DEFAULT_WORD_CONTEXT));
    if (key === '') return { error: `${word.text}: bad array subscript` };
    roots.push(key);
    this.checkTilde(keyed.value, true);
    const value = this.joinSegments(this.expandParts(keyed.value, DEFAULT_WORD_CONTEXT));
    roots.push(value);
    return { key, value, append: keyed.append, rawText: word.text };
  }

  private expandAlternatingAssociative(
    words: Word[],
    onPair?: (key: string, value: string, append: boolean) => boolean
  ): { elements: CompoundElement[] } {
    const roots: string[] = [];
    return this.shell.withValuesRoot(roots, () => {
      const elements: CompoundElement[] = [];
      for (let i = 0; i < words.length; i += 2) {
        const key = this.expandAssignmentValue(words[i]);
        if (key === '') {
          this.shell.reportError(`${words[i].text}: bad array subscript`);
          continue;
        }
        roots.push(key);
        const value = i + 1 < words.length ? this.expandAssignmentValue(words[i + 1]) : '';
        roots.push(value);
        if (!emitAlternatingPair(elements, words, i, key, value, onPair)) return { elements };
      }
      return { elements };
    });
  }

  validateCompoundItems(
    items: CompoundElement[],
    isAssociative: boolean,
    declared: boolean,
    reportedName = ''
  ): { elements: CompoundElement[]; error?: string } {
    const keyedMode = items.length > 0 && typeof items[0] !== 'string' && !('plain' in items[0]);
    if (!isAssociative || !keyedMode) return { elements: items };
    const elements: CompoundElement[] = [];
    for (const item of items) {
      const error = compoundItemValidationError(item, declared, reportedName);
      if (error !== undefined) return { elements, error };
      elements.push(item);
    }
    return { elements };
  }

  /** Substitutes expansions inside an arithmetic expression before evaluating it. */
  arithmeticText(source: ArithmeticSource, unquoteAnsiC = false): string {
    return this.arithmeticTextWithMask(source, unquoteAnsiC).text;
  }

  /** Substitutes expansions inside an arithmetic expression and records indices produced by expanded/quoted parts. */
  arithmeticTextWithMask(
    source: ArithmeticSource,
    unquoteAnsiC = false
  ): { text: string; quoted: ReadonlySet<number> } {
    return this.shell.withBuilderRoot((builder) => {
      const spend = (cost?: number): void => this.spend(cost);
      const doubleCtx: WordContext = { inDouble: true, spacedStar: false };
      const quoted = new Set<number>();
      for (const piece of source.pieces) {
        if (typeof piece === 'string') {
          builder.text = appendBounded(builder.text, piece, spend);
        } else if (piece.kind === 'ansiC' && !unquoteAnsiC) {
          builder.text = appendMaskedAnsiC(builder.text, piece.text, quoted, spend);
        } else {
          const chunk = this.joinSegments(this.expandPart(piece, doubleCtx));
          const start = builder.text.length;
          builder.text = appendBounded(builder.text, chunk, spend);
          for (let i = start; i < builder.text.length; i++) quoted.add(i);
        }
      }
      return { text: builder.text, quoted };
    });
  }

  // ---------------------------------------------------------------- parts

  /** Expands `parts` with explicit `ctx`, rooting complete live builder text for turtle GC. */
  expandParts(parts: WordPart[], ctx: WordContext): WordSegment[] {
    const segments: WordSegment[] = [];
    const fieldTexts: string[] = [];
    return this.shell.withValuesRoot(fieldTexts, () =>
      this.shell.withBuilderRoot((builder) => {
        const spend = (cost?: number): void => this.spend(cost);
        for (const part of parts) {
          for (const seg of this.expandPart(part, ctx)) {
            segments.push(seg);
            recordSegmentBuilderText(seg, builder, fieldTexts, spend);
          }
        }
        return segments;
      })
    );
  }

  private expandPart(part: WordPart, ctx: WordContext): WordSegment[] {
    this.spend();
    switch (part.kind) {
      case 'literal': {
        return ctx.inDouble
          ? [textSegment(unescapeDoubleQuoted(part.text, ctx.inOperatorWord), true, false)]
          : literalSegments(part.text);
      }
      case 'single':
      case 'ansiC': {
        return [textSegment(part.text, true, false)];
      }
      case 'double': {
        return this.expandDoublePart(part.parts, ctx);
      }
      case 'parameter': {
        return this.expandParameter(part, ctx);
      }
      case 'commandSubstitution': {
        return this.expandCommandSubstitution(part, ctx.inDouble);
      }
      case 'arithmeticExpansion': {
        const value = this.shell.evaluate(part.expression, undefined);
        return [textSegment(String(value), ctx.inDouble, !ctx.inDouble)];
      }
    }
  }

  private expandDoublePart(parts: WordPart[], ctx: WordContext): WordSegment[] {
    const inner = this.expandParts(parts, {
      inDouble: true,
      spacedStar: ctx.spacedStar,
      ...(ctx.inOperatorWord ? { inOperatorWord: true } : {}),
    });
    if (inner.length > 0 && inner.every((seg) => seg.kind === 'emptyList')) return [];
    const kept = inner.filter((seg) => seg.kind !== 'emptyList');
    if (kept.length === 0) return [QUOTED_EMPTY_SEGMENT];
    if (kept.every(isBreakSegment)) return kept;
    return [QUOTED_EMPTY_SEGMENT, ...kept];
  }

  private expandCommandSubstitution(
    part: Extract<WordPart, { kind: 'commandSubstitution' }>,
    inDouble: boolean
  ): WordSegment[] {
    if (part.syntaxError) return this.failBackquoted(part.syntaxError, inDouble);
    const { output, status } = this.shell.captureSubshell(part.body, part.row);
    this.lastSubstitutionStatus = status;
    this.shell.store.lastStatus = status;
    if (output.includes('\0')) this.shell.reportError('warning: command substitution: ignored null byte in input');
    return [textSegment(output.replaceAll('\0', '').replace(/\n+$/, ''), inDouble, !inDouble)];
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
          rejectUnsupportedExpansion('tilde');
        }
        atPrefix = afterColon && c === ':';
      }
    }
  }

  // ---------------------------------------------------------------- parameters

  expandParameter(expansion: ParameterExpansion, ctx: WordContext): WordSegment[] {
    const { name } = expansion;
    if (!expansion.braced) {
      return this.valueSegments(this.parameterValue(name, undefined, expansion), ctx);
    }
    if (!isValidParameterName(name) || (expansion.prefix === '#' && expansion.operator !== undefined)) {
      this.shell.discard(`${expansion.text}: bad substitution`);
    }
    if (
      expansion.prefix === '#' &&
      expansion.subscript !== undefined &&
      expansion.subscript.text !== '@' &&
      expansion.subscript.text !== '*'
    ) {
      return this.valueSegments(this.elementLengthValue(expansion), ctx);
    }
    const subscript = expansion.subscript ? this.subscriptRef(name, expansion.subscript) : undefined;
    if (expansion.prefix === '!') return this.expandIndirect(expansion, subscript, ctx);
    if (expansion.prefix === '#') return this.expandLength(name, subscript, expansion, ctx);
    const value = this.parameterValue(name, subscript, expansion);
    if (expansion.operator === undefined) {
      if (expansion.argument.length > 0) this.shell.discard(`${expansion.text}: bad substitution`);
      return this.valueSegments(value, ctx);
    }
    return applyOperator(this, this.shell, expansion, value, name, subscript, ctx);
  }

  private expandLength(
    name: string,
    subscript: SubscriptRef | undefined,
    expansion: ParameterExpansion,
    ctx: WordContext
  ): WordSegment[] {
    if (subscript?.wholeArray) {
      const resolved = resolveTargetName(this.shell, name);
      const count = resolved === undefined ? 0 : this.shell.store.readArrayLength(resolved);
      return this.valueSegments({ kind: 'scalar', value: String(count) }, ctx);
    }
    return this.valueSegments(lengthOf(this.parameterValue(name, subscript, expansion)), ctx);
  }

  private elementLengthValue(expansion: ParameterExpansion): ParameterValue {
    const rawSubscript = expansion.subscript as Word;
    if (rawSubscript.text === '') this.shell.discard(`${expansion.text}: bad substitution`);
    const resolved = resolveTargetName(this.shell, expansion.name);
    if (resolved === undefined || !this.shell.store.hasMaterializedTarget(resolved)) {
      return { kind: 'scalar', value: '0' };
    }
    const target = resolveSubscriptTarget(this.shell, {
      name: expansion.name,
      subscript: { kind: 'word', word: rawSubscript, unquoteAnsiC: true },
      operation: 'read',
    });
    if (!target) return { kind: 'scalar', value: '0' };
    if (target.kind === 'invalid') {
      this.shell.discard(target.failure.message || `[${rawSubscript.text}]: bad array subscript`);
    }
    return lengthOf({ kind: 'scalar', value: readResolvedTarget(this.shell, target) });
  }

  private subscriptRef(name: string, subscript: Word): SubscriptRef {
    const raw = subscript.text;
    if (raw === '@' || raw === '*') return { text: raw, wholeArray: true, rawText: raw, word: subscript };
    const resolved = resolveTargetName(this.shell, name, false) ?? name;
    const text = this.shell.store.isAssociativeName(resolved)
      ? this.expandAssociativeKey(subscript)
      : this.expandSubscriptString(subscript, true);
    return { text, wholeArray: false, rawText: raw, word: subscript };
  }

  parameterValue(name: string, subscript: SubscriptRef | undefined, expansion?: ParameterExpansion): ParameterValue {
    if (subscript !== undefined) return this.subscriptedParameterValue(name, subscript, expansion);
    const special = this.specialParameterValue(name);
    if (special) return special;
    return {
      kind: 'scalar',
      value: this.shell.store.readScalar(name, (c) => this.shell.reportError(`warning: ${c}: circular name reference`)),
    };
  }

  private subscriptedParameterValue(
    name: string,
    subscript: SubscriptRef,
    expansion?: ParameterExpansion
  ): ParameterValue {
    const resolved = resolveTargetName(this.shell, name);
    if (resolved === undefined) {
      return subscript.wholeArray
        ? { kind: 'list', values: [], star: subscript.text === '*' }
        : { kind: 'scalar', value: undefined };
    }
    if (subscript.wholeArray) {
      return { kind: 'list', values: this.shell.store.readArrayValues(resolved), star: subscript.text === '*' };
    }
    if (subscript.rawText === '' && expansion) this.shell.discard(`${expansion.text}: bad substitution`);
    if (subscript.text === '' && this.shell.store.isAssociativeName(resolved)) {
      this.shell.reportError(`${name}: bad array subscript`);
      return { kind: 'scalar', value: undefined };
    }
    const target = resolveSubscriptTarget(this.shell, {
      name,
      subscript: { kind: 'text', text: subscript.text === '' ? '0' : subscript.text, preExpanded: true },
      operation: 'read',
    });
    if (!target) return { kind: 'scalar', value: undefined };
    if (target.kind === 'invalid') {
      if (target.failure.message !== '') this.shell.reportError(target.failure.message);
      return { kind: 'scalar', value: undefined };
    }
    return { kind: 'scalar', value: readResolvedTarget(this.shell, target) };
  }

  private specialParameterValue(name: string): ParameterValue | undefined {
    const positional = this.shell.store.positionalArgs();
    switch (name) {
      case '@':
      case '*': {
        return { kind: 'list', values: [...positional], star: name === '*', positional: true };
      }
      case '#': {
        return { kind: 'scalar', value: String(positional.length) };
      }
      case '?': {
        return { kind: 'scalar', value: String(this.shell.store.lastStatus) };
      }
      case '-': {
        return { kind: 'scalar', value: 'hB' };
      }
      case '$': {
        return rejectUnsupportedExpansion('pid');
      }
      case '!': {
        return rejectUnsupportedExpansion('bgPid');
      }
      case '0': {
        return { kind: 'scalar', value: SCRIPT_NAME };
      }
      case '_': {
        if (this.shell.store.lastArgument === undefined) rejectUnsupportedExpansion('initialLastArg');
        return { kind: 'scalar', value: this.shell.store.lastArgument };
      }
    }
    if (/^[0-9]+$/.test(name)) return { kind: 'scalar', value: positional[Number(name) - 1] };
    return undefined;
  }

  private expandIndirect(
    expansion: ParameterExpansion,
    subscript: SubscriptRef | undefined,
    ctx: WordContext
  ): WordSegment[] {
    const { name } = expansion;
    if (subscript?.wholeArray) {
      if (expansion.operator !== undefined) this.shell.discard(`${expansion.text}: bad substitution`);
      const resolved = resolveTargetName(this.shell, name);
      const keys = resolved === undefined ? [] : this.shell.store.readArrayKeys(resolved);
      return this.valueSegments({ kind: 'list', values: keys, star: subscript.text === '*' }, ctx);
    }
    if ((expansion.operator === '*' || expansion.operator === '@') && expansion.argument.length === 0) {
      return this.valueSegments(
        { kind: 'list', values: this.shell.store.namesWithPrefix(name), star: expansion.operator === '*' },
        ctx
      );
    }
    const own = subscript === undefined ? this.shell.store.ownView(name) : undefined;
    if (own?.attributes.has('n')) {
      const target = own.scalar ?? '';
      return this.finishIndirect(expansion, { kind: 'scalar', value: target }, target, undefined, ctx);
    }
    const direct = this.parameterValue(name, subscript, expansion);
    const reference = direct.kind === 'scalar' ? direct.value : direct.values.join(' ');
    if (reference === undefined || reference === '') {
      if (expansion.operator === undefined) this.checkIndirectReference(name, subscript?.text);
      return this.finishIndirect(expansion, { kind: 'scalar', value: undefined }, '', undefined, ctx);
    }
    const target = this.indirectTarget(reference);
    return this.finishIndirect(
      expansion,
      this.parameterValue(target.name, target.subscript, expansion),
      target.name,
      target.subscript,
      ctx
    );
  }

  private finishIndirect(
    expansion: ParameterExpansion,
    value: ParameterValue,
    targetName: string,
    targetSubscript: SubscriptRef | undefined,
    ctx: WordContext
  ): WordSegment[] {
    if (expansion.operator === undefined) return this.valueSegments(value, ctx);
    return applyOperator(this, this.shell, expansion, value, targetName, targetSubscript, ctx);
  }

  private checkIndirectReference(name: string, subscript: string | undefined): void {
    if (subscript === undefined) this.shell.discard(`${name}: invalid indirect expansion`);
    const resolved = resolveTargetName(this.shell, name, false);
    if (resolved === undefined || !this.shell.store.ownView(resolved)) {
      this.shell.discard(`${name}[${subscript}]: invalid indirect expansion`);
    }
  }

  private indirectTarget(reference: string): { name: string; subscript: SubscriptRef | undefined } {
    const split = this.shell.splitSubscript(reference);
    if (split && isIdentifier(split.name) && split.subscript !== '') {
      const raw = split.subscript;
      if (raw === '@' || raw === '*') {
        return { name: split.name, subscript: { text: raw, wholeArray: true, rawText: raw } };
      }
      const resolved = resolveTargetName(this.shell, split.name, false) ?? split.name;
      const expanded = this.shell.store.isAssociativeName(resolved)
        ? this.expandSubscriptText(raw)
        : this.expandIndexedSubscriptText(raw);
      return { name: split.name, subscript: { text: expanded, wholeArray: false, rawText: raw } };
    }
    if (!isValidParameterName(reference)) this.shell.discard(`${reference}: invalid variable name`);
    return { name: reference, subscript: undefined };
  }

  valueSegments(value: ParameterValue, ctx: WordContext): WordSegment[] {
    const { inDouble } = ctx;
    if (value.kind === 'scalar') return scalarValueSegments(value.value, inDouble);
    const listOrigin = !(value.star && (inDouble || ctx.inOperatorWord));
    if (value.star && inDouble) return this.quotedStarSegments(value.values);
    if (inDouble && value.values.length === 0) return [EMPTY_LIST_SEGMENT];
    const segments: WordSegment[] = [];
    const separator = this.separatorOf(value, ctx.spacedStar);
    for (const [index, element] of value.values.entries()) {
      if (index > 0) segments.push(separator);
      segments.push(listElementSegment(element, inDouble, value.star, listOrigin));
    }
    if (inDouble && value.values.length > 0) segments.unshift(QUOTED_EMPTY_SEGMENT);
    return segments;
  }

  private quotedStarSegments(values: readonly string[]): WordSegment[] {
    if (values.length === 0) return [QUOTED_EMPTY_SEGMENT];
    const joined = joinBounded(values, this.ifsJoiner(), (cost) => this.spend(cost));
    return [textSegment(joined, true, false)];
  }

  private separatorOf(value: Extract<ParameterValue, { kind: 'list' }>, spacedStar: boolean): WordSegment {
    const ifsJoiner = this.ifsJoiner();
    if (!value.star) return breakSegment(value.positional ? 'positional' : 'field', ifsJoiner);
    return value.positional && spacedStar && ifsJoiner === ''
      ? breakSegment('field', ifsJoiner)
      : breakSegment('star', ifsJoiner);
  }

  ifsJoiner(): string {
    const ifs = this.shell.store.readScalar('IFS');
    if (ifs === undefined) return ' ';
    return charactersOf(ifs)[0] ?? '';
  }

  currentIfs(): string {
    return this.shell.store.readScalar('IFS') ?? ' \t\n';
  }

  // ---------------------------------------------------------------- splitting & joining

  joinSegments(segments: readonly WordSegment[], useSubscriptIfs = false): string {
    let text = '';
    const spend = (cost?: number): void => this.spend(cost);
    for (const segment of segments) {
      if (segment.kind === 'emptyList') continue;
      const chunk = segment.kind === 'break' ? this.breakJoinerOf(segment, useSubscriptIfs) : segment.text;
      text = appendBounded(text, chunk, spend);
    }
    return text;
  }

  private breakJoinerOf(segment: BreakSegment, useSubscriptIfs: boolean): string {
    const ifsJoiner = segment.ifsJoiner ?? this.ifsJoiner();
    if (useSubscriptIfs) return ifsJoiner || ' ';
    return segment.breakKind === 'star' ? ifsJoiner : ' ';
  }

  flatten(segments: readonly WordSegment[]): TextSegment[] {
    const out: TextSegment[] = [];
    for (const segment of segments) {
      if (segment.kind === 'emptyList') continue;
      if (segment.kind === 'break') {
        out.push(textSegment(this.breakJoinerOf(segment, false), true, false));
      } else out.push(segment);
    }
    return out;
  }

  patternOf(segments: readonly WordSegment[]): string {
    let pattern = '';
    const spend = (cost?: number): void => this.spend(cost);
    for (const fragment of this.flatten(segments)) {
      const chunk = fragment.quoted ? quotePattern(fragment.text) : fragment.text;
      pattern = appendBounded(pattern, chunk, spend);
    }
    if (hasExtendedGlob(pattern, () => this.spend())) rejectUnsupportedExpansion('extglob');
    return pattern;
  }

  splitFields(segments: readonly WordSegment[]): TextSegment[][] {
    return splitWordSegments(segments, this.currentIfs());
  }

  finishField(field: readonly TextSegment[]): string {
    let length = 0;
    for (const fragment of field) {
      length += fragment.text.length;
      if (length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    }
    const unquoted = field.map((fragment) => (fragment.quoted ? quotePattern(fragment.text) : fragment.text)).join('');
    const result = field.map((fragment) => fragment.text).join('');
    if (hasPatternCharacters(unquoted, () => this.spend())) rejectUnsupportedPathnameExpansion(result);
    return result;
  }

  private failBackquoted(error: BackquoteSyntaxError, inDouble: boolean): WordSegment[] {
    const prefix = `${SCRIPT_NAME}: command substitution: line ${error.row + 1}: `;
    for (const message of error.messages) this.shell.fd2.write(`${prefix}${message}\n`);
    if (error.line !== undefined) this.shell.fd2.write(`${prefix}\`${error.line}'\n`);
    this.lastSubstitutionStatus = 2;
    this.shell.store.lastStatus = 2;
    return [textSegment('', inDouble, !inDouble)];
  }

  failParameter(name: string, message: string): never {
    this.shell.reportError(`${name}: ${message}`);
    throw new ExitSignal(1);
  }
}

export function appendBounded(current: string, addition: string, spend: (cost?: number) => void): string {
  if (addition.length === 0) return current;
  spend(Math.ceil(addition.length / 256));
  if (current.length + addition.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return current + addition;
}

function appendMaskedAnsiC(
  initial: string,
  decoded: string,
  quoted: Set<number>,
  spend: (cost?: number) => void
): string {
  let text = appendBounded(initial, "'", spend);
  for (const ch of decoded) {
    if (ch === "'") {
      text = appendBounded(text, String.raw`'\''`, spend);
    } else {
      const idx = text.length;
      text = appendBounded(text, ch, spend);
      quoted.add(idx);
    }
  }
  return appendBounded(text, "'", spend);
}

/** Removes syntactic quotes and escapes from a pre-expanded arithmetic associative subscript while keeping masked text verbatim. */
export function unquotePreExpandedAssociativeKey(raw: string, quoted: ReadonlySet<number>): string {
  let out = '';
  const state = { inSingle: false, inDouble: false };
  for (let i = 0; i < raw.length; i++) {
    if (quoted.has(i)) {
      out += raw[i];
      continue;
    }
    const step = unquoteSubscriptChar(raw, i, state, quoted);
    out += step.emit;
    i = step.nextIndex;
  }
  return out;
}

function unquoteSubscriptChar(
  raw: string,
  index: number,
  state: { inSingle: boolean; inDouble: boolean },
  quoted: ReadonlySet<number>
): { emit: string; nextIndex: number } {
  const c = raw[index];
  if (state.inSingle) {
    state.inSingle = c !== "'";
    return { emit: state.inSingle ? c : '', nextIndex: index };
  }
  if (c === "'" && !state.inDouble) {
    state.inSingle = true;
    return { emit: '', nextIndex: index };
  }
  if (c === '"') {
    state.inDouble = !state.inDouble;
    return { emit: '', nextIndex: index };
  }
  const escaped = tryUnescapeSubscriptChar(raw, index, state.inDouble, quoted);
  return escaped ?? { emit: c, nextIndex: index };
}

function tryUnescapeSubscriptChar(
  raw: string,
  index: number,
  inDouble: boolean,
  quoted: ReadonlySet<number>
): { emit: string; nextIndex: number } | undefined {
  if (raw[index] !== '\\' || index + 1 >= raw.length || quoted.has(index + 1)) return undefined;
  const next = raw[index + 1];
  if (inDouble && !'$`"\\\n'.includes(next)) return undefined;
  return { emit: next === '\n' ? '' : next, nextIndex: index + 1 };
}

export function joinBounded(items: readonly string[], separator: string, spend: (cost?: number) => void): string {
  let text = '';
  for (const [index, item] of items.entries()) {
    if (index > 0) text = appendBounded(text, separator, spend);
    text = appendBounded(text, item, spend);
  }
  return text;
}

function compoundItemValidationError(
  item: CompoundElement,
  declared: boolean,
  reportedName: string
): string | undefined {
  if (typeof item === 'string' || 'plain' in item) {
    const invalidPlain = typeof item === 'string' ? item : item.plain;
    const prefix = reportedName === '' ? '' : `${reportedName}: `;
    return `${prefix}${invalidPlain}: must use subscript when assigning associative array`;
  }
  if (item.key === '') {
    const text = declared ? `[${singleQuote(item.key)}]=${singleQuote(item.value)}` : (item.rawText ?? '');
    return `${text}: bad array subscript`;
  }
  return undefined;
}

function isValidParameterName(name: string): boolean {
  return isIdentifier(name) || /^[0-9]+$/.test(name) || SPECIAL_PARAMETERS.has(name);
}

function emitKeyedPair(
  elements: CompoundElement[],
  pair: { key: string; value: string; append: boolean; rawText: string },
  onPair?: (key: string, value: string, append: boolean) => boolean
): boolean {
  if (onPair) return onPair(pair.key, pair.value, pair.append);
  elements.push(pair);
  return true;
}

function emitAlternatingPair(
  elements: CompoundElement[],
  words: readonly Word[],
  index: number,
  key: string,
  value: string,
  onPair?: (key: string, value: string, append: boolean) => boolean
): boolean {
  if (onPair) return onPair(key, value, false);
  elements.push({ plain: key, rawText: words[index].text });
  if (index + 1 < words.length) elements.push({ plain: value, rawText: words[index + 1].text });
  return true;
}

function recordSegmentBuilderText(
  seg: WordSegment,
  builder: { text: string },
  fieldTexts: string[],
  spend: (cost?: number) => void
): void {
  if (seg.kind === 'break') {
    if (builder.text !== '') fieldTexts.push(builder.text);
    builder.text = '';
  } else if (seg.kind === 'text' && seg.text !== '') {
    builder.text = appendBounded(builder.text, seg.text, spend);
  }
}

function hasUnquotedTildePrefix(parts: WordPart[], partIndex: number, from: number, afterColon: boolean): boolean {
  for (let p = partIndex; p < parts.length; p++) {
    const part = parts[p];
    if (part.kind !== 'literal') return false;
    const step = scanTildeLiteral(part.text, p === partIndex ? from : 0, afterColon);
    if (step !== undefined) return step;
  }
  return true;
}

function scanTildeLiteral(text: string, start: number, afterColon: boolean): boolean | undefined {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') return false;
    if (c === '/' || (afterColon && c === ':')) return true;
  }
  return undefined;
}

function scalarValueSegments(value: string | undefined, inDouble: boolean): WordSegment[] {
  if (value === undefined || value === '') return inDouble ? [QUOTED_EMPTY_SEGMENT] : [];
  return [textSegment(value, inDouble, !inDouble)];
}

function listElementSegment(element: string, inDouble: boolean, star: boolean, listOrigin: boolean): TextSegment {
  if (inDouble && element === '') {
    return listOrigin ? textSegment('', true, false, { fromList: true }) : QUOTED_EMPTY_SEGMENT;
  }
  return textSegment(element, inDouble, !inDouble, {
    ...(!inDouble && !star ? { atListElement: true } : {}),
    ...(listOrigin ? { fromList: true } : {}),
  });
}

function lengthOf(value: ParameterValue): ParameterValue {
  if (value.kind === 'list') return { kind: 'scalar', value: String(value.values.length) };
  return { kind: 'scalar', value: String(charactersOf(value.value ?? '').length) };
}

// code-gauge-allow functionCognitiveComplexity -- Bash's quote removal of backslashes, including a trailing backslash at word end.
function literalSegments(text: string): TextSegment[] {
  const fragments: TextSegment[] = [];
  let plain = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 === text.length) {
      if (plain) fragments.push(textSegment(plain, false, false));
      fragments.push(QUOTED_EMPTY_SEGMENT);
      return fragments;
    }
    if (c === '\\') {
      if (plain) fragments.push(textSegment(plain, false, false));
      plain = '';
      const next = text.codePointAt(i + 1) as number;
      const char = String.fromCodePoint(next);
      if (char !== '\n') fragments.push(textSegment(char, true, false));
      i += char.length;
      continue;
    }
    plain += c;
  }
  if (plain) fragments.push(textSegment(plain, false, false));
  return fragments;
}

export function unescapeDoubleQuoted(text: string, inOperatorWord = false): string {
  const pattern = inOperatorWord ? /\\([$`"\\}\n])/g : /\\([$`"\\\n])/g;
  return text.replaceAll(pattern, (_, c: string) => (c === '\n' ? '' : c));
}

// code-gauge-allow functionCognitiveComplexity -- Splits a word at its [key]= prefix across literal and expanded parts.
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
