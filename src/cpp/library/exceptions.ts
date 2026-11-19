import { ClassInfo, type NativeContext, type Type } from '../types';
import { CObject, Ptr } from '../values';
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
    cls.library = { kind: name, args: [], size: base ? 16 : 8, align: 8, isInheritable: true };
    if (base) for (const [key, fn] of base.virtuals) cls.virtuals.set(key, fn);
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
            construct(readCString(args[0] as Ptr))(args, context)
          ),
        ]
      : [nativeConstructor(cls, [], (args, context) => construct(undefined)(args, context))];
    cls.operations = {
      copy: (_frame, source) => {
        const object = source as CObject;
        const copy = new CObject(cls, [...object.values]);
        // Copying as `std::exception` slices the message off, as its copy constructor keeps none.
        copy.message = hasMessage ? object.message : defaultMessage;
        return copy;
      },
      assign: (_frame, target, source) => {
        if (hasMessage) (target as CObject).message = (source as CObject).message;
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
      (_args, { self }) => new Ptr(cStringStore((self as CObject).message ?? 'std::exception'), 0),
      { isConst: true, isVirtual: true }
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
  for (const name of ['invalid_argument', 'domain_error', 'length_error', 'out_of_range']) define(name, logic, true);
  for (const name of ['range_error', 'overflow_error', 'underflow_error']) define(name, runtime, true);
  return classes;
}
