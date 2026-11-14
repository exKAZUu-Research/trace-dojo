import { replacePointerBytes } from './pointerBounds';
import type { Frame } from './runtime';
import { type CType, type Field, sizeOf } from './types';

export type Writer = (frame: Frame, address: number) => void;

export interface BitRange {
  start: number;
  end: number;
}

export interface Write {
  offset: number;
  size: number;
  coverage?: BitRange[];
  write: Writer;
}

export function zeroedWriter(size: number, writes: Write[]): Writer {
  return (frame, address) => {
    const block = frame.runtime.memory.locate(address, size);
    const offset = address - block.base;
    replacePointerBytes(block.pointerBytes, offset, size);
    block.bytes.fill(0, offset, offset + size);
    block.initialized.fill(255, offset, offset + size);
    for (const { offset: at, write } of writes) write(frame, address + at);
  };
}

export function memberCoverage(member: { offset: number; type: CType; field?: Field }): BitRange[] {
  const start = member.offset * 8 + (member.field?.bitOffset ?? 0);
  return [{ start, end: start + (member.field?.bitWidth ?? sizeOf(member.type) * 8) }];
}

export function replaceWrites(writes: Write[], offset: number, size: number, coverage?: BitRange[]): void {
  const replacements = coverage ?? [{ start: offset * 8, end: (offset + size) * 8 }];
  for (let index = writes.length - 1; index >= 0; index--) {
    const write = writes[index];
    let remaining = write.coverage ?? [{ start: write.offset * 8, end: (write.offset + write.size) * 8 }];
    for (const replacement of replacements) remaining = remaining.flatMap((range) => subtract(range, replacement));
    if (remaining.length === 0) writes.splice(index, 1);
    else write.coverage = remaining;
  }
}

function subtract(range: BitRange, replacement: BitRange): BitRange[] {
  if (replacement.end <= range.start || replacement.start >= range.end) return [range];
  const remaining: BitRange[] = [];
  if (range.start < replacement.start) remaining.push({ start: range.start, end: replacement.start });
  if (replacement.end < range.end) remaining.push({ start: replacement.end, end: range.end });
  return remaining;
}
