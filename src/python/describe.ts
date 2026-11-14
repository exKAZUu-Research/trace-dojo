import { pyStr } from './conversions';
import { getAttributeOrUndefined } from './objects';
import { currentRuntime } from './runtimeContext';
import { STDLIB_MODULE_NAMES } from './stdlibModuleNames';
import { iterStr } from './strings';
import { fullyQualifiedName } from './types';
import { type ExceptionState, PyError, type PyInstance, PyList, type PyValue } from './values';

const MOVE_COST = 2;
const CASE_COST = 1;
const MAX_CANDIDATE_ITEMS = 750;
const MAX_STRING_SIZE = 40;

/** The last line of the traceback CPython prints for an uncaught exception, followed by the exception's notes. */
export function describeException(exception: PyInstance): string {
  const cls = exception.cls;
  const name = fullyQualifiedName(cls);
  let text: string;
  try {
    text = pyStr(exception);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
    text = '<exception str() failed>';
  }
  let line = text === '' ? name : `${name}: ${text}`;
  const suggestion = suggestionFor(exception);
  if (suggestion) line += suggestion;
  const notes = exception.dict.get('__notes__');
  if (notes instanceof PyList) {
    for (const note of notes.items) line += `\n${typeof note === 'string' ? note : safeStr(note)}`;
  }
  return line;
}

function safeStr(value: PyValue): string {
  try {
    return pyStr(value);
  } catch {
    return '<note str() failed>';
  }
}

// code-gauge-allow functionCognitiveComplexity 23 -- Follows traceback._compute_suggestion_error.
// code-gauge-allow functionNcss 31 -- Follows traceback._compute_suggestion_error.
function suggestionFor(exception: PyInstance): string | undefined {
  const state = exception.exception;
  if (!state) return undefined;
  const is = (className: string): boolean => exception.cls.mro.some((cls) => cls.isBuiltin && cls.name === className);
  if (is('ImportError')) return importSuggestion(state);
  if (!state.name) return undefined;
  const wrongName = state.name;
  if (is('AttributeError') && state.object !== undefined) {
    let candidates: string[];
    try {
      candidates = currentRuntime().suggestionNames(state.object);
    } catch {
      return undefined;
    }
    if (!wrongName.startsWith('_')) candidates = candidates.filter((candidate) => !candidate.startsWith('_'));
    const suggestion = bestSuggestion(wrongName, candidates);
    return suggestion ? `. Did you mean: '${suggestion}'?` : undefined;
  }
  if (is('NameError') && state.candidates) {
    let candidates = state.candidates;
    if (!wrongName.startsWith('_')) candidates = candidates.filter((candidate) => !candidate.startsWith('_'));
    // CPython checks an attribute of `self` before looking for a similar name.
    if (state.selfValue !== undefined && getAttributeOrUndefinedSafe(state.selfValue, wrongName)) {
      return `. Did you mean: 'self.${wrongName}'?`;
    }
    const suggestion = bestSuggestion(wrongName, candidates);
    if (suggestion) return `. Did you mean: '${suggestion}'?`;
    if (STDLIB_MODULE_NAMES.has(wrongName)) return `. Did you forget to import '${wrongName}'?`;
  }
  return undefined;
}

/** The name of the module `name` that is most similar to the `name_from` an ImportError could not import from it. */
function importSuggestion(state: ExceptionState): string | undefined {
  const moduleName = state.fields?.get('name');
  const wrongName = state.fields?.get('name_from');
  if (typeof moduleName !== 'string' || typeof wrongName !== 'string') return undefined;
  const runtime = currentRuntime();
  let candidates: string[];
  try {
    candidates = runtime.suggestionNames(runtime.resolveImport(moduleName));
  } catch {
    return undefined;
  }
  if (!wrongName.startsWith('_')) candidates = candidates.filter((candidate) => !candidate.startsWith('_'));
  const suggestion = bestSuggestion(wrongName, candidates);
  return suggestion ? `. Did you mean: '${suggestion}'?` : undefined;
}

function getAttributeOrUndefinedSafe(value: PyValue, name: string): boolean {
  try {
    return getAttributeOrUndefined(value, name) !== undefined;
  } catch {
    return false;
  }
}

/** The candidate CPython suggests for a wrong name, as `_Py_CalculateSuggestions` of its suggestions.c chooses it. */
export function bestSuggestion(wrongName: string, candidates: string[]): string | undefined {
  if (candidates.length >= MAX_CANDIDATE_ITEMS) return undefined;
  const wrongLength = wrongName.length;
  let bestDistance = Number.POSITIVE_INFINITY;
  let suggestion: string | undefined;
  for (const candidate of candidates) {
    if (candidate === wrongName) continue;
    let maxDistance = Math.floor(((candidate.length + wrongLength + 3) * MOVE_COST) / 6);
    maxDistance = Math.min(maxDistance, bestDistance - 1);
    const distance = levenshtein(wrongName, candidate, maxDistance);
    if (distance > maxDistance) continue;
    if (!suggestion || distance < bestDistance) {
      suggestion = candidate;
      bestDistance = distance;
    }
  }
  return suggestion;
}

function substitutionCost(a: string, b: string): number {
  if (a === b) return 0;
  if (a.toLowerCase() === b.toLowerCase()) return CASE_COST;
  return MOVE_COST;
}

// code-gauge-allow functionNcss 40 -- Transcribes traceback._levenshtein_distance.
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes traceback._levenshtein_distance.
function levenshtein(left: string, right: string, maxCost: number): number {
  if (left === right) return 0;
  let a = iterStr(left);
  let b = iterStr(right);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  a = a.slice(prefix);
  b = b.slice(prefix);
  let suffix = 0;
  while (suffix < a.length && suffix < b.length && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  a = a.slice(0, a.length - suffix);
  b = b.slice(0, b.length - suffix);
  if (a.length === 0 || b.length === 0) return MOVE_COST * (a.length + b.length);
  if (a.length > MAX_STRING_SIZE || b.length > MAX_STRING_SIZE) return maxCost + 1;
  if (b.length < a.length) [a, b] = [b, a];
  if ((b.length - a.length) * MOVE_COST > maxCost) return maxCost + 1;
  const row = Array.from({ length: a.length }, (_, index) => (index + 1) * MOVE_COST);
  let result = 0;
  for (const [bIndex, bChar] of b.entries()) {
    let distance = bIndex * MOVE_COST;
    result = distance;
    let minimum = Number.POSITIVE_INFINITY;
    for (const [index, aChar] of a.entries()) {
      const substitute = distance + substitutionCost(bChar, aChar);
      distance = row[index];
      const insertDelete = Math.min(result, distance) + MOVE_COST;
      result = Math.min(insertDelete, substitute);
      row[index] = result;
      if (result < minimum) minimum = result;
    }
    if (minimum > maxCost) return maxCost + 1;
  }
  return result;
}
