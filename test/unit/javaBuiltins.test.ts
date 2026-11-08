import { expect, test } from 'vitest';

import { getBuiltins } from '../../src/java/builtins';
import { findImplementation } from '../../src/java/runtime';
import { superclassesOf } from '../../src/java/typeResolver';
import { superinterfacesOf } from '../../src/java/types';

test('every concrete builtin class implements the abstract methods it inherits', () => {
  const missing: string[] = [];
  for (const cls of getBuiltins().classes.values()) {
    if (cls.isAbstract || cls.kind === 'interface') continue;
    for (const ancestor of [cls, ...superclassesOf(cls), ...superinterfacesOf(cls)]) {
      for (const method of ancestor.methods) {
        if (method.isAbstract && findImplementation(cls, method).isAbstract) {
          missing.push(`${cls.name}.${method.name}/${method.parameterTypes.length} from ${ancestor.name}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
});
