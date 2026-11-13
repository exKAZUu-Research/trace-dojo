// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity, FuncEntity } from '../entities';
import { newError } from '../errorValues';
import { Printer } from '../fmt';
import { dynamicMethod } from '../methods';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { ERROR_TYPE, missingMethod, pointerTo, sliceOf } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { FMT_PACKAGE } from './fmt';
import { joinPath as joinPathElements } from './paths';
import {
  appendBytes,
  BOOL,
  BYTES,
  bytesOf,
  receiverStruct,
  sliceOfValues,
  sliceValues,
  spendFor,
  STRING,
} from './support';
import {
  attempt,
  cut,
  escape,
  ESCAPE_ERROR,
  INVALID_HOST_ERROR,
  parseAddr,
  shouldEscape,
  unescape,
  UrlFailure,
} from './urlEscape';
import { resolvePath } from './urlPath';
import { parseQuery, VALUES } from './urlValues';

const STRINGS = sliceOf(STRING);
const ERROR_RESULT = [ERROR_TYPE];

// Types -------------------------------------------------------------------------------------------------------------

const USERINFO = namedType('url', 'Userinfo', {
  kind: 'struct',
  fields: [
    { name: 'username', type: STRING, embedded: false },
    { name: 'password', type: STRING, embedded: false },
    { name: 'passwordSet', type: BOOL, embedded: false },
  ],
});
const USERINFO_POINTER = pointerTo(USERINFO);

/** The fields of `url.URL` in the order Go 1.27 declares them. */
const URL_FIELDS = [
  ['Scheme', STRING],
  ['Opaque', STRING],
  ['User', USERINFO_POINTER],
  ['Host', STRING],
  ['Path', STRING],
  ['Fragment', STRING],
  ['RawQuery', STRING],
  ['RawPath', STRING],
  ['RawFragment', STRING],
  ['ForceQuery', BOOL],
  ['OmitHost', BOOL],
] as const;

const URL = namedType('url', 'URL', {
  kind: 'struct',
  fields: URL_FIELDS.map(([name, type]) => ({ name, type, embedded: false })),
});
const URL_POINTER = pointerTo(URL);

const URL_ERROR = namedType('url', 'Error', {
  kind: 'struct',
  fields: [
    { name: 'Op', type: STRING, embedded: false },
    { name: 'URL', type: STRING, embedded: false },
    { name: 'Err', type: ERROR_TYPE, embedded: false },
  ],
});

/** A `url.URL` as a JavaScript object, which the methods read from and write back to the Go struct. */
interface Url {
  scheme: string;
  opaque: string;
  /** The `*Userinfo`, or undefined for nil. */
  user: Value;
  host: string;
  path: string;
  fragment: string;
  rawQuery: string;
  rawPath: string;
  rawFragment: string;
  forceQuery: boolean;
  omitHost: boolean;
}

function emptyUrl(): Url {
  return {
    scheme: '',
    opaque: '',
    user: undefined,
    host: '',
    path: '',
    fragment: '',
    rawQuery: '',
    rawPath: '',
    rawFragment: '',
    forceQuery: false,
    omitHost: false,
  };
}

function urlOf(receiver: Value): Url {
  const [scheme, opaque, user, host, path, fragment, rawQuery, rawPath, rawFragment, forceQuery, omitHost] =
    receiverStruct(receiver).fields;
  return {
    scheme: scheme as string,
    opaque: opaque as string,
    user,
    host: host as string,
    path: path as string,
    fragment: fragment as string,
    rawQuery: rawQuery as string,
    rawPath: rawPath as string,
    rawFragment: rawFragment as string,
    forceQuery: forceQuery as boolean,
    omitHost: omitHost as boolean,
  };
}

