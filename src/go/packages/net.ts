import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, ERROR_TYPE, type NamedType, sliceOf, type Type, typeString } from '../types';
import { GoStruct, Iface, type Pointer, type Slice, type Value } from '../values';
import { EOF, implementsInterface, IO_WRITER, libraryVariable, subslice, writeFrom } from './io';
import { ADDR_ERROR, errorValue, HARDWARE_ADDR, IP, ipEmptyString, NET_IP_MEMBERS } from './netIp';
import { BOOL, BYTES, callMethod, errorText, INT, receiverStruct, STRING } from './support';
import { DURATION } from './time';

function struct(name: string, fields: [string, Type][]): NamedType {
  return namedType('net', name, {
    kind: 'struct',
    fields: fields.map(([field, type]) => ({ name: field, type, embedded: false })),
  });
}

const fieldsOf = (receiver: Value): Value[] => receiverStruct(receiver).fields;

// Interfaces and errors ---------------------------------------------------------------------------------------------

const ADDR = namedType('net', 'Addr', {
  kind: 'interface',
  methods: [
    { name: 'Network', type: fn([], [STRING]) },
    { name: 'String', type: fn([], [STRING]) },
  ],
});
const NET_ERROR = namedType('net', 'Error', {
  kind: 'interface',
  methods: [
    { name: 'Error', type: fn([], [STRING]) },
    { name: 'Temporary', type: fn([], [BOOL]) },
    { name: 'Timeout', type: fn([], [BOOL]) },
  ],
});
const TIMEOUT = { kind: 'interface' as const, methods: [{ name: 'Timeout', type: fn([], [BOOL]) }] };
const TEMPORARY = { kind: 'interface' as const, methods: [{ name: 'Temporary', type: fn([], [BOOL]) }] };

/** A string error type such as `UnknownNetworkError`, which is neither a timeout nor temporary. */
function stringError(name: string, message: (text: string) => string): NamedType {
  const type = namedType('net', name, STRING);
  addMethod(type, 'Error', fn([], [STRING]), (receiver) => message(receiver as string));
  for (const method of ['Timeout', 'Temporary']) addMethod(type, method, fn([], [BOOL]), () => false);
  return type;
}

const UNKNOWN_NETWORK_ERROR = stringError('UnknownNetworkError', (text) => `unknown network ${text}`);
const INVALID_ADDR_ERROR = stringError('InvalidAddrError', (text) => text);

/** Whether an error, or the error inside an `*os.SyscallError`, reports true from the method. */
function errorReports(error: Value, method: 'Timeout' | 'Temporary'): boolean {
  let inner = error;
  if (inner instanceof Iface && typeString(inner.type) === '*os.SyscallError') inner = fieldsOf(inner.value).at(-1);
  return implementsInterface(inner, method === 'Timeout' ? TIMEOUT : TEMPORARY) && callMethod(inner, method) === true;
}

const OP_ERROR = struct('OpError', [
  ['Op', STRING],
  ['Net', STRING],
  ['Source', ADDR],
  ['Addr', ADDR],
  ['Err', ERROR_TYPE],
]);
addMethod(OP_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => fieldsOf(receiver)[4], true);
addMethod(
  OP_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    if (receiver === undefined) return '<nil>';
    const [op, network, source, addr, error] = fieldsOf(receiver);
    let text = op as string;
    if (network !== '') text += ` ${network as string}`;
    if (source !== undefined) text += ` ${callMethod(source, 'String') as string}`;
    if (addr !== undefined) text += `${source === undefined ? ' ' : '->'}${callMethod(addr, 'String') as string}`;
    return `${text}: ${errorText(error)}`;
  },
  true
);
addMethod(OP_ERROR, 'Timeout', fn([], [BOOL]), (receiver) => errorReports(fieldsOf(receiver)[4], 'Timeout'), true);
addMethod(OP_ERROR, 'Temporary', fn([], [BOOL]), (receiver) => errorReports(fieldsOf(receiver)[4], 'Temporary'), true);

