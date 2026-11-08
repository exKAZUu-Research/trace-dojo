/** Discovery must abort the whole input, never return a biased prefix when a bound is exceeded. */
export class GenerationLimitError extends Error {}
export const MAX_REPLACEMENTS = 256;
