import type { GoPackage } from '../entities';
import { BASE64_PACKAGE } from './base64';
import { BIG_PACKAGE } from './big';
import { BINARY_PACKAGE } from './binary';
import { BITS_PACKAGE } from './bits';
import { BUFIO_PACKAGE } from './bufio';
import { BYTES_PACKAGE } from './bytes';
import { CMPLX_PACKAGE } from './cmplx';
import { CMP_PACKAGE, MAPS_PACKAGE, SLICES_PACKAGE, SORT_PACKAGE } from './collections';
import { HEAP_PACKAGE, LIST_PACKAGE, RING_PACKAGE } from './containers';
import { ERRORS_PACKAGE } from './errors';
import { FMT_PACKAGE } from './fmt';
import {
  CRC32_PACKAGE,
  FNV_PACKAGE,
  HASH_PACKAGE,
  MD5_PACKAGE,
  SHA1_PACKAGE,
  SHA256_PACKAGE,
  SHA512_PACKAGE,
} from './hash';
import { HEX_PACKAGE } from './hex';
import { IMAGE_PACKAGE } from './image';
import { COLOR_PACKAGE } from './imageColor';
import { IO_PACKAGE } from './ioStreams';
import { ITER_PACKAGE } from './iter';
import { JSON_PACKAGE } from './json';
import { LOG_PACKAGE } from './log';
import { MATH_PACKAGE } from './math';
import { RUNTIME_PACKAGE } from './misc';
import { NET_PACKAGE } from './net';
import { OS_PACKAGE } from './os';
import { FILEPATH_PACKAGE, PATH_PACKAGE } from './paths';
import { RAND_PACKAGE, RAND_V2_PACKAGE } from './rand';
import { REGEXP_PACKAGE } from './regexp';
import { SLOG_PACKAGE } from './slog';
import { STRCONV_PACKAGE } from './strconv';
import { STRINGS_PACKAGE } from './strings';
import { SYNC_PACKAGE } from './sync';
import { TEXT_TEMPLATE_PACKAGE } from './template';
import { TIME_PACKAGE } from './time';
import { UNICODE_PACKAGE, UTF8_PACKAGE } from './unicode';
import { URL_PACKAGE } from './url';
import { XML_PACKAGE } from './xml';

const PACKAGES = new Map<string, GoPackage>(
  [
    BITS_PACKAGE,
    BIG_PACKAGE,
    BINARY_PACKAGE,
    RING_PACKAGE,
    ITER_PACKAGE,
    SYNC_PACKAGE,
    BUFIO_PACKAGE,
    BYTES_PACKAGE,
    CMP_PACKAGE,
    CMPLX_PACKAGE,
    COLOR_PACKAGE,
    HEAP_PACKAGE,
    IMAGE_PACKAGE,
    LIST_PACKAGE,
    RAND_PACKAGE,
    RAND_V2_PACKAGE,
    REGEXP_PACKAGE,
    RUNTIME_PACKAGE,
    TEXT_TEMPLATE_PACKAGE,
    TIME_PACKAGE,
    ERRORS_PACKAGE,
    FMT_PACKAGE,
    IO_PACKAGE,
    JSON_PACKAGE,
    LOG_PACKAGE,
    SLOG_PACKAGE,
    MAPS_PACKAGE,
    MATH_PACKAGE,
    OS_PACKAGE,
    SLICES_PACKAGE,
    SORT_PACKAGE,
    STRCONV_PACKAGE,
    STRINGS_PACKAGE,
    UNICODE_PACKAGE,
    UTF8_PACKAGE,
    XML_PACKAGE,
    NET_PACKAGE,
    URL_PACKAGE,
    HASH_PACKAGE,
    CRC32_PACKAGE,
    FNV_PACKAGE,
    MD5_PACKAGE,
    SHA1_PACKAGE,
    SHA256_PACKAGE,
    SHA512_PACKAGE,
    BASE64_PACKAGE,
    HEX_PACKAGE,
    PATH_PACKAGE,
    FILEPATH_PACKAGE,
  ].map((pkg) => [pkg.path, pkg])
);

/** The library package with the import path, when this environment provides it. */
export function lookupPackage(path: string): GoPackage | undefined {
  return PACKAGES.get(path);
}
