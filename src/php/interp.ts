// code-gauge-allow-file fileNcss 680 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import {
  applyOperator,
  assignExpression,
  assignReference,
  compoundAssign,
  destructure,
  incDec,
  isset,
  placeOf,
} from './assignment';
import type { Arg, ClassDecl, ClassRef, Expr } from './ast';
import { hasReferenceItem } from './astAnalysis';
import { lower } from './bytes';
import {
  callExpression,
  callMethod,
  callValue,
  createArrow,
  createClosure,
  evalArgs,
  methodCallExpression,
  staticCallExpression,
} from './callables';
import { type ArgValue, callStack, invoke } from './calls';
import {
  canCall,
  checkInstantiable,
  classConstant,
  createObject,
  declareClass,
  findClass,
  instantiate,
  issetProp,
  readProp,
  readStaticProp,
  requireClass,
  visibleProps,
  writeProp,
} from './classes';
import * as classesModule from './classes';
import * as conversionsModule from './conversions';
import { debugType, toBool, valueName } from './conversions';
import { deprecated, notice, throwError, warn } from './errors';
import { constantDeprecation } from './native';
import {
  bitwiseNot,
  compare,
  looseEquals,
  negate,
  strictEquals,
  toFloat,
  toInt,
  toKey,
  toStr,
  unaryPlus,
} from './operators';
import { readElement, share } from './places';
import { ExitSignal, PhpThrow, rt } from './runtime';
import { constantKey, iteratorOf } from './statements';
import { UnsupportedFeatureError } from './unsupported';
import { type ClosureData, isClosure, PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

export const SHORT = Symbol('nullsafe');
export type Chain = Value | typeof SHORT;

// Expressions --------------------------------------------------------------------------------------------------------

/** Evaluates an expression whose value a `return` passes to the caller, which keeps it alive meanwhile. */
export function evReturn(e: Expr): Value {
  const frame = rt().frame;
  const fn = frame.fn;
  if (fn?.kind === 'user' && fn.decl.byRefReturn) {
    if (['var', 'idx', 'prop', 'sprop'].includes(e.k)) {
      const ref = placeOf(e).ref();
      ref.isRef = true;
      frame.returnRef = ref;
      return ref.v;
    }
    notice('Only variable references should be returned by reference');
  }
  return ev(e);
}

export function ev(e: Expr): Value {
  if (RELEASING_OPERANDS.has(e.k)) {
    // PHP frees the operands of these expressions as soon as it has used them.
    const mark = rt().frame.temporaries.length;
    const value = evChain(e);
    return keepResult(mark, value === SHORT ? null : value) as Value;
  }
  const value = evChain(e);
  return value === SHORT ? null : value;
}

/** The expressions that consume their operands, which PHP frees right after the expression. */
const RELEASING_OPERANDS = new Set<Expr['k']>(['instanceof', 'unary', 'cast', 'cond', 'empty', 'prop', 'idx']);

export function evChain(e: Expr): Chain {
  const runtime = rt();
  switch (e.k) {
    case 'lit': {
      return e.v;
    }
    case 'interp': {
      let text = '';
      for (const part of e.parts) {
        text += typeof part === 'string' ? part : toStr(ev(part));
        rt().ensureStringFits(text.length);
      }
      return text;
    }
    case 'var': {
      return readVar(e.name, e.row);
    }
    case 'varvar': {
      return readVar(toStr(ev(e.name)), e.row);
    }
    case 'array': {
      return arrayLiteral(e);
    }
    case 'idx': {
      if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
      if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
        const name = toStr(ev(e.index));
        runtime.row = e.row;
        const ref = runtime.globalFrame.vars.get(name);
        if (ref) return ref.v;
        warn(`Undefined global variable $${name}`);
        return null;
      }
      const base = evChain(e.base);
      if (base === SHORT) return SHORT;
      const index = ev(e.index);
      runtime.row = e.row;
      return readIndex(base, index, false);
    }
    case 'prop': {
      const object = evChain(e.obj);
      if (object === SHORT) return SHORT;
      if (e.nullsafe && object === null) return SHORT;
      const name = memberName(e.name);
      runtime.row = e.row;
      if (!(object instanceof PhpObject)) {
        warn(`Attempt to read property "${name}" on ${valueName(object)}`);
        return null;
      }
      return readProp(object, name, runtime.frame.scope);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      return readStaticProp(cls, name, runtime.frame.scope);
    }
    case 'cconst': {
      return classConstantOf(e);
    }
    case 'const': {
      return readConstant(e.name.name, e.name.fallback);
    }
    case 'magic': {
      return magicConstant(e.name);
    }
    case 'call': {
      const mark = runtime.frame.temporaries.length;
      return keepResult(mark, callExpression(e));
    }
    case 'mcall': {
      const mark = runtime.frame.temporaries.length;
      return keepResult(mark, methodCallExpression(e));
    }
    case 'scall': {
      const mark = runtime.frame.temporaries.length;
      return keepResult(mark, staticCallExpression(e));
    }
    case 'new': {
      return keepingResult(() => {
        runtime.row = e.row;
        const cls = resolveClassRef(e.cls);
        checkInstantiable(cls);
        return instantiate(cls, () => constructorArgs(cls, e.args, e.row), e.row, runtime.frame.scope);
      });
    }
    case 'newAnon': {
      return keepingResult(() => {
        runtime.row = e.row;
        const cls = anonymousClass(e.decl, e.row);
        return instantiate(cls, () => constructorArgs(cls, e.args, e.row), e.row, runtime.frame.scope);
      });
    }
    case 'assign': {
      if (e.target.k === 'list') {
        const value = ev(e.value);
        runtime.frame.temporaries.push(value);
        if (['call', 'mcall', 'scall'].includes(e.value.k) && hasReferenceItem(e.target)) {
          notice('Attempting to set reference to non referenceable value');
        }
        destructure(e.target, value);
        return value;
      }
      return assignExpression(e.target, e.value);
    }
    case 'assignRef': {
      return assignReference(e.target, e.source);
    }
    case 'assignOp': {
      return compoundAssign(e);
    }
    case 'bin': {
      return binary(e);
    }
    case 'unary': {
      const value = ev(e.e);
      runtime.row = e.row;
      switch (e.op) {
        case '!': {
          return !toBool(value);
        }
        case '-': {
          return negate(value);
        }
        case '+': {
          return unaryPlus(value);
        }
        default: {
          return bitwiseNot(value);
        }
      }
    }
    case 'incdec': {
      return incDec(e);
    }
    case 'cond': {
      const test = ev(e.test);
      if (e.consequent === undefined) return toBool(test) ? test : ev(e.alternate);
      return toBool(test) ? ev(e.consequent) : ev(e.alternate);
    }
    case 'cast': {
      return cast(e.type, ev(e.e));
    }
    case 'silence': {
      runtime.silence++;
      try {
        return ev(e.e);
      } finally {
        runtime.silence--;
      }
    }
    case 'clone': {
      return cloneExpression(e);
    }
    case 'throw': {
      const value = ev(e.e);
      runtime.row = e.row;
      if (!(value instanceof PhpObject) || !isThrowableObject(value)) throwError('Error', 'Can only throw objects');
      throw new PhpThrow(value);
    }
    case 'isset': {
      return e.items.every((item) => isset(item));
    }
    case 'empty': {
      return !toBool(evQuiet(e.e));
    }
    case 'closure': {
      return createClosure(e);
    }
    case 'arrow': {
      return createArrow(e);
    }
    case 'instanceof': {
      const value = ev(e.e);
      if (!(value instanceof PhpObject)) return false;
      if (e.cls.k === 'expr') {
        const right = ev(e.cls.e);
        if (right instanceof PhpObject) return value.cls.isSubclassOf(right.cls);
        if (typeof right === 'string') {
          const cls = findClass(right);
          return cls !== undefined && value.cls.isSubclassOf(cls);
        }
        throwError('Error', 'Class name must be a valid object or a string');
      }
      if (e.cls.k === 'named') {
        const cls = findClass(e.cls.name);
        return cls !== undefined && value.cls.isSubclassOf(cls);
      }
      return value.cls.isSubclassOf(resolveClassRef(e.cls));
    }
    case 'match': {
      return matchExpression(e);
    }
    case 'print': {
      runtime.echo(toStr(ev(e.e)));
      return 1n;
    }
    case 'exit': {
      const value = e.e ? ev(e.e) : null;
      if (typeof value === 'string') {
        runtime.echo(value);
        throw new ExitSignal(0);
      }
      if (value === null) throw new ExitSignal(0);
      if (typeof value === 'bigint') throw new ExitSignal(Number(value));
      if (typeof value === 'boolean' || typeof value === 'number') {
        // PHP 8.4 treats exit() as a function taking string|int.
        if (typeof value === 'boolean') throw new ExitSignal(value ? 1 : 0);
        deprecated(`Implicit conversion from float ${value} to int loses precision`);
        throw new ExitSignal(Math.trunc(value));
      }
      throwError('TypeError', `exit(): Argument #1 ($status) must be of type string|int, ${valueName(value)} given`);
    }
    case 'pipe': {
      const value = ev(e.l);
      runtime.frame.temporaries.push(value);
      const callable = ev(e.r);
      runtime.row = e.row;
      return callValue(callable, [{ v: value }], e.row);
    }
    case 'list': {
      throwError('Error', 'Cannot use list() outside an assignment');
    }
    case 'unsupported': {
      throwError('Error', e.what);
    }
  }
}