function urlPointer(u: Url): Pointer {
  currentRuntime().allocate(URL_FIELDS.length);
  const fields: Value[] = [
    u.scheme,
    u.opaque,
    u.user,
    u.host,
    u.path,
    u.fragment,
    u.rawQuery,
    u.rawPath,
    u.rawFragment,
    u.forceQuery,
    u.omitHost,
  ];
  return new Pointer(new Cell(new GoStruct(fields)), 'v');
}

// Errors ------------------------------------------------------------------------------------------------------------

function urlError(op: string, url: string, err: Value): Iface {
  return new Iface(pointerTo(URL_ERROR), new Pointer(new Cell(new GoStruct([op, url, err])), 'v'));
}

addMethod(URL_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => receiverStruct(receiver).fields[2], true);
addMethod(
  URL_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    const [op, url, err] = receiverStruct(receiver).fields;
    return new Printer().printf('%s %q: %s', [new Iface(STRING, op), new Iface(STRING, url), err]);
  },
  true
);
for (const name of ['Timeout', 'Temporary']) {
  const iface = { kind: 'interface' as const, methods: [{ name, type: fn([], [BOOL]) }] };
  addMethod(
    URL_ERROR,
    name,
    fn([], [BOOL]),
    (receiver) => {
      const err = receiverStruct(receiver).fields[2];
      if (!(err instanceof Iface) || missingMethod(err.type, iface)) return false;
      return dynamicMethod(err.type, name)?.(err.value, []) === true;
    },
    true
  );
}

function fail(message: string): never {
  throw new UrlFailure(newError(message));
}

/** `fmt.Errorf(format, err)` with %w, whose result wraps the error as Go's does. */
function wrapError(format: string, err: Value): Value {
  const errorf = FMT_PACKAGE.members.get('Errorf') as FuncEntity;
  return errorf.direct?.([format, sliceOfValues([err])], undefined) as Value;
}

// Userinfo ----------------------------------------------------------------------------------------------------------

function newUserinfo(username: string, password: string, passwordSet: boolean): Pointer {
  return new Pointer(new Cell(new GoStruct([username, password, passwordSet])), 'v');
}

function userFields(user: Value): [string, string, boolean] | undefined {
  if (!(user instanceof Pointer)) return undefined;
  return (user.load() as GoStruct).fields as [string, string, boolean];
}

function userString(user: Value): string {
  const fields = userFields(user);
  if (!fields) return '';
  let s = escape(fields[0], 'userPassword');
  if (fields[2]) s += `:${escape(fields[1], 'userPassword')}`;
  return s;
}

addMethod(USERINFO, 'Username', fn([], [STRING]), (receiver) => userFields(receiver)?.[0] ?? '', true);
addMethod(
  USERINFO,
  'Password',
  fn([], [STRING, BOOL]),
  (receiver) => {
    const fields = userFields(receiver);
    return fields ? [fields[1], fields[2]] : ['', false];
  },
  true
);
addMethod(USERINFO, 'String', fn([], [STRING]), (receiver) => userString(receiver), true);

// Parsing -----------------------------------------------------------------------------------------------------------

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes net/url's getScheme.
function getScheme(rawURL: string): [string, string] {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) continue;
    if ((c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.') {
      if (i === 0) return ['', rawURL];
    } else if (c === ':') {
      if (i === 0) fail('missing protocol scheme');
      return [rawURL.slice(0, i), rawURL.slice(i + 1)];
    } else {
      return ['', rawURL];
    }
  }
  return ['', rawURL];
}

function parseUrl(rawURL: string): Value[] {
  const [u, frag] = cut(rawURL, '#');
  const parsed = attempt(() => parse(u, false));
  if ('error' in parsed) return [undefined, urlError('parse', u, parsed.error)];
  const url = parsed.value;
  if (frag === '') return [urlPointer(url), undefined];
  const fragment = attempt(() => setFragment(url, frag));
  if ('error' in fragment) return [undefined, urlError('parse', rawURL, fragment.error)];
  return [urlPointer(url), undefined];
}

// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes net/url's parse step by step.
// code-gauge-allow functionNcss 45 -- Transcribes net/url's parse step by step.
function parse(rawURL: string, viaRequest: boolean): Url {
  spendFor(rawURL.length);
  if (stringContainsCTLByte(rawURL)) fail('net/url: invalid control character in URL');
  if (rawURL === '' && viaRequest) fail('empty url');
  const url = emptyUrl();
  if (rawURL === '*') {
    url.path = '*';
    return url;
  }
  let rest: string;
  [url.scheme, rest] = getScheme(rawURL);
  url.scheme = url.scheme.toLowerCase();
  if (rest.endsWith('?') && rest.split('?').length === 2) {
    url.forceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    [rest, url.rawQuery] = cut(rest, '?');
  }
  if (!rest.startsWith('/')) {
    if (url.scheme !== '') {
      url.opaque = rest;
      return url;
    }
    if (viaRequest) fail('invalid URI for request');
    if (cut(rest, '/')[0].includes(':')) fail('first path segment in URL cannot contain colon');
  }
  if ((url.scheme !== '' || (!viaRequest && !rest.startsWith('///'))) && rest.startsWith('//')) {
    let authority = rest.slice(2);
    rest = '';
    const slash = authority.indexOf('/');
    if (slash !== -1) {
      rest = authority.slice(slash);
      authority = authority.slice(0, slash);
    }
    [url.user, url.host] = parseAuthority(url.scheme, authority);
  } else if (url.scheme !== '' && rest.startsWith('/')) {
    url.omitHost = true;
  }
  setPath(url, rest);
  return url;
}

function parseAuthority(scheme: string, authority: string): [Value, string] {
  const at = authority.lastIndexOf('@');
  const host = parseHost(scheme, at === -1 ? authority : authority.slice(at + 1));
  if (at === -1) return [undefined, host];
  const userinfo = authority.slice(0, at);
  if (!validUserinfo(userinfo)) fail('net/url: invalid userinfo');
  if (!userinfo.includes(':')) return [newUserinfo(unescape(userinfo, 'userPassword'), '', false), host];
  const [username, password] = cut(userinfo, ':');
  return [newUserinfo(unescape(username, 'userPassword'), unescape(password, 'userPassword'), true), host];
}

function parseHost(scheme: string, host: string): string {
  const openBracket = host.lastIndexOf('[');
  if (openBracket > 0) fail('invalid IP-literal');
  if (openBracket === 0) return parseIpLiteral(host);
  const colon = host.indexOf(':');
  if (colon !== -1) {
    const lastColon = host.lastIndexOf(':');
    // Go 1.27 rejects extra colons only in http and https hosts, where it checks from the first colon.
    const portAt = lastColon !== colon && (scheme === 'http' || scheme === 'https') ? colon : lastColon;
    const colonPort = host.slice(portAt);
    if (!validOptionalPort(colonPort)) failWithPort(colonPort);
  }
  return unescape(host, 'host');
}

function failWithPort(colonPort: string): never {
  return fail(new Printer().printf('invalid port %q after host', [new Iface(STRING, colonPort)]));
}

function parseIpLiteral(host: string): string {
  const closeBracket = host.lastIndexOf(']');
  if (closeBracket === -1) fail("missing ']' in host");
  const colonPort = host.slice(closeBracket + 1);
  if (!validOptionalPort(colonPort)) failWithPort(colonPort);
  const unescapedColonPort = unescape(colonPort, 'host');
  const hostname = host.slice(1, closeBracket);
  const zoneAt = hostname.indexOf('%25');
  const unescapedHostname =
    zoneAt !== -1
      ? unescape(hostname.slice(0, zoneAt), 'host') + unescape(hostname.slice(zoneAt), 'zone')
      : unescape(hostname, 'host');
  const addr = parseAddr(unescapedHostname);
  if ('error' in addr) throw new UrlFailure(wrapError('invalid host: %w', addr.error));
  if (addr.is4) fail('invalid IP-literal');
  return `[${unescapedHostname}]${unescapedColonPort}`;
}

