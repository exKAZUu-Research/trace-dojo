import { classOf } from './types';
import { PyDict, PyList, PyRange, PyTuple, type PyValue } from './values';

/** Whether a match statement's sequence pattern may match a value: a list, tuple, range, or deque, but not a string. */
export function isSequenceForMatch(value: PyValue): boolean {
  if (value instanceof PyList || value instanceof PyTuple || value instanceof PyRange) return true;
  return classOf(value).mro.some((cls) => cls.isBuiltin && cls.name === 'deque');
}

/** Whether a match statement's mapping pattern may match a value. */
export function isMapping(value: PyValue): boolean {
  return value instanceof PyDict;
}