/**
 * Runs a call, then releases the temporaries its arguments held, as PHP frees arguments when a call returns, keeping
 * only the result until the statement stores or drops it.
 */
function keepingResult(run: () => Chain): Chain {
  return keepResult(rt().frame.temporaries.length, run());
}

/** Releases the temporaries held since `mark`, keeping only a call's result, as {@link keepingResult} describes. */
function keepResult(mark: number, result: Chain): Chain {
  const runtime = rt();
  const frame = runtime.frame;
  const keep = result instanceof PhpObject || result instanceof PhpArray;
  // The result stays held while the temporaries it was made from are released.
  if (keep) frame.temporaries.splice(mark, 0, result);
  runtime.dropTemporaries(frame, keep ? mark + 1 : mark);
  return result;
}

function isThrowableObject(object: PhpObject): boolean {
  const throwable = rt().classes.get('throwable');
  return throwable !== undefined && object.cls.isSubclassOf(throwable);
}

/** Evaluates an expression without the warnings an undefined variable or key would raise, as `??` and `empty` do. */
// code-gauge-allow functionCognitiveComplexity 17 -- One case per expression kind, as PHP evaluates each kind differently.
// code-gauge-allow functionNcss 37 -- One case per expression kind, as PHP evaluates each kind differently.
export function evQuiet(e: Expr): Value {
  const runtime = rt();
  switch (e.k) {
    case 'var': {
      if (e.name === 'this') return runtime.frame.thisObj ?? null;
      if (e.name === 'GLOBALS') return globalsArray();
      return runtime.frame.vars.get(e.name)?.v ?? null;
    }
    case 'varvar': {
      return runtime.frame.vars.get(toStr(ev(e.name)))?.v ?? null;
    }
    case 'idx': {
      if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
      const base = evQuiet(e.base);
      const index = ev(e.index);
      if (base === null) return null;
      return readIndex(base, index, true);
    }
    case 'prop': {
      const object = evQuiet(e.obj);
      if (!(object instanceof PhpObject)) return null;
      const name = memberName(e.name);
      const scope = runtime.frame.scope;
      if (!issetProp(object, name, scope)) return null;
      return readProp(object, name, scope, true);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      const found = cls.findStatic(name);
      if (!found) return null;
      return readStaticProp(cls, name, runtime.frame.scope);
    }
    default: {
      return ev(e);
    }
  }
}

function readVar(name: string, row: number): Value {
  const runtime = rt();
  const frame = runtime.frame;
  if (name === 'this') {
    if (frame.thisObj) return frame.thisObj;
    runtime.row = row;
    throwError('Error', 'Using $this when not in object context');
  }
  const ref = frame.vars.get(name);
  if (ref) return ref.v;
  if (name === 'GLOBALS') return globalsArray();
  runtime.row = row;
  warn(`Undefined variable $${name}`);
  return null;
}

function globalsArray(): PhpArray {
  const array = new PhpArray();
  for (const [name, ref] of rt().globalFrame.vars) array.set(toKey(name), share(ref.v));
  return array;
}

export function readIndex(base: Value, index: Value, quiet: boolean): Value {
  if (base instanceof PhpArray) return readElement(base, toKey(index, quiet ? 'isset' : 'access'), quiet);
  if (typeof base === 'string') return readStringOffset(base, index, quiet);
  if (base instanceof PhpObject) {
    if (base.cls.findMethod('offsetget') && isArrayAccess(base)) {
      if (quiet && !toBool(callMethod(base, 'offsetExists', [index]))) return null;
      return callMethod(base, 'offsetGet', [index]);
    }
    throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
  }
  if (!quiet) warn(`Trying to access array offset on ${valueName(base)}`);
  return null;
}

export function isArrayAccess(object: PhpObject): boolean {
  const arrayAccess = rt().classes.get('arrayaccess');
  return arrayAccess !== undefined && object.cls.isSubclassOf(arrayAccess);
}

/** The position an index selects in a string: -1 when it is out of range, undefined when `quiet` and the index is not an integer. */
// code-gauge-allow functionCognitiveComplexity 28 -- One case per expression kind, as PHP evaluates each kind differently.
// code-gauge-allow functionNcss 32 -- One case per expression kind, as PHP evaluates each kind differently.
export function stringOffset(text: string, index: Value, quiet: boolean): number | undefined {
  let offset: bigint;
  if (typeof index === 'bigint') offset = index;
  else if (typeof index === 'string') {
    if (/^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(index)) offset = BigInt(index);
    else {
      const leading = /^[ \t\n\r\v\f]*[+-]?\d+/.exec(index);
      if (!leading || quiet) {
        if (quiet) return undefined;
        throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
      }
      warn(`Illegal string offset "${index}"`);
      offset = BigInt(leading[0].trim());
    }
  } else if (typeof index === 'number') {
    if (!quiet) warn('String offset cast occurred');
    offset = toInt(index);
  } else if (typeof index === 'boolean' || index === null) {
    if (!quiet) warn('String offset cast occurred');
    offset = index ? 1n : 0n;
  } else throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
  const position = offset < 0n ? BigInt(text.length) + offset : offset;
  if (position < 0n || position >= BigInt(text.length)) return -1;
  return Number(position);
}

