import { help } from '../help';
import { registerExtraAttributes } from '../modules';
import { registerSourceModule } from '../sourceModules';
import { nativeFunction } from '../types';
import { type PyClass, PyInstance } from '../values';

// The Quitter and _Helper classes of CPython's `_sitebuiltins.py`, on the lines CPython's are, whose objects are the
// builtins `quit`, `exit`, and `help`. Quitter does not close sys.stdin, which programs here have none of; _Helper calls
// the help() of help.ts, which documents objects as pydoc's Helper does. It imports no sys, whose import here, before
// the program's frame exists, would make the wrong frame's globals __main__.
const SOURCE = String.raw`"""
The objects used by the site module to add custom builtins.
"""









class Quitter(object):
    def __init__(self, name, eof):
        self.name = name
        self.eof = eof
    def __repr__(self):
        return 'Use %s() or %s to exit' % (self.name, self.eof)
    def __call__(self, code=None):






        raise SystemExit(code)

















































class _Helper(object):
    """Define the builtin 'help'.

    This is a wrapper around pydoc.help that provides a helpful message
    when 'help' is typed at the Python interactive prompt.

    Calling help() at the Python prompt starts an interactive help session.
    Calling help(thing) prints help for the python object 'thing'.
    """

    def __repr__(self):
        return "Type help() for interactive help, " \
               "or help(object) for help about object."
    def __call__(self, *args, **kwds):

        return _help(*args, **kwds)
`;

registerSourceModule('_sitebuiltins', SOURCE, () => new Map([['_help', nativeFunction('help', help)]]));

// The site module adds these objects to the builtins, which every program has; no frame runs yet to call __init__.
registerExtraAttributes('builtins', (runtime) => {
  const site = runtime.importModule('_sitebuiltins').dict;
  const quitter = (name: string): PyInstance => {
    const instance = new PyInstance(site.get('Quitter') as PyClass);
    instance.dict.set('name', name);
    instance.dict.set('eof', 'Ctrl-D (i.e. EOF)');
    return instance;
  };
  return [
    ['quit', quitter('quit')],
    ['exit', quitter('exit')],
    ['help', new PyInstance(site.get('_Helper') as PyClass)],
  ];
});
