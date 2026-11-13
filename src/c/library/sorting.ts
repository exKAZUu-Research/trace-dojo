/*-
 * Copyright (c) 1991, 1992, 1993
 *	The Regents of the University of California.  All rights reserved.
 *
 * This code is derived from software contributed to Berkeley by
 * Ronnie Kon at Mindcraft Inc., Kevin Lew and Elmer Yglesias.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 4. Neither the name of the University nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */
import type { Runtime } from '../runtime';
import { readRaw, writeBytes } from './support';

// Match the platform's comparator order, including fallback after equal-element relocation.
// https://github.com/apple-oss-distributions/Libc/blob/main/stdlib/FreeBSD/qsort.c
export function qsort(
  runtime: Runtime,
  base: number,
  count: number,
  size: number,
  compare: (a: number, b: number) => number
): void {
  new QuickSort(runtime, size, compare).sort(base, count);
}

class QuickSort {
  constructor(
    private readonly runtime: Runtime,
    private readonly size: number,
    private readonly compare: (a: number, b: number) => number
  ) {}

  // code-gauge-allow functionCognitiveComplexity 23 -- Preserve Apple qsort partition, fallback, and recursion order because comparator calls are observable.
  // code-gauge-allow functionNcss 36 -- The sort loop keeps pivot, partition boundaries, fallback and tail recursion in one order.
  sort(start: number, n: number, depth = 2 * Math.floor(Math.log2(n))): void {
    const { size } = this;
    let a = start;
    let length = n;
    for (;;) {
      this.runtime.spend();
      if (depth-- <= 0) {
        this.heapSort(a, length);
        return;
      }
      if (length <= 7) {
        this.insertionSort(a, length);
        return;
      }
      this.swap(a, this.pivot(a, length));
      const { pa, pb, pc, pd, swapped } = this.partition(a, length);
      const pn = a + length * size;
      let r = Math.min(pa - a, pb - pa);
      this.vectorSwap(a, pb - r, r);
      r = Math.min(pd - pc, pn - pd - size);
      this.vectorSwap(pb, pn - r, r);
      if (!swapped && this.insertionSort(a, length, 1 + Math.floor(length / 4))) return;
      const left = pb - pa;
      const right = pd - pc;
      if (left <= right) {
        if (left > size) this.sort(a, left / size, depth);
        if (right <= size) return;
        a = pn - right;
        length = right / size;
      } else {
        if (right > size) this.sort(pn - right, right / size, depth);
        if (left <= size) return;
        length = left / size;
      }
    }
  }

  private pivot(a: number, length: number): number {
    const { size } = this;
    let pm = a + Math.floor(length / 2) * size;
    if (length > 7) {
      let pl = a;
      let pn = a + (length - 1) * size;
      if (length > 40) {
        const d = Math.floor(length / 8) * size;
        pl = this.med3(pl, pl + d, pl + 2 * d);
        pm = this.med3(pm - d, pm, pm + d);
        pn = this.med3(pn - 2 * d, pn - d, pn);
      }
      pm = this.med3(pl, pm, pn);
    }
    return pm;
  }

  private partition(a: number, length: number): { pa: number; pb: number; pc: number; pd: number; swapped: boolean } {
    const { size } = this;
    let swapped = false;
    let pa = a + size;
    let pb = pa;
    let pc = a + (length - 1) * size;
    let pd = pc;
    for (;;) {
      let result: number;
      while (pb <= pc && (result = this.compare(pb, a)) <= 0) {
        if (result === 0) {
          swapped = true;
          this.swap(pa, pb);
          pa += size;
        }
        pb += size;
      }
      while (pb <= pc && (result = this.compare(pc, a)) >= 0) {
        if (result === 0) {
          swapped = true;
          this.swap(pc, pd);
          pd -= size;
        }
        pc -= size;
      }
      if (pb > pc) return { pa, pb, pc, pd, swapped };
      this.swap(pb, pc);
      swapped = true;
      pb += size;
      pc -= size;
    }
  }

  private med3(a: number, b: number, c: number): number {
    if (this.compare(a, b) < 0) {
      if (this.compare(b, c) < 0) return b;
      return this.compare(a, c) < 0 ? c : a;
    }
    if (this.compare(b, c) > 0) return b;
    return this.compare(a, c) < 0 ? a : c;
  }

  private insertionSort(start: number, n: number, limit = 0): boolean {
    const { size } = this;
    let swaps = 0;
    for (let pm = start + size; pm < start + n * size; pm += size) {
      for (let pl = pm; pl > start && this.compare(pl - size, pl) > 0; pl -= size) {
        this.swap(pl, pl - size);
        if (limit && ++swaps > limit) return false;
      }
    }
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Heap construction and bottom-up selection preserve the platform comparison order and displaced record.
  // code-gauge-allow functionNcss 37 -- Build and extraction share the one-based address mapping and temporary allocation lifetime.
  private heapSort(start: number, n: number): void {
    if (n <= 1) return;
    const { size, compare, runtime } = this;
    const at = (index: number): number => start + (index - 1) * size;
    const copy = (destination: number, source: number): void => {
      const value = readRaw(runtime, source, size);
      writeBytes(runtime, destination, value.bytes, value.initialized, value.pointerRanges);
    };
    const temporary = runtime.allocate(size, 'heap');
    try {
      for (let root = Math.floor(n / 2); root > 0; root--) {
        let parent = root;
        for (let child = parent * 2; child <= n; child = parent * 2) {
          if (child < n && compare(at(child), at(child + 1)) < 0) child++;
          if (compare(at(child), at(parent)) <= 0) break;
          this.swap(at(parent), at(child));
          parent = child;
        }
      }
      while (n > 1) {
        copy(temporary.base, at(n));
        copy(at(n), at(1));
        n--;
        let parent = 1;
        for (let child = parent * 2; child <= n; child = parent * 2) {
          if (child < n && compare(at(child), at(child + 1)) < 0) child++;
          copy(at(parent), at(child));
          parent = child;
        }
        for (;;) {
          const child = parent;
          parent = Math.floor(child / 2);
          if (child === 1 || compare(temporary.base, at(parent)) < 0) {
            copy(at(child), temporary.base);
            break;
          }
          copy(at(child), at(parent));
        }
      }
    } finally {
      runtime.memory.release(temporary);
    }
  }

  private vectorSwap(a: number, b: number, length: number): void {
    for (let offset = 0; offset < length; offset += this.size) this.swap(a + offset, b + offset);
  }

  private swap(a: number, b: number): void {
    if (a === b) return;
    const first = readRaw(this.runtime, a, this.size);
    const second = readRaw(this.runtime, b, this.size);
    writeBytes(this.runtime, a, second.bytes, second.initialized, second.pointerRanges);
    writeBytes(this.runtime, b, first.bytes, first.initialized, first.pointerRanges);
  }
}
