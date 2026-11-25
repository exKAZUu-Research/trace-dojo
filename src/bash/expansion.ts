// code-gauge-allow-file fileNcss -- Keeps word, brace, tilde, parameter, arithmetic, and field-splitting expansions in one cohesive stateless Expander.
import type { ArithmeticSource, BackquoteSyntaxError, ParameterExpansion, Word, WordPart } from './ast';
import { expandBraces } from './braces';
import { appendMetered, joinMetered, pushMeteredItem } from './budget';
import {
  rejectListInScalarContext,
  rejectQuotedSubscriptExpansion,
  rejectUnsupportedExpansion,
  rejectUnsupportedNamerefMutation,
  rejectUnsupportedPathnameExpansion,
} from './capabilities';
import { charactersOf } from './characters';
import {
  type BadSubstitutionTarget,
  type BreakSegment,
  breakSegment,
  DEFAULT_WORD_CONTEXT,
  EMPTY_LIST_SEGMENT,
  FIELD_SPLITTING_WORD_CONTEXT,
  isBreakSegment,
  QUOTED_EMPTY_SEGMENT,
  splitWordSegments,
  type TextSegment,
  textSegment,
  type WordContext,
  type WordSegment,
} from './fields';
import { applyOperator } from './parameterOperators';
import { hasExtendedGlob, hasPatternCharacters, matchesPattern, quotePattern } from './pattern';
import { singleQuote } from './quoting';
import { ExitSignal, SCRIPT_NAME } from './runtime';
import type { Shell } from './shell';
import { readResolvedTarget, resolveSubscriptTarget, resolveTargetName } from './targets';
import { type CompoundElement, formatKeyedCompoundElement, isIdentifier } from './variables';

/** A parameter's value before its operator: one string, or the elements of `$@`, `$*`, or `${a[@]}`. */
export type ParameterValue =
  | { kind: 'scalar'; value: string | undefined }
  | {
      kind: 'list';
      values: string[];
      star: boolean;
      positional?: boolean;
      assignmentJoin?: 'ifs' | 'quotedIfs';
    };

/** An expanded parameter subscript, preserving whether `@` or `*` was written as a whole-array operator. */
export interface SubscriptRef {
  readonly text: string;
  readonly wholeArray: boolean;
  readonly rawText: string;
  readonly word?: Word;
  readonly indirect?: string;
}

const SPECIAL_PARAMETERS = new Set(['@', '*', '#', '?', '-', '$', '!', '0', '_']);
const SUBSCRIPT_WORD_CONTEXT: WordContext = { inDouble: false, spacedStar: false, inSubscript: true };

