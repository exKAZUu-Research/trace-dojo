import { addressOf, Printer } from './fmt';
import { type Type, underlying } from './types';
import { Complex, Iface, type Slice, type Value } from './values';

const address = (value: Value): string => (value === undefined ? '0x0' : addressOf(value as object));

/** What the builtins `print` and `println` write for a value of a type, as Go's runtime prints it. */
export function runtimePrint(value: Value, type: Type): string {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      // Go 1.27 prints floats and complex numbers as fmt's %v does.
      if (typeof value === 'number' || value instanceof Complex) return new Printer().print([new Iface(type, value)]);
      return String(value);
    }
    case 'interface': {
      if (value === undefined) return '(0x0,0x0)';
      const iface = value as Iface;
      // A value that is not an object stands for the copy Go's runtime allocated when converting it.
      const data = typeof iface.value === 'object' ? iface.value : iface;
      return `(${addressOf(iface.type as object)},${addressOf(data)})`;
    }
    case 'slice': {
      const slice = value as Slice | undefined;
      return `[${slice?.length ?? 0}/${slice?.capacity ?? 0}]${slice ? addressOf(slice) : '0x0'}`;
    }
    default: {
      return address(value);
    }
  }
}
