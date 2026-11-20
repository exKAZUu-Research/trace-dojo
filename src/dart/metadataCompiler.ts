import type {
  Annotation,
  Arguments,
  ClassDeclaration,
  Expression,
  ExtensionDeclaration,
  Library,
  TypeParameter,
} from './ast';
import type { ClassInfo } from './classes';
import { at, type Compiled } from './compilerBase';
import { ConstructorCompiler } from './constructorCompiler';
import type { ExtensionInfo } from './environment';
import { Flow, FunctionContext } from './scope';

export abstract class MetadataCompiler extends ConstructorCompiler {
  private readonly typeAnnotationVisits = new WeakSet<readonly TypeParameter[]>();
  private pendingTypeAnnotations: (() => void)[] | undefined = [];

  protected checkDeclarationAnnotations(
    syntax: Library,
    classes: readonly { cls: ClassInfo; declaration: ClassDeclaration }[],
    extensions: readonly { ext: ExtensionInfo; declaration: ExtensionDeclaration }[]
  ): void {
    if (this.isLibraryCode) return;
    this.inTemporaryFunction(true, undefined, () => this.checkTopLevelAnnotations(syntax));
    for (const { cls, declaration } of classes) {
      this.inAnnotationScope(cls, undefined, () => {
        this.checkTypeParameterAnnotations(declaration.typeParameters);
        for (const member of declaration.members) this.checkMemberAnnotations(member);
        for (const value of declaration.enumConstants) this.checkAnnotations(value.annotations);
      });
    }
    for (const { ext, declaration } of extensions) {
      this.inAnnotationScope(undefined, ext, () => {
        this.checkTypeParameterAnnotations(declaration.typeParameters);
        for (const member of declaration.members) this.checkMemberAnnotations(member);
      });
    }
  }

  private checkTopLevelAnnotations(syntax: Library): void {
    for (const declaration of syntax.declarations) {
      this.checkAnnotations(declaration.annotations);
      if (declaration.kind === 'function' || declaration.kind === 'typeAlias')
        this.checkTypeParameterAnnotations(declaration.typeParameters);
      if (declaration.kind === 'function' && !declaration.body) this.checkParameterAnnotations(declaration.parameters);
    }
  }

  private checkMemberAnnotations(member: ClassDeclaration['members'][number]): void {
    this.checkAnnotations(member.annotations);
    if (member.kind === 'method') this.checkTypeParameterAnnotations(member.typeParameters);
    if (member.kind === 'constructor' && !member.body) this.checkParameterAnnotations(member.parameters);
  }

  private inAnnotationScope(cls: ClassInfo | undefined, ext: ExtensionInfo | undefined, run: () => void): void {
    this.inDeclarationScope(cls, ext, () => this.inTemporaryFunction(true, cls, run));
  }

  protected inDeclarationScope<T>(cls: ClassInfo | undefined, ext: ExtensionInfo | undefined, run: () => T): T {
    const savedClass = this.currentClass;
    const savedExtension = this.currentExtension;
    this.currentClass = cls;
    this.currentExtension = ext;
    try {
      return run();
    } finally {
      this.currentClass = savedClass;
      this.currentExtension = savedExtension;
    }
  }

  protected checkDeferredFunctionTypeAnnotations(): void {
    const checks = this.pendingTypeAnnotations;
    this.pendingTypeAnnotations = undefined;
    for (const check of checks ?? []) check();
  }

  protected checkFunctionTypeAnnotations(parameters: readonly TypeParameter[]): void {
    if (this.isLibraryCode || !parameters.some((parameter) => parameter.annotations?.length)) return;
    if (this.typeAnnotationVisits.has(parameters)) return;
    this.typeAnnotationVisits.add(parameters);
    if (this.pendingTypeAnnotations) {
      const { currentClass, currentExtension } = this;
      this.pendingTypeAnnotations.push(() =>
        this.inAnnotationScope(currentClass, currentExtension, () => this.checkTypeParameterAnnotations(parameters))
      );
      return;
    }
    this.checkTypeParameterAnnotations(parameters);
  }

