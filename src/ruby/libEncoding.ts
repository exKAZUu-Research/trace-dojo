import { def } from './define';
import { RObject, type RString, type RSymbol, type Value } from './objects';
import { rt, type Runtime } from './runtime';
import { isAsciiText } from './unicodeText';
import { asciiString, stringBytes } from './values';

const encodingNames = new WeakMap<RObject, RString>();
const builtinEncodings = new WeakMap<Runtime, Map<string, RObject>>();

export function builtinEncoding(name: string): RObject {
  return builtinEncodings.get(rt())!.get(name)!;
}

export function installEncodings(runtime: Runtime): void {
  const encoding = runtime.c.Encoding;
  const builtins = new Map<string, RObject>();
  builtinEncodings.set(runtime, builtins);
  for (const [constant, name] of [
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Ruby names the encoding this way.
    ['UTF_8', 'UTF-8'],
    ['ASCII_8BIT', 'ASCII-8BIT'],
    ['BINARY', 'ASCII-8BIT'],
    ['US_ASCII', 'US-ASCII'],
  ] as const) {
    const existing = [...encoding.constants.values()].find((value) => value instanceof RObject && value.data === name);
    if (existing instanceof RObject) {
      encoding.constants.set(constant, existing);
      builtins.set(constant, existing);
      continue;
    }
    const object = new RObject(encoding);
    object.data = name;
    object.frozen = true;
    const nameString = asciiString(name);
    nameString.frozen = true;
    encodingNames.set(object, nameString);
    encoding.constants.set(constant, object);
    builtins.set(constant, object);
  }
  for (const [alias, constant] of [
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- This is a case-sensitive Ruby constant.
    ['ASCII', 'US_ASCII'],
    ['ANSI_X3_4_1968', 'US_ASCII'],
    ['CP65001', 'UTF_8'],
  ])
    encoding.constants.set(alias, encoding.constants.get(constant) as Value);
}

def('Encoding', ['to_s', 'name'], 0, (self: RObject) => encodingNames.get(self) as RString);
def('Encoding', 'inspect', 0, (self: RObject) =>
  asciiString(self.data === 'ASCII-8BIT' ? '#<Encoding:BINARY (ASCII-8BIT)>' : `#<Encoding:${self.data as string}>`)
);
def('String', 'encoding', 0, (self: RString) =>
  builtinEncoding(self.binary ? 'ASCII_8BIT' : self.usAscii ? 'US_ASCII' : 'UTF_8')
);
def('Symbol', 'encoding', 0, (self: RSymbol) =>
  builtinEncoding(self.binary ? 'ASCII_8BIT' : self.usAscii || isAsciiText(self.name) ? 'US_ASCII' : 'UTF_8')
);
export function validStringEncoding(self: RString): boolean {
  if (self.usAscii) return stringBytes(self).every((byte) => byte < 0x80);
  if (self.binary || !self.rawBytes) return true;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stringBytes(self));
    return true;
  } catch {
    return false;
  }
}
def('String', 'valid_encoding?', 0, (self: RString) => validStringEncoding(self));
