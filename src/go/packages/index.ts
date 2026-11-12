import type { GoPackage } from '../entities';
import { BITS_PACKAGE } from './bits';
import { BUFIO_PACKAGE } from './bufio';
import { CMPLX_PACKAGE } from './cmplx';
import { CMP_PACKAGE, MAPS_PACKAGE, SLICES_PACKAGE, SORT_PACKAGE } from './collections';
import { HEAP_PACKAGE, LIST_PACKAGE } from './containers';
import { ERRORS_PACKAGE } from './errors';
import { FMT_PACKAGE } from './fmt';
import { IO_PACKAGE } from './io';
import { ITER_PACKAGE } from './iter';
import { MATH_PACKAGE } from './math';
import { COLOR_PACKAGE, IMAGE_PACKAGE, RUNTIME_PACKAGE } from './misc';
import { OS_PACKAGE } from './os';
import { RAND_PACKAGE, RAND_V2_PACKAGE } from './rand';
import { STRCONV_PACKAGE } from './strconv';
import { STRINGS_PACKAGE } from './strings';
import { SYNC_PACKAGE } from './sync';
import { TIME_PACKAGE } from './time';
import { UNICODE_PACKAGE, UTF8_PACKAGE } from './unicode';

const PACKAGES = new Map<string, GoPackage>(
  [
    BITS_PACKAGE,
    BUFIO_PACKAGE,
    CMP_PACKAGE,
    CMPLX_PACKAGE,
    COLOR_PACKAGE,
    HEAP_PACKAGE,
    IMAGE_PACKAGE,
    LIST_PACKAGE,
    RAND_PACKAGE,
    RAND_V2_PACKAGE,
    RUNTIME_PACKAGE,
    TIME_PACKAGE,
    ERRORS_PACKAGE,
    FMT_PACKAGE,
    IO_PACKAGE,
    ITER_PACKAGE,
    MAPS_PACKAGE,
    MATH_PACKAGE,
    OS_PACKAGE,
    SLICES_PACKAGE,
    SORT_PACKAGE,
    STRCONV_PACKAGE,
    STRINGS_PACKAGE,
    SYNC_PACKAGE,
    UNICODE_PACKAGE,
    UTF8_PACKAGE,
  ].map((pkg) => [pkg.path, pkg])
);

/** The library package with the import path, when this environment provides it. */
export function lookupPackage(path: string): GoPackage | undefined {
  return PACKAGES.get(path);
}
