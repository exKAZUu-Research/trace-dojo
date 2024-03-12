import * as fs from 'node:fs';

import { test } from 'vitest';

import { traceProgram } from '../src/tracer/traceProgram';
import type { GeneratedProgram } from '../src/types';

test.each([
  {
    displayProgram: 'straight',
    instrumentedProgram: fs.readFileSync('test-fixtures/sample.js', { encoding: 'utf8' }),
  },
] as const)('Trace a program', (program: GeneratedProgram) => {
  traceProgram(program);
});
