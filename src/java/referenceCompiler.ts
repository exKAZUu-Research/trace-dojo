import type { Expression, PatternBinding } from './ast';
import {
  type Capture,
  type Compiled,
  type CompiledValue,
  CompilerBase,
  type MethodContext,
  type Reference,
} from './compilerBase';
import { memberBindings, memberType } from './conversions';
import { type Frame, throwBuiltin, UNASSIGNED } from './runtime';
import {
  asSuper,
  type ClassInfo,
  type FieldInfo,
  INT,
  isReference,
  isSubclass,
  isWidening,
  type JavaType,
  thisTypeOf,
  typeName,
  upperBound,
} from './types';
import { JavaArray, JavaObject, type Value } from './values';

/** Resolves names, fields, and array elements, including those of enclosing instances and enclosing methods. */
export abstract class ReferenceCompiler extends CompilerBase {
  protected abstract compileExpression(context: MethodContext, expression: Expression): Compiled;

  /** The local and anonymous classes, with the method context that declares each and the locals it reads. */
  protected readonly localClasses = new WeakMap<ClassInfo, { definingContext: MethodContext; captures: Capture[] }>();
  /** The local slots that pattern variables use. */
  protected readonly bindingSlots = new WeakMap<PatternBinding, number>();

  protected compileName(context: MethodContext, expression: Extract<Expression, { kind: 'name' }>): Compiled {
    const slot = this.findLocal(context, expression.name);
    if (slot !== undefined) {
      const type = context.locals[slot].type;
      const constant = context.constants.get(slot);
      if (constant !== undefined) {
        return {
          kind: 'value',
          type,
          constant,
          run: (frame) => {
            if (frame.locals[slot] === UNASSIGNED)
              throw new Error(`Local ${expression.name} is read before assignment`);
            return constant;
          },
        };
      }
      return {
        kind: 'value',
        type,
        run: (frame) => {
          const value = frame.locals[slot];
          if (value === UNASSIGNED) throw new Error(`Local ${expression.name} is read before assignment`);
          return value;
        },
      };
    }
    const captured = this.findCapture(context, expression, expression.name);
    if (captured) {
      const { index, capture } = captured;
      return { kind: 'value', type: capture.type, constant: capture.constant, run: (frame) => frame.captured[index] };
    }
    const reference = this.compileSimpleNameReference(context, expression);
    if ('kind' in reference) return reference;
    const bound = reference.bind;
    return {
      kind: 'value',
      type: reference.type,
      run: (frame) => bound(frame).get(),
      constant: reference.constant,
    };
  }

  /** Resolves `object.name`, or a simple name when `object` is `undefined`. */
  /** Resolves a simple name that is not a local: a field of the current class or a class name. */
  protected compileSimpleNameReference(
    context: MethodContext,
    name: Extract<Expression, { kind: 'name' }>
  ): (Reference & { constant?: Value }) | Compiled {
    const field = this.findField(context.cls, name.name);
    if (field) {
      if (!field.isStatic && context.isStatic) {
        this.error(name, `static ではないフィールド ${name.name} は static メソッドの中から使えません。`);
      }
      return this.fieldReference(field, field.isStatic ? undefined : thisValue(context));
    }
    for (let current: ClassInfo | undefined = context.cls; current; current = current.enclosing) {
      if (current !== context.cls) {
        const outerField = this.findField(current, name.name);
        if (outerField?.isStatic) return this.fieldReference(outerField, undefined);
        if (outerField) {
          const receiver = this.outerInstanceValue(context, current);
          if (!receiver) {
            this.error(name, `static ではないフィールド ${name.name} は、ここからは使えません。`);
          }
          return this.fieldReference(outerField, receiver);
        }
      }
      // A local or anonymous class reads the locals of the method that declares it.
      const captured = this.findClassCapture(context, current, name);
      if (captured) return captured;
    }
    const imported = this.staticallyImported(name.name, (cls) => {
      const field = this.findField(cls, name.name);
      return field?.isStatic ? field : undefined;
    });
    if (imported) return this.fieldReference(imported, undefined);
    const cls = this.lookupType(name.name, context.cls);
    if (cls) return { kind: 'class', cls };
    return this.error(name, `変数 ${name.name} が見つかりません。`);
  }

