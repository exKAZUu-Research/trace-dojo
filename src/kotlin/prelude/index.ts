import { ANNOTATION_SOURCES } from './annotations';
import { arraysSource } from './arrays';
import { COLLECTION_CLASSES_SOURCE } from './collectionClasses';
import { COLLECTION_FUNCTIONS_SOURCE } from './collectionFunctions';
import { COLLECTION_TYPES_SOURCE } from './collectionTypes';
import { COLLECTION_VIEWS_SOURCE } from './collectionViews';
import { COMPARISONS_SOURCE, MATH_SOURCE, RANDOM_SOURCE } from './comparisonsRandomMath';
import { CORE_SOURCE } from './core';
import { PROPERTIES_SOURCE } from './properties';
import { RANGES_SOURCE } from './ranges';
import { REGEX_SOURCE } from './regex';
import { RESULT_SOURCE, SYSTEM_EXIT_SOURCE } from './result';
import {
  exceptionSources,
  FUNCTIONS_SOURCE,
  IO_SOURCE,
  JAVA_IO_SOURCE,
  REFLECT_SOURCE,
  SYSTEM_SOURCE,
  TURTLE_SOURCE,
} from './runtimeTypes';
import { SEQUENCES_SOURCE } from './sequences';
import { SORTED_COLLECTION_FUNCTIONS_SOURCE, SORTED_COLLECTIONS_SOURCE } from './sortedCollections';
import { STANDARD_SOURCE } from './standard';
import { TEXT_SOURCE, UTIL_SOURCE } from './text';
import { TEXT_COLLECTIONS_SOURCE } from './textCollections';
import { TIME_SOURCE } from './time';

/** The prelude of the standard library, in the order its files are compiled together. */
export const PRELUDE_SOURCES = [
  CORE_SOURCE,
  ...ANNOTATION_SOURCES,
  FUNCTIONS_SOURCE,
  ...exceptionSources(),
  STANDARD_SOURCE,
  RESULT_SOURCE,
  SYSTEM_EXIT_SOURCE,
  RANGES_SOURCE,
  COLLECTION_TYPES_SOURCE,
  COLLECTION_CLASSES_SOURCE,
  COLLECTION_FUNCTIONS_SOURCE,
  COLLECTION_VIEWS_SOURCE,
  SEQUENCES_SOURCE,
  SORTED_COLLECTIONS_SOURCE,
  SORTED_COLLECTION_FUNCTIONS_SOURCE,
  arraysSource(),
  COMPARISONS_SOURCE,
  RANDOM_SOURCE,
  MATH_SOURCE,
  UTIL_SOURCE,
  TEXT_SOURCE,
  TEXT_COLLECTIONS_SOURCE,
  REGEX_SOURCE,
  PROPERTIES_SOURCE,
  TIME_SOURCE,
  JAVA_IO_SOURCE,
  IO_SOURCE,
  SYSTEM_SOURCE,
  REFLECT_SOURCE,
  TURTLE_SOURCE,
];