function readStringOffset(text: string, index: Value, quiet: boolean): Value {
  const position = stringOffset(text, index, quiet);
  if (position === undefined) return null;
  if (position < 0) {
    if (quiet) return null;
    warn(`Uninitialized string offset ${toInt(index)}`);
    return '';
  }
  return text[position];
}

export function memberName(name: string | Expr): string {
  return typeof name === 'string' ? name : toStr(ev(name));
}

// code-gauge-allow functionCognitiveComplexity 21 -- One case per expression kind, as PHP evaluates each kind differently.
function arrayLiteral(e: Extract<Expr, { k: 'array' }>): PhpArray {
  const runtime = rt();
  const array = new PhpArray();
  for (const item of e.items) {
    if (item.spread) {
      const value = ev(item.value);
      spreadInto(array, value);
      continue;
    }
    const key = item.key === undefined ? undefined : toKey(ev(item.key));
    if (item.byRef) {
      const ref = placeOf(item.value).ref();
      ref.isRef = true;
      ref.rc++;
      if (key === undefined) {
        if (!array.append(ref))
          throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      } else array.setSlot(key, ref);
      continue;
    }
    const value = share(ev(item.value));
    if (key === undefined) {
      if (!array.append(value))
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    } else array.set(key, value);
    runtime.spend();
  }
  return array;
}

function spreadInto(array: PhpArray, value: Value): void {
  if (value instanceof PhpArray) {
    for (const [key, slot] of value.map) {
      const item = slot instanceof Ref && slot.isRef ? slot : share(slot instanceof Ref ? slot.v : slot);
      if (item instanceof Ref) item.rc++;
      if (typeof key === 'string') array.setSlot(key, item);
      else if (!array.append(item))
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    }
    return;
  }
  if (value instanceof PhpObject) {
    for (const [key, item] of iterate(value)) {
      if (typeof key === 'string') array.set(key, share(item));
      else if (typeof key === 'bigint') array.append(share(item));
      else throwError('Error', 'Keys must be of type int|string during array unpacking');
    }
    return;
  }
  throwError('Error', 'Only arrays and Traversables can be unpacked');
}

/** Iterates over an array or a Traversable object, as `foreach` would. */
export function* iterate(value: Value): Generator<[Value, Value]> {
  if (value instanceof PhpArray) {
    for (const entry of value.entries()) yield entry;
    return;
  }
  if (value instanceof PhpObject) {
    const iterator = iteratorOf(value);
    if (!iterator) {
      for (const entry of visibleProps(value, rt().frame.scope)) yield entry;
      return;
    }
    callMethod(iterator, 'rewind', []);
    while (toBool(callMethod(iterator, 'valid', []))) {
      rt().spend();
      const current = callMethod(iterator, 'current', []);
      const key = callMethod(iterator, 'key', []);
      yield [key, current];
      callMethod(iterator, 'next', []);
    }
  }
}

/** The constants that describe the machine running PHP, which differ between this grader and a learner's PHP. */
const ENVIRONMENT_CONSTANTS = new Set([
  'PHP_OS',
  'PHP_OS_FAMILY',
  'PHP_BINARY',
  'PHP_BINDIR',
  'PHP_LIBDIR',
  'PHP_DATADIR',
  'PHP_EXTENSION_DIR',
  'PHP_CONFIG_FILE_PATH',
  'PHP_CONFIG_FILE_SCAN_DIR',
  'PHP_SHLIB_SUFFIX',
  'PHP_PREFIX',
  'PHP_MANDIR',
  'PHP_SYSCONFDIR',
  'PHP_LOCALSTATEDIR',
  'DEFAULT_INCLUDE_PATH',
  'PEAR_INSTALL_DIR',
  'PEAR_EXTENSION_DIR',
]);

