import { type AST, RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';
import { CharSet } from 'refa';
import { toUnicodeSet } from 'regexp-ast-analysis';
import { analyse } from 'scslre';

interface Alphabets {
  readonly cache: WeakMap<AST.Element, CharSet>;
  readonly empty: CharSet;
  readonly any: CharSet;
  readonly unicode: boolean;
  readonly caseless: WeakSet<AST.Element>;
}

// code-gauge-allow functionNcss 36 -- Tracks scoped flags and repetition shapes in one AST traversal.
export function hasAmbiguousRepetition(tree: AST.Pattern, unicode: boolean, ignoreCase: boolean): boolean {
  const baseIgnoreCase = ignoreCase;
  const cases: boolean[] = [];
  const caseless = new WeakSet<AST.Element>();
  const alphabets = createAlphabets(unicode, caseless);
  const ambiguousBodies = new WeakMap<AST.Element, boolean>();
  const choiceCounts = new WeakMap<AST.Element, number>();
  let changesCaseSensitivity = false;
  let unbounded = 0;
  let ambiguous = false;
  visitRegExpAST(tree, {
    onGroupEnter(node) {
      cases.push(ignoreCase);
      if (node.modifiers?.add.ignoreCase) ignoreCase = true;
      if (node.modifiers?.remove?.ignoreCase) ignoreCase = false;
      changesCaseSensitivity ||= ignoreCase !== cases.at(-1);
    },
    onGroupLeave() {
      ignoreCase = cases.pop() as boolean;
    },
    onCharacterEnter(node) {
      if (ignoreCase) caseless.add(node);
    },
    onCharacterClassEnter(node) {
      if (ignoreCase) caseless.add(node);
    },
    onCharacterSetEnter(node) {
      if (ignoreCase) caseless.add(node);
    },
    onAlternativeLeave(node) {
      ambiguous ||= overlapsInSequence(node, alphabets);
    },
    onQuantifierLeave(node) {
      if (node.max === Infinity) unbounded++;
      ambiguous ||=
        node.max > 1 &&
        ambiguousRepeatBody(node.element, alphabets, ambiguousBodies) &&
        branchChoices(node, choiceCounts) > MAX_REPEAT_CHOICES;
    },
  });
  return (
    ambiguous ||
    overlappingUnboundedGroups(tree, unicode, baseIgnoreCase, unbounded, changesCaseSensitivity ? caseless : undefined)
  );
}

const MAX_GROUP_ANALYSIS_SOURCE = 8192;

function overlappingUnboundedGroups(
  tree: AST.Pattern,
  unicode: boolean,
  ignoreCase: boolean,
  count: number,
  scopedCase?: WeakSet<AST.Element>
): boolean {
  if (count < 2) return false;
  if (count > 32 || tree.raw.length > MAX_GROUP_ANALYSIS_SOURCE) return true;
  const parser = new RegExpParser({ ecmaVersion: 2025 });
  if (!scopedCase) {
    const flags = parser.parseFlags(`${unicode ? 'u' : ''}${ignoreCase ? 'i' : ''}`);
    return hasGroupedOverlap(tree, flags);
  }
  const source = expandScopedCase(tree, scopedCase, unicode);
  if (source === undefined) return true;
  return hasGroupedOverlap(
    parser.parsePattern(source, 0, source.length, { unicode }),
    parser.parseFlags(unicode ? 'u' : '')
  );
}

function hasGroupedOverlap(pattern: AST.Pattern, flags: AST.Flags): boolean {
  return analyse({ pattern, flags }, { maxReports: 1, reportTypes: { Move: false } }).reports.length > 0;
}

function expandScopedCase(tree: AST.Pattern, caseless: WeakSet<AST.Element>, unicode: boolean): string | undefined {
  let output = '';
  let end = 0;
  let exceeded = false;
  const replace = (node: AST.Node, text: string): void => {
    output += tree.raw.slice(end, node.start) + text;
    end = node.end;
    exceeded ||= output.length > MAX_GROUP_ANALYSIS_SOURCE;
  };
  const expand = (node: AST.Character | AST.CharacterClass | AST.CharacterSet): void => {
    if (exceeded || node.start < end || !caseless.has(node)) return;
    const { ranges } = toUnicodeSet(node, { unicode, ignoreCase: true }).chars;
    if (ranges.length > MAX_GROUP_ANALYSIS_SOURCE / 6) {
      exceeded = true;
      return;
    }
    replace(node, `[${ranges.map(({ min, max }) => escapeRange(min, max, unicode)).join('')}]`);
  };
  visitRegExpAST(tree, {
    onModifiersEnter(node) {
      if (exceeded || !node.raw.includes('i')) return;
      const flags = node.raw.replaceAll('i', '').replace(/-$/, '');
      replace(node, flags);
    },
    onCharacterEnter: expand,
    onCharacterClassEnter: expand,
    onCharacterSetEnter: expand,
  });
  const source = output + tree.raw.slice(end);
  return exceeded || source.length > MAX_GROUP_ANALYSIS_SOURCE ? undefined : source;
}

function escapeRange(min: number, max: number, unicode: boolean): string {
  const escape = (code: number): string =>
    unicode ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  return min === max ? escape(min) : `${escape(min)}-${escape(max)}`;
}

const MAX_REPEAT_CHOICES = 1024;
const UNBOUNDED_REPEAT_CHOICES = 64;

function createAlphabets(unicode: boolean, caseless: WeakSet<AST.Element>): Alphabets {
  const maximum = unicode ? 0x10_ff_ff : 0xff_ff;
  return { cache: new WeakMap(), empty: CharSet.empty(maximum), any: CharSet.all(maximum), unicode, caseless };
}

// code-gauge-allow functionCognitiveComplexity 18 -- Tracks the overlapping character set and choice count in one pass.
function overlapsInSequence(alternative: AST.Alternative, alphabets: Alphabets): boolean {
  let repeated = alphabets.empty;
  let choices = 1;
  for (const atom of sequenceAtoms(alternative.elements)) {
    if (atom.type === 'Assertion') continue;
    const alphabet = possibleCharacters(atom, alphabets);
    if (!repeated.isEmpty && alwaysConsumes(atom)) repeated = repeated.intersect(alphabet);
    if (repeated.isEmpty) choices = 1;
    if (atom.type !== 'Quantifier' || atom.min === atom.max) continue;
    const count = atom.max === Infinity ? UNBOUNDED_REPEAT_CHOICES : atom.max - atom.min + 1;
    const overlaps = !repeated.isDisjointWith(alphabet);
    choices = overlaps ? choices * count : Math.max(choices, count);
    if (overlaps && choices > MAX_REPEAT_CHOICES) return true;
    repeated = repeated.union(alphabet);
  }
  return false;
}

function alwaysConsumes(element: AST.Element): boolean {
  switch (element.type) {
    case 'Group':
    case 'CapturingGroup': {
      return element.alternatives.every((branch) => branch.elements.some(alwaysConsumes));
    }
    case 'Quantifier': {
      return element.min > 0 && alwaysConsumes(element.element);
    }
    case 'Assertion':
    case 'Backreference': {
      return false;
    }
    default: {
      return true;
    }
  }
}

function* sequenceAtoms(elements: readonly AST.Element[]): Generator<AST.Element> {
  for (const element of elements) {
    if ((element.type === 'Group' || element.type === 'CapturingGroup') && element.alternatives.length === 1)
      yield* sequenceAtoms(element.alternatives[0].elements);
    else yield element;
  }
}

function possibleCharacters(atom: AST.Element, alphabets: Alphabets): CharSet {
  const known = alphabets.cache.get(atom);
  if (known !== undefined) return known;
  let result = alphabets.any;
  switch (atom.type) {
    case 'Assertion': {
      result = alphabets.empty;
      break;
    }
    case 'Character':
    case 'CharacterSet':
    case 'CharacterClass': {
      result = toUnicodeSet(atom, { unicode: alphabets.unicode, ignoreCase: alphabets.caseless.has(atom) }).chars;
      break;
    }
    case 'Group':
    case 'CapturingGroup': {
      result = alphabets.empty;
      for (const branch of atom.alternatives)
        for (const element of branch.elements) result = result.union(possibleCharacters(element, alphabets));
      break;
    }
    case 'Quantifier': {
      result = possibleCharacters(atom.element, alphabets);
      break;
    }
  }
  alphabets.cache.set(atom, result);
  return result;
}

function ambiguousRepeatBody(node: AST.Element, alphabets: Alphabets, cache: WeakMap<AST.Element, boolean>): boolean {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  let ambiguous = false;
  if (node.type === 'Quantifier') {
    ambiguous = node.min !== node.max || ambiguousRepeatBody(node.element, alphabets, cache);
  } else if (node.type === 'Group' || node.type === 'CapturingGroup') {
    ambiguous =
      !disjointAlternatives(node.alternatives, alphabets) ||
      node.alternatives.some((alternative) =>
        alternative.elements.some((element) => ambiguousRepeatBody(element, alphabets, cache))
      );
  } else if (node.type === 'Backreference') {
    ambiguous = true;
  }
  cache.set(node, ambiguous);
  return ambiguous;
}

function branchChoices(node: AST.Element, cache: WeakMap<AST.Element, number>): number {
  const known = cache.get(node);
  if (known !== undefined) return known;
  let count = 1;
  if (node.type === 'Quantifier') {
    const repetitions = node.max === Infinity ? UNBOUNDED_REPEAT_CHOICES : node.max - node.min + 1;
    const inner = branchChoices(node.element, cache);
    count = inner === 1 ? repetitions : repetitions * inner ** node.max;
  } else if (node.type === 'Group' || node.type === 'CapturingGroup') {
    count = 0;
    for (const alternative of node.alternatives) {
      let product = 1;
      for (const element of alternative.elements) product *= branchChoices(element, cache);
      count += product;
    }
  }
  const capped = Math.min(MAX_REPEAT_CHOICES + 1, count);
  cache.set(node, capped);
  return capped;
}

function disjointAlternatives(alternatives: AST.Alternative[], alphabets: Alphabets): boolean {
  if (alternatives.length <= 1) return true;
  const prefixes = alternatives.map(({ elements }) => {
    let prefix = '';
    for (const element of elements) {
      if (element.type !== 'Character') break;
      // Direct literals share the group's case mode, so the lowest member identifies each equivalence set.
      prefix += String.fromCodePoint(possibleCharacters(element, alphabets).ranges[0].min);
    }
    return prefix;
  });
  prefixes.sort();
  return prefixes.every((prefix, index) => index === 0 || !prefix.startsWith(prefixes[index - 1]));
}
