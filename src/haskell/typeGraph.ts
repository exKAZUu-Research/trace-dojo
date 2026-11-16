import { chargeCompilationWork } from './compilationBudget';

type Resolve<T> = (node: T) => T;
type Children<T> = (node: T) => readonly T[];

export function mapGraph<T>(
  root: T,
  resolve: Resolve<T>,
  children: Children<T>,
  rebuild: (node: T, mapped: T[]) => T
): T {
  const result = new Map<T, T>();
  const first = resolve(root);
  const work = [first];
  while (work.length > 0) {
    const node = work.at(-1)!;
    if (result.has(node)) {
      work.pop();
      continue;
    }
    chargeCompilationWork();
    const inputs = children(node).map(resolve);
    const missing = inputs.find((child) => !result.has(child));
    if (missing !== undefined) {
      work.push(missing);
      continue;
    }
    result.set(
      node,
      rebuild(
        node,
        inputs.map((child) => result.get(child)!)
      )
    );
    work.pop();
  }
  return result.get(first)!;
}

export function* walkGraph<T>(root: T, resolve: Resolve<T>, children: Children<T>): Generator<T> {
  const seen = new Set<T>();
  const work = [root];
  while (work.length > 0) {
    const node = resolve(work.pop()!);
    if (seen.has(node)) continue;
    chargeCompilationWork();
    seen.add(node);
    yield node;
    const next = children(node);
    for (let index = next.length - 1; index >= 0; index--) work.push(next[index]);
  }
}

export function* walkGraphPairs<T>(a: T, b: T, resolve: Resolve<T>, children: Children<T>): Generator<[T, T]> {
  const seen = new Map<T, Set<T>>();
  const work: [T, T][] = [[a, b]];
  while (work.length > 0) {
    const [left, right] = work.pop()!;
    const x = resolve(left);
    const y = resolve(right);
    let matches = seen.get(x);
    if (matches?.has(y)) continue;
    chargeCompilationWork();
    if (!matches) {
      matches = new Set();
      seen.set(x, matches);
    }
    matches.add(y);
    yield [x, y];
    const xs = children(x);
    const ys = children(y);
    if (xs.length === ys.length) {
      for (let index = xs.length - 1; index >= 0; index--) work.push([xs[index], ys[index]]);
    }
  }
}
