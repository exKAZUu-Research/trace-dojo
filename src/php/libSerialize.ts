// code-gauge-allow-file fileNcss -- Keeps the serializer and the unserializer, which mirror each other's format, together.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt reads as they are.
import { lower, untilNul } from './bytes';
import { classConstant } from './classConstants';
import { coerceProperty, createDynamicProp, createObject, declForKey, findClass, findDeclaredClass } from './classes';
import { formatFloatRepr, getType, normalizeKeyString } from './conversions';
import { throwError, warn } from './errors';
import { defineClass, defineFunction } from './native';
import { toStr } from './operators';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import {
  enumCaseIdentifier,
  isClosure,
  type Key,
  PhpArray,
  type PhpClass,
  PhpObject,
  type PropDecl,
  Ref,
  type Slot,
  UNINIT,
  type Value,
} from './values';

// This module follows PHP's ext/standard/var.c and var_unserializer.re.

const INCOMPLETE_CLASS = '__PHP_Incomplete_Class';
const INCOMPLETE_CLASS_NAME = '__PHP_Incomplete_Class_Name';

defineClass({ name: INCOMPLETE_CLASS, isFinal: true });

const MAGIC_METHODS = ['__serialize', '__unserialize', '__sleep', '__wakeup'];

/** Rejects a class whose serialization this grader does not reproduce: custom serialization and builtin classes. */
function checkSerializableClass(cls: PhpClass): void {
  const serializable = rt().classes.get('serializable');
  for (const name of MAGIC_METHODS)
    if (cls.findMethod(name)) throw new UnsupportedFeatureError(`直列化のマジックメソッド（${name}）`);
  if (serializable && cls.isSubclassOf(serializable))
    throw new UnsupportedFeatureError('Serializable インターフェースによる直列化');
  for (let current: PhpClass | undefined = cls; current; current = current.parent)
    if (!current.isUser && current.name !== 'stdClass' && current.name !== INCOMPLETE_CLASS)
      throw new UnsupportedFeatureError(`組み込みクラスの直列化（${current.name}）`);
}

// Serialization ------------------------------------------------------------------------------------------------------

defineFunction('serialize(mixed $value): string', ({ args }) => new Serializer().serialize(args[0], true));

class Serializer {
  /** The number of values written so far, which `r:` and `R:` refer to. */
  private count = 0;
  /** The objects and references written so far, by their number. */
  private readonly numbers = new Map<object, number>();
  private readonly parts: string[] = [];

  serialize(value: Value, root: boolean): string {
    this.write(value, root);
    return this.parts.join('');
  }

  /** Writes a value, or a slot that is a reference when another holder shares it. */
  // code-gauge-allow functionCognitiveComplexity -- Follows php_var_serialize_intern, which dispatches on each type.
  // code-gauge-allow functionNcss -- One case per type, as php_var_serialize_intern writes them.
  private write(slot: Value | Ref, root = false): void {
    const runtime = rt();
    runtime.spend();
    const isReference = slot instanceof Ref;
    const value = slot instanceof Ref ? slot.v : slot;
    const number = this.number(slot, value);
    if (number !== undefined) {
      this.parts.push(isReference ? `R:${number};` : `r:${number};`);
      return;
    }
    if (value === null) this.parts.push('N;');
    else if (typeof value === 'boolean') this.parts.push(value ? 'b:1;' : 'b:0;');
    else if (typeof value === 'bigint') this.parts.push(`i:${value};`);
    else if (typeof value === 'number')
      this.parts.push(`d:${formatFloatRepr(value, 'E', false, { literalZero: true })};`);
    else if (typeof value === 'string') this.parts.push(`s:${value.length}:"${value}";`);
    else if (value instanceof PhpArray) {
      this.parts.push(`a:${value.size}:{`);
      this.writeEntries(value.map.entries(), root ? undefined : value);
      this.parts.push('}');
    } else if (value instanceof PhpObject) this.writeObject(value);
    else this.parts.push('i:0;');
    runtime.ensureStringFits(this.parts.length);
  }