const DNS_CONFIG_ERROR = struct('DNSConfigError', [['Err', ERROR_TYPE]]);
addMethod(DNS_CONFIG_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => fieldsOf(receiver)[0], true);
addMethod(
  DNS_CONFIG_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => `error reading DNS config: ${errorText(fieldsOf(receiver)[0])}`,
  true
);
for (const method of ['Timeout', 'Temporary']) addMethod(DNS_CONFIG_ERROR, method, fn([], [BOOL]), () => false, true);

const DNS_ERROR = struct('DNSError', [
  ['UnwrapErr', ERROR_TYPE],
  ['Err', STRING],
  ['Name', STRING],
  ['Server', STRING],
  ['IsTimeout', BOOL],
  ['IsTemporary', BOOL],
  ['IsNotFound', BOOL],
]);
addMethod(DNS_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => fieldsOf(receiver)[0], true);
addMethod(
  DNS_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    if (receiver === undefined) return '<nil>';
    const [, error, name, server] = fieldsOf(receiver) as string[];
    return `lookup ${name}${server === '' ? '' : ` on ${server}`}: ${error}`;
  },
  true
);
addMethod(DNS_ERROR, 'Timeout', fn([], [BOOL]), (receiver) => fieldsOf(receiver)[4], true);
addMethod(
  DNS_ERROR,
  'Temporary',
  fn([], [BOOL]),
  (receiver) => fieldsOf(receiver)[4] === true || fieldsOf(receiver)[5] === true,
  true
);

/** `poll.errNetClosing`, which `net.ErrClosed` is. */
const NET_CLOSING = namedType('internal/poll', 'errNetClosing', { kind: 'struct', fields: [] });
addMethod(NET_CLOSING, 'Error', fn([], [STRING]), () => 'use of closed network connection');
for (const method of ['Timeout', 'Temporary']) addMethod(NET_CLOSING, method, fn([], [BOOL]), () => false);

// Addresses ---------------------------------------------------------------------------------------------------------

function joinHostPort(host: string, port: string): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function socketAddr(name: string, network: string): NamedType {
  const type = struct(name, [
    ['IP', IP],
    ['Port', INT],
    ['Zone', STRING],
  ]);
  addMethod(type, 'Network', fn([], [STRING]), () => network, true);
  addMethod(
    type,
    'String',
    fn([], [STRING]),
    (receiver) => {
      if (receiver === undefined) return '<nil>';
      const [ip, port, zone] = fieldsOf(receiver);
      const host = ipEmptyString(ip) + (zone === '' ? '' : `%${zone as string}`);
      return joinHostPort(host, String(port as bigint));
    },
    true
  );
  type.unsupported = new Set(['AddrPort']);
  return type;
}

const TCP_ADDR = socketAddr('TCPAddr', 'tcp');
const UDP_ADDR = socketAddr('UDPAddr', 'udp');
const IP_ADDR = struct('IPAddr', [
  ['IP', IP],
  ['Zone', STRING],
]);
addMethod(IP_ADDR, 'Network', fn([], [STRING]), () => 'ip', true);
addMethod(
  IP_ADDR,
  'String',
  fn([], [STRING]),
  (receiver) => {
    if (receiver === undefined) return '<nil>';
    const [ip, zone] = fieldsOf(receiver);
    return ipEmptyString(ip) + (zone === '' ? '' : `%${zone as string}`);
  },
  true
);
const UNIX_ADDR = struct('UnixAddr', [
  ['Name', STRING],
  ['Net', STRING],
]);
addMethod(UNIX_ADDR, 'Network', fn([], [STRING]), (receiver) => fieldsOf(receiver)[1], true);
addMethod(
  UNIX_ADDR,
  'String',
  fn([], [STRING]),
  (receiver) => (receiver === undefined ? '<nil>' : fieldsOf(receiver)[0]),
  true
);