  /** Resolves `object.name`. */
  protected compileFieldReference(
    context: MethodContext,
    access: Extract<Expression, { kind: 'fieldAccess' }>
  ): (Reference & { constant?: Value }) | Compiled {
    const { name } = access;
    if (access.object === 'super') {
      if (context.isStatic) this.error(access, 'static メソッドの中では super を使えません。');
      const field = this.findField(context.cls.superclass as ClassInfo, name);
      if (!field) return this.error(access, missingFieldMessage(context.cls.superclass as ClassInfo, name));
      return notConstant(this.fieldReference(field, field.isStatic ? undefined : superValue(context)));
    }
    const object = this.compileExpression(context, access.object);
    if (object.kind === 'class') {
      const field = this.findField(object.cls, name);
      if (!field) {
        const member = this.findMemberType(object.cls, name);
        if (member) return { kind: 'class', cls: member };
        return this.error(access, missingFieldMessage(object.cls, name));
      }
      if (!field.isStatic) this.error(access, `static ではないフィールド ${name} はクラス名から使えません。`);
      this.checkAccess(context, field.owner, field.access, access, `フィールド ${name}`);
      return this.fieldReference(field, undefined);
    }
    // Java folds a constant field only when it is named by its simple name or as TypeName.name.
    return notConstant(this.compileMemberOfValue(context, access, object));
  }

  /** Resolves `object.name` where `object` is a value, including an array's `length`. */
  protected compileMemberOfValue(
    context: MethodContext,
    access: Extract<Expression, { kind: 'fieldAccess' }>,
    object: CompiledValue
  ): Reference & { constant?: Value } {
    const { name } = access;
    if (object.type.kind === 'array') {
      if (name !== 'length') this.error(access, `配列にフィールド ${name} はありません。`);
      return arrayLengthReference(object);
    }
    const bound = upperBound(object.type);
    if (bound.kind !== 'class') {
      return this.error(access, `${typeName(object.type)} 型の値にはフィールドがありません。`);
    }
    const field = this.findField(bound.cls, name);
    if (!field) return this.error(access, missingFieldMessage(bound.cls, name));
    this.checkAccess(context, field.owner, field.access, access, `フィールド ${name}`);
    return this.fieldReference(field, field.isStatic ? undefined : object, field.isStatic ? object : undefined);
  }