  /** The number of an object or reference written before, after counting this value as PHP's php_add_var_hash does. */
  private number(slot: Value | Ref, value: Value): number | undefined {
    this.count++;
    let key: object;
    if (slot instanceof Ref) key = value instanceof PhpObject ? value : slot;
    else if (value instanceof PhpObject) key = value;
    else return undefined;
    const number = this.numbers.get(key);
    if (number === undefined) {
      this.numbers.set(key, this.count);
      return undefined;
    }
    if (slot instanceof Ref) this.count--;
    return number;
  }

  private writeEntries(entries: Iterable<[Key, Slot]>, self?: PhpArray): void {
    for (const [key, slot] of entries) {
      if (slot === UNINIT) continue;
      this.parts.push(typeof key === 'bigint' ? `i:${key};` : `s:${key.length}:"${key}";`);
      const shared = slot instanceof Ref && slot.isRef && slot.rc > 1 ? slot : slot instanceof Ref ? slot.v : slot;
      if (self && shared === self) {
        this.count++;
        this.parts.push('N;');
      } else this.write(shared);
    }
  }

  private writeObject(object: PhpObject): void {
    const cls = object.cls;
    if (isClosure(object) || cls.isAnonymous || cls.name === 'WeakReference')
      throwError('Exception', `Serialization of '${untilNul(cls.name)}' is not allowed`);
    if (cls.kind === 'enum') {
      const text = `${cls.name}:${enumCaseIdentifier(object) ?? ''}`;
      this.parts.push(`E:${text.length}:"${text}";`);
      return;
    }
    checkSerializableClass(cls);
    const entries: [string, Value | Ref][] = [];
    let name = cls.name;
    for (const [key, slot] of object.props) {
      if (slot === UNINIT) continue;
      if (cls.name === INCOMPLETE_CLASS && key === INCOMPLETE_CLASS_NAME) {
        name = toStr(slot instanceof Ref ? slot.v : slot);
        continue;
      }
      entries.push([declForKey(cls, key)?.visibility === 'protected' ? `\0*\0${key}` : key, slot]);
    }
    this.parts.push(`O:${name.length}:"${name}":${entries.length}:{`);
    this.writeEntries(entries);
    this.parts.push('}');
  }
}

// Unserialization ----------------------------------------------------------------------------------------------------

const VALID_CLASS_NAME = /^[A-Za-z_\u0080-ÿ][\w\u0080-ÿ]*(\\[A-Za-z_\u0080-ÿ][\w\u0080-ÿ]*)*$/;
const MAX_INT_DIGITS = 19;

/** Where an unserialized value is stored, which `R:` turns into a reference. */
interface Location {
  slot(): Value | Ref;
  store(slot: Value | Ref): void;
}

class Failure {}

defineFunction('unserialize(string $data, array $options = []): mixed', ({ args }) => {
  const data = args[0] as string;
  const allowed = allowedClasses((args[1] as PhpArray | undefined) ?? new PhpArray());
  if (data.length === 0) return false;
  const parser = new Unserializer(data, allowed);
  let result: Value;
  try {
    result = parser.root();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    warn(`unserialize(): Error at offset ${parser.offset} of ${data.length} bytes`);
    return false;
  }
  if (parser.offset < data.length)
    warn(`unserialize(): Extra data starting at offset ${parser.offset} of ${data.length} bytes`);
  return result;
});

/** The lowercase class names `allowed_classes` permits, or undefined when it permits every class. */
function allowedClasses(options: PhpArray): Set<string> | undefined {
  const option = options.get('allowed_classes');
  if (option === undefined || option === true) return undefined;
  if (option === false) return new Set();
  if (!(option instanceof PhpArray))
    throwError(
      'TypeError',
      `unserialize(): Option "allowed_classes" must be of type array|bool, ${getType(option) === 'integer' ? 'int' : getType(option)} given`
    );
  const names = new Set<string>();
  for (const slot of option.map.values()) {
    const value = slot instanceof Ref ? slot.v : slot;
    if (typeof value !== 'string' && !(value instanceof PhpObject))
      throwError(
        'TypeError',
        `unserialize(): Option "allowed_classes" must be an array of class names, ${getType(value)} given`
      );
    const name = toStr(value);
    if (!VALID_CLASS_NAME.test(name))
      throwError(
        'ValueError',
        `unserialize(): Option "allowed_classes" must be an array of class names, "${name}" given`
      );
    names.add(lower(name));
  }
  return names;
}