function setPath(url: Url, p: string): void {
  const path = unescape(p, 'path');
  url.path = path;
  url.rawPath = p === escape(path, 'path') ? '' : p;
}

function setFragment(url: Url, f: string): void {
  const fragment = unescape(f, 'fragment');
  url.fragment = fragment;
  url.rawFragment = f === escape(fragment, 'fragment') ? '' : f;
}

function escapedPath(u: Url): string {
  if (u.rawPath !== '' && validEncoded(u.rawPath, 'path')) {
    const decoded = attempt(() => unescape(u.rawPath, 'path'));
    if ('value' in decoded && decoded.value === u.path) return u.rawPath;
  }
  if (u.path === '*') return '*';
  return escape(u.path, 'path');
}

function escapedFragment(u: Url): string {
  if (u.rawFragment !== '' && validEncoded(u.rawFragment, 'fragment')) {
    const decoded = attempt(() => unescape(u.rawFragment, 'fragment'));
    if ('value' in decoded && decoded.value === u.fragment) return u.rawFragment;
  }
  return escape(u.fragment, 'fragment');
}

function validEncoded(s: string, mode: 'path' | 'fragment'): boolean {
  for (let i = 0; i < s.length; i++) {
    if ("!$&'()*+,;=:@[]%".includes(s[i])) continue;
    if (shouldEscape(s.charCodeAt(i), mode)) return false;
  }
  return true;
}

function validOptionalPort(port: string): boolean {
  if (port === '') return true;
  if (port[0] !== ':') return false;
  return /^\d*$/.test(port.slice(1));
}

