import { Random } from '../../app/utils/random';
import { uniqueCandidates } from './candidates';
import { GenerationLimitError, MAX_REPLACEMENTS } from './limits';
import type { Candidate, GeneratedExercise, GenerationAdapter, GenerationInput } from './types';

const MAX_SOURCE_LENGTH = 20_000;
const MAX_CANDIDATES = 2000;
const MAX_TOTAL_REPLACEMENTS = 4096;
const MAX_GENERATION_MILLISECONDS = 3000;
interface Choice {
  source: string;
  kind: 'logical' | 'syntax';
}

/**
 * Sample distinct source ranges uniformly, then sample valid replacements within the selected range.
 * A random permutation followed by the first viable range is uniform over viable ranges: mutation count never weights a range.
 * Eligibility is exhaustive and seed-independent. Resource caps reject the whole input, never a prefix of its ranges.
 * Wall-clock timeouts abort generation rather than making machine load decide which range is eligible.
 */
export function generateExercise<T>(
  input: GenerationInput,
  adapter: GenerationAdapter<T>
): GeneratedExercise<T> | undefined {
  if (input.source.length > MAX_SOURCE_LENGTH || input.selectors.length === 0) return;
  const deadline = performance.now() + MAX_GENERATION_MILLISECONDS;
  const source = adapter.canonicalize(input.source);
  const baseline = adapter.evaluate(source);
  if (baseline.kind !== 'success') return;
  let candidates: Candidate[];
  try {
    candidates = uniqueCandidates(adapter.collect(source, input.selectors));
  } catch (error) {
    if (error instanceof GenerationLimitError) return;
    throw error;
  }
  if (
    candidates.length === 0 ||
    candidates.length > MAX_CANDIDATES ||
    performance.now() > deadline ||
    candidates.reduce((count, candidate) => count + candidate.replacements.length, 0) > MAX_TOTAL_REPLACEMENTS ||
    candidates.some((c) => c.replacements.length > MAX_REPLACEMENTS)
  )
    return;
  const random = new Random(input.seed);
  for (const candidate of random.shuffle(candidates)) {
    const range = { start: candidate.start, end: candidate.end };
    if (input.format === 'fillInBlank')
      return {
        correctProgram: source,
        displayProgram: replace(source, candidate, '【1】'),
        answer: source.slice(candidate.start, candidate.end),
        range,
        target: baseline.target,
      };
    const choices = validMutations(input, adapter, source, candidate, baseline.target, deadline);
    if (!choices) return;
    if (choices.length > 0) {
      const selected = random.pick(choices);
      return {
        correctProgram: source,
        displayProgram: selected.source,
        range,
        bugKind: selected.kind,
        target: baseline.target,
      };
    }
  }
  return;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keep timeout handling and both observable verdicts in the same validation loop.
function validMutations<T>(
  input: GenerationInput,
  adapter: GenerationAdapter<T>,
  source: string,
  candidate: Candidate,
  target: T,
  deadline: number
): Choice[] | undefined {
  const choices: Choice[] = [];
  for (const replacement of candidate.replacements) {
    const mutated = replace(source, candidate, replacement);
    if (mutated === source || mutated.length > MAX_SOURCE_LENGTH) continue;
    if (performance.now() > deadline) return;
    const result = adapter.evaluate(mutated);
    if (performance.now() > deadline) return;
    if (result.kind === 'timeout') return;
    if (result.kind === 'compileError' && input.bugKind !== 'logical')
      choices.push({ source: mutated, kind: 'syntax' });
    if (result.kind === 'success' && input.bugKind !== 'syntax' && !adapter.equals(target, result.target))
      choices.push({ source: mutated, kind: 'logical' });
  }
  return choices;
}

function replace(source: string, range: Candidate, replacement: string): string {
  return source.slice(0, range.start) + replacement + source.slice(range.end);
}
