import assert from 'node:assert/strict';

import { z } from 'zod';

import { parse } from '../../src/interpreter/traceTransport';

import '../../src/infrastructures/trpcBackend/client';

const names = z.custom<Record<string, unknown>>((value) => z.record(z.string(), z.unknown()).safeParse(value).success);
const cases = z
  .array(z.object({ name: z.string(), field: z.boolean(), wire: z.string() }))
  .parse(JSON.parse(process.argv[2]!));
for (const { name, field, wire } of cases) {
  const raw: unknown = parse(wire);
  const recording = z
    .object({
      finalVars: names,
      traceItems: z.array(z.object({ vars: names, referenceVars: names })),
    })
    .parse(raw);
  assert.ok(Object.is(recording.finalVars.later, -0));
  if (field) {
    const frame = recording.traceItems.find((item) => Object.hasOwn(item.referenceVars, 'box'));
    assert.ok(frame);
    const node = z.object({ entries: names }).parse(frame.referenceVars.box);
    const entry = z.object({ kind: z.literal('value'), value: z.bigint() }).parse(node.entries[name]);
    assert.equal(entry.value, 10n ** 30n, `field ${name}`);
  } else {
    if (name !== 'toString') assert.ok(Object.getPrototypeOf(recording.finalVars) === null);
    assert.equal(recording.finalVars[name], 10n ** 30n, name);
    assert.ok(recording.traceItems.some((item) => item.vars[name] === 10n ** 30n));
  }
}
process.stdout.write(JSON.stringify(cases.map(({ name, field }) => ({ name, field }))));
