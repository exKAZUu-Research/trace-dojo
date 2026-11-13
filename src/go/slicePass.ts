/**
 * Go's slice optimization pass (cmd/compile/internal/slice) for a local slice variable: when the pass understands every
 * use of the variable and exactly one of them lets the array be shared (a transition: returning or assigning the
 * variable, ranging over it, or passing it to an inlined function), outside any loop the declaration is not in, and the
 * function appends to the variable more than once, the compiler moves the array to the heap just before the transition
 * and lets the appends use the 32-byte stack buffer although the slice escapes.
 */
export interface SliceTracking {
  /** The loop depth of the declaration. */
  declDepth: number;
  /** One entry per mention of the variable, with whether the pass understands it, which may depend on a callee. */
  uses: SliceUse[];
  /** The uses that let the array be shared, with whether each one is (a call is only once it is inlined). */
  transitions: { loopDepth: number; applies: () => boolean }[];
  /** `s = append(s, ...)` statements, each weighing one more per loop it is nested in below the declaration. */
  appendWeight: number;
  /** Uses that read the capacity: `cap(s)`, `s = s[i:j]`, `s = []T{...}`, or passing s to a function not inlined. */
  capReads: (() => boolean)[];
  /** The first `append(s, ...)`, the only one to which Go's compiler gives the whole buffer for an empty slice. */
  firstAppend?: object;
  mode?: SliceMode | 'none';
}

export interface SliceUse {
  understood?: () => boolean;
}

/**
 * How the pass allocates the variable's appends: `move` gives an empty slice's first append the whole buffer and moves
 * the array to the heap at the transition with the capacity its length needs; `buffer`, used when the function reads the
 * capacity, grows into the buffer one size class at a time and keeps the capacity when it moves.
 */
export type SliceMode = 'move' | 'buffer';

export function newSliceTracking(declDepth: number): SliceTracking {
  return { declDepth, uses: [], transitions: [], appendWeight: 0, capReads: [] };
}

/** Decides the variable's mode once the whole program has compiled, which the first append or transition does. */
export function sliceMode(tracking: SliceTracking): SliceMode | undefined {
  tracking.mode ??= decideMode(tracking) ?? 'none';
  return tracking.mode === 'none' ? undefined : tracking.mode;
}

function decideMode(tracking: SliceTracking): SliceMode | undefined {
  if (!tracking.uses.every((use) => use.understood?.())) return undefined;
  const transitions = tracking.transitions.filter((transition) => transition.applies());
  if (transitions.length !== 1 || transitions[0].loopDepth > tracking.declDepth) return undefined;
  if (tracking.appendWeight < 2) return undefined;
  return tracking.capReads.some((reads) => reads()) ? 'buffer' : 'move';
}
