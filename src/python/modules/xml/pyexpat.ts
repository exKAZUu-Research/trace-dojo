import { bytesLikeData, newBytes } from '../../bytesValues';
import { builtin } from '../../define';
import { registerModule } from '../../modules';
import { toIndex } from '../../numbers';
import { callValue, toArray } from '../../objects';
import { registerSourceModule } from '../../sourceModules';
import { builtinClass, newDict, newList, newTuple, None, typeError, typeName } from '../../types';
import { unavailableValue } from '../../unavailableValues';
import { PyOpaque, type PyValue } from '../../values';
import { type ContentModel, ERROR_MESSAGES, XmlError } from './expatDocument';
import type { ExpatHandlers } from './expatHandlers';
import { INVALID_CHAR, knownEncoding } from './expatInput';
import { ExpatParser } from './expatParser';
import { MODEL_SOURCE, PYEXPAT_SOURCE } from './pyexpatSource';

// The natives of `pyexpat`, which run this grader's expat for the parser objects its Python part defines.

const engineClass = builtinClass('expat_engine');

const engineOf = (value: PyValue): ExpatParser => (value as PyOpaque).data as ExpatParser;

const optional = (value: string | undefined): PyValue => value ?? None;
const flag = (value: boolean): bigint => (value ? 1n : 0n);

registerSourceModule('pyexpat', PYEXPAT_SOURCE, () => new Map<string, PyValue>(NATIVES));
registerSourceModule('pyexpat.model', MODEL_SOURCE);
registerModule('pyexpat.errors', () => {
  const entries = new Map<string, PyValue>([['__doc__', 'Constants used to describe error conditions.']]);
  for (const [name, code] of Object.entries(ERROR_NAMES))
    entries.set(`XML_ERROR_${name}`, ERROR_MESSAGES[code] as string);
  const codes = Object.values(ERROR_NAMES);
  entries.set('codes', newDict(codes.map((code) => [ERROR_MESSAGES[code] as string, BigInt(code)])));
  entries.set('messages', newDict(codes.map((code) => [BigInt(code), ERROR_MESSAGES[code] as string])));
  return entries;
});

/** The names of expat's error codes, without their `XML_ERROR_` prefix, in the order of the codes. */
const ERROR_NAMES: Record<string, number> = Object.fromEntries(
  [
    'NO_MEMORY',
    'SYNTAX',
    'NO_ELEMENTS',
    'INVALID_TOKEN',
    'UNCLOSED_TOKEN',
    'PARTIAL_CHAR',
    'TAG_MISMATCH',
    'DUPLICATE_ATTRIBUTE',
    'JUNK_AFTER_DOC_ELEMENT',
    'PARAM_ENTITY_REF',
    'UNDEFINED_ENTITY',
    'RECURSIVE_ENTITY_REF',
    'ASYNC_ENTITY',
    'BAD_CHAR_REF',
    'BINARY_ENTITY_REF',
    'ATTRIBUTE_EXTERNAL_ENTITY_REF',
    'MISPLACED_XML_PI',
    'UNKNOWN_ENCODING',
    'INCORRECT_ENCODING',
    'UNCLOSED_CDATA_SECTION',
    'EXTERNAL_ENTITY_HANDLING',
    'NOT_STANDALONE',
    'UNEXPECTED_STATE',
    'ENTITY_DECLARED_IN_PE',
    'FEATURE_REQUIRES_XML_DTD',
    'CANT_CHANGE_FEATURE_ONCE_PARSING',
    'UNBOUND_PREFIX',
    'UNDECLARING_PREFIX',
    'INCOMPLETE_PE',
    'XML_DECL',
    'TEXT_DECL',
    'PUBLICID',
    'SUSPENDED',
    'NOT_SUSPENDED',
    'ABORTED',
    'FINISHED',
    'SUSPEND_PE',
    'RESERVED_PREFIX_XML',
    'RESERVED_PREFIX_XMLNS',
    'RESERVED_NAMESPACE_URI',
    'INVALID_ARGUMENT',
    'NO_BUFFER',
    'AMPLIFICATION_LIMIT_BREACH',
    'NOT_STARTED',
  ].map((name, index) => [name, index + 1])
);