const UNSUPPORTED_CONSTANTS = new Set([
  'DATE_ATOM',
  'DATE_COOKIE',
  'DATE_ISO8601',
  'DATE_ISO8601_EXPANDED',
  'DATE_RFC822',
  'DATE_RFC850',
  'DATE_RFC1036',
  'DATE_RFC1123',
  'DATE_RFC7231',
  'DATE_RFC2822',
  'DATE_RFC3339',
  'DATE_RFC3339_EXTENDED',
  'DATE_RSS',
  'DATE_W3C',
  'CURLOPT_AUTOREFERER',
  'CURLOPT_BINARYTRANSFER',
  'CURLOPT_BUFFERSIZE',
  'CURLOPT_CAINFO',
  'CURLOPT_CAPATH',
  'CURLOPT_CONNECTTIMEOUT',
  'CURLOPT_COOKIE',
  'CURLOPT_COOKIEFILE',
  'CURLOPT_COOKIEJAR',
  'CURLOPT_COOKIESESSION',
  'CURLOPT_CRLF',
  'CURLOPT_CUSTOMREQUEST',
  'CURLOPT_DNS_CACHE_TIMEOUT',
  'CURLOPT_DNS_USE_GLOBAL_CACHE',
  'CURLOPT_EGDSOCKET',
  'CURLOPT_ENCODING',
  'CURLOPT_FAILONERROR',
  'CURLOPT_FILE',
  'CURLOPT_FILETIME',
  'CURLOPT_FOLLOWLOCATION',
  'CURLOPT_FORBID_REUSE',
  'CURLOPT_FRESH_CONNECT',
  'CURLOPT_FTPAPPEND',
  'CURLOPT_FTPLISTONLY',
  'CURLOPT_FTPPORT',
  'CURLOPT_FTP_USE_EPRT',
  'CURLOPT_FTP_USE_EPSV',
  'CURLOPT_HEADER',
  'CURLOPT_HEADERFUNCTION',
  'CURLOPT_HTTP200ALIASES',
  'CURLOPT_HTTPGET',
  'CURLOPT_HTTPHEADER',
  'CURLOPT_HTTPPROXYTUNNEL',
  'CURLOPT_HTTP_VERSION',
  'CURLOPT_INFILE',
  'CURLOPT_INFILESIZE',
  'CURLOPT_INFILESIZE_LARGE',
  'CURLOPT_INTERFACE',
  'CURLOPT_KRB4LEVEL',
  'CURLOPT_LOW_SPEED_LIMIT',
  'CURLOPT_LOW_SPEED_TIME',
  'CURLOPT_MAXCONNECTS',
  'CURLOPT_MAXREDIRS',
  'CURLOPT_NETRC',
  'CURLOPT_NOBODY',
  'CURLOPT_NOPROGRESS',
  'CURLOPT_NOSIGNAL',
  'CURLOPT_PORT',
  'CURLOPT_POST',
  'CURLOPT_POSTFIELDS',
  'CURLOPT_POSTQUOTE',
  'CURLOPT_PREQUOTE',
  'CURLOPT_PRIVATE',
  'CURLOPT_PROGRESSFUNCTION',
  'CURLOPT_PROXY',
  'CURLOPT_PROXYPORT',
  'CURLOPT_PROXYTYPE',
  'CURLOPT_PROXYUSERPWD',
  'CURLOPT_PUT',
  'CURLOPT_QUOTE',
  'CURLOPT_RANDOM_FILE',
  'CURLOPT_RANGE',
  'CURLOPT_READDATA',
  'CURLOPT_READFUNCTION',
  'CURLOPT_REFERER',
  'CURLOPT_RESUME_FROM',
  'CURLOPT_RETURNTRANSFER',
  'CURLOPT_SHARE',
  'CURLOPT_SSLCERT',
  'CURLOPT_SSLCERTPASSWD',
  'CURLOPT_SSLCERTTYPE',
  'CURLOPT_SSLENGINE',
  'CURLOPT_SSLENGINE_DEFAULT',
  'CURLOPT_SSLKEY',
  'CURLOPT_SSLKEYPASSWD',
  'CURLOPT_SSLKEYTYPE',
  'CURLOPT_SSLVERSION',
  'CURLOPT_SSL_CIPHER_LIST',
  'CURLOPT_SSL_VERIFYHOST',
  'CURLOPT_SSL_VERIFYPEER',
  'CURLOPT_STDERR',
  'CURLOPT_TCP_KEEPCNT',
  'CURLOPT_TELNETOPTIONS',
  'CURLOPT_TIMECONDITION',
  'CURLOPT_TIMEOUT',
  'CURLOPT_TIMEVALUE',
  'CURLOPT_TRANSFERTEXT',
  'CURLOPT_UNRESTRICTED_AUTH',
  'CURLOPT_UPLOAD',
  'CURLOPT_URL',
  'CURLOPT_USERAGENT',
  'CURLOPT_USERPWD',
  'CURLOPT_VERBOSE',
  'CURLOPT_WRITEFUNCTION',
  'CURLOPT_WRITEHEADER',
  'CURLOPT_XFERINFOFUNCTION',
  'CURLOPT_DEBUGFUNCTION',
  'CURL_HTTP_VERSION_1_0',
  'CURL_HTTP_VERSION_1_1',
  'CURL_HTTP_VERSION_NONE',
  'CURL_LOCK_DATA_COOKIE',
  'CURL_LOCK_DATA_DNS',
  'CURL_LOCK_DATA_SSL_SESSION',
  'CURL_NETRC_IGNORED',
  'CURL_NETRC_OPTIONAL',
  'CURL_NETRC_REQUIRED',
  'CURL_SSLVERSION_DEFAULT',
  'CURL_SSLVERSION_SSLv2',
  'CURL_SSLVERSION_SSLv3',
  'CURL_SSLVERSION_TLSv1',
  'CURL_TIMECOND_IFMODSINCE',
  'CURL_TIMECOND_IFUNMODSINCE',
  'CURL_TIMECOND_LASTMOD',
  'CURL_TIMECOND_NONE',
  'CURL_VERSION_ASYNCHDNS',
  'CURL_VERSION_CONV',
  'CURL_VERSION_DEBUG',
  'CURL_VERSION_GSSNEGOTIATE',
  'CURL_VERSION_IDN',
  'CURL_VERSION_IPV6',
  'CURL_VERSION_KERBEROS4',
  'CURL_VERSION_LARGEFILE',
  'CURL_VERSION_LIBZ',
  'CURL_VERSION_NTLM',
  'CURL_VERSION_SPNEGO',
  'CURL_VERSION_SSL',
  'CURL_VERSION_SSPI',
  'CURLOPT_HTTPAUTH',
  'CURLOPT_FTP_CREATE_MISSING_DIRS',
  'CURLOPT_PROXYAUTH',
  'CURLOPT_FTP_RESPONSE_TIMEOUT',
  'CURLOPT_SERVER_RESPONSE_TIMEOUT',
  'CURLOPT_IPRESOLVE',
  'CURLOPT_MAXFILESIZE',
  'CURL_IPRESOLVE_V4',
  'CURL_IPRESOLVE_V6',
  'CURL_IPRESOLVE_WHATEVER',
  'CURLOPT_FTP_SSL',
  'CURLOPT_NETRC_FILE',
  'CURLOPT_MAXFILESIZE_LARGE',
  'CURLOPT_TCP_NODELAY',
  'CURLOPT_FTPSSLAUTH',
  'CURLOPT_FTP_ACCOUNT',
  'CURLOPT_COOKIELIST',
  'CURLOPT_IGNORE_CONTENT_LENGTH',
  'CURLOPT_FTP_SKIP_PASV_IP',
  'CURLOPT_FTP_FILEMETHOD',
  'CURLOPT_CONNECT_ONLY',
  'CURLOPT_LOCALPORT',
  'CURLOPT_LOCALPORTRANGE',
  'CURLOPT_FTP_ALTERNATIVE_TO_USER',
  'CURLOPT_MAX_RECV_SPEED_LARGE',
  'CURLOPT_MAX_SEND_SPEED_LARGE',
  'CURLOPT_SSL_SESSIONID_CACHE',
  'CURLOPT_FTP_SSL_CCC',
  'CURLOPT_SSH_AUTH_TYPES',
  'CURLOPT_SSH_PRIVATE_KEYFILE',
  'CURLOPT_SSH_PUBLIC_KEYFILE',
  'CURLOPT_CONNECTTIMEOUT_MS',
  'CURLOPT_HTTP_CONTENT_DECODING',
  'CURLOPT_HTTP_TRANSFER_DECODING',
  'CURLOPT_TIMEOUT_MS',
  'CURLOPT_KRBLEVEL',
  'CURLOPT_NEW_DIRECTORY_PERMS',
  'CURLOPT_NEW_FILE_PERMS',
  'CURLOPT_APPEND',
  'CURLOPT_DIRLISTONLY',
  'CURLOPT_USE_SSL',
  'CURLOPT_SSH_HOST_PUBLIC_KEY_MD5',
  'CURLOPT_PROXY_TRANSFER_MODE',
  'CURL_READFUNC_PAUSE',
  'CURL_WRITEFUNC_PAUSE',
  'CURLOPT_ADDRESS_SCOPE',
  'CURLOPT_CRLFILE',
  'CURLOPT_ISSUERCERT',
  'CURLOPT_KEYPASSWD',
  'CURLOPT_CERTINFO',
  'CURLOPT_PASSWORD',
  'CURLOPT_POSTREDIR',
  'CURLOPT_PROXYPASSWORD',
  'CURLOPT_PROXYUSERNAME',
  'CURLOPT_USERNAME',
  'CURL_REDIR_POST_301',
  'CURL_REDIR_POST_302',
  'CURL_REDIR_POST_ALL',
  'CURLOPT_NOPROXY',
  'CURLOPT_PROTOCOLS',
  'CURLOPT_REDIR_PROTOCOLS',
  'CURLOPT_SOCKS5_GSSAPI_NEC',
  'CURLOPT_SOCKS5_GSSAPI_SERVICE',
  'CURLOPT_TFTP_BLKSIZE',
  'CURL_VERSION_CURLDEBUG',
  'CURLOPT_SSH_KNOWNHOSTS',
  'CURLOPT_FTP_USE_PRET',
  'CURLOPT_MAIL_FROM',
  'CURLOPT_MAIL_RCPT',
  'CURLOPT_RTSP_CLIENT_CSEQ',
  'CURLOPT_RTSP_REQUEST',
  'CURLOPT_RTSP_SERVER_CSEQ',
  'CURLOPT_RTSP_SESSION_ID',
  'CURLOPT_RTSP_STREAM_URI',
  'CURLOPT_RTSP_TRANSPORT',
  'CURL_RTSPREQ_ANNOUNCE',
  'CURL_RTSPREQ_DESCRIBE',
  'CURL_RTSPREQ_GET_PARAMETER',
  'CURL_RTSPREQ_OPTIONS',
  'CURL_RTSPREQ_PAUSE',
  'CURL_RTSPREQ_PLAY',
  'CURL_RTSPREQ_RECEIVE',
  'CURL_RTSPREQ_RECORD',
  'CURL_RTSPREQ_SET_PARAMETER',
  'CURL_RTSPREQ_SETUP',
  'CURL_RTSPREQ_TEARDOWN',
  'CURLOPT_FNMATCH_FUNCTION',
  'CURLOPT_WILDCARDMATCH',
  'CURL_FNMATCHFUNC_FAIL',
  'CURL_FNMATCHFUNC_MATCH',
  'CURL_FNMATCHFUNC_NOMATCH',
  'CURLOPT_RESOLVE',
  'CURLOPT_TLSAUTH_PASSWORD',
  'CURLOPT_TLSAUTH_TYPE',
  'CURLOPT_TLSAUTH_USERNAME',
  'CURL_TLSAUTH_SRP',
  'CURL_VERSION_TLSAUTH_SRP',
  'CURLOPT_ACCEPT_ENCODING',
  'CURLOPT_TRANSFER_ENCODING',
  'CURLOPT_GSSAPI_DELEGATION',
  'CURL_VERSION_NTLM_WB',
  'CURLOPT_ACCEPTTIMEOUT_MS',
  'CURLOPT_DNS_SERVERS',
  'CURLOPT_MAIL_AUTH',
  'CURLOPT_SSL_OPTIONS',
  'CURLOPT_TCP_KEEPALIVE',
  'CURLOPT_TCP_KEEPIDLE',
  'CURLOPT_TCP_KEEPINTVL',
  'CURL_REDIR_POST_303',
  'CURLOPT_SASL_IR',
  'CURLOPT_DNS_INTERFACE',
  'CURLOPT_DNS_LOCAL_IP4',
  'CURLOPT_DNS_LOCAL_IP6',
  'CURLOPT_XOAUTH2_BEARER',
  'CURL_HTTP_VERSION_2_0',
  'CURL_VERSION_HTTP2',
  'CURLOPT_LOGIN_OPTIONS',
  'CURL_SSLVERSION_TLSv1_0',
  'CURL_SSLVERSION_TLSv1_1',
  'CURL_SSLVERSION_TLSv1_2',
  'CURLOPT_EXPECT_100_TIMEOUT_MS',
  'CURLOPT_SSL_ENABLE_ALPN',
  'CURLOPT_SSL_ENABLE_NPN',
  'CURLOPT_HEADEROPT',
  'CURLOPT_PROXYHEADER',
  'CURL_VERSION_GSSAPI',
  'CURLOPT_PINNEDPUBLICKEY',
  'CURLOPT_UNIX_SOCKET_PATH',
  'CURL_VERSION_KERBEROS5',
  'CURL_VERSION_UNIX_SOCKETS',
  'CURLOPT_SSL_VERIFYSTATUS',
  'CURLOPT_PATH_AS_IS',
  'CURLOPT_SSL_FALSESTART',
  'CURL_HTTP_VERSION_2',
  'CURLOPT_PIPEWAIT',
  'CURLOPT_PROXY_SERVICE_NAME',
  'CURLOPT_SERVICE_NAME',
  'CURLOPT_DEFAULT_PROTOCOL',
  'CURLOPT_STREAM_WEIGHT',
  'CURL_PUSH_OK',
  'CURL_PUSH_DENY',
  'CURL_HTTP_VERSION_2TLS',
  'CURL_VERSION_PSL',
  'CURLOPT_TFTP_NO_OPTIONS',
  'CURL_HTTP_VERSION_2_PRIOR_KNOWLEDGE',
  'CURLOPT_CONNECT_TO',
  'CURLOPT_TCP_FASTOPEN',
  'CURLOPT_KEEP_SENDING_ON_ERROR',
  'CURL_SSLVERSION_TLSv1_3',
  'CURL_VERSION_HTTPS_PROXY',
  'CURLOPT_PRE_PROXY',
  'CURLOPT_PROXY_CAINFO',
  'CURLOPT_PROXY_CAPATH',
  'CURLOPT_PROXY_CRLFILE',
  'CURLOPT_PROXY_KEYPASSWD',
  'CURLOPT_PROXY_PINNEDPUBLICKEY',
  'CURLOPT_PROXY_SSL_CIPHER_LIST',
  'CURLOPT_PROXY_SSL_OPTIONS',
  'CURLOPT_PROXY_SSL_VERIFYHOST',
  'CURLOPT_PROXY_SSL_VERIFYPEER',
  'CURLOPT_PROXY_SSLCERT',
  'CURLOPT_PROXY_SSLCERTTYPE',
  'CURLOPT_PROXY_SSLKEY',
  'CURLOPT_PROXY_SSLKEYTYPE',
  'CURLOPT_PROXY_SSLVERSION',
  'CURLOPT_PROXY_TLSAUTH_PASSWORD',
  'CURLOPT_PROXY_TLSAUTH_TYPE',
  'CURLOPT_PROXY_TLSAUTH_USERNAME',
  'CURL_MAX_READ_SIZE',
  'CURLOPT_ABSTRACT_UNIX_SOCKET',
  'CURL_SSLVERSION_MAX_DEFAULT',
  'CURL_SSLVERSION_MAX_NONE',
  'CURL_SSLVERSION_MAX_TLSv1_0',
  'CURL_SSLVERSION_MAX_TLSv1_1',
  'CURL_SSLVERSION_MAX_TLSv1_2',
  'CURL_SSLVERSION_MAX_TLSv1_3',
  'CURLOPT_SUPPRESS_CONNECT_HEADERS',
  'CURLOPT_REQUEST_TARGET',
  'CURLOPT_SOCKS5_AUTH',
  'CURLOPT_SSH_COMPRESSION',
  'CURL_VERSION_MULTI_SSL',
  'CURL_VERSION_BROTLI',
  'CURL_LOCK_DATA_CONNECT',
  'CURLOPT_HAPPY_EYEBALLS_TIMEOUT_MS',
  'CURLOPT_TIMEVALUE_LARGE',
  'CURLOPT_DNS_SHUFFLE_ADDRESSES',
  'CURLOPT_HAPROXYPROTOCOL',
  'CURL_LOCK_DATA_PSL',
  'CURLOPT_DISALLOW_USERNAME_IN_URL',
  'CURLOPT_PROXY_TLS13_CIPHERS',
  'CURLOPT_TLS13_CIPHERS',
  'CURLOPT_DOH_URL',
  'CURLOPT_UPKEEP_INTERVAL_MS',
  'CURLOPT_UPLOAD_BUFFERSIZE',
  'CURLOPT_HTTP09_ALLOWED',
  'CURLOPT_ALTSVC',
  'CURLOPT_ALTSVC_CTRL',
  'CURL_VERSION_ALTSVC',
  'CURLOPT_MAXAGE_CONN',
  'CURLOPT_SASL_AUTHZID',
  'CURL_VERSION_HTTP3',
  'CURL_HTTP_VERSION_3',
  'CURLOPT_MAIL_RCPT_ALLLOWFAILS',
  'CURLOPT_ISSUERCERT_BLOB',
  'CURLOPT_PROXY_ISSUERCERT',
  'CURLOPT_PROXY_ISSUERCERT_BLOB',
  'CURLOPT_PROXY_SSLCERT_BLOB',
  'CURLOPT_PROXY_SSLKEY_BLOB',
  'CURLOPT_SSLCERT_BLOB',
  'CURLOPT_SSLKEY_BLOB',
  'CURL_VERSION_UNICODE',
  'CURL_VERSION_ZSTD',
  'CURLOPT_SSL_EC_CURVES',
  'CURLOPT_SSL_SIGNATURE_ALGORITHMS',
  'CURLOPT_HSTS',
  'CURLOPT_HSTS_CTRL',
  'CURL_VERSION_HSTS',
  'CURLOPT_AWS_SIGV4',
  'CURLOPT_DOH_SSL_VERIFYHOST',
  'CURLOPT_DOH_SSL_VERIFYPEER',
  'CURLOPT_DOH_SSL_VERIFYSTATUS',
  'CURL_VERSION_GSASL',
  'CURLOPT_CAINFO_BLOB',
  'CURLOPT_PROXY_CAINFO_BLOB',
  'CURLOPT_MAXLIFETIME_CONN',
  'CURLOPT_SSH_HOST_PUBLIC_KEY_SHA256',
  'CURLOPT_PREREQFUNCTION',
  'CURL_PREREQFUNC_OK',
  'CURL_PREREQFUNC_ABORT',
  'CURLOPT_MIME_OPTIONS',
  'CURLOPT_SSH_HOSTKEYFUNCTION',
  'CURLOPT_PROTOCOLS_STR',
  'CURLOPT_REDIR_PROTOCOLS_STR',
  'CURLOPT_WS_OPTIONS',
  'CURLOPT_CA_CACHE_TIMEOUT',
  'CURLOPT_QUICK_EXIT',
  'CURL_HTTP_VERSION_3ONLY',
  'CURLOPT_SAFE_UPLOAD',
  'FILTER_FLAG_NONE',
  'FILTER_REQUIRE_SCALAR',
  'FILTER_REQUIRE_ARRAY',
  'FILTER_FORCE_ARRAY',
  'FILTER_NULL_ON_FAILURE',
  'FILTER_THROW_ON_FAILURE',
  'FILTER_VALIDATE_INT',
  'FILTER_VALIDATE_BOOLEAN',
  'FILTER_VALIDATE_BOOL',
  'FILTER_VALIDATE_FLOAT',
  'FILTER_VALIDATE_REGEXP',
  'FILTER_VALIDATE_DOMAIN',
  'FILTER_VALIDATE_URL',
  'FILTER_VALIDATE_EMAIL',
  'FILTER_VALIDATE_IP',
  'FILTER_VALIDATE_MAC',
  'FILTER_DEFAULT',
  'FILTER_UNSAFE_RAW',
  'FILTER_SANITIZE_STRING',
  'FILTER_SANITIZE_STRIPPED',
  'FILTER_SANITIZE_ENCODED',
  'FILTER_SANITIZE_SPECIAL_CHARS',
  'FILTER_SANITIZE_FULL_SPECIAL_CHARS',
  'FILTER_SANITIZE_EMAIL',
  'FILTER_SANITIZE_URL',
  'FILTER_SANITIZE_NUMBER_INT',
  'FILTER_SANITIZE_NUMBER_FLOAT',
  'FILTER_SANITIZE_ADD_SLASHES',
  'FILTER_CALLBACK',
  'FILTER_FLAG_ALLOW_OCTAL',
  'FILTER_FLAG_ALLOW_HEX',
  'FILTER_FLAG_STRIP_LOW',
  'FILTER_FLAG_STRIP_HIGH',
  'FILTER_FLAG_STRIP_BACKTICK',
  'FILTER_FLAG_ENCODE_LOW',
  'FILTER_FLAG_ENCODE_HIGH',
  'FILTER_FLAG_ENCODE_AMP',
  'FILTER_FLAG_NO_ENCODE_QUOTES',
  'FILTER_FLAG_EMPTY_STRING_NULL',
  'FILTER_FLAG_ALLOW_FRACTION',
  'FILTER_FLAG_ALLOW_THOUSAND',
  'FILTER_FLAG_ALLOW_SCIENTIFIC',
  'FILTER_FLAG_PATH_REQUIRED',
  'FILTER_FLAG_QUERY_REQUIRED',
  'FILTER_FLAG_IPV4',
  'FILTER_FLAG_IPV6',
  'FILTER_FLAG_NO_RES_RANGE',
  'FILTER_FLAG_NO_PRIV_RANGE',
  'FILTER_FLAG_GLOBAL_RANGE',
  'FILTER_FLAG_HOSTNAME',
  'FILTER_FLAG_EMAIL_UNICODE',
  'LOCK_SH',
  'LOCK_EX',
  'LOCK_UN',
  'LOCK_NB',
  'STREAM_NOTIFY_CONNECT',
  'STREAM_NOTIFY_AUTH_REQUIRED',
  'STREAM_NOTIFY_AUTH_RESULT',
  'STREAM_NOTIFY_MIME_TYPE_IS',
  'STREAM_NOTIFY_FILE_SIZE_IS',
  'STREAM_NOTIFY_REDIRECTED',
  'STREAM_NOTIFY_PROGRESS',
  'STREAM_NOTIFY_FAILURE',
  'STREAM_NOTIFY_COMPLETED',
  'STREAM_NOTIFY_RESOLVE',
  'STREAM_NOTIFY_SEVERITY_INFO',
  'STREAM_NOTIFY_SEVERITY_WARN',
  'STREAM_NOTIFY_SEVERITY_ERR',
  'STREAM_FILTER_READ',
  'STREAM_FILTER_WRITE',
  'STREAM_FILTER_ALL',
  'STREAM_CLIENT_PERSISTENT',
  'STREAM_CLIENT_ASYNC_CONNECT',
  'STREAM_CLIENT_CONNECT',
  'STREAM_CRYPTO_METHOD_ANY_CLIENT',
  'STREAM_CRYPTO_METHOD_SSLv2_CLIENT',
  'STREAM_CRYPTO_METHOD_SSLv3_CLIENT',
  'STREAM_CRYPTO_METHOD_SSLv23_CLIENT',
  'STREAM_CRYPTO_METHOD_TLS_CLIENT',
  'STREAM_CRYPTO_METHOD_TLSv1_0_CLIENT',
  'STREAM_CRYPTO_METHOD_TLSv1_1_CLIENT',
  'STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT',
  'STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT',
  'STREAM_CRYPTO_METHOD_ANY_SERVER',
  'STREAM_CRYPTO_METHOD_SSLv2_SERVER',
  'STREAM_CRYPTO_METHOD_SSLv3_SERVER',
  'STREAM_CRYPTO_METHOD_SSLv23_SERVER',
  'STREAM_CRYPTO_METHOD_TLS_SERVER',
  'STREAM_CRYPTO_METHOD_TLSv1_0_SERVER',
  'STREAM_CRYPTO_METHOD_TLSv1_1_SERVER',
  'STREAM_CRYPTO_METHOD_TLSv1_2_SERVER',
  'STREAM_CRYPTO_METHOD_TLSv1_3_SERVER',
  'STREAM_CRYPTO_PROTO_SSLv3',
  'STREAM_CRYPTO_PROTO_TLSv1_0',
  'STREAM_CRYPTO_PROTO_TLSv1_1',
  'STREAM_CRYPTO_PROTO_TLSv1_2',
  'STREAM_CRYPTO_PROTO_TLSv1_3',
  'STREAM_SHUT_RD',
  'STREAM_SHUT_WR',
  'STREAM_SHUT_RDWR',
  'STREAM_PF_INET',
  'STREAM_PF_INET6',
  'STREAM_PF_UNIX',
  'STREAM_IPPROTO_IP',
  'STREAM_IPPROTO_TCP',
  'STREAM_IPPROTO_UDP',
  'STREAM_IPPROTO_ICMP',
  'STREAM_IPPROTO_RAW',
  'STREAM_SOCK_STREAM',
  'STREAM_SOCK_DGRAM',
  'STREAM_SOCK_RAW',
  'STREAM_SOCK_SEQPACKET',
  'STREAM_SOCK_RDM',
  'STREAM_PEEK',
  'STREAM_OOB',
  'STREAM_SERVER_BIND',
  'STREAM_SERVER_LISTEN',
  'FILE_USE_INCLUDE_PATH',
  'FILE_IGNORE_NEW_LINES',
  'FILE_SKIP_EMPTY_LINES',
  'FILE_APPEND',
  'FILE_NO_DEFAULT_CONTEXT',
  'FILE_TEXT',
  'FILE_BINARY',
  'PASSWORD_DEFAULT',
  'PASSWORD_BCRYPT',
  'PASSWORD_BCRYPT_DEFAULT_COST',
  'PASSWORD_ARGON2I',
  'PASSWORD_ARGON2ID',
  'PASSWORD_ARGON2_PROVIDER',
  'PASSWORD_ARGON2_DEFAULT_MEMORY_COST',
  'PASSWORD_ARGON2_DEFAULT_TIME_COST',
  'PASSWORD_ARGON2_DEFAULT_THREADS',
  'STREAM_USE_PATH',
  'STREAM_IGNORE_URL',
  'STREAM_REPORT_ERRORS',
  'STREAM_MUST_SEEK',
  'STREAM_URL_STAT_LINK',
  'STREAM_URL_STAT_QUIET',
  'STREAM_MKDIR_RECURSIVE',
  'STREAM_IS_URL',
  'STREAM_OPTION_BLOCKING',
  'STREAM_OPTION_READ_TIMEOUT',
  'STREAM_OPTION_READ_BUFFER',
  'STREAM_OPTION_WRITE_BUFFER',
  'STREAM_BUFFER_NONE',
  'STREAM_BUFFER_LINE',
  'STREAM_BUFFER_FULL',
  'STREAM_CAST_AS_STREAM',
  'STREAM_CAST_FOR_SELECT',
  'STREAM_META_TOUCH',
  'STREAM_META_OWNER',
  'STREAM_META_OWNER_NAME',
  'STREAM_META_GROUP',
  'STREAM_META_GROUP_NAME',
  'STREAM_META_ACCESS',
]);