function addrError(addr: string, why: string): Value[] {
  return ['', '', errorValue(ADDR_ERROR, [why, addr])];
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes net.SplitHostPort.
/** `net.SplitHostPort`. */
function splitHostPort(hostport: string): Value[] {
  const missingPort = 'missing port in address';
  const tooManyColons = 'too many colons in address';
  const i = hostport.lastIndexOf(':');
  if (i === -1) return addrError(hostport, missingPort);
  let host: string;
  let j = 0;
  let k = 0;
  if (hostport[0] === '[') {
    const end = hostport.indexOf(']');
    if (end === -1) return addrError(hostport, "missing ']' in address");
    if (end + 1 === hostport.length) return addrError(hostport, missingPort);
    if (end + 1 !== i) return addrError(hostport, hostport[end + 1] === ':' ? tooManyColons : missingPort);
    host = hostport.slice(1, end);
    j = 1;
    k = end + 1;
  } else {
    host = hostport.slice(0, i);
    if (host.includes(':')) return addrError(hostport, tooManyColons);
  }
  if (hostport.slice(j).includes('[')) return addrError(hostport, "unexpected '[' in address");
  if (hostport.slice(k).includes(']')) return addrError(hostport, "unexpected ']' in address");
  return [host, hostport.slice(i + 1), undefined];
}

// Flags, records, and Buffers ---------------------------------------------------------------------------------------

const FLAGS = namedType('net', 'Flags', BASIC.uint);
const FLAG_NAMES = ['up', 'broadcast', 'loopback', 'pointtopoint', 'multicast', 'running'];
addMethod(FLAGS, 'String', fn([], [STRING]), (receiver) => {
  const flags = receiver as bigint;
  const names = FLAG_NAMES.filter((_, index) => (flags >> BigInt(index)) & 1n);
  return names.length === 0 ? '0' : names.join('|');
});
const FLAG_CONSTANTS = ['FlagUp', 'FlagBroadcast', 'FlagLoopback', 'FlagPointToPoint', 'FlagMulticast', 'FlagRunning'];

const INTERFACE = struct('Interface', [
  ['Index', INT],
  ['MTU', INT],
  ['Name', STRING],
  ['HardwareAddr', HARDWARE_ADDR],
  ['Flags', FLAGS],
]);
INTERFACE.unsupported = new Set(['Addrs', 'MulticastAddrs']);

const UINT16 = BASIC.uint16;
const RECORDS = [
  struct('MX', [
    ['Host', STRING],
    ['Pref', UINT16],
  ]),
  struct('NS', [['Host', STRING]]),
  struct('SRV', [
    ['Target', STRING],
    ['Port', UINT16],
    ['Priority', UINT16],
    ['Weight', UINT16],
  ]),
  struct('KeepAliveConfig', [
    ['Enable', BOOL],
    ['Idle', DURATION],
    ['Interval', DURATION],
    ['Count', INT],
  ]),
];

/** `net.Buffers`, a list of byte slices that Read and WriteTo consume. */
const BUFFERS = namedType('net', 'Buffers', sliceOf(BYTES));

function buffersOf(receiver: Value): Pointer {
  return receiver as Pointer;
}

function consume(receiver: Value, count: bigint): void {
  const pointer = buffersOf(receiver);
  let n = count;
  for (;;) {
    const list = pointer.load() as Slice | undefined;
    if (!list || list.length === 0) return;
    const first = list.get(0) as Slice | undefined;
    const length = BigInt(first?.length ?? 0);
    if (length > n) {
      list.set(0, subslice(first, Number(n)));
      return;
    }
    n -= length;
    list.set(0, undefined);
    pointer.store(subslice(list, 1));
  }
}

addMethod(
  BUFFERS,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [buffer]) => {
    let p = buffer as Slice | undefined;
    let n = 0;
    while (p && p.length > 0 && ((buffersOf(receiver).load() as Slice | undefined)?.length ?? 0) > 0) {
      const first = (buffersOf(receiver).load() as Slice).get(0) as Slice | undefined;
      const count = Math.min(p.length, first?.length ?? 0);
      for (let index = 0; index < count; index++) p.set(index, (first as Slice).get(index));
      consume(receiver, BigInt(count));
      p = subslice(p, count);
      n += count;
    }
    const empty = ((buffersOf(receiver).load() as Slice | undefined)?.length ?? 0) === 0;
    return [BigInt(n), empty ? EOF : undefined];
  },
  true
);
addMethod(
  BUFFERS,
  'WriteTo',
  fn([IO_WRITER], [BASIC.int64, ERROR_TYPE]),
  (receiver, [writer]) => {
    let n = 0n;
    const list = buffersOf(receiver).load() as Slice | undefined;
    for (let index = 0; index < (list?.length ?? 0); index++) {
      const [written, error] = writeFrom(writer, (list as Slice).get(index));
      n += BigInt(written);
      if (error !== undefined) {
        consume(receiver, n);
        return [n, error];
      }
    }
    consume(receiver, n);
    return [n, undefined];
  },
  true
);

