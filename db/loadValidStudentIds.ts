import { readFileSync } from 'node:fs';

import { parse } from 'csv-parse/sync';

export function loadValidStudentIds(csvPath: string): Set<string> {
  const rows = parseCsvRows(readCsvText(csvPath));
  const studentIdColumnIndex = rows[0]?.findIndex((value) => normalizeStudentId(value) === '管理ID') ?? -1;
  if (studentIdColumnIndex < 0) {
    throw new Error(`No 管理ID column found in ${csvPath}`);
  }

  const studentIds = new Set<string>();
  for (const row of rows.slice(1)) {
    const studentId = normalizeStudentId(row[studentIdColumnIndex]);
    if (studentId) {
      studentIds.add(studentId);
    }
  }

  if (studentIds.size === 0) {
    throw new Error(`No valid student IDs found in ${csvPath}`);
  }
  return studentIds;
}

function readCsvText(csvPath: string): string {
  const bytes = readFileSync(csvPath);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  }
}

function normalizeStudentId(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/^\uFEFF/, '')
      .toUpperCase() ?? ''
  );
}

function parseCsvRows(content: string): string[][] {
  return parse(content, {
    bom: true,
    skip_empty_lines: true,
  }) as string[][];
}