function validUserinfo(s: string): boolean {
  return /^[\w!$%&'()*+,\-.:;=@~]*$/.test(s);
}

function stringContainsCTLByte(s: string): boolean {
  // oxlint-disable-next-line no-control-regex -- Go rejects the ASCII control bytes.
  return /[\u0000-\u001F\u007F]/.test(s);
}

// Formatting --------------------------------------------------------------------------------------------------------

function urlString(u: Url): string {
  let buf = u.scheme === '' ? '' : `${u.scheme}:`;
  if (u.opaque === '') {
    buf += authorityString(u);
    let path = escapedPath(u);
    if (u.omitHost && u.host === '' && u.user === undefined && path.startsWith('//')) {
      buf += '%2F';
      path = path.slice(1);
    }
    if (path !== '' && path[0] !== '/' && u.host !== '') buf += '/';
    if (buf.length === 0 && cut(path, '/')[0].includes(':')) buf += './';
    buf += path;
  } else {
    buf += u.opaque;
  }
  if (u.forceQuery || u.rawQuery !== '') buf += `?${u.rawQuery}`;
  if (u.fragment !== '') buf += `#${escapedFragment(u)}`;
  currentRuntime().checkStringLength(buf.length);
  return buf;
}

function authorityString(u: Url): string {
  if (u.scheme === '' && u.host === '' && u.user === undefined) return '';
  if (u.omitHost && u.host === '' && u.user === undefined) return '';
  let buf = u.host !== '' || u.path !== '' || u.user !== undefined ? '//' : '';
  if (u.user !== undefined) buf += `${userString(u.user)}@`;
  if (u.host !== '') buf += escape(u.host, 'host');
  return buf;
}

function requestURI(u: Url): string {
  let result = u.opaque;
  if (result === '') result = escapedPath(u) || '/';
  else if (result.startsWith('//')) result = `${u.scheme}:${result}`;
  if (u.forceQuery || u.rawQuery !== '') result += `?${u.rawQuery}`;
  return result;
}

function splitHostPort(hostPort: string): [string, string] {
  let host = hostPort;
  let port = '';
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && validOptionalPort(host.slice(colon))) {
    port = host.slice(colon + 1);
    host = host.slice(0, colon);
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return [host, port];
}

// References --------------------------------------------------------------------------------------------------------

function resolveReference(u: Url, ref: Url): Url {
  const url = { ...ref };
  if (ref.scheme === '') url.scheme = u.scheme;
  if (ref.scheme !== '' || ref.host !== '' || ref.user !== undefined) {
    setPath(url, resolvePath(escapedPath(ref), ''));
    return url;
  }
  if (ref.opaque !== '') {
    url.user = undefined;
    url.host = '';
    url.path = '';
    return url;
  }
  if (ref.path === '' && !ref.forceQuery && ref.rawQuery === '') {
    url.rawQuery = u.rawQuery;
    if (ref.fragment === '') {
      url.fragment = u.fragment;
      url.rawFragment = u.rawFragment;
    }
  }
  if (ref.path === '' && u.opaque !== '') {
    url.opaque = u.opaque;
    url.user = undefined;
    url.host = '';
    url.path = '';
    return url;
  }
  url.host = u.host;
  url.user = u.user;
  setPath(url, resolvePath(escapedPath(u), escapedPath(ref)));
  return url;
}

function joinPath(u: Url, elements: string[]): Url {
  const elem = [escapedPath(u), ...elements];
  let p: string;
  if (elem[0].startsWith('/')) {
    p = joinPathElements(elem);
  } else {
    elem[0] = `/${elem[0]}`;
    p = joinPathElements(elem).slice(1);
  }
  if ((elem.at(-1) as string).endsWith('/') && !p.endsWith('/')) p += '/';
  const url = { ...u };
  setPath(url, p);
  return url;
}

// URL methods -------------------------------------------------------------------------------------------------------

function urlMethod(
  name: string,
  params: Parameters<typeof fn>[0],
  results: Parameters<typeof fn>[1],
  impl: (u: Url, args: Value[], receiver: Value) => Value | Value[],
  variadic = false
): void {
  addMethod(URL, name, fn(params, results, variadic), (receiver, args) => impl(urlOf(receiver), args, receiver), true);
}

urlMethod('String', [], [STRING], (u) => urlString(u));
urlMethod('EscapedPath', [], [STRING], (u) => escapedPath(u));
urlMethod('EscapedFragment', [], [STRING], (u) => escapedFragment(u));
urlMethod('IsAbs', [], [BOOL], (u) => u.scheme !== '');
urlMethod('Hostname', [], [STRING], (u) => splitHostPort(u.host)[0]);
urlMethod('Port', [], [STRING], (u) => splitHostPort(u.host)[1]);
urlMethod('RequestURI', [], [STRING], (u) => requestURI(u));
urlMethod('Query', [], [VALUES], (u) => parseQuery(u.rawQuery)[0]);
urlMethod('ResolveReference', [URL_POINTER], [URL_POINTER], (u, [ref]) => urlPointer(resolveReference(u, urlOf(ref))));
urlMethod('Parse', [STRING], [URL_POINTER, ERROR_TYPE], (u, [ref]) => {
  const [parsed, err] = parseUrl(ref as string);
  if (err !== undefined) return [undefined, err];
  return [urlPointer(resolveReference(u, urlOf(parsed))), undefined];
});
urlMethod(
  'JoinPath',
  [STRINGS],
  [URL_POINTER],
  (u, [elements]) => {
    const joined = { ...u };
    const result = attempt(() => joinPath(u, sliceValues(elements) as string[]));
    return urlPointer('value' in result ? result.value : joined);
  },
  true
);
urlMethod('MarshalBinary', [], [BYTES, ERROR_TYPE], (u) => [appendBytes(undefined, urlString(u)), undefined]);
urlMethod('AppendBinary', [BYTES], [BYTES, ERROR_TYPE], (u, [bytes]) => [appendBytes(bytes, urlString(u)), undefined]);
urlMethod('UnmarshalBinary', [BYTES], ERROR_RESULT, (_, [text], receiver) => {
  const [parsed, err] = parseUrl(bytesOf(text));
  if (err !== undefined) return err;
  (receiver as Pointer).store((parsed as Pointer).load());
  return;
});

addMethod(
  URL,
  'Redacted',
  fn([], [STRING]),
  (receiver) => {
    if (receiver === undefined) return '';
    const u = urlOf(receiver);
    const user = userFields(u.user);
    if (user?.[2]) u.user = newUserinfo(user[0], 'xxxxx', true);
    return urlString(u);
  },
  true
);
addMethod(
  URL,
  'Clone',
  fn([], [URL_POINTER]),
  (receiver) => {
    if (receiver === undefined) return;
    const u = urlOf(receiver);
    const user = userFields(u.user);
    if (user) u.user = newUserinfo(...user);
    return urlPointer(u);
  },
  true
);

// Package -----------------------------------------------------------------------------------------------------------

const members: Record<string, Entity> = {
  URL: typeEntity(URL),
  Userinfo: typeEntity(USERINFO),
  Values: typeEntity(VALUES),
  Error: typeEntity(URL_ERROR),
  EscapeError: typeEntity(ESCAPE_ERROR),
  InvalidHostError: typeEntity(INVALID_HOST_ERROR),
  Parse: nativeFunction('Parse', fn([STRING], [URL_POINTER, ERROR_TYPE]), ([rawURL]) => parseUrl(rawURL as string)),
  ParseRequestURI: nativeFunction('ParseRequestURI', fn([STRING], [URL_POINTER, ERROR_TYPE]), ([rawURL]) => {
    const parsed = attempt(() => parse(rawURL as string, true));
    if ('error' in parsed) return [undefined, urlError('parse', rawURL as string, parsed.error)];
    return [urlPointer(parsed.value), undefined];
  }),
  ParseQuery: nativeFunction('ParseQuery', fn([STRING], [VALUES, ERROR_TYPE]), ([query]) =>
    parseQuery(query as string)
  ),
  User: nativeFunction('User', fn([STRING], [USERINFO_POINTER]), ([username]) =>
    newUserinfo(username as string, '', false)
  ),
  UserPassword: nativeFunction('UserPassword', fn([STRING, STRING], [USERINFO_POINTER]), ([username, password]) =>
    newUserinfo(username as string, password as string, true)
  ),
  QueryEscape: nativeFunction('QueryEscape', fn([STRING], [STRING]), ([s]) => escape(s as string, 'queryComponent')),
  PathEscape: nativeFunction('PathEscape', fn([STRING], [STRING]), ([s]) => escape(s as string, 'pathSegment')),
  QueryUnescape: nativeFunction('QueryUnescape', fn([STRING], [STRING, ERROR_TYPE]), ([s]) =>
    unescapeResult(s as string, 'queryComponent')
  ),
  PathUnescape: nativeFunction('PathUnescape', fn([STRING], [STRING, ERROR_TYPE]), ([s]) =>
    unescapeResult(s as string, 'pathSegment')
  ),
  JoinPath: nativeFunction('JoinPath', fn([STRING, STRINGS], [STRING, ERROR_TYPE], true), ([base, elements]) => {
    const [parsed, err] = parseUrl(base as string);
    if (err !== undefined) return ['', err];
    const joined = attempt(() => joinPath(urlOf(parsed), sliceValues(elements) as string[]));
    if ('error' in joined) return ['', joined.error];
    return [urlString(joined.value), undefined];
  }),
};

function unescapeResult(s: string, mode: 'queryComponent' | 'pathSegment'): Value[] {
  const result = attempt(() => unescape(s, mode));
  return 'error' in result ? ['', result.error] : [result.value, undefined];
}

export const URL_PACKAGE = definePackage('net/url', members);