const NATIVES: [string, PyValue][] = [
  [
    '_create',
    builtin('_create', 'expected', 3, 3, ([separator, encoding, table]) => {
      const name = encoding === None ? undefined : (encoding as string);
      const known = name === undefined ? undefined : knownEncoding(name);
      const parser = new ExpatParser(separator === None ? undefined : (separator as string), undefined);
      parser.unknownEncoding = (encodingName) =>
        toArray(callValue(table as PyValue, [encodingName])).map((code) =>
          code === -1n ? INVALID_CHAR : Number(code)
        );
      if (name !== undefined) parser.setProtocolEncoding(known === 'utf-16' ? undefined : known, name);
      return new PyOpaque(engineClass, 'expat_engine', parser);
    }),
  ],
  [
    '_install',
    builtin('_install', 'expected', 3, 3, ([engine, kind, fn]) => {
      const parser = engineOf(engine as PyValue);
      const key = kind as keyof ExpatHandlers;
      if (fn === None) delete parser.handlers[key];
      else (parser.handlers as Record<string, unknown>)[key] = handlerFor(key, fn as PyValue);
      return None;
    }),
  ],
  [
    '_option',
    builtin('_option', 'expected', 3, 3, ([engine, name, value]) =>
      setOption(engineOf(engine as PyValue), name as string, value as PyValue)
    ),
  ],
  [
    '_info',
    builtin('_info', 'expected', 2, 2, ([engine, name]) => information(engineOf(engine as PyValue), name as string)),
  ],
  [
    '_parse',
    builtin('_parse', 'expected', 4, 4, ([engine, data, isFinal, request]) => {
      const parser = engineOf(engine as PyValue);
      try {
        const size = request === None ? undefined : Number(request);
        if (typeof data === 'string') parser.parseText(data, isFinal === true);
        else parser.parseBytes(bytesLikeData(data as PyValue) as Uint8Array, isFinal === true, size);
      } catch (error) {
        if (!(error instanceof XmlError)) throw error;
        return newTuple([BigInt(parser.errorCode), BigInt(parser.errorLine), BigInt(parser.errorColumn)]);
      }
      return None;
    }),
  ],
  [
    '_bytes_like',
    builtin('_bytes_like', 'one', 1, 1, ([data]) => {
      const bytes = bytesLikeData(data as PyValue);
      if (bytes === undefined) throw typeError(`a bytes-like object is required, not '${typeName(data as PyValue)}'`);
      return newBytes(bytes);
    }),
  ],
  ['_capsule', builtin('_capsule', 'none', 0, 0, () => unavailableValue('C のカプセル（pyexpat.expat_CAPI）'))],
];

function setOption(parser: ExpatParser, name: string, value: PyValue): PyValue {
  switch (name) {
    case 'expand': {
      parser.defaultExpandInternalEntities = value === true;
      break;
    }
    case 'triplets': {
      parser.returnTriplets = value === true;
      break;
    }
    case 'base': {
      parser.base = value as string;
      break;
    }
    case 'foreignDTD': {
      const code = parser.useForeignDTD(value === true);
      if (code === 0) break;
      const [line, column] = parser.position(parser.eventPtr);
      return newTuple([BigInt(code), BigInt(line), BigInt(column)]);
    }
    case 'paramEntityParsing': {
      parser.paramEntityParsing = Number(value as bigint);
      break;
    }
    default: {
      parser.reparseDeferral = value === true;
    }
  }
  return None;
}

function information(parser: ExpatParser, name: string): PyValue {
  switch (name) {
    case 'ErrorCode': {
      return BigInt(parser.errorCode);
    }
    case 'ErrorLineNumber': {
      return BigInt(parser.errorLine);
    }
    case 'ErrorColumnNumber': {
      return BigInt(parser.errorColumn);
    }
    case 'ErrorByteIndex': {
      return BigInt(parser.errorByte);
    }
    case 'CurrentLineNumber': {
      return BigInt(parser.position(parser.eventPtr)[0]);
    }
    case 'CurrentColumnNumber': {
      return BigInt(parser.position(parser.eventPtr)[1]);
    }
    case 'CurrentByteIndex': {
      return BigInt(parser.byteIndex());
    }
    case 'base': {
      return optional(parser.base);
    }
    case 'context': {
      return newBytes(parser.inputContext());
    }
    default: {
      return parser.reparseDeferral;
    }
  }
}

/** The callback of the parser for one kind of event, which calls the Python parser's method with its arguments. */
function handlerFor(kind: keyof ExpatHandlers, fn: PyValue): unknown {
  const call = (...args: PyValue[]): PyValue => callValue(fn, args);
  switch (kind) {
    case 'startElement': {
      return (name: string, attributes: string[], specified: number) =>
        call(name, newList(attributes), BigInt(specified));
    }
    case 'xmlDecl': {
      return (version?: string, encoding?: string, standalone = -1) =>
        call(optional(version), optional(encoding), BigInt(standalone));
    }
    case 'startDoctypeDecl': {
      return (name: string, systemId?: string, publicId?: string, internal = false) =>
        call(name, optional(systemId), optional(publicId), flag(internal));
    }
    case 'entityDecl': {
      return (name: string, isParam: boolean, ...rest: (string | undefined)[]) =>
        call(name, flag(isParam), ...rest.map(optional));
    }
    case 'attlistDecl': {
      return (element: string, attribute: string, type: string, value: string | undefined, required: boolean) =>
        call(element, attribute, type, optional(value), flag(required));
    }
    case 'elementDecl': {
      return (name: string, model: ContentModel) => call(name, modelTuple(model));
    }
    case 'skippedEntity': {
      return (name: string, isParam: boolean) => call(name, flag(isParam));
    }
    case 'notStandalone':
    case 'externalEntityRef': {
      return (...args: (string | undefined)[]) => toIndex(call(...args.map(optional))) !== 0n;
    }
    default: {
      return (...args: (string | undefined)[]) => call(...args.map(optional));
    }
  }
}

function modelTuple(model: ContentModel): PyValue {
  return newTuple([
    BigInt(model.type),
    BigInt(model.quant),
    optional(model.name),
    newTuple(model.children.map(modelTuple)),
  ]);
}