function readConstant(name: string, fallback: string | undefined): Value {
  const runtime = rt();
  const global = fallback ?? name;
  if (ENVIRONMENT_CONSTANTS.has(global) && !runtime.constants.has(constantKey(name))) {
    throw new UnsupportedFeatureError(`実行環境の情報（${global}）`);
  }
  const value = runtime.constants.get(constantKey(name));
  if (value !== undefined) return deprecatedConstant(name, value);
  if (fallback !== undefined) {
    const global = runtime.constants.get(fallback);
    if (global !== undefined) return deprecatedConstant(fallback, global);
  }
  if (UNSUPPORTED_CONSTANTS.has(global)) {
    throw new UnsupportedFeatureError(`実行環境の機能（${global}）`);
  }
  throwError('Error', `Undefined constant "${name}"`);
}

/** Returns a constant's value after the deprecation PHP reports when a program reads a deprecated builtin one. */
export function deprecatedConstant(name: string, value: Value): Value {
  const message = constantDeprecation(name);
  if (message) deprecated(message);
  return value;
}

// code-gauge-allow functionCognitiveComplexity 23 -- One case per expression kind, as PHP evaluates each kind differently.
function magicConstant(name: Extract<Expr, { k: 'magic' }>['name']): Value {
  const frame = rt().frame;
  const decl = frame.decl;
  switch (name) {
    case '__CLASS__': {
      if (frame.closure) return (frame.closure.internal as ClosureData).scope?.fullName ?? '';
      return frame.scope?.fullName ?? '';
    }
    case '__FUNCTION__': {
      if (!decl) return '';
      if (decl.isClosure) return decl.name;
      return frame.method ? frame.method.name : decl.name;
    }
    case '__METHOD__': {
      if (!decl) return '';
      if (decl.isClosure) return decl.name;
      // The class or trait that declares the method, as PHP fixes it at compile time.
      if (frame.method) {
        const scope = frame.method.scope;
        const owner = decl.className === undefined || decl.className === scope.name ? scope.fullName : decl.className;
        return `${owner}::${frame.method.name}`;
      }
      return decl.name;
    }
    case '__TRAIT__': {
      const owner = decl?.className === undefined ? undefined : findClass(decl.className);
      return owner?.kind === 'trait' ? owner.name : '';
    }
  }
}

