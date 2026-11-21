/**
 * The `__HI` and `__LO` macros of fdlibm 5.3, which read and write the 32-bit words of a double as C's signed `int`.
 *
 * The fdlibm sources carry this notice:
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

const view = new DataView(new ArrayBuffer(8));

/** `__HI`: the high word as C's signed `int`. */
export function high(value: number): number {
  view.setFloat64(0, value);
  return view.getInt32(0);
}

/** `__LO`: the low word as C's signed `int`. */
export function low(value: number): number {
  view.setFloat64(0, value);
  return view.getInt32(4);
}

export function withHigh(value: number, word: number): number {
  view.setFloat64(0, value);
  view.setInt32(0, word);
  return view.getFloat64(0);
}

export function withLow(value: number, word: number): number {
  view.setFloat64(0, value);
  view.setInt32(4, word);
  return view.getFloat64(0);
}

export function fromWords(highWord: number, lowWord: number): number {
  view.setInt32(0, highWord);
  view.setInt32(4, lowWord);
  return view.getFloat64(0);
}
