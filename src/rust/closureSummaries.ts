import type { LocalVar } from './annotations';
import type { Span } from './ast';
import type { LoanError } from './loanGraph';
import { type Layout, layoutOf, NONE, regionsOf, relate, type RVar } from './regions';
import type { Regions } from './signatureInstance';
import type { ClosureType } from './types';

/**
 * Which regions of a closure's parameters its result may hold: `[param, region of the param, region of the result]`;
 * `capturedRegions` likewise for the regions of the variables it captures, and `captures` lists the regions of the
 * result that may hold borrows of what the closure itself holds.
 */
export interface ClosureSummary {
  edges: [number, number, number][];
  capturedRegions: [LocalVar, number, number][];
  captures: number[];
  /** The closure's body, where rustc reports a result that outlives its parameters' borrows. */
  body: Span;
}

/** What a closure's body relates: its outlives relations and the regions of its result, parameters and captures. */
export interface ClosureBody {
  outlives: readonly (readonly [RVar, RVar])[];
  ret: RVar[];
  params: RVar[][];
  captures: [LocalVar, RVar[]][];
  /** The regions of the loans of what the closure captures. */
  captureLoans: RVar[];
  span: Span;
}

/** A call of a closure with a summary. */
export interface SummaryCall {
  args: Layout[];
  result: Layout;
  /** The region of the closure called. */
  callee: RVar;
  higherRanked: boolean[];
  higherRankedResult: ReadonlySet<RVar>;
  /** A region of a variable the closure captures, as the caller reaches it. */
  captured: (local: LocalVar, region: number) => RVar | undefined;
}

export function summarizeClosure(body: ClosureBody): ClosureSummary {
  const reached = reachedResultRegions(body.outlives, body.ret);
  const summary: ClosureSummary = { edges: [], capturedRegions: [], captures: [], body: body.span };
  for (const [param, regions] of body.params.entries()) {
    for (const [index, region] of regions.entries()) {
      for (const retRegion of reached([region])) summary.edges.push([param, index, retRegion]);
    }
  }
  for (const [local, regions] of body.captures) {
    for (const [index, region] of regions.entries()) {
      for (const retRegion of reached([region])) summary.capturedRegions.push([local, index, retRegion]);
    }
  }
  summary.captures = reached(body.captureLoans);
  return summary;
}

/** The indexes of the regions of a result that the given regions reach through the outlives relations. */
function reachedResultRegions(outlives: readonly (readonly [RVar, RVar])[], ret: RVar[]): (from: RVar[]) => number[] {
  const edges = outlivesEdges(outlives);
  return (from) => {
    const seen = new Set(from);
    const stack = [...from];
    while (stack.length > 0) {
      for (const next of edges.get(stack.pop() as RVar) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return ret.flatMap((region, index) => (seen.has(region) ? [index] : []));
  };
}

/** The regions each region outlives directly. */
function outlivesEdges(outlives: readonly (readonly [RVar, RVar])[]): Map<RVar, RVar[]> {
  const edges = new Map<RVar, RVar[]>();
  for (const [sup, sub] of outlives) {
    const list = edges.get(sup);
    if (list) list.push(sub);
    else edges.set(sup, [sub]);
  }
  return edges;
}

/** Relates the arguments and the result of a call of a closure as its summary says. */
export function relateSummaryCall(
  closure: ClosureType,
  summary: ClosureSummary,
  call: SummaryCall,
  regions: Regions,
  errors: LoanError[]
): void {
  const params = closure.params.map((type) => layoutOf(type, regions.fresh, regions.staticRegion));
  const ret = layoutOf(closure.ret, regions.fresh);
  for (const [index, arg] of call.args.entries()) relate(regions.outlives, arg, params[index] ?? NONE);
  relate(regions.outlives, ret, call.result);
  const retRegions = regionsOf(ret);
  for (const [param, region, retRegion] of summary.edges) {
    // A bound `F: FnMut(&T) -> K` takes every lifetime of its reference, which `K` cannot name.
    if (call.higherRanked[param] && region === 0) {
      errors.push({
        span: summary.body,
        message:
          'このクロージャーは、引数の参照から借りた値を返せません（呼び出すたびに違う寿命の参照を受け取るため）。',
      });
    }
    const from = regionsOf(params[param] ?? NONE)[region];
    if (from !== undefined && retRegions[retRegion] !== undefined) regions.outlives(from, retRegions[retRegion]);
  }
  relateCaptures(summary, call, retRegions, regions);
}

/** Relates the regions of what a closure captures, and of what it holds, to those of its result that may hold them. */
function relateCaptures(summary: ClosureSummary, call: SummaryCall, retRegions: RVar[], regions: Regions): void {
  const resultRegions = regionsOf(call.result);
  const captured = (from: RVar, retRegion: number): void => {
    if (retRegions[retRegion] === undefined) return;
    regions.outlives(from, retRegions[retRegion]);
    if (call.higherRankedResult.has(resultRegions[retRegion])) regions.outlives(from, regions.staticRegion());
  };
  for (const [local, region, retRegion] of summary.capturedRegions) {
    const from = call.captured(local, region);
    if (from !== undefined) captured(from, retRegion);
  }
  for (const retRegion of summary.captures) captured(call.callee, retRegion);
}