// Classes ------------------------------------------------------------------------------------------------------------

export function resolveClassRef(ref: ClassRef): PhpClass {
  const frame = rt().frame;
  switch (ref.k) {
    case 'named': {
      return requireClass(ref.name);
    }
    case 'self': {
      if (!frame.scope) throwError('Error', 'Cannot use "self" when no class scope is active');
      return frame.scope;
    }
    case 'parent': {
      if (!frame.scope) throwError('Error', 'Cannot use "parent" when no class scope is active');
      if (!frame.scope.parent) throwError('Error', 'Cannot use "parent" when current class scope has no parent');
      return frame.scope.parent;
    }
    case 'static': {
      if (!frame.staticClass) throwError('Error', 'Cannot use "static" when no class scope is active');
      return frame.staticClass;
    }
    case 'expr': {
      const value = ev(ref.e);
      if (value instanceof PhpObject) return value.cls;
      if (typeof value === 'string') return requireClass(value);
      throwError('Error', 'Class name must be a valid object or a string');
    }
  }
}

function classConstantOf(e: Extract<Expr, { k: 'cconst' }>): Value {
  const runtime = rt();
  if (lower(e.name) === 'class') {
    if (e.cls.k === 'named') return e.cls.name;
    if (e.cls.k === 'expr') {
      const value = ev(e.cls.e);
      if (!(value instanceof PhpObject)) throwError('TypeError', `Cannot use "::class" on ${debugType(value)}`);
      return value.cls.fullName;
    }
    return resolveClassRef(e.cls).fullName;
  }
  const cls = resolveClassRef(e.cls);
  runtime.row = e.row;
  return classConstant(cls, e.name, runtime.frame.scope);
}

