import { ANY } from './sources/any';
import { BIT } from './sources/bit';
import { BITSET } from './sources/bitset';
import { COMPLEX } from './sources/complex';
import { COROUTINE } from './sources/coroutine';
import { DISTRIBUTIONS } from './sources/distributions';
import { EXCEPTION_PTR } from './sources/exceptionPtr';
import { FILESYSTEM } from './sources/filesystem';
import { FORWARD_LIST } from './sources/forwardList';
import { FUNCTION } from './sources/functional';
import { HASH } from './sources/hash';
import { INITIALIZER_LIST } from './sources/initializerList';
import { INVOKE } from './sources/invoke';
import { MEMORY } from './sources/memory';
import { NUMBERS } from './sources/numbers';
import { OPTIONAL } from './sources/optional';
import { RANGES } from './sources/ranges';
import { REVERSE_ITERATOR, SPAN } from './sources/span';
import { STRING_VIEW } from './sources/stringView';
import { INTEGER_SEQUENCE, TUPLE } from './sources/tuple';
import { TYPE_INFO } from './sources/typeInfo';
import { TYPE_TRAITS } from './sources/typeTraits';
import { UTILITY } from './sources/utility';
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
  TYPE_INFO,
  ANY,
  INITIALIZER_LIST,
  DISTRIBUTIONS,
  COROUTINE,
  UTILITY,
  EXCEPTION_PTR,
  INVOKE,
  HASH,
  BIT,
  REVERSE_ITERATOR,
  SPAN,
  COMPLEX,
  RANGES,
  FILESYSTEM,
  FORWARD_LIST,
];

const SOURCES_BY_NAME = new Map<string, LibrarySource[]>();
for (const source of LIBRARY_SOURCES) {
  for (const name of source.names) SOURCES_BY_NAME.set(name, [...(SOURCES_BY_NAME.get(name) ?? []), source]);
}

/** The parts of the library's C++ source that declare `std::name`, such as the overloads of a function. */
export function librarySourcesDeclaring(name: string): readonly LibrarySource[] {
  return SOURCES_BY_NAME.get(name) ?? [];
}