  protected fieldReference(
    field: FieldInfo,
    receiver: CompiledValue | undefined,
    ignoredReceiver?: CompiledValue
  ): Reference & { constant?: Value } {
    const { slot, owner } = field;
    const constant = this.constantOf(field);
    if (constant !== undefined) {
      return {
        type: field.type,
        field,
        constant,
        bind: (frame) => {
          // A receiver written before the field still runs, and an instance field still needs an object.
          ignoredReceiver?.run(frame);
          if (!field.isStatic && !((receiver as CompiledValue).run(frame) instanceof JavaObject)) {
            throwBuiltin(frame, 'NullPointerException');
          }
          return {
            get: () => constant,
            set: () => {
              throw new Error('A constant variable was assigned');
            },
          };
        },
      };
    }
    if (field.isStatic) {
      const builtinConstant = field.constant;
      return {
        type: field.type,
        field,
        constant:
          builtinConstant !== undefined && !(builtinConstant instanceof JavaObject) ? builtinConstant : undefined,
        bind: (frame) => {
          ignoredReceiver?.run(frame);
          const values = frame.runtime.staticsOf(frame, owner);
          return {
            get: () => values[slot],
            set: (value) => {
              values[slot] = value;
            },
          };
        },
      };
    }
    const object = receiver as CompiledValue;
    return {
      type: memberType(field.type, memberBindings(object.type, field.owner)),
      field,
      bind: (frame) => {
        const target = object.run(frame);
        if (!(target instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
        return {
          get: () => target.fields[slot],
          set: (value) => {
            target.fields[slot] = value;
          },
        };
      },
    };
  }

  protected compileReference(context: MethodContext, target: Expression): Reference {
    if (target.kind === 'arrayAccess') return this.compileArrayElementReference(context, target);
    if (target.kind !== 'name' && target.kind !== 'fieldAccess') return this.error(target, '代入できない式です。');
    const slot = target.kind === 'name' ? this.findLocal(context, target.name) : undefined;
    if (slot !== undefined) {
      this.recordAssignment(context, target, slot);
      return localReference(context, slot);
    }
    if (target.kind === 'name' && this.findCapture(context, target, target.name)) {
      this.error(target, `ラムダ式の中からは、外側のローカル変数 ${target.name} に代入できません。`);
    }
    const reference =
      target.kind === 'name'
        ? this.compileSimpleNameReference(context, target)
        : this.compileFieldReference(context, target);
    if ('kind' in reference) return this.error(target, `${target.name} には代入できません。`);
    if (reference.isCapture) {
      this.error(target, `クラスの中からは、外側のメソッドのローカル変数 ${target.name} に代入できません。`);
    }
    return reference;
  }

  protected compileArrayElementReference(
    context: MethodContext,
    target: Extract<Expression, { kind: 'arrayAccess' }>
  ): Reference {
    const array = this.compileValue(context, target.array);
    if (array.type.kind !== 'array') {
      return this.error(target, `${typeName(array.type)} 型の値は配列ではありません。`);
    }
    const index = this.convert(this.compileValue(context, target.index), INT, 'invocation', target.index).run;
    return {
      type: array.type.element,
      bind: (frame) => {
        const values = array.run(frame);
        if (!(values instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
        frame.temporaries.push(values);
        let position: number;
        try {
          position = index(frame) as number;
        } finally {
          frame.temporaries.pop();
        }
        if (position < 0 || position >= values.values.length) {
          throwBuiltin(
            frame,
            'ArrayIndexOutOfBoundsException',
            `Index ${position} out of bounds for length ${values.values.length}`
          );
        }
        return {
          get: () => values.values[position],
          set: (value) => {
            // An array of a subclass type, assigned to a variable of a superclass array type, still checks its stores.
            if (isReference(values.elementType) && !fitsElement(frame, values.elementType, value)) {
              const actual = value instanceof JavaObject ? value.cls.binaryName : 'java.lang.String';
              throwBuiltin(frame, 'ArrayStoreException', actual);
            }
            values.values[position] = value;
          },
        };
      },
    };
  }

  /**
   * Rejects assigning an array's length or a final field, except a blank final field that a constructor or an
   * initializer of its class assigns by its simple name or through `this`.
   */
  protected checkAssignable(context: MethodContext, target: Expression, reference: Reference): void {
    const { field } = reference;
    if (reference.isArrayLength) this.error(target, 'length は final なので代入できません。');
    if (!field?.isFinal) return;
    const isBlank =
      field.constant === undefined &&
      !field.declaration?.declarators.find((declarator) => declarator.name === field.name)?.initializer;
    const namesOwnField =
      target.kind === 'name' ||
      (target.kind === 'fieldAccess' && target.object !== 'super' && target.object.kind === 'this');
    const initializesField =
      context.cls === field.owner && context.initializes === (field.isStatic ? 'static' : 'instance');
    if (!(isBlank && namesOwnField && initializesField))
      this.error(target, `${field.name} は final なので代入できません。`);
  }

  /**
   * The instance of `target` (or a subclass) that code in `context` reaches through the enclosing instances of inner,
   * local, and anonymous classes, or `undefined` when a static context or a static class lies on the way.
   *
   * @param isExact Whether the instance must be of `target` itself, as `Target.this` requires.
   */
  protected outerInstanceValue(context: MethodContext, target: ClassInfo, isExact = false): CompiledValue | undefined {
    if (context.isStatic) return;
    let cls = context.cls;
    let hops = 0;
    while (isExact ? cls !== target : !isSubclass(cls, target)) {
      if (!cls.hasOuterInstance || !cls.enclosing) return;
      cls = cls.enclosing;
      hops++;
    }
    return {
      kind: 'value',
      type: thisTypeOf(cls),
      run: (frame) => {
        let object = frame.thisObject;
        for (let hop = 0; hop < hops; hop++) object = object?.outer;
        return object;
      },
    };
  }

  /**
   * Resolves a name in a local or anonymous class `cls` as a local of the method that declares it, which the class's
   * instances copy when they are created.
   */
  protected findClassCapture(
    context: MethodContext,
    cls: ClassInfo,
    name: Extract<Expression, { kind: 'name' }>
  ): (Reference & { constant?: Value }) | undefined {
    const local = this.localClasses.get(cls);
    if (!local) return;
    let index = local.captures.findIndex((capture) => capture.name === name.name);
    if (index === -1) {
      const defining = local.definingContext;
      const slot = this.findLocal(defining, name.name);
      let type: JavaType;
      let constant: Value;
      if (slot === undefined) {
        const lambdaCapture = this.findCapture(defining, name, name.name);
        if (!lambdaCapture) return;
        ({ type, constant } = lambdaCapture.capture);
      } else {
        const allowed = defining.uninitializedSlots.has(slot) ? 1 : 0;
        if ((defining.assignmentCounts.get(slot) ?? 0) > allowed) {
          this.error(
            name,
            `クラスの中から使うローカル変数 ${name.name} は、final か実質的に final (一度しか代入しない) である必要があります。`
          );
        }
        defining.capturedSlots.add(slot);
        type = defining.locals[slot].type;
        constant = defining.constants.get(slot);
      }
      index = local.captures.push({ name: name.name, type, constant, read: () => {} }) - 1;
    }
    const capture = local.captures[index];
    const holder = cls === context.cls ? thisValue(context) : this.outerInstanceValue(context, cls, true);
    if (!holder && context.isStatic) this.error(name, `変数 ${name.name} は static メソッドの中からは使えません。`);
    const read = holder?.run;
    return {
      type: capture.type,
      constant: capture.constant,
      isCapture: true,
      bind: (frame) => ({
        get: () => (read?.(frame) as JavaObject | undefined)?.capturedLocals?.[index],
        set: () => {
          throw new Error('A captured local was assigned');
        },
      }),
    };
  }
}

/** Whether an array whose elements have the runtime type `elementType` may store `value`. */
function fitsElement(frame: Frame, elementType: JavaType, value: Value): boolean {
  if (value === undefined) return true;
  if (elementType.kind === 'class') return frame.runtime.isInstance(value, elementType.cls);
  if (elementType.kind === 'array') {
    return (
      value instanceof JavaArray &&
      isWidening({ kind: 'array', element: value.elementType }, elementType, frame.runtime.builtins.objectClass)
    );
  }
  return true;
}

/** This environment implements only part of the standard library, so the message states only what it has. */
function missingFieldMessage(cls: ClassInfo, name: string): string {
  return `この採点環境の ${cls.name} には、フィールド ${name} がありません。`;
}

function notConstant(reference: Reference & { constant?: Value }): Reference & { constant?: Value } {
  return { ...reference, constant: undefined };
}

export function thisValue(context: MethodContext): CompiledValue {
  return { kind: 'value', type: thisTypeOf(context.cls), run: (frame) => frame.thisObject };
}

/** `this` viewed as its superclass, with the type arguments the class gives it. */
export function superValue(context: MethodContext): CompiledValue {
  const superclass = context.cls.superclass as ClassInfo;
  return {
    kind: 'value',
    type: asSuper(thisTypeOf(context.cls), superclass) ?? superclass.type,
    run: (frame) => frame.thisObject,
  };
}

function arrayLengthReference(array: CompiledValue): Reference {
  return {
    type: INT,
    isArrayLength: true,
    bind: (frame) => {
      const value = array.run(frame);
      if (!(value instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
      return {
        get: () => value.values.length,
        set: () => {
          throw new Error('Array length is final');
        },
      };
    },
  };
}

function localReference(context: MethodContext, slot: number): Reference {
  return {
    type: context.locals[slot].type,
    bind: (frame) => ({
      get: () => frame.locals[slot] as Value,
      set: (value) => {
        frame.locals[slot] = value;
      },
    }),
  };
}