/** Evaluates the arguments of `new`, which PHP does after it has created the object. */
function constructorArgs(cls: PhpClass, args: Arg[], row: number): ArgValue[] {
  const constructor = cls.findMethod('__construct');
  const values = evalArgs(args, constructor?.fn, constructor ? `${constructor.scope.name}::__construct` : undefined);
  rt().row = row;
  return values;
}

const anonymousClasses = new WeakMap<object, PhpClass>();

function anonymousClass(decl: ClassDecl, row: number): PhpClass {
  let cls = anonymousClasses.get(decl);
  if (!cls) {
    cls = declareClass(decl, row);
    anonymousClasses.set(decl, cls);
  }
  return cls;
}

function cloneExpression(e: Extract<Expr, { k: 'clone' }>): Value {
  const runtime = rt();
  const value = ev(e.e);
  const withValue = e.with ? ev(e.with) : undefined;
  runtime.row = e.row;
  if (withValue === undefined) {
    if (!(value instanceof PhpObject)) {
      throwError('TypeError', `clone(): Argument #1 ($object) must be of type object, ${valueName(value)} given`);
    }
    return cloneObject(value);
  }
  // `clone($object, $with)` is a call of PHP 8.5's clone function, which stack traces show.
  callStack.push({ name: 'clone', args: [value, withValue], row: e.row });
  try {
    if (!(value instanceof PhpObject)) {
      throwError('TypeError', `clone(): Argument #1 ($object) must be of type object, ${valueName(value)} given`);
    }
    return cloneObject(value, withValue);
  } finally {
    callStack.pop();
  }
}

