import { ClassInfo, type NativeContext, type Type, VOID } from '../types';
import type { Ptr } from '../values';
import { CObject } from '../values';
import { addMethod, CONST_CHAR_PTR, constRef, cStringStore, native, nativeConstructor, readCString } from './support';

/** The standard exception classes of `<exception>` and `<stdexcept>`, by name without `std::`. */
export function exceptionClasses(stringType: () => Type): Map<string, ClassInfo> {
  const classes = new Map<string, ClassInfo>();
  const define = (
    name: string,
    base: ClassInfo | undefined,
    hasMessage: boolean,
    defaultMessage = `std::${name}`
  ): ClassInfo => {
    const cls = new ClassInfo(`std::${name}`, 'class');
    cls.base = base;
    cls.baseAccess = 'public';
    cls.isComplete = true;
    cls.library = { kind: name, args: [], size: hasMessage ? 16 : 8, align: 8, isInheritable: true };
    if (base) for (const [key, fn] of base.virtuals) cls.virtuals.set(key, fn);
    cls.destructor = {
      ...native(`~${name}`, [], VOID, () => {}, { owner: cls, isVirtual: true }),
      isDestructor: true,
      isNoexcept: true,
    };
    cls.virtuals.set('~', cls.destructor);
    const construct = (message: string | undefined) => (_args: unknown[], context: NativeContext) => {
      const self = context.self instanceof CObject ? context.self : new CObject(cls, []);
      self.message = message ?? defaultMessage;
      return context.self instanceof CObject ? undefined : self;
    };
    cls.constructors = hasMessage
      ? [
          nativeConstructor(cls, [constRef(stringType())], (args, context) =>
            construct(((args[0] as Ptr).read() as unknown as { bytes: string }).bytes)(args, context)
          ),
          nativeConstructor(cls, [CONST_CHAR_PTR], (args, context) =>
            construct(readCString(args[0] as Ptr, context.frame.runtime))(args, context)
          ),
        ]
      : [nativeConstructor(cls, [], (args, context) => construct(undefined)(args, context))];
    cls.operations = {
      copyIsNoexcept: true,
      copy: (_frame, source) => {
        const object = source as CObject;
        const copy = new CObject(cls, []);
        // Copying as `std::exception` slices the message off, as its copy constructor keeps none.
        if (hasMessage) copy.shareMessageFrom(object);
        else copy.message = defaultMessage;
        return copy;
      },
      assign: (_frame, target, source) => {
        if (hasMessage) (target as CObject).shareMessageFrom(source as CObject);
      },
    };
    classes.set(name, cls);
    return cls;
  };
  const exception = define('exception', undefined, false);
  const what = {
    ...native(
      'what',
      [],
      CONST_CHAR_PTR,
      (_args, { self, frame }) =>
        (self as CObject).messageLocation((text) => {
          frame.runtime.reserve(text.length + 1);
          return cStringStore(text);
        }),
      {
        isConst: true,
        isVirtual: true,
      }
    ),
    isNoexcept: true,
  };
  addMethod(exception, what);
  exception.virtuals.set('what()const', what);
  const logic = define('logic_error', exception, true);
  const runtime = define('runtime_error', exception, true);
  const badAlloc = define('bad_alloc', exception, false);
  define('bad_array_new_length', badAlloc, false, 'bad_array_new_length');
  define('bad_exception', exception, false);
  const badCast = define('bad_cast', exception, false);
  define('bad_typeid', exception, false);
  define('bad_function_call', exception, false);
  define('bad_weak_ptr', exception, false, 'bad_weak_ptr');
  define('bad_optional_access', exception, false, 'bad_optional_access');
  define('bad_variant_access', exception, false, 'bad_variant_access');
  define('bad_any_cast', badCast, false, 'bad any cast');
  for (const name of ['invalid_argument', 'domain_error', 'length_error', 'out_of_range']) define(name, logic, true);
  for (const name of ['range_error', 'overflow_error', 'underflow_error']) define(name, runtime, true);
  return classes;
}
