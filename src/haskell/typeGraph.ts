import { chargeTypeWork } from './typeWorkBudget';

type Resolve<T> = (node: T) => T;
type Children<T> = (node: T) => readonly T[];

export function mapGraphPairs<T>(
  a: T,
  b: T,
  resolve: Resolve<T>,
  children: (left: T, right: T) => [T, T][],
  rebuild: (left: T, right: T, mapped: T[]) => T
): T {
  interface Pair {
    left: T;
    right: T;
  }
  const pairs = new Map<T, Map<T, Pair>>();
  const pairOf = (a: T, b: T): Pair => {
    const left = resolve(a);
    const right = resolve(b);
    let matches = pairs.get(left);
    if (!matches) {
      matches = new Map();
      pairs.set(left, matches);
    }
    let pair = matches.get(right);
    if (!pair) {
      pair = { left, right };
      matches.set(right, pair);
    }
    return pair;
  };
  return mapGraph<Pair, T>(
    pairOf(a, b),
    (pair) => pair,
    ({ left, right }) => children(left, right).map(([x, y]) => pairOf(x, y)),
    ({ left, right }, mapped) => rebuild(left, right, mapped)
  );
}

export function mapGraph<T, R = T>(
  root: T,
  resolve: Resolve<T>,
  children: Children<T>,
  rebuild: (node: T, mapped: R[]) => R
): R {
  const result = new Map<T, R>();
  const first = resolve(root);
  const work = [first];
  while (work.length > 0) {
    const node = work.at(-1)!;
    if (result.has(node)) {
      work.pop();
      continue;
    }
    chargeTypeWork();
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
    chargeTypeWork();
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
    chargeTypeWork();
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
