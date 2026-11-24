import { BITSET } from './sources/bitset';
import { FUNCTION } from './sources/functional';
import { MEMORY } from './sources/memory';
import { NUMBERS } from './sources/numbers';
import { OPTIONAL } from './sources/optional';
import { STRING_VIEW } from './sources/stringView';
import { INTEGER_SEQUENCE, TUPLE } from './sources/tuple';
import { TYPE_TRAITS } from './sources/typeTraits';
import { VARIANT } from './sources/variant';

/**
 * The parts of the standard library the interpreter defines in C++ itself, each with the names of `std` it declares.
 * They are compiled as members of `std` when a program first names one of them, and their code records no steps.
 */
export interface LibrarySource {
  readonly names: readonly string[];
  readonly source: string;
  /** The other parts whose names this part's code uses, which are compiled before it. */
  readonly uses?: readonly LibrarySource[];
}

export const LIBRARY_SOURCES: readonly LibrarySource[] = [
  TYPE_TRAITS,
  OPTIONAL,
  FUNCTION,
  MEMORY,
  INTEGER_SEQUENCE,
  TUPLE,
  NUMBERS,
  BITSET,
  STRING_VIEW,
  VARIANT,
];

const SOURCE_BY_NAME = new Map(LIBRARY_SOURCES.flatMap((source) => source.names.map((name) => [name, source])));

/** The part of the library's C++ source that declares `std::name`, if any. */
export function librarySourceDeclaring(name: string): LibrarySource | undefined {
  return SOURCE_BY_NAME.get(name);
}
