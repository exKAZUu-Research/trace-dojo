// The `copyright`, `credits`, and `license` objects CPython's site module adds to the builtins, as `_sitebuiltins`
// defines them, writing through the plain pager CPython uses when stdout is not a terminal.
import { method } from './define';
import { callValue, getAttribute } from './objects';
import { currentRuntime } from './runtimeContext';
import { builtinClass, None } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyOpaque, type PyValue } from './values';

const printerClass = builtinClass('_Printer');
printerClass.module = '_sitebuiltins';
printerClass.dict.set('MAXLINES', 23n);

interface PrinterData {
  /** The text the object shows, or undefined for `license`, whose text CPython reads from its LICENSE file. */
  text?: string;
}

method(printerClass, '__repr__', 'none', 0, 0, (self) => {
  const { text } = (self as PyOpaque).data as PrinterData;
  return text ?? 'Type license() to see the full license text';
});
method(printerClass, '__call__', 'none', 0, 0, (self) => {
  const { text } = (self as PyOpaque).data as PrinterData;
  if (text === undefined) throw new UnsupportedFeatureError('license()（Python のライセンスのファイルの読み込み）');
  const runtime = currentRuntime();
  callValue(getAttribute(getAttribute(runtime.importModule('sys'), 'stdout'), 'write'), [text]);
  return None;
});

const COPYRIGHT = `Copyright (c) 2001 Python Software Foundation.
All Rights Reserved.

Copyright (c) 2000 BeOpen.com.
All Rights Reserved.

Copyright (c) 1995-2001 Corporation for National Research Initiatives.
All Rights Reserved.

Copyright (c) 1991-1995 Stichting Mathematisch Centrum, Amsterdam.
All Rights Reserved.`;

const CREDITS = `Thanks to CWI, CNRI, BeOpen, Zope Corporation, the Python Software
Foundation, and a cast of thousands for supporting Python
development.  See www.python.org for more information.`;

/** The site module's builtins `copyright`, `credits`, and `license`, in the order it adds them. */
export function siteBuiltins(): [string, PyValue][] {
  return [
    ['copyright', new PyOpaque(printerClass, '', { text: COPYRIGHT } satisfies PrinterData)],
    ['credits', new PyOpaque(printerClass, '', { text: CREDITS } satisfies PrinterData)],
    ['license', new PyOpaque(printerClass, '', {} satisfies PrinterData)],
  ];
}
