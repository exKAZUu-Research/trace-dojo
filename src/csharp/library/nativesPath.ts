import { resolvePath } from '../../interpreter/programIo';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { type CsString, stringText, type Value } from '../values';
import { iterate } from './iteration';
import { fail } from './support';

// The path arguments of the IO natives, and System.IO.Path, which works on the text of paths alone.

export function valueText(value: Value): string {
  return stringText(value as string | CsString);
}

/** The path argument of a file operation, which may be neither null nor empty. */
export function pathArgument(value: Value, paramName = 'path'): string {
  if (value === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', paramName);
  const path = valueText(value);
  if (path === '') fail('System.ArgumentException', 'The value cannot be an empty string.', paramName);
  return path;
}

export function trimEnd(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') || '/' : path;
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionStart(path: string): number {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? dot : -1;
}

/** `Path.GetFullPath`, which keeps a final separator. */
export function fullPathOf(path: string): string {
  const resolved = resolvePath(path);
  return path.endsWith('/') && resolved !== '/' ? `${resolved}/` : resolved;
}

function optionalText(value: Value): string | undefined {
  return value === undefined ? undefined : valueText(value);
}

function pathParts(call: NativeCall, args: Value[]): (string | undefined)[] {
  const params = call.method.parameters.at(-1)?.isParams;
  if (!params) return args.map(optionalText);
  const array = args[0];
  if (array === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'paths');
  return [...iterate(call, array, 'paths')].map(optionalText);
}

/** `Path.Combine`: a rooted part starts the path again; parts join with a separator unless one ends with it. */
const combine: NativeMethod = (call, _receiver, args) => {
  const parts = pathParts(call, args as Value[]);
  const names = call.method.parameters.map((parameter) => parameter.name);
  let path = '';
  for (const [index, part] of parts.entries()) {
    if (part === undefined)
      fail('System.ArgumentNullException', 'Value cannot be null.', names.length === 1 ? 'paths' : names[index]);
    if (part === '') continue;
    if (part.startsWith('/')) path = part;
    else path = path === '' || path.endsWith('/') ? `${path}${part}` : `${path}/${part}`;
  }
  return path;
};

/** `Path.Join`: parts join with one separator between them unless one already has it; null and empty parts drop. */
const join: NativeMethod = (call, _receiver, args) => {
  let path = '';
  for (const part of pathParts(call, args as Value[])) {
    if (part === undefined || part === '') continue;
    path = path === '' || path.endsWith('/') || part.startsWith('/') ? `${path}${part}` : `${path}/${part}`;
  }
  return path;
};

defineNatives({
  'System.IO.Path.Combine': combine,
  'System.IO.Path.Join': join,
  'System.IO.Path.GetFileName': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    return text === undefined ? undefined : fileNameOf(text);
  },
  'System.IO.Path.GetFileNameWithoutExtension': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return;
    const name = fileNameOf(text);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? name : name.slice(0, dot);
  },
  'System.IO.Path.GetExtension': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return;
    const dot = extensionStart(text);
    return dot === -1 || dot === text.length - 1 ? '' : text.slice(dot);
  },
  'System.IO.Path.HasExtension': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return false;
    const dot = extensionStart(text);
    return dot !== -1 && dot !== text.length - 1;
  },
  'System.IO.Path.GetDirectoryName': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined || text === '' || /^\/+$/u.test(text)) return;
    const slash = text.lastIndexOf('/');
    if (slash === -1) return '';
    const directory = text.slice(0, slash).replace(/\/+$/u, '');
    // Repeated separators inside the directory collapse to one, as .NET normalizes them.
    return directory === '' ? '/' : directory.replaceAll(/\/{2,}/gu, '/');
  },
  'System.IO.Path.ChangeExtension': (_call, _receiver, [path, extension]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return;
    const dot = extensionStart(text);
    const stem = dot === -1 ? text : text.slice(0, dot);
    const added = optionalText(extension as Value);
    if (added === undefined) return stem;
    if (added === '') return `${stem}.`;
    return added.startsWith('.') ? `${stem}${added}` : `${stem}.${added}`;
  },
  'System.IO.Path.IsPathRooted': (_call, _receiver, [path]) => optionalText(path as Value)?.startsWith('/') ?? false,
  'System.IO.Path.GetFullPath': (_call, _receiver, [path]) => fullPathOf(pathArgument(path as Value)),
});