class Unserializer {
  offset = 0;
  /** The locations of the values read so far, which `r:` and `R:` refer to by number from 1. */
  private readonly locations: Location[] = [];

  constructor(
    private readonly data: string,
    private readonly allowed: Set<string> | undefined
  ) {}

  root(): Value {
    let result = null as Value | Ref;
    this.value({
      slot: () => result,
      store: (slot) => (result = slot),
    });
    return result instanceof Ref ? result.v : result;
  }

  /** Matches `pattern` (sticky) at the offset without moving it. */
  private match(pattern: RegExp): RegExpExecArray | undefined {
    pattern.lastIndex = this.offset;
    return pattern.exec(this.data) ?? undefined;
  }

  private fail(at = this.offset): never {
    this.offset = at;
    throw new Failure();
  }

  /** Reads a value into `location`, or a key when `location` is undefined, as php_var_unserialize_internal does. */
  private value(location: Location | undefined): Value {
    rt().spend();
    const start = this.offset;
    if (start >= this.data.length) this.fail();
    if (location && this.data[start] !== 'R') this.locations.push(location);
    const scalar = this.scalar();
    if (scalar) {
      this.offset = start + scalar.length;
      return store(location, scalar.value);
    }
    let match: RegExpExecArray | undefined;
    if ((match = this.match(/([sS]):(\d+):"/y))) return store(location, this.string(start, match));
    if ((match = this.match(/[Rr]:(\d+);/y))) {
      this.offset = start + match[0].length;
      return this.reference(this.located(location), Number(match[1]), match[0][0] === 'R');
    }
    if ((match = this.match(/a:(\d+):\{/y))) {
      this.offset = start + match[0].length;
      return this.array(this.located(location), Number(match[1]));
    }
    if ((match = this.match(/([OC]):(\d+):"/y))) {
      if (match[1] === 'C') throw new UnsupportedFeatureError('Serializable インターフェースによる直列化');
      return this.object(this.located(location), start, match[0].length, Number(match[2]));
    }
    if ((match = this.match(/E:(\d+):"/y)))
      return this.enumCase(this.located(location), start, match[0].length, Number(match[1]));
    if (this.data[start] === '}') warn('unserialize(): Unexpected end of serialized data');
    this.fail(start);
  }

  /** The location of a value that only a value, not a key, may be, failing for a key as PHP does. */
  private located(location: Location | undefined): Location {
    if (!location) this.fail();
    return location;
  }

  /** Reads null, a boolean, an int, or a float at the offset, with the length of its text. */
  private scalar(): { value: Value; length: number } | undefined {
    let match: RegExpExecArray | undefined;
    if ((match = this.match(/(N|b:0|b:1);/y)))
      return { value: match[1] === 'N' ? null : match[1] === 'b:1', length: match[0].length };
    if ((match = this.match(/i:([+-]?\d+);/y))) return { value: parseInteger(match[1]), length: match[0].length };
    if ((match = this.match(/d:(NAN|-?INF|[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?);/y))) {
      const text = match[1];
      const value =
        text === 'NAN' ? Number.NaN : text.endsWith('INF') ? (text[0] === '-' ? -1 : 1) * Infinity : Number(text);
      return { value, length: match[0].length };
    }
    return undefined;
  }

  /** Reads a string whose `s:<length>:"` header `header` matched at `start`. */
  private string(start: number, header: RegExpExecArray): string {
    const length = Number(header[2]);
    const begin = start + header[0].length;
    if (this.data.length - begin < length) this.fail(start + 2);
    if (header[1] === 'S') throw new UnsupportedFeatureError("unserialize() の 'S' 形式");
    const end = begin + length;
    if (this.data[end] !== '"') this.fail(end);
    if (this.data[end + 1] !== ';') this.fail(end + 1);
    this.offset = end + 2;
    return this.data.slice(begin, end);
  }

  private reference(location: Location, number: number, isReference: boolean): Value {
    const target = this.locations[number - 1];
    if (number === 0 || !target || target === location) this.fail();
    const slot = target.slot();
    if (!isReference) {
      const value = slot instanceof Ref ? slot.v : slot;
      if (!(value instanceof PhpObject)) this.fail();
      location.store(value);
      return value;
    }
    let ref: Ref;
    if (slot instanceof Ref && slot.isRef) ref = slot;
    else {
      ref = new Ref(slot instanceof Ref ? slot.v : slot);
      ref.isRef = true;
      target.store(ref);
    }
    ref.rc++;
    location.store(ref);
    return ref.v;
  }

  private array(location: Location, count: number): Value {
    if (count > (this.data.length - this.offset) / 2) this.fail();
    const array = new PhpArray();
    location.store(array);
    for (let index = 0; index < count; index++) {
      const key = this.value(undefined);
      let arrayKey: Key;
      if (typeof key === 'bigint') arrayKey = key;
      else if (typeof key === 'string') arrayKey = normalizeKeyString(key);
      else this.fail();
      array.set(arrayKey, null);
      this.value(arrayLocation(array, arrayKey));
      this.checkSeparator(index < count - 1);
    }
    this.finish();
    return array;
  }

  /** Checks that a value other than the last ended as PHP requires, with `;` or `}`. */
  private checkSeparator(more: boolean): void {
    if (more && !';}'.includes(this.data[this.offset - 1])) this.fail(this.offset - 1);
  }

  private finish(): void {
    if (this.data[this.offset] !== '}') this.fail();
    this.offset++;
  }

  /** Reads a quoted name of `length` bytes after a header of `headerLength`, followed by `next`. */
  private quotedName(start: number, headerLength: number, length: number, next: string): string {
    const begin = start + headerLength;
    if (this.data.length - begin < length || length === 0) this.fail(start + 2);
    const end = begin + length;
    if (this.data[end] !== '"') this.fail(end);
    if (this.data[end + 1] !== next) this.fail(end + 1);
    this.offset = end + 2;
    return this.data.slice(begin, end);
  }

  private object(location: Location, start: number, headerLength: number, length: number): Value {
    const name = this.quotedName(start, headerLength, length, ':');
    const cls = this.objectClass(name);
    const count = this.objectCount();
    if (cls && (cls.kind !== 'class' || cls.isAbstract))
      throwError('Error', `Cannot instantiate ${cls.kind === 'class' ? 'abstract class' : cls.kind} ${cls.name}`);
    const object = createObject(cls ?? (rt().classes.get(lower(INCOMPLETE_CLASS)) as PhpClass));
    if (!cls) object.props.set(INCOMPLETE_CLASS_NAME, name);
    location.store(object);
    for (let index = 0; index < count; index++) {
      const key = this.value(undefined);
      if (typeof key !== 'string' && typeof key !== 'bigint') this.fail();
      const propertyKey = propertyKeyFor(object, typeof key === 'bigint' ? key.toString() : key);
      if (propertyKey === undefined) this.fail();
      this.property(object, propertyKey);
      this.checkSeparator(index < count - 1);
    }
    this.finish();
    return object;
  }

  /** The class of a serialized object, or undefined for an incomplete one of a class missing or not allowed. */
  private objectClass(name: string): PhpClass | undefined {
    if (name[0] === '\0' || name[0] === '\\') this.fail();
    const allowed = this.allowed === undefined || this.allowed.has(lower(name));
    const found = allowed ? findDeclaredClass(name, true) : undefined;
    const cls = found?.isAnonymous ? undefined : found;
    if (!cls) {
      if (!VALID_CLASS_NAME.test(name)) this.fail();
      return undefined;
    }
    if (cls.name === 'Closure' || cls.name === 'Generator')
      throwError('Exception', `Unserialization of '${cls.name}' is not allowed`);
    checkSerializableClass(cls);
    return cls;
  }

  /** Reads the `<count>:{` of an object's properties. */
  private objectCount(): number {
    const header = this.match(/([+-]?\d+):\{/y);
    if (!header) {
      if (this.offset >= this.data.length - 2) {
        warn('Bad unserialize data');
        this.fail();
      }
      const digits = /[+-]?\d*/y;
      digits.lastIndex = this.offset;
      digits.exec(this.data);
      this.fail(this.data[digits.lastIndex] === ':' ? digits.lastIndex + 1 : digits.lastIndex);
    }
    const count = Number(header[1]);
    if (count < 0 || count > (this.data.length - this.offset - header[0].length) / 2) this.fail();
    this.offset += header[0].length;
    return count;
  }

  private property(object: PhpObject, key: string): void {
    const decl = declForKey(object.cls, key);
    if (!decl && !object.props.has(key) && object.cls.name !== INCOMPLETE_CLASS) createDynamicProp(object, key, null);
    const old = object.props.get(key);
    if (old instanceof Ref) old.rc--;
    object.props.set(key, null);
    const value = this.value({
      slot: () => object.props.get(key) as Value | Ref,
      store: (slot) => object.props.set(key, slot),
    });
    if (decl?.type) checkPropertyType(decl, value, object);
  }

  private enumCase(location: Location, start: number, headerLength: number, length: number): Value {
    const text = this.quotedName(start, headerLength, length, ';');
    const colon = text.indexOf(':');
    if (colon === -1) {
      warn(`unserialize(): Invalid enum name '${text}' (missing colon)`);
      this.fail(start);
    }
    const enumName = text.slice(0, colon);
    const caseName = text.slice(colon + 1);
    if (!VALID_CLASS_NAME.test(enumName)) this.fail(start);
    const cls = findClass(enumName);
    if (!cls) {
      warn(`unserialize(): Class '${enumName}' not found`);
      this.fail(start);
    }
    if (cls.kind !== 'enum') {
      warn(`unserialize(): Class '${enumName}' is not an enum`);
      this.fail(start);
    }
    if (!cls.consts.has(caseName)) {
      warn(`unserialize(): Undefined constant ${enumName}::${caseName}`);
      this.fail(start);
    }
    const value = classConstant(cls, caseName, cls);
    if (!(value instanceof PhpObject) || value.cls !== cls) {
      warn(`unserialize(): ${enumName}::${caseName} is not an enum case`);
      this.fail(start);
    }
    location.store(value);
    return value;
  }
}

function store(location: Location | undefined, value: Value): Value {
  location?.store(value);
  return value;
}

function arrayLocation(array: PhpArray, key: Key): Location {
  return {
    slot: () => array.map.get(key) as Value | Ref,
    store: (slot) => (slot instanceof Ref ? array.setSlot(key, slot) : array.set(key, slot)),
  };
}

function parseInteger(text: string): bigint {
  const digits = text.replace(/^[+-]/, '').replace(/^0+/, '');
  const value = BigInt(text.replace(/^\+/, ''));
  if (digits.length > MAX_INT_DIGITS || value > 9_223_372_036_854_775_807n || value < -9_223_372_036_854_775_808n) {
    warn('unserialize(): Numerical result out of range');
    return text.startsWith('-') ? -9_223_372_036_854_775_808n : 9_223_372_036_854_775_807n;
  }
  return value;
}

/**
 * The property a serialized name stores into, as PHP's is_property_visibility_changed finds it: a declared property by
 * its plain or mangled name, else a dynamic property of that name; undefined for a malformed mangled name.
 */
function propertyKeyFor(object: PhpObject, name: string): string | undefined {
  if (object.props.has(name) && declForKey(object.cls, name)) return name;
  let plain = name;
  let owner: string | undefined;
  if (name.startsWith('\0')) {
    const end = name.indexOf('\0', 1);
    if (end === -1) return undefined;
    owner = name.slice(1, end);
    plain = name.slice(end + 1);
  }
  if (owner === undefined || owner === '*' || lower(owner) === lower(object.cls.name)) {
    const decl: PropDecl | undefined = object.cls.propByName.get(plain) ?? object.cls.privateProps.get(plain);
    if (decl && !decl.isStatic) {
      if (decl.isVirtual) {
        warn(`unserialize(): Cannot unserialize value for virtual property ${decl.cls.name}::$${name}`);
        return undefined;
      }
      return decl.key;
    }
  }
  return name;
}

/** Checks a value unserialized into a typed property as PHP does: strictly, without coercion. */
function checkPropertyType(decl: PropDecl, value: Value, object: PhpObject): void {
  const runtime = rt();
  const strict = runtime.strictTypes;
  runtime.strictTypes = true;
  try {
    coerceProperty(decl, value, object);
  } finally {
    runtime.strictTypes = strict;
  }
}