// Package -----------------------------------------------------------------------------------------------------------

const members: Record<string, Entity> = {
  ...NET_IP_MEMBERS,
  Addr: typeEntity(ADDR),
  Error: typeEntity(NET_ERROR),
  OpError: typeEntity(OP_ERROR),
  DNSError: typeEntity(DNS_ERROR),
  DNSConfigError: typeEntity(DNS_CONFIG_ERROR),
  UnknownNetworkError: typeEntity(UNKNOWN_NETWORK_ERROR),
  InvalidAddrError: typeEntity(INVALID_ADDR_ERROR),
  TCPAddr: typeEntity(TCP_ADDR),
  UDPAddr: typeEntity(UDP_ADDR),
  IPAddr: typeEntity(IP_ADDR),
  UnixAddr: typeEntity(UNIX_ADDR),
  Flags: typeEntity(FLAGS),
  Interface: typeEntity(INTERFACE),
  Buffers: typeEntity(BUFFERS),
  ...Object.fromEntries(RECORDS.map((type) => [type.name, typeEntity(type)])),
  ...Object.fromEntries(
    FLAG_CONSTANTS.map((name, index): [string, Entity] => [
      name,
      {
        kind: 'const',
        name,
        type: FLAGS,
        value: { kind: 'int', value: 1n << BigInt(index) },
        span: { row: 0, column: 0 },
        used: true,
      },
    ])
  ),
  ErrClosed: libraryVariable('ErrClosed', ERROR_TYPE, new Iface(NET_CLOSING, new GoStruct([]))),
  ErrWriteToConnected: libraryVariable(
    'ErrWriteToConnected',
    ERROR_TYPE,
    newError('use of WriteTo with pre-connected connection')
  ),
  SplitHostPort: nativeFunction('SplitHostPort', fn([STRING], [STRING, STRING, ERROR_TYPE]), ([hostport]) =>
    splitHostPort(hostport as string)
  ),
  JoinHostPort: nativeFunction('JoinHostPort', fn([STRING, STRING], [STRING]), ([host, port]) =>
    joinHostPort(host as string, port as string)
  ),
};

/**
 * The net package's addresses and errors. What dials, listens, resolves names, reads the machine's interfaces, or
 * converts to net/netip types (a package this environment does not provide) is unavailable, as are pipes.
 */
export const NET_PACKAGE = definePackage('net', members, [
  'Dial',
  'DialIP',
  'DialTCP',
  'DialTimeout',
  'DialUDP',
  'DialUnix',
  'Dialer',
  'Listen',
  'ListenIP',
  'ListenMulticastUDP',
  'ListenPacket',
  'ListenTCP',
  'ListenUDP',
  'ListenUnix',
  'ListenUnixgram',
  'ListenConfig',
  'LookupAddr',
  'LookupCNAME',
  'LookupHost',
  'LookupIP',
  'LookupMX',
  'LookupNS',
  'LookupPort',
  'LookupSRV',
  'LookupTXT',
  'Resolver',
  'DefaultResolver',
  'ResolveIPAddr',
  'ResolveTCPAddr',
  'ResolveUDPAddr',
  'ResolveUnixAddr',
  'Interfaces',
  'InterfaceAddrs',
  'InterfaceByIndex',
  'InterfaceByName',
  'Conn',
  'PacketConn',
  'Listener',
  'IPConn',
  'TCPConn',
  'TCPListener',
  'UDPConn',
  'UnixConn',
  'UnixListener',
  'FileConn',
  'FileListener',
  'FilePacketConn',
  'Pipe',
  'TCPAddrFromAddrPort',
  'UDPAddrFromAddrPort',
]);
