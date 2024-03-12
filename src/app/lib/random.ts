import seedrandom from 'seedrandom';

export class Random {
  random: seedrandom.PRNG;

  constructor(seed?: string) {
    this.random = seedrandom(seed);
  }

  getNumber(): number {
    return this.random();
  }

  getInteger(inclusiveMin: number, exclusiveMax: number): number {
    return Math.floor(this.random() * (exclusiveMax - inclusiveMin)) + inclusiveMin;
  }

  getUniqueIntegers(inclusiveMin: number, exclusiveMax: number, count: number, { sorting = false } = {}): number[] {
    const ret: number[] = [];
    while (ret.length < count) {
      const candidate = Math.floor(this.random() * (exclusiveMax - inclusiveMin)) + inclusiveMin;
      if (!ret.includes(candidate)) {
        ret.push(candidate);
      }
    }
    return sorting ? ret.sort((a, b) => a - b) : ret;
  }

  pick<T>(array: T[]): T {
    return array[this.getInteger(0, array.length)];
  }

  /**
   * Pick an element from the array with the given weight.
   * The probability of picking an element is proportional to its weight.
   * For example, if the input is [['a', 1], ['b', 2], ['c', 3]],
   * the probability of picking 'a' is 1/6, 'b' is 2/6, and 'c' is 3/6.
   * @param array An array of [element, weight] pairs.
   */
  pickWithWeight<T>(array: [T, number][]): T {
    const totalWeight = array.reduce((acc, [, weight]) => acc + weight, 0);
    const random = this.getNumber() * totalWeight;
    let sum = 0;
    for (const [element, weight] of array) {
      sum += weight;
      if (random < sum) {
        return element;
      }
    }
    return (array.at(-1) as [T, number])[0];
  }

  shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; --i) {
      const r = this.getInteger(0, i + 1);
      const tmp = array[i];
      array[i] = array[r];
      array[r] = tmp;
    }
    return array;
  }
}
