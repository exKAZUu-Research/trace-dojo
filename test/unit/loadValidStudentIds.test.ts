import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { loadValidStudentIds } from '../../db/loadValidStudentIds';

const csv = '氏名,管理ID\r\n"Example, Student", ab123 \r\nAnother,CD456\r\nDuplicate,AB123\r\nEmpty,\r\n';
const shiftJisCsv = Buffer.concat([
  Buffer.from('8e8196bc2c8ac7979d4944', 'hex'),
  Buffer.from(csv.slice(csv.indexOf('\r\n'))),
]);

test.each([
  { encoding: 'utf8', content: Buffer.from(csv) },
  { encoding: 'UTF-8 with BOM', content: Buffer.from(`\uFEFF${csv}`) },
  { encoding: 'CP932', content: shiftJisCsv },
])('loads and normalizes student IDs from a $encoding roster', ({ content }) => {
  withCsv(content, (path) => {
    expect([...loadValidStudentIds(path)]).toEqual(['AB123', 'CD456']);
  });
});

test.each([
  { content: Buffer.from('氏名,ID\nExample,AB123\n'), message: 'No 管理ID column' },
  { content: Buffer.from('管理ID\n" "\n'), message: 'No valid student IDs' },
])('rejects an unusable roster: $message', ({ content, message }) => {
  withCsv(content, (path) => {
    expect(() => loadValidStudentIds(path)).toThrow(message);
  });
});

function withCsv(content: Buffer, check: (path: string) => void): void {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync('.tmp/student-roster-');
  try {
    const path = join(directory, 'students.csv');
    writeFileSync(path, content);
    check(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
