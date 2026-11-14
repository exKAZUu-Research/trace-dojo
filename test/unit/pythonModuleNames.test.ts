import { expect, test } from 'vitest';

import { checkModules, checkValues } from '../../scripts/checkPythonNames';

// A part of what scripts/pythonData/generateModuleNames.py prints with CPython 3.14.10: the names of a few modules,
// with the module each name holds, and of a few values, with '!' before the names whose reading raises AttributeError.

/** A module's names: those holding no module, then those holding one, mapped to its name. */
function names(plain: string, modules: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(plain.split(' ').map((name) => [name, ''])),
    ...Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, `module:${module}`])),
  };
}

const MODULES: Record<string, Record<string, string>> = {
  fractions: names(
    'Fraction _FLOAT_FORMAT_SPECIFICATION_MATCHER _GENERAL_FORMAT_SPECIFICATION_MATCHER _PyHASH_INF _PyHASH_MODULUS _RATIONAL_FORMAT __all__ __builtins__ __cached__ __doc__ __file__ __loader__ __name__ __package__ __spec__ _hash_algorithm _round_to_exponent _round_to_figures',
    { functools: 'functools', math: 'math', numbers: 'numbers', operator: 'operator', re: 're', sys: 'sys' }
  ),
  time: names(
    'CLOCK_MONOTONIC CLOCK_MONOTONIC_RAW CLOCK_MONOTONIC_RAW_APPROX CLOCK_PROCESS_CPUTIME_ID CLOCK_REALTIME CLOCK_THREAD_CPUTIME_ID CLOCK_UPTIME_RAW CLOCK_UPTIME_RAW_APPROX _STRUCT_TM_ITEMS __doc__ __loader__ __name__ __package__ __spec__ altzone asctime clock_getres clock_gettime clock_gettime_ns clock_settime clock_settime_ns ctime daylight get_clock_info gmtime localtime mktime monotonic monotonic_ns perf_counter perf_counter_ns process_time process_time_ns sleep strftime strptime struct_time thread_time thread_time_ns time time_ns timezone tzname tzset',
    {}
  ),
  numbers: names(
    'ABCMeta Complex Integral Number Rational Real __all__ __builtins__ __cached__ __doc__ __file__ __loader__ __name__ __package__ __spec__ abstractmethod',
    {}
  ),
  json: names(
    'JSONDecodeError JSONDecoder JSONEncoder __all__ __author__ __builtins__ __cached__ __doc__ __file__ __loader__ __name__ __package__ __path__ __spec__ __version__ _default_decoder _default_encoder detect_encoding dump dumps load loads',
    { codecs: 'codecs', decoder: 'json.decoder', encoder: 'json.encoder', scanner: 'json.scanner' }
  ),
  'os.path': names(
    'ALLOW_MISSING __all__ __builtins__ __doc__ __file__ __loader__ __name__ __package__ __spec__ _get_sep _varpattern _varsub _varsubb abspath altsep basename commonpath commonprefix curdir defpath devnull dirname exists expanduser expandvars extsep getatime getctime getmtime getsize isabs isdevdrive isdir isfile isjunction islink ismount join lexists normcase normpath pardir pathsep realpath relpath samefile sameopenfile samestat sep split splitdrive splitext splitroot supports_unicode_filenames',
    { errno: 'errno', genericpath: 'genericpath', os: 'os', stat: 'stat', sys: 'sys' }
  ),
};

const VALUES: Record<string, string[]> = {
  'collections.deque()':
    '__add__ __class__ __class_getitem__ __contains__ __copy__ __delattr__ __delitem__ __dir__ __doc__ __eq__ __format__ __ge__ __getattribute__ __getitem__ __getstate__ __gt__ __hash__ __iadd__ __imul__ __init__ __init_subclass__ __iter__ __le__ __len__ __lt__ __module__ __mul__ __ne__ __new__ __reduce__ __reduce_ex__ __repr__ __reversed__ __rmul__ __setattr__ __setitem__ __sizeof__ __str__ __subclasshook__ append appendleft clear copy count extend extendleft index insert maxlen pop popleft remove reverse rotate'.split(
      ' '
    ),
  'time.localtime(0)':
    '__add__ __class__ __class_getitem__ __contains__ __delattr__ __dir__ __doc__ __eq__ __format__ __ge__ __getattribute__ __getitem__ __getnewargs__ __getstate__ __gt__ __hash__ __init__ __init_subclass__ __iter__ __le__ __len__ __lt__ __match_args__ __module__ __mul__ __ne__ __new__ __reduce__ __reduce_ex__ __replace__ __repr__ __rmul__ __setattr__ __sizeof__ __str__ __subclasshook__ count index n_fields n_sequence_fields n_unnamed_fields tm_gmtoff tm_hour tm_isdst tm_mday tm_min tm_mon tm_sec tm_wday tm_yday tm_year tm_zone'.split(
      ' '
    ),
};

test('every name CPython has in a module works or raises the unsupported error', () => {
  const failures = [...checkModules(MODULES), ...checkValues(VALUES)].filter(
    (result) => result.status !== 'ok' && result.status !== 'unsupported'
  );
  expect(failures).toEqual([]);
});
