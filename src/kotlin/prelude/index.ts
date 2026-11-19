import { COLLECTION_TYPES_SOURCE } from './collectionTypes';
import { CORE_SOURCE } from './core';
import { RANGES_SOURCE } from './ranges';
import { exceptionsSource, IO_SOURCE, REFLECT_SOURCE, TURTLE_SOURCE } from './runtimeTypes';

/** The prelude of the standard library, in the order its files are compiled together. */
export const PRELUDE_SOURCES = [
  CORE_SOURCE,
  exceptionsSource(),
  RANGES_SOURCE,
  COLLECTION_TYPES_SOURCE,
  IO_SOURCE,
  REFLECT_SOURCE,
  TURTLE_SOURCE,
];