/**
 * Stateless per-word expander: passes immutable `WordContext` explicitly and emits typed `WordSegment` lists
 * split by the pure `splitWordSegments` function.
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
    for (const word of words) {
      for (const parts of expandBraces(word.parts, this.shell.runtime.step)) {
        this.checkTilde(parts, false);
        for (const field of this.splitFields(this.expandParts(parts, FIELD_SPLITTING_WORD_CONTEXT))) {
          pushMeteredItem(fields, this.finishField(field), this.shell.runtime.step);
        }
      }
    }
    return fields;
  }

  /** Expands a word to one string without splitting it, as for `case` and the operands of `[[`. */
  expandString(word: Word): string {
    this.checkTilde(word.parts, false);
    return this.joinSegments(this.expandParts(word.parts, DEFAULT_WORD_CONTEXT));
  }

  /** Expands an associative array's subscript, rejecting list expansions inside subscripts. */
  expandAssociativeKey(word: Word): string {
    return this.joinSegments(this.expandParts(word.parts, SUBSCRIPT_WORD_CONTEXT));
  }

  /** Expands an assignment's subscript in a declaration word (`a[k]=v`), rejecting list expansions inside subscripts. */
  expandAssignmentSubscript(word: Word): string {
    return this.joinSegments(this.expandParts(word.parts, SUBSCRIPT_WORD_CONTEXT));
  }

  /** Expands an assignment's value, optionally joining `$*` with spaces when `IFS` is empty (`spacedStar`). */
  expandAssignmentValue(word: Word, spacedStar = false): string {
    this.checkTilde(word.parts, true);
    return this.joinSegments(
      this.expandParts(word.parts, { inDouble: false, spacedStar, inAssignmentValue: true, inAssignmentRhs: true })
    );
  }

  /** Expands a word into a glob pattern, quoting characters protected by quotes. */
  expandPattern(word: Word, firstWordOnly = false): string {
    this.checkTilde(word.parts, false);
    const segments = this.expandParts(word.parts, DEFAULT_WORD_CONTEXT);
    return this.patternOf(firstWordOnly ? firstWordSegments(segments) : segments);
  }

  /** Expands the right side of `=~` into an ERE, escaping characters protected by quotes. */
  expandRegex(word: Word): string {
    this.checkTilde(word.parts, false);
    let regex = '';
    const spend = (cost?: number): void => this.spend(cost);
    for (const fragment of this.flatten(this.expandParts(word.parts, DEFAULT_WORD_CONTEXT))) {
      const chunk = fragment.quoted ? fragment.text.replaceAll(/[\\^$.|?*+()[\]{}]/g, String.raw`\$&`) : fragment.text;
      regex = appendMetered(regex, chunk, spend);
    }
    return regex;
  }

  /** Expands an indexed array's subscript into text for arithmetic evaluation, rejecting quote/list-bearing expansions. */
  expandSubscriptString(word: Word, unquoteAnsiC = false): string {
    const pieces = word.parts.map((part): string | WordPart => {
      if (part.kind === 'single') return `'${part.text}'`;
      if (part.kind === 'literal') return unescapeDoubleQuoted(part.text);
      return part;
    });
    return this.arithmeticText({ pieces, row: word.row }, unquoteAnsiC, true);
  }

  matches(text: string, pattern: string, extmatch = false): boolean {
    return matchesPattern(pattern, text, this.shell.runtime.step, extmatch);
  }

  /** Expands raw compound items of `name=(...)` through metered word and string helpers. */
  expandRawCompoundItems(words: Word[], isAssociative = false): CompoundElement[] {
    if (isAssociative && words.length > 0 && !splitKeyedElement(words[0])) {
      return words.map((word) => ({ plain: this.expandAssignmentValue(word), rawText: word.text }));
    }
    const elements: CompoundElement[] = [];
    for (const word of words) {
      const keyed = splitKeyedElement(word);
      if (keyed) {
        const key = this.joinSegments(this.expandParts(keyed.key, SUBSCRIPT_WORD_CONTEXT));
        this.checkTilde(keyed.value, true);
        const value = this.joinSegments(
          this.expandParts(keyed.value, {
            inDouble: false,
            spacedStar: !isAssociative,
            spacedArrayStar: !isAssociative,
            inAssignmentRhs: true,
          })
        );
        pushMeteredItem(elements, { key, value, append: keyed.append, rawText: word.text }, this.shell.runtime.step);
        continue;
      }
      if (isAssociative) {
        pushMeteredItem(elements, { plain: word.text, rawText: word.text }, this.shell.runtime.step);
        continue;
      }
      for (const field of this.expandWords([word])) {
        pushMeteredItem(elements, { plain: field, rawText: word.text }, this.shell.runtime.step);
      }
    }
    return elements;
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
    const elements: CompoundElement[] = [];
    for (const word of words) {
      const outcome = this.expandOneKeyedPair(word, reportedName);
      if ('error' in outcome) return { elements, error: outcome.error };
      if (!emitKeyedPair(elements, outcome, this.shell.runtime.step, onPair)) return { elements };
    }
    return { elements };
  }

  private expandOneKeyedPair(
    word: Word,
    reportedName: string
  ): { key: string; value: string; append: boolean; rawText: string } | { error: string | undefined } {
    const keyed = splitKeyedElement(word);
    if (!keyed) {
      return { error: compoundItemValidationError({ plain: word.text, rawText: word.text }, false, reportedName) };
    }
    const key = this.joinSegments(this.expandParts(keyed.key, SUBSCRIPT_WORD_CONTEXT));
    if (key === '') return { error: `${word.text}: bad array subscript` };
    this.checkTilde(keyed.value, true);
    const value = this.joinSegments(
      this.expandParts(keyed.value, { inDouble: false, spacedStar: false, inAssignmentRhs: true })
    );
    return { key, value, append: keyed.append, rawText: word.text };
  }

  private expandAlternatingAssociative(
    words: Word[],
    onPair?: (key: string, value: string, append: boolean) => boolean
  ): { elements: CompoundElement[] } {
    const elements: CompoundElement[] = [];
    for (let i = 0; i < words.length; i += 2) {
      const key = this.expandAssignmentValue(words[i]);
      if (key === '') {
        this.shell.reportError(`${words[i].text}: bad array subscript`);
        continue;
      }
      const value = i + 1 < words.length ? this.expandAssignmentValue(words[i + 1]) : '';
      if (!emitAlternatingPair(elements, words, i, { key, value }, this.shell.runtime.step, onPair)) {
        return { elements };
      }
    }
    return { elements };
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

  /** Substitutes expansions inside an arithmetic expression, rejecting quotes or brackets inside expanded parts. */
  arithmeticText(source: ArithmeticSource, unquoteAnsiC = false, inSubscript = false): string {
    let text = '';
    const spend = (cost?: number): void => this.spend(cost);
    const partCtx: WordContext = {
      inDouble: true,
      spacedStar: false,
      ...(inSubscript ? { inSubscript: true } : {}),
      badSubTarget: { kind: 'arithmetic', pieces: source.pieces },
    };
    for (const piece of source.pieces) {
      if (typeof piece === 'string') {
        text = appendMetered(text, piece, spend);
      } else if (piece.kind === 'ansiC' && !unquoteAnsiC) {
        rejectQuotedSubscriptExpansion(piece.text);
        text = appendMetered(text, `'${piece.text}'`, spend);
      } else {
        const chunk = this.joinSegments(this.expandPart(piece, partCtx));
        rejectQuotedSubscriptExpansion(chunk);
        text = appendMetered(text, chunk, spend);
      }
    }
    return text;
  }

  // ---------------------------------------------------------------- parts

  /** Expands `parts` with explicit immutable `WordContext`. */
  expandParts(parts: WordPart[], ctx: WordContext): WordSegment[] {
    const effectiveCtx: WordContext =
      ctx.badSubTarget === undefined ? { ...ctx, badSubTarget: { kind: 'parts', parts } } : ctx;
    const segments: WordSegment[] = [];
    for (const part of parts) {
      for (const seg of this.expandPart(part, effectiveCtx)) {
        segments.push(seg);
      }
    }
    return segments;
  }

  private expandPart(part: WordPart, ctx: WordContext): WordSegment[] {
    this.spend();
    switch (part.kind) {
      case 'literal': {
        return ctx.inDouble
          ? [textSegment(unescapeDoubleQuoted(part.text, ctx.inQuotedOperatorWord), true, false)]
          : literalSegments(part.text);
      }
      case 'single':
      case 'ansiC': {
        return [textSegment(part.text, true, false)];
      }
      case 'double': {
        return this.expandDoublePart(part, ctx);
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

  private expandDoublePart(part: Extract<WordPart, { kind: 'double' }>, ctx: WordContext): WordSegment[] {
    const inner = this.expandParts(part.parts, {
      inDouble: true,
      spacedStar: ctx.spacedStar,
      ...(ctx.spacedArrayStar ? { spacedArrayStar: true } : {}),
      ...(ctx.splittingFields ? { splittingFields: true } : {}),
      ...(ctx.inAssignmentRhs ? { inAssignmentRhs: true } : {}),
      ...(ctx.inOperatorWord ? { inOperatorWord: true } : {}),
      ...(ctx.inQuotedOperatorWord ? { inQuotedOperatorWord: true } : {}),
      ...(ctx.inSubscript ? { inSubscript: true } : {}),
      badSubTarget: { kind: 'double', part },
    });
    if (inner.length > 0 && inner.every((seg) => seg.kind === 'emptyList')) return [EMPTY_LIST_SEGMENT];
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
    if (expansion.unclosedSubscript) this.failUnclosedSubscript(expansion, ctx.badSubTarget);
    if ((ctx.inOperatorWord || ctx.inSubscript) && isListExpansionSyntax(expansion)) {
      rejectListInScalarContext(expansion.text);
    }
    const { name } = expansion;
    if (!expansion.braced) {
      return this.valueSegments(this.parameterValue(name, undefined, expansion), ctx, expansion.text);
    }
    if (!isValidParameterName(name) || (expansion.prefix === '#' && expansion.operator !== undefined)) {
      this.shell.discard(`${expansion.text}: bad substitution`);
    }
    if (isElementLengthExpansion(expansion)) {
      return this.valueSegments(this.elementLengthValue(expansion), ctx, expansion.text);
    }
    const subscript = expansion.subscript ? this.subscriptRef(name, expansion.subscript) : undefined;
    if (expansion.prefix === '!') return this.expandIndirect(expansion, subscript, ctx);
    if (expansion.prefix === '#') return this.expandLength(name, subscript, expansion, ctx);
    const value = this.parameterValue(name, subscript, expansion);
    if (expansion.operator === undefined) {
      if (expansion.argument.length > 0) this.shell.discard(`${expansion.text}: bad substitution`);
      return this.valueSegments(value, ctx, expansion.text);
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
      const count = this.shell.store.readArrayLength(resolved);
      return this.valueSegments({ kind: 'scalar', value: String(count) }, ctx, expansion.text);
    }
    return this.valueSegments(lengthOf(this.parameterValue(name, subscript, expansion)), ctx, expansion.text);
  }

  private elementLengthValue(expansion: ParameterExpansion): ParameterValue {
    const rawSubscript = expansion.subscript as Word;
    if (rawSubscript.text === '') this.shell.discard(`${expansion.text}: bad substitution`);
    const resolved = resolveTargetName(this.shell, expansion.name);
    if (!this.shell.store.hasMaterializedTarget(resolved)) {
      return { kind: 'scalar', value: '0' };
    }
    const target = resolveSubscriptTarget(this.shell, {
      name: expansion.name,
      subscript: { kind: 'word', word: rawSubscript, unquoteAnsiC: true },
      operation: 'read',
    });
    if (target.kind === 'invalid') {
      this.shell.discard(target.failure.message || `[${rawSubscript.text}]: bad array subscript`);
    }
    return lengthOf({ kind: 'scalar', value: readResolvedTarget(this.shell, target) });
  }

  private subscriptRef(name: string, subscript: Word): SubscriptRef {
    const raw = subscript.text;
    if (raw === '@' || raw === '*') return { text: raw, wholeArray: true, rawText: raw, word: subscript };
    const resolved = resolveTargetName(this.shell, name);
    const text = this.shell.store.isAssociativeName(resolved)
      ? this.expandAssociativeKey(subscript)
      : this.expandSubscriptString(subscript, true);
    return { text, wholeArray: false, rawText: raw, word: subscript };
  }

  parameterValue(name: string, subscript: SubscriptRef | undefined, expansion?: ParameterExpansion): ParameterValue {
    if (subscript !== undefined) return this.subscriptedParameterValue(name, subscript, expansion);
    const special = this.specialParameterValue(name);
    if (special) return special;
    return { kind: 'scalar', value: this.shell.store.readScalar(name) };
  }

  private subscriptedParameterValue(
    name: string,
    subscript: SubscriptRef,
    expansion?: ParameterExpansion
  ): ParameterValue {
    const resolved = resolveTargetName(this.shell, name);
    if (subscript.wholeArray) {
      return { kind: 'list', values: this.shell.store.readArrayValues(resolved), star: subscript.text === '*' };
    }
    if (subscript.rawText === '' && expansion) this.shell.discard(`${expansion.text}: bad substitution`);
    if (subscript.text === '' && this.shell.store.isAssociativeName(resolved)) {
      this.shell.reportError(`${name}: bad array subscript`);
      return { kind: 'scalar', value: undefined };
    }
    const subText = subscript.text === '' ? '0' : subscript.text;
    const target = resolveSubscriptTarget(this.shell, {
      name,
      subscript:
        subscript.indirect === undefined ? { kind: 'evaluated', text: subText } : { kind: 'text', text: subText },
      operation: 'read',
    });
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
      const keys = this.shell.store.readArrayKeys(resolved);
      return this.valueSegments(
        { kind: 'list', values: keys, star: subscript.text === '*', assignmentJoin: 'quotedIfs' },
        ctx,
        expansion.text
      );
    }
    if ((expansion.operator === '*' || expansion.operator === '@') && expansion.argument.length === 0) {
      return this.valueSegments(
        {
          kind: 'list',
          values: this.shell.store.namesWithPrefix(name),
          star: expansion.operator === '*',
          assignmentJoin: 'quotedIfs',
        },
        ctx,
        expansion.text
      );
    }
    return this.expandIndirectVariable(expansion, subscript, ctx);
  }

  private expandIndirectVariable(
    expansion: ParameterExpansion,
    subscript: SubscriptRef | undefined,
    ctx: WordContext
  ): WordSegment[] {
    const { name } = expansion;
    const own = subscript === undefined ? this.shell.store.ownView(name) : undefined;
    if (own?.attributes.has('n')) rejectUnsupportedNamerefMutation('indirect', name);
    const direct = this.parameterValue(name, subscript, expansion);
    const reference =
      direct.kind === 'scalar' ? direct.value : direct.values.length === 0 ? undefined : direct.values.join(' ');
    if (reference === undefined) {
      this.checkIndirectReference(name, subscript?.rawText);
      const missingName = `!${name}[${subscript?.rawText ?? ''}]`;
      return this.finishIndirect(expansion, { kind: 'scalar', value: undefined }, missingName, undefined, ctx);
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
    if (expansion.operator === undefined) return this.valueSegments(value, ctx, expansion.text);
    return applyOperator(this, this.shell, expansion, value, targetName, targetSubscript, ctx);
  }

  private checkIndirectReference(name: string, subscript: string | undefined): void {
    if (subscript === undefined) this.shell.discard(`${name}: invalid indirect expansion`);
    const resolved = resolveTargetName(this.shell, name);
    if (!this.shell.store.hasIndirectContainer(resolved)) {
      this.shell.discard(`${name}[${subscript}]: invalid indirect expansion`);
    }
  }

  private indirectTarget(reference: string): { name: string; subscript: SubscriptRef | undefined } {
    const split = this.shell.splitSubscript(reference);
    if (split && isIdentifier(split.name) && split.subscript !== '') {
      const raw = split.subscript;
      if (raw === '@' || raw === '*') {
        return { name: split.name, subscript: { text: raw, wholeArray: true, rawText: raw, indirect: reference } };
      }
      return { name: split.name, subscript: { text: raw, wholeArray: false, rawText: raw, indirect: reference } };
    }
    if (!isValidParameterName(reference)) this.shell.discard(`${reference}: invalid variable name`);
    return { name: reference, subscript: undefined };
  }

  valueSegments(value: ParameterValue, ctx: WordContext, sourceText?: string): WordSegment[] {
    const { inDouble } = ctx;
    if (value.kind === 'scalar') return scalarValueSegments(value.value, inDouble);
    if (ctx.inOperatorWord || ctx.inSubscript) rejectListInScalarContext(sourceText ?? '$@');
    if (value.star && inDouble) return this.quotedStarSegments(value.values);
    if (value.values.length === 0) return [EMPTY_LIST_SEGMENT];
    const segments: WordSegment[] = [];
    const separator = value.values.length > 1 ? this.separatorOf(value, ctx) : undefined;
    for (const [index, element] of value.values.entries()) {
      if (index > 0 && separator) segments.push(separator);
      segments.push(listElementSegment(element, inDouble));
    }
    if (inDouble && value.values.length > 0) segments.unshift(QUOTED_EMPTY_SEGMENT);
    return segments;
  }

  private quotedStarSegments(values: readonly string[]): WordSegment[] {
    if (values.length === 0) return [QUOTED_EMPTY_SEGMENT];
    const joiner = values.length > 1 ? this.ifsJoiner() : '';
    const joined = joinMetered(values, joiner, (cost) => this.spend(cost));
    return [textSegment(joined, true, false)];
  }

  private separatorOf(value: Extract<ParameterValue, { kind: 'list' }>, ctx: WordContext): WordSegment {
    if (!value.star) return this.nonStarSeparatorOf(value, ctx);
    const ifsJoiner = this.ifsJoiner();
    const spaceEmptyIfs = ctx.spacedStar && (Boolean(value.positional) || Boolean(ctx.spacedArrayStar));
    return spaceEmptyIfs && ifsJoiner === ''
      ? breakSegment('field', ifsJoiner, ctx.inDouble)
      : breakSegment('star', ifsJoiner, ctx.inDouble);
  }

  private nonStarSeparatorOf(value: Extract<ParameterValue, { kind: 'list' }>, ctx: WordContext): WordSegment {
    if (usesAssignmentIfs(value, ctx)) {
      const ifsJoiner = this.ifsJoiner();
      return breakSegment(ifsJoiner === '' ? 'field' : 'star', ifsJoiner, ctx.inDouble);
    }
    const rawJoiner = this.shell.store.readScalar('IFS') === '' ? '' : ' ';
    return breakSegment(value.positional ? 'positional' : 'field', rawJoiner, ctx.inDouble);
  }

  ifsJoiner(): string {
    const ifs = this.readIfs();
    if (ifs === undefined) return ' ';
    return charactersOf(ifs)[0] ?? '';
  }

  currentIfs(): string {
    return this.readIfs() ?? ' \t\n';
  }

  private readIfs(): string | undefined {
    const ifs = this.shell.store.readScalar('IFS');
    if (ifs !== undefined && /\P{ASCII}/u.test(ifs)) rejectUnsupportedExpansion('nonAsciiIfs');
    return ifs;
  }

  // ---------------------------------------------------------------- splitting & joining

  joinSegments(segments: readonly WordSegment[]): string {
    let text = '';
    const spend = (cost?: number): void => this.spend(cost);
    for (const segment of segments) {
      if (segment.kind === 'emptyList') continue;
      const chunk = segment.kind === 'break' ? this.breakJoinerOf(segment) : segment.text;
      text = appendMetered(text, chunk, spend);
    }
    return text;
  }

  private breakJoinerOf(segment: BreakSegment): string {
    const ifsJoiner = segment.ifsJoiner ?? this.ifsJoiner();
    return segment.breakKind === 'star' ? ifsJoiner : ' ';
  }

  flatten(segments: readonly WordSegment[]): TextSegment[] {
    const out: TextSegment[] = [];
    for (const segment of segments) {
      if (segment.kind === 'emptyList') continue;
      if (segment.kind === 'break') {
        out.push(textSegment(this.breakJoinerOf(segment), true, false));
      } else out.push(segment);
    }
    return out;
  }

  patternOf(segments: readonly WordSegment[]): string {
    let pattern = '';
    const spend = (cost?: number): void => this.spend(cost);
    for (const fragment of this.flatten(segments)) {
      const chunk = fragment.quoted ? quotePattern(fragment.text) : fragment.text;
      pattern = appendMetered(pattern, chunk, spend);
    }
    if (hasExtendedGlob(pattern, this.shell.runtime.step)) rejectUnsupportedExpansion('extglob');
    return pattern;
  }

  splitFields(segments: readonly WordSegment[]): TextSegment[][] {
    const needsIfs = segments.some(
      (seg) => (seg.kind === 'break' && !seg.quoted) || (seg.kind === 'text' && seg.split && seg.text !== '')
    );
    return splitWordSegments(segments, needsIfs ? this.currentIfs() : ' \t\n');
  }

  finishField(field: readonly TextSegment[]): string {
    const spend = (cost?: number): void => this.spend(cost);
    let result = '';
    let unquoted = '';
    for (const fragment of field) {
      result = appendMetered(result, fragment.text, spend);
      unquoted = appendMetered(unquoted, fragment.quoted ? quotePattern(fragment.text) : fragment.text, spend);
    }
    if (hasPatternCharacters(unquoted, this.shell.runtime.step)) rejectUnsupportedPathnameExpansion(result);
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

  private failUnclosedSubscript(expansion: ParameterExpansion, target: BadSubstitutionTarget | undefined): never {
    if (target?.kind === 'double') {
      const quoted = stripLineContinuations(target.part.rawText);
      this.shell.discard(`bad substitution: no closing \`}' in ${quoted}`);
    }
    const shown = stripLineContinuations(formatBadSubstitutionText(target, expansion.text));
    this.shell.discard(`${shown}: bad substitution`);
  }

  failParameter(name: string, message: string): never {
    this.shell.reportError(`${name}: ${message}`);
    throw new ExitSignal(1);
  }
}

function isElementLengthExpansion(expansion: ParameterExpansion): boolean {
  return (
    expansion.prefix === '#' &&
    expansion.subscript !== undefined &&
    expansion.subscript.text !== '@' &&
    expansion.subscript.text !== '*'
  );
}

function formatBadSubstitutionText(target: BadSubstitutionTarget | undefined, fallback: string): string {
  if (!target) return fallback;
  if (target.kind === 'double') return target.part.rawText;
  if (target.kind === 'arithmetic') {
    return target.pieces.map((piece) => (typeof piece === 'string' ? piece : partSourceText(piece))).join('');
  }
  return target.parts.map(partSourceText).join('');
}

function partSourceText(part: WordPart): string {
  switch (part.kind) {
    case 'literal':
    case 'parameter':
    case 'commandSubstitution': {
      return part.text;
    }
    case 'single': {
      return `'${part.text}'`;
    }
    case 'ansiC':
    case 'double':
    case 'arithmeticExpansion': {
      return part.rawText;
    }
  }
}

function stripLineContinuations(raw: string): string {
  if (!raw.includes('\\\n')) return raw;
  let out = '';
  for (let i = 0; i < raw.length;) {
    const step = readContinuationAtom(raw, i);
    out += step.emit;
    i = step.next;
  }
  return out;
}

function readContinuationAtom(raw: string, i: number): { emit: string; next: number } {
  if (raw[i] === "'") {
    const close = raw.indexOf("'", i + 1);
    return close === -1 ? { emit: raw.slice(i), next: raw.length } : { emit: raw.slice(i, close + 1), next: close + 1 };
  }
  if (raw[i] === '\\' && i + 1 < raw.length) {
    return { emit: raw[i + 1] === '\n' ? '' : raw.slice(i, i + 2), next: i + 2 };
  }
  return { emit: raw[i], next: i + 1 };
}

function usesAssignmentIfs(value: Extract<ParameterValue, { kind: 'list' }>, ctx: WordContext): boolean {
  if (ctx.spacedArrayStar) return true;
  if (!ctx.inAssignmentRhs) return false;
  return value.assignmentJoin === 'ifs' || (value.assignmentJoin === 'quotedIfs' && ctx.inDouble);
}

function isListExpansionSyntax(expansion: ParameterExpansion): boolean {
  if (expansion.prefix === '#') return false;
  if (expansion.name === '@' || expansion.name === '*') return true;
  if (expansion.subscript?.text === '@' || expansion.subscript?.text === '*') return true;
  return (
    expansion.prefix === '!' &&
    (expansion.operator === '*' || expansion.operator === '@') &&
    expansion.argument.length === 0
  );
}

function firstWordSegments(segments: readonly WordSegment[]): readonly WordSegment[] {
  const breakIndex = segments.findIndex(isCasePatternWordBreak);
  return breakIndex === -1 ? segments : segments.slice(0, breakIndex);
}

function isCasePatternWordBreak(seg: WordSegment): boolean {
  return seg.kind === 'break' && seg.breakKind !== 'star' && Boolean(seg.quoted) && seg.ifsJoiner !== '';
}

function compoundItemValidationError(
  item: CompoundElement,
  declared: boolean,
  reportedName: string
): string | undefined {
  if (typeof item === 'string' || 'plain' in item) {
    const rawPlain = typeof item === 'string' ? item : item.rawText;
    const shown = declared ? singleQuote(rawPlain) : rawPlain;
    const prefix = reportedName === '' ? '' : `${reportedName}: `;
    return `${prefix}${shown}: must use subscript when assigning associative array`;
  }
  if (item.key === '') {
    const text = declared
      ? formatKeyedCompoundElement(singleQuote(item.key), singleQuote(item.value), item.append)
      : (item.rawText ?? '');
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
  step: () => void,
  onPair?: (key: string, value: string, append: boolean) => boolean
): boolean {
  if (onPair) return onPair(pair.key, pair.value, pair.append);
  pushMeteredItem(elements, pair, step);
  return true;
}

function emitAlternatingPair(
  elements: CompoundElement[],
  words: readonly Word[],
  index: number,
  pair: { key: string; value: string },
  step: () => void,
  onPair?: (key: string, value: string, append: boolean) => boolean
): boolean {
  if (onPair) return onPair(pair.key, pair.value, false);
  pushMeteredItem(elements, { plain: pair.key, rawText: words[index].text }, step);
  if (index + 1 < words.length) pushMeteredItem(elements, { plain: pair.value, rawText: words[index + 1].text }, step);
  return true;
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

function listElementSegment(element: string, inDouble: boolean): TextSegment {
  if (inDouble && element === '') return QUOTED_EMPTY_SEGMENT;
  return textSegment(element, inDouble, !inDouble, !inDouble);
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