  protected checkAnnotations(annotations: Annotation[] | undefined): void {
    if (this.isLibraryCode || !annotations) return;
    for (const annotation of annotations) {
      const value = this.withConstContext(true, () =>
        annotation.arguments
          ? this.compileAnnotationConstruction(annotation, annotation.arguments)
          : this.compileAnnotationReference(annotation)
      );
      if (!value?.isConst) this.error(annotation, '注釈には定数か const コンストラクタを書いてください。');
      this.checkConstant(annotation, value);
    }
  }

  private compileAnnotationConstruction(annotation: Annotation, args: Arguments): Compiled {
    const span = at(annotation);
    const [head, ...tail] = annotation.names;
    const prefix = this.library.hasPrefix(head) ? head : undefined;
    const name = prefix ? tail.shift() : head;
    if (!name || tail.length > 1) return this.error(annotation, '注釈には const コンストラクタを書いてください。');
    return this.compileNew(
      {
        ...span,
        kind: 'new',
        type: { ...span, kind: 'named', name, prefix, args: annotation.typeArguments, nullable: false },
        constructorName: tail[0],
        arguments: args,
        isConst: true,
        isSelectorCall: false,
      },
      undefined
    );
  }

  private compileAnnotationReference(annotation: Annotation): Compiled | undefined {
    const name = annotation.names.at(-1);
    if (name === undefined) return undefined;
    const qualifiers = annotation.names.slice(0, -1);
    if (qualifiers.length === 0) return this.compileUnqualifiedAnnotation(name, annotation);
    if (qualifiers.length > 2) return undefined;
    const first: Expression = { ...at(annotation), kind: 'identifier', name: qualifiers[0] };
    const target = this.staticTarget(
      qualifiers.length === 1
        ? first
        : { ...at(annotation), kind: 'member', object: first, name: qualifiers[1], nullAware: false }
    );
    if (target?.kind === 'prefix') {
      const declaration = this.library.lookupPrefixed(target.prefix, name);
      return declaration?.kind === 'variable' ? this.readDeclaration(declaration, annotation) : undefined;
    }
    const member = target?.kind === 'class' ? target.cls.staticMembers.get(name) : target?.ext.staticMembers.get(name);
    return member?.kind === 'field' ? this.readStatic(member, annotation) : undefined;
  }

  private compileUnqualifiedAnnotation(name: string, annotation: Annotation): Compiled | undefined {
    const resolution = this.resolveName(name, annotation);
    if (resolution?.kind === 'local' && resolution.variable.options.isConst)
      return this.readLocal(resolution.variable, annotation);
    if (resolution?.kind === 'declaration' && resolution.declaration.kind === 'variable')
      return this.readDeclaration(resolution.declaration, annotation);
    if (resolution?.kind === 'staticMember' && resolution.member.kind === 'field')
      return this.readStatic(resolution.member, annotation);
    return undefined;
  }

  /** Runs `run` in a function context of its own, as initializers compile outside any function. */
  protected inTemporaryFunction<T>(
    isStatic: boolean,
    cls: ClassInfo | undefined,
    run: () => T,
    isInitializer = false
  ): T {
    const savedFn = this.fn;
    const savedFlow = this.flow;
    const savedRecords = this.recordsSteps;
    const info = this.newFunctionInfo('initializer', undefined, false);
    this.fn = new FunctionContext(undefined, info, {
      returnType: undefined,
      isGenerator: false,
      thisClass: cls,
      thisType: cls?.thisType,
      hasThis: !isStatic && !isInitializer && cls !== undefined,
      extensionOn: undefined,
      isInitializer,
      isConstructor: false,
    });
    this.flow = Flow.start();
    try {
      return run();
    } finally {
      this.fn = savedFn;
      this.flow = savedFlow;
      this.recordsSteps = savedRecords;
    }
  }
}
