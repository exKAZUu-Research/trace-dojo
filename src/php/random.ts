const N = 624;
const M = 397;

function twist(m: number, u: number, v: number): number {
  const mixed = ((u & 0x80_00_00_00) | (v & 0x7f_ff_ff_ff)) >>> 1;
  return (m ^ mixed ^ (v & 1 ? 0x99_08_b0_df : 0)) >>> 0;
}

/** PHP's Mersenne Twister (`mt_rand`, `rand`, `shuffle`), which the same seed makes produce PHP's sequence. */
export class MersenneTwister {
  private readonly state = new Uint32Array(N);
  private count = N;
  private seeded = false;

  seed(seed: number): void {
    const s = this.state;
    s[0] = seed >>> 0;
    for (let index = 1; index < N; index++) {
      const previous = s[index - 1] ^ (s[index - 1] >>> 30);
      s[index] = (Math.imul(1_812_433_253, previous) + index) >>> 0;
    }
    this.reload();
    this.seeded = true;
  }

  private reload(): void {
    const s = this.state;
    let p = 0;
    for (let index = N - M; index > 0; index--, p++) s[p] = twist(s[p + M], s[p], s[p + 1]);
    for (let index = M; --index > 0; p++) s[p] = twist(s[p + M - N], s[p], s[p + 1]);
    s[p] = twist(s[p + M - N], s[p], s[0]);
    this.count = 0;
  }

  /** The next 32-bit output. */
  next(): number {
    if (!this.seeded) this.seed(Math.floor(Math.random() * 2 ** 32));
    if (this.count >= N) this.reload();
    let value = this.state[this.count++];
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d_2c_56_80;
    value ^= (value << 15) & 0xef_c6_00_00;
    return (value ^ (value >>> 18)) >>> 0;
  }

  /** A uniform integer in [min, max], as `php_mt_rand_range` draws it. */
  range(min: bigint, max: bigint): bigint {
    const umax = BigInt.asUintN(64, max - min);
    if (umax > 0xff_ff_ff_ffn) return BigInt.asIntN(64, min + this.range64(umax));
    return min + BigInt(this.range32(Number(umax)));
  }

  private range32(umax: number): number {
    let result = this.next();
    if (umax === 0xff_ff_ff_ff) return result;
    const size = umax + 1;
    if ((size & (size - 1)) === 0) return (result & (size - 1)) >>> 0;
    const limit = 0xff_ff_ff_ff - (0xff_ff_ff_ff % size) - 1;
    while (result > limit) result = this.next();
    return result % size;
  }

  private range64(umax: bigint): bigint {
    const draw = (): bigint => {
      const low = BigInt(this.next());
      const high = BigInt(this.next());
      return low | (high << 32n);
    };
    let result = draw();
    if (umax === 0xff_ff_ff_ff_ff_ff_ff_ffn) return result;
    const size = umax + 1n;
    if ((size & (size - 1n)) === 0n) return result & (size - 1n);
    const limit = 0xff_ff_ff_ff_ff_ff_ff_ffn - (0xff_ff_ff_ff_ff_ff_ff_ffn % size) - 1n;
    while (result > limit) result = draw();
    return result % size;
  }
}