// code-gauge-allow functionCognitiveComplexity 24 -- One case per expression kind, as PHP evaluates each kind differently.
// code-gauge-allow functionNcss 32 -- One case per expression kind, as PHP evaluates each kind differently.
export function cloneObject(original: PhpObject, withValue?: Value): PhpObject {
  const runtime = rt();
  const scope = runtime.frame.scope;
  const cloneMethod = original.cls.findMethod('__clone');
  if (cloneMethod && !canCall(cloneMethod, scope)) {
    throwError(
      'Error',
      `Call to ${cloneMethod.visibility} method ${original.cls.name}::__clone() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  const copy = runtime.newObject(original.cls);
  runtime.frame.temporaries.push(copy);
  for (const [key, slot] of original.props) {
    if (slot instanceof Ref) {
      if (slot.rc > 1) {
        slot.rc++;
        copy.props.set(key, slot);
      } else copy.props.set(key, share(slot.v));
    } else copy.props.set(key, typeof slot === 'symbol' ? slot : share(slot));
  }
  copy.internal = cloneInternal(original, copy);
  copy.cloning = true;
  try {
    if (cloneMethod) {
      invoke(
        { fn: cloneMethod.fn, thisObj: copy, scope: cloneMethod.scope, staticClass: copy.cls, method: cloneMethod },
        [],
        runtime.row
      );
    }
    if (withValue !== undefined) {
      if (!(withValue instanceof PhpArray)) {
        throwError(
          'TypeError',
          `clone(): Argument #2 ($withProperties) must be of type array, ${valueName(withValue)} given`
        );
      }
      for (const [key, item] of withValue.entries()) {
        if (typeof key !== 'string') throwError('Error', 'Property name must be of type string, int given');
        writeProp(copy, key, item, scope);
      }
    }
  } finally {
    copy.cloning = false;
    copy.readonlyInit = undefined;
  }
  return copy;
}

function cloneInternal(original: PhpObject, copy: PhpObject): unknown {
  const internal = original.internal as { clone?: (copy: PhpObject) => unknown } | undefined;
  if (internal && typeof internal.clone === 'function') return internal.clone(copy);
  if (isClosure(original)) return { ...(original.internal as ClosureData) };
  return internal;
}

// Operators ----------------------------------------------------------------------------------------------------------

function binary(e: Extract<Expr, { k: 'bin' }>): Value {
  const runtime = rt();
  switch (e.op) {
    case '&&':
    case 'and': {
      return toBool(ev(e.l)) && toBool(ev(e.r));
    }
    case '||':
    case 'or': {
      return toBool(ev(e.l)) || toBool(ev(e.r));
    }
    case 'xor': {
      return toBool(ev(e.l)) !== toBool(ev(e.r));
    }
    case '??': {
      return evQuiet(e.l) ?? ev(e.r);
    }
  }
  const mark = runtime.frame.temporaries.length;
  const left = ev(e.l);
  runtime.frame.temporaries.push(left);
  const right = ev(e.r);
  runtime.row = e.row;
  // PHP frees the operands as soon as the operator has used them.
  return keepResult(mark, operate(e.op, left, right)) as Value;
}

function operate(op: string, left: Value, right: Value): Value {
  switch (op) {
    case '==': {
      return looseEquals(left, right);
    }
    case '!=': {
      return !looseEquals(left, right);
    }
    case '===': {
      return strictEquals(left, right);
    }
    case '!==': {
      return !strictEquals(left, right);
    }
    case '<': {
      return compareForOrder(left, right) < 0;
    }
    case '<=': {
      return compareForOrder(left, right) <= 0;
    }
    case '>': {
      return compareForOrder(right, left) < 0;
    }
    case '>=': {
      return compareForOrder(right, left) <= 0;
    }
    case '<=>': {
      return BigInt(compare(left, right));
    }
    default: {
      return applyOperator(op, left, right);
    }
  }
}

function compareForOrder(left: Value, right: Value): number {
  return compare(left, right);
}

// code-gauge-allow functionCognitiveComplexity 17 -- One case per expression kind, as PHP evaluates each kind differently.
// code-gauge-allow functionNcss 33 -- One case per expression kind, as PHP evaluates each kind differently.
export function cast(type: string, value: Value): Value {
  switch (type) {
    case 'int': {
      return toInt(value);
    }
    case 'float': {
      return toFloat(value);
    }
    case 'string': {
      return toStr(value);
    }
    case 'bool': {
      return toBool(value);
    }
    case 'array': {
      if (value instanceof PhpArray) return value;
      if (value === null) return new PhpArray();
      if (value instanceof PhpObject) return objectToArrayCast(value);
      if (Number.isNaN(value)) warn('unexpected NAN value was coerced to array');
      return PhpArray.list([value]);
    }
    case 'object': {
      if (value instanceof PhpObject) return value;
      const object = createObject(rt().classes.get('stdclass') as PhpClass);
      if (value instanceof PhpArray) {
        for (const [key, slot] of value.map) {
          if (slot instanceof Ref && slot.isRef) {
            slot.rc++;
            object.props.set(String(key), slot);
          } else object.props.set(String(key), share(slot instanceof Ref ? slot.v : slot));
        }
      } else if (value !== null) object.props.set('scalar', value);
      return object;
    }
    default: {
      throwError('Error', `Unknown cast ${type}`);
    }
  }
}

function objectToArrayCast(object: PhpObject): PhpArray {
  if (isClosure(object)) return PhpArray.list([object]);
  // ArrayObject and ArrayIterator cast to the array they hold.
  const storage = (object.internal as { properties?: () => PhpArray } | undefined)?.properties;
  if (typeof storage === 'function') return storage.call(object.internal).copy();
  return classesModule.objectToArray(object);
}

function matchExpression(e: Extract<Expr, { k: 'match' }>): Value {
  const runtime = rt();
  const subject = ev(e.subject);
  runtime.frame.temporaries.push(subject);
  for (const arm of e.arms) {
    if (!arm.conditions) continue;
    for (const condition of arm.conditions) {
      if (strictEquals(subject, ev(condition))) return ev(arm.body);
    }
  }
  const fallback = e.arms.find((arm) => !arm.conditions);
  if (fallback) return ev(fallback.body);
  runtime.row = e.row;
  throwError('UnhandledMatchError', `Unhandled match case ${matchCaseText(subject)}`);
}

function matchCaseText(value: Value): string {
  if (typeof value === 'string') {
    const escaped = value
      .slice(0, 15)
      .replaceAll(/[\\']/g, String.raw`\$&`)
      .replaceAll('\n', String.raw`\n`)
      .replaceAll('\r', String.raw`\r`)
      .replaceAll('\t', String.raw`\t`);
    return `'${escaped}${value.length > 15 ? '...' : ''}'`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return conversionsModule.formatFloatRepr(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'NULL';
  return `of type ${debugType(value)}`;
}
