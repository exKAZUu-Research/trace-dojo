// code-gauge-allow-file fileNcss -- The statementBinder module keeps one stage of the C# interpreter together.
import type {
  Block,
  Expression,
  MethodDeclaration,
  Position,
  Statement,
  SwitchLabel,
  SwitchSection,
  VariableDeclarator,
} from './ast';
import { markOverflowChecks, type TypeContext, unavailableDotnetNamespace } from './binderBase';
import type {
  BoundBlock,
  BoundCatch,
  BoundExpression,
  BoundLValue,
  BoundStatement,
  BoundSwitchSection,
  ForeachKind,
  StepKind,
} from './bound';
import { LabelSymbol } from './bound';
import type { BindContext } from './convertBinder';
import { constantText } from './convertBinder';
import type { MemberLookup } from './lookup';
import { propertyDisplay } from './memberBinder';
import { PatternBinder } from './patternBinder';
import type { Space } from './patternSpace';
import { TRANSPARENT_PREFIX } from './queries';
import { FunctionScope, LocalScope, type PendingSwitch } from './scopes';
import {
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  type FieldSymbol,
  isReferenceType,
  isValueType,
  LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  nullableUnderlying,
  type ParameterSymbol,
  type PropertySymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
  type TypeSymbol,
  VOID_TYPE,
} from './types';
import { isVariable } from './variables';

/** What the earlier labels of a switch have covered. */
interface SwitchLabelsSeen {
  constants: unknown[];
  hasDefault: boolean;
  /** The values that the earlier unguarded case labels surely match. */
  handled: Space;
}

/** The built-in types that have literals, which may be constants and which learners write down in a trace. */
const LITERAL_TYPES = new Set<string>([
  'bool',
  'char',
  'sbyte',
  'byte',
  'short',
  'ushort',
  'int',
  'uint',
  'long',
  'ulong',
  'float',
  'double',
  'decimal',
  'string',
]);

/** The modifiers a local function may have. */
const LOCAL_FUNCTION_MODIFIERS = new Set(['static', 'async', 'unsafe', 'extern']);

/** Binds statements and the storage that assignments write. */
export abstract class StatementBinder extends PatternBinder {
  /** Binds a constant field's initializer once, detecting constants that depend on themselves. */
  protected abstract constantValueOf(field: FieldSymbol): unknown;

  protected constantField(field: FieldSymbol, type: Type, position: Position): BoundExpression {
    const value = this.constantValueOf(field);
    return { kind: 'constant', value, type, row: position.row };
  }

  protected rejectUnavailableName(name: string, position: Position): void {
    const simple = name.slice(name.lastIndexOf('.') + 1);
    const unavailable = this.unavailableType(name, simple) ?? unavailableDotnetNamespace(name.split('.'));
    if (unavailable) this.unsupported(position, unavailable);
  }

  declareLocal(name: string, type: Type, position: Position, context: BindContext): LocalSymbol {
    const { scope } = context;
    if (scope.variables.has(name) || scope.localFunctions.has(name)) {
      this.error(
        position,
        'CS0128',
        `'${name}' という名前のローカル変数または関数はこのスコープで既に定義されています`
      );
    } else if (scope.isDeclaredOutside(name)) {
      this.error(
        position,
        'CS0136',
        `ローカルまたはパラメーター '${name}' は、その名前が外側のローカルのスコープでローカルやパラメーターの定義に使用されているため、このスコープでは宣言できません`
      );
    }
    const local = new LocalSymbol(name, type, position.row, position.column);
    context.fn.addLocal(local);
    scope.variables.set(name, local);
    scope.locals.push(local);
    scope.declaredLater.delete(name);
    return local;
  }

  /** Reports CS1654 for a member of a struct that a readonly local, such as a foreach variable, holds. */
  private reportsReadonlyLocalMember(receiver: BoundExpression, position: Position): boolean {
    let holder = receiver;
    while (holder.kind === 'field' && isValueType(holder.type)) holder = holder.receiver;
    if (holder.kind !== 'local' || !holder.local.isReadonly || !isValueType(holder.type)) return false;
    const reason = holder.local.readonlyReason;
    this.error(position, 'CS1654', `'${holder.local.name}' のメンバーは '${reason}' であるため変更できません`);
    return true;
  }

  // code-gauge-allow functionNcss -- Each kind of storage has its own rule for assignment.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  checkAssignable(
    target: BoundExpression,
    position: Position,
    context: BindContext,
    use: 'assign' | 'ref' | 'out' | 'compound' | 'initializer'
  ): BoundLValue {
    switch (target.kind) {
      case 'implicitIndex': {
        this.checkAssignable(target.access, position, context, use);
        return target;
      }
      case 'local': {
        const { local } = target;
        if (local.isReadonly) {
          this.error(
            position,
            'CS1656',
            `'${local.name}' は '${local.readonlyReason}' であるため、これに割り当てることはできません`
          );
        }
        return target;
      }
      case 'field': {
        this.checkReadonlyField(target.field, context, position);
        if (this.reportsReadonlyLocalMember(target.receiver, position)) return target;
        const holder = target.receiver;
        if (
          (holder.kind === 'field' || holder.kind === 'staticField') &&
          holder.field.isReadonly &&
          isValueType(holder.field.type) &&
          !this.canAssignReadonly(holder.field, context)
        ) {
          this.error(
            position,
            'CS1648',
            `読み取り専用フィールド '${displayTypeSymbol(holder.field.owner)}.${holder.field.name}' のメンバーは変更できません (コンストラクターまたは変数初期化子では可)`
          );
          return target;
        }
        if (
          target.receiver.type.kind === 'named' &&
          target.receiver.type.symbol.isValueType &&
          !isVariable(target.receiver, false) &&
          use !== 'initializer'
        ) {
          this.error(
            position,
            'CS1612',
            `変数ではないため、'${this.describeValue(target.receiver)}' の戻り値を変更できません`
          );
        }
        return target;
      }
      case 'staticField': {
        this.checkReadonlyField(target.field, context, position);
        return target;
      }
      case 'element': {
        return target;
      }
      case 'property': {
        return this.checkPropertyAssignable(target, position, context, use);
      }
      case 'this': {
        // A struct's `this` is a variable in its constructors, and in its other members unless the struct is readonly.
        if (
          target.type.kind === 'named' &&
          target.type.symbol.kind === 'struct' &&
          (context.fn.method.kind === 'constructor' || !target.type.symbol.isReadonly)
        )
          return target;
        this.error(position, 'CS1604', "読み取り専用であるため 'this' に割り当てできません");
        return { kind: 'discard', type: ERROR_TYPE, row: position.row };
      }
      default: {
        if (target.type.kind !== 'error') this.reportNotAssignable(position, use);
        return { kind: 'discard', type: ERROR_TYPE, row: position.row };
      }
    }
  }

  private checkPropertyAssignable(
    target: Extract<BoundExpression, { kind: 'property' }>,
    position: Position,
    context: BindContext,
    use: string
  ): BoundLValue {
    const { property } = target;
    const declared = this.setterOf(property);
    // A library property's private setter stands for .NET's explicit IList<T> indexer, which leaves it read-only.
    const setter = declared?.access === 'private' && property.owner.isLibrary ? undefined : declared;
    const display = propertyDisplay(target);
    if (!setter) {
      if (property.backingField && !property.isStatic && this.isInConstructorOf(property, context)) {
        return {
          kind: 'field',
          receiver: target.receiver as BoundExpression,
          field: property.backingField,
          type: target.type,
          row: target.row,
        };
      }
      if (
        property.backingField &&
        property.isStatic &&
        context.fn.method.kind === 'staticConstructor' &&
        context.fn.method.owner === property.owner
      ) {
        return {
          kind: 'staticField',
          field: property.backingField,
          owner: target.owner,
          type: target.type,
          row: target.row,
        };
      }
      this.error(
        position,
        'CS0200',
        `プロパティまたはインデクサー '${display}' は読み取り専用であるため、割り当てることはできません`
      );
      return { kind: 'discard', type: ERROR_TYPE, row: position.row };
    }
    if (property.isInitOnly && use !== 'initializer' && !this.isInConstructorOf(property, context)) {
      this.error(
        position,
        'CS8852',
        `init 専用プロパティまたはインデクサー '${display}' を割り当てることができるのは、オブジェクト初期化子の中か、インスタンス コンストラクターまたは 'init' アクセサーの 'this' か 'base' 上のみです。`
      );
    }
    this.checkAccessorUse(target, property, setter, 'set', position, context);
    if (target.receiver && this.reportsReadonlyLocalMember(target.receiver, position)) return target as BoundLValue;
    if (
      target.receiver &&
      target.receiver.type.kind === 'named' &&
      target.receiver.type.symbol.isValueType &&
      !isVariable(target.receiver, false) &&
      use !== 'initializer'
    ) {
      this.error(
        position,
        'CS1612',
        `変数ではないため、'${this.describeValue(target.receiver)}' の戻り値を変更できません`
      );
    }
    return target;
  }

  private setterOf(property: PropertySymbol): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden)
      if (current.setter) return current.setter;
    return undefined;
  }

  private isInConstructorOf(property: PropertySymbol, context: BindContext): boolean {
    const method = context.fn.method;
    return (
      (method.kind === 'constructor' ||
        method.kind === 'staticConstructor' ||
        (method.kind === 'setter' && method.property?.isInitOnly === true)) &&
      method.owner === property.owner &&
      context.fn.kind !== 'lambda'
    );
  }

  private checkReadonlyField(field: FieldSymbol, context: BindContext, position: Position): void {
    if (field.isConst) {
      this.error(position, 'CS0131', '代入式の左辺には変数、プロパティ、またはインデクサーを指定してください');
      return;
    }
    if (!field.isReadonly) return;
    if (!this.canAssignReadonly(field, context)) {
      if (field.isStatic)
        this.error(
          position,
          'CS0198',
          '静的読み取り専用フィールドへの割り当てはできません (静的コンストラクターまたは変数初期化子では可)'
        );
      else
        this.error(
          position,
          'CS0191',
          '読み取り専用フィールドに割り当てることはできません (フィールドが定義されている型のコンストラクターか init 専用セッター、または変数初期化子では可)'
        );
    }
  }

  /** Whether code may assign a readonly field: in its type's constructor, init accessor, or field initializer. */
  private canAssignReadonly(field: FieldSymbol, context: BindContext): boolean {
    const method = context.fn.method;
    const inConstructor =
      (field.isStatic
        ? method.kind === 'staticConstructor'
        : method.kind === 'constructor' || (method.kind === 'setter' && method.property?.isInitOnly === true)) &&
      method.owner === field.owner &&
      context.fn.kind !== 'lambda';
    return inConstructor || context.fn.kind === 'initializer';
  }

  private describeValue(expression: BoundExpression): string {
    if (expression.kind === 'property') {
      const { property, owner } = expression;
      return property.isIndexer
        ? `${displayTypeSymbol(owner.symbol, owner.args)}.this[${property.parameters.map((parameter) => displayType(substitute(parameter.type, substitutionOf(owner)))).join(', ')}]`
        : `${displayTypeSymbol(owner.symbol, owner.args)}.${property.name}`;
    }
    if (expression.kind === 'call')
      return `${displayTypeSymbol(expression.method.owner)}.${expression.method.name}(${expression.method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})`;
    return displayType(expression.type);
  }

  private reportNotAssignable(position: Position, use: 'assign' | 'ref' | 'out' | 'compound' | 'initializer'): void {
    if (use === 'ref' || use === 'out')
      this.error(position, 'CS1510', 'ref または out 値は、割り当て可能な変数でなければなりません');
    else this.error(position, 'CS0131', '代入式の左辺には変数、プロパティ、またはインデクサーを指定してください');
  }

  bindLValue(node: Expression, context: BindContext, use: 'assign' | 'ref' | 'out' | 'compound'): BoundLValue {
    if (
      node.kind === 'name' &&
      node.name === '_' &&
      !context.scope.lookup('_') &&
      (use === 'assign' || use === 'out')
    ) {
      return { kind: 'discard', type: ERROR_TYPE, row: node.row };
    }
    const bound = this.bindExpression(node, context);
    if (bound.kind === 'methodGroup') {
      this.error(node, 'CS1656', `'${bound.name}' は 'メソッド グループ' であるため、これに割り当てることはできません`);
      return { kind: 'discard', type: ERROR_TYPE, row: node.row };
    }
    const value = this.toValue(bound, node);
    if ((use === 'ref' || use === 'out') && value.kind === 'property') {
      this.error(
        node,
        'CS0206',
        '参照を返さないプロパティまたはインデクサーを out 値または ref 値として使用することはできません'
      );
      return { kind: 'discard', type: ERROR_TYPE, row: node.row };
    }
    if (use === 'compound') this.checkReadable(value, node, context);
    return this.checkAssignable(value, node, context, use);
  }

  /** Binds the body of a member, lambda, or local function in its own scope. */
  protected bindFunctionBlock(block: Block, context: BindContext): BoundBlock {
    return this.bindBlock(block, context, false);
  }

  /** Binds a block, whose locals and local functions are in scope throughout it. */
  bindBlock(block: Block, context: BindContext, newScope = true): BoundBlock {
    const scope = newScope ? new LocalScope(context.scope, context.fn) : context.scope;
    const inner: BindContext = { scope, fn: context.fn };
    this.predeclare(block.statements, inner);
    const statements = this.bindStatements(block.statements, inner);
    return { kind: 'block', statements, capturedLocals: [], locals: scope.locals, row: block.row, step: 'none' };
  }

  /**
   * Binds a while, do, or foreach loop in a scope of its own, which the variables its condition or collection
   * declares (`out int x`) belong to, as C# declares them; a block around the loop drops them when the loop ends.
   */
  private inLoopScope(context: BindContext, row: number, bind: (inner: BindContext) => BoundStatement): BoundStatement {
    const scope = new LocalScope(context.scope, context.fn);
    const loop = bind({ scope, fn: context.fn });
    if (scope.locals.length === 0) return loop;
    return { kind: 'block', statements: [loop], capturedLocals: [], locals: scope.locals, row, step: 'none' };
  }

  /** Makes a block's names known from its start: local functions to call, and locals that may not be used before their declarations. */
  protected predeclare(statements: Statement[], context: BindContext, labelScope = context.scope): void {
    this.declareLabels(statements, labelScope);
    for (const statement of statements) {
      for (const name of namesDeclaredInBlock(statement)) context.scope.declaredLater.add(name);
      if (statement.kind === 'localFunction') this.declareLocalFunction(statement.declaration, context);
    }
  }

  /** Declares the labels of a block's statements, reporting one that the block or an enclosing block already has. */
  private declareLabels(statements: Statement[], scope: LocalScope): void {
    for (let statement of statements) {
      while (statement.kind === 'labeled') {
        const { label } = statement;
        const duplicate = [...scope.chain()].some((outer) => outer.owner === scope.owner && outer.labels.has(label));
        if (duplicate && scope.labels.has(label)) this.error(statement, 'CS0140', `ラベル '${label}' が重複しています`);
        else if (duplicate)
          this.error(statement, 'CS0158', `ラベル '${label}' は、同じ名前を持つ外側のラベルをシャドウします`);
        else scope.labels.set(label, new LabelSymbol(label, statement.row));
        statement = statement.statement;
      }
    }
  }

  /**
   * Binds a block's statements. A `using` declaration disposes its variables when the block ends, so the statements
   * after it form the body that it disposes them after, as `using (...) { rest }` would (C# spec §13.14).
   */
  protected bindStatements(statements: Statement[], context: BindContext): BoundStatement[] {
    const index = statements.findIndex((statement) => statement.kind === 'localDeclaration' && statement.using);
    if (index === -1) return statements.map((statement) => this.bindStatement(statement, context));
    const declaration = statements[index] as Extract<Statement, { kind: 'localDeclaration' }>;
    const before = statements.slice(0, index).map((statement) => this.bindStatement(statement, context));
    const resources = this.bindUsingResources(
      { kind: 'declaration', type: declaration.type, declarators: declaration.declarators },
      declaration,
      context
    );
    const rest = statements.slice(index + 1);
    const restRow = rest[0]?.row ?? declaration.row;
    const body: BoundBlock = {
      kind: 'block',
      statements: this.bindStatements(rest, context),
      capturedLocals: [],
      locals: [],
      row: restRow,
      step: 'none',
    };
    return [...before, ...this.nestUsings(resources, body)];
  }

  private bindUsingStatement(statement: Extract<Statement, { kind: 'using' }>, context: BindContext): BoundStatement {
    const scope = new LocalScope(context.scope, context.fn);
    const inner: BindContext = { scope, fn: context.fn };
    const resources = this.bindUsingResources(statement.resource, statement, inner);
    const body = this.bindEmbedded(statement.body, inner);
    return {
      kind: 'block',
      statements: this.nestUsings(resources, body),
      capturedLocals: [],
      locals: scope.locals,
      row: statement.row,
      step: 'none',
    };
  }

  /** Binds the resources of a `using` statement or declaration: each declared variable, or a hidden one for a value. */
  private bindUsingResources(
    resource: Extract<Statement, { kind: 'using' }>['resource'],
    position: Position,
    context: BindContext
  ): { declaration: BoundStatement; local: LocalSymbol }[] {
    if (resource.kind === 'expression') {
      const value = this.bindTypedValue(resource.value, context);
      const local = new LocalSymbol('\0using', value.type, position.row, position.column);
      local.isHidden = true;
      context.fn.addLocal(local);
      this.checkDisposable(value.type, resource.value);
      return [{ declaration: { kind: 'localDeclaration', local, value, row: position.row, step: 'callsOnly' }, local }];
    }
    return resource.declarators.map((declarator) => {
      if (!declarator.initializer)
        this.error(declarator, 'CS0210', 'fixed または using ステートメントの宣言の中に、初期化子を指定してください');
      const declaration = this.bindLocalDeclaration(
        { kind: 'localDeclaration', isConst: false, type: resource.type, declarators: [declarator], ...position },
        context
      );
      const local = context.scope.variables.get(declarator.name) as LocalSymbol;
      local.isReadonly = true;
      local.readonlyReason = 'using 変数';
      this.checkDisposable(local.type, declarator);
      return { declaration: { ...declaration, row: declarator.row }, local };
    });
  }

  /** Reports a resource type that converts to no `IDisposable`, which `using` needs to dispose it. */
  private checkDisposable(type: Type, position: Position): void {
    if (type.kind === 'error' || type.kind === 'null') return;
    const disposable = this.library.typeNamed('System.IDisposable').declaredType;
    if (this.conversions.implicit(type, disposable) !== undefined) return;
    this.error(
      position,
      'CS1674',
      `'${displayType(type)}': using ステートメントで使用される型は 'System.IDisposable' を実装する必要があります。`
    );
  }

  /** The declarations of the resources, each followed by the `using` that disposes it after the rest. */
  private nestUsings(
    resources: { declaration: BoundStatement; local: LocalSymbol }[],
    body: BoundStatement
  ): BoundStatement[] {
    let inner: BoundStatement[] = [body];
    for (const { declaration, local } of resources.toReversed()) {
      const disposable = this.library.typeNamed('System.IDisposable');
      inner = [
        declaration,
        {
          kind: 'using',
          local,
          body:
            inner.length === 1
              ? inner[0]
              : { kind: 'block', statements: inner, capturedLocals: [], locals: [], row: body.row, step: 'none' },
          dispose: disposable.methods.find((method) => method.name === 'Dispose') as MethodSymbol,
          disposable: disposable.declaredType,
          row: declaration.row,
          step: 'none',
        },
      ];
    }
    return inner;
  }

  // code-gauge-allow functionNcss -- One case per kind of statement.
  bindStatement(statement: Statement, context: BindContext): BoundStatement {
    const row = statement.row;
    switch (statement.kind) {
      case 'block': {
        return this.bindBlock(statement, context);
      }
      case 'empty': {
        return { kind: 'empty', row, step: 'none' };
      }
      case 'expression': {
        return this.bindExpressionStatement(statement, context);
      }
      case 'localDeclaration': {
        return this.bindLocalDeclaration(statement, context);
      }
      case 'deconstruction': {
        return this.bindDeconstruction(statement, context);
      }
      case 'localFunction': {
        this.bindLocalFunctionBody(statement.declaration, context);
        return { kind: 'empty', row, step: 'none' };
      }
      case 'if': {
        const condition = this.bindCondition(statement.condition, context);
        const consequence = this.bindEmbedded(statement.consequence, context);
        const alternative = statement.alternative ? this.bindEmbedded(statement.alternative, context) : undefined;
        return { kind: 'if', condition, consequence, alternative, row, step: 'none' };
      }
      case 'while': {
        return this.inLoopScope(context, row, (inner) => {
          const condition = this.bindCondition(statement.condition, inner);
          const body = this.inLoop(inner, () => this.bindEmbedded(statement.body, inner));
          return { kind: 'while', condition, body, row, step: 'none' };
        });
      }
      case 'do': {
        return this.inLoopScope(context, row, (inner) => {
          const body = this.inLoop(inner, () => this.bindEmbedded(statement.body, inner));
          const condition = this.bindCondition(statement.condition, inner);
          return { kind: 'do', body, condition, conditionRow: statement.conditionRow, row, step: 'none' };
        });
      }
      case 'for': {
        return this.bindFor(statement, context);
      }
      case 'foreach': {
        // The collection expression's declarations belong to the loop, as the iteration variable does.
        return this.inLoopScope(context, row, (inner) => this.bindForeach(statement, inner));
      }
      case 'switch': {
        return this.bindSwitch(statement, context);
      }
      // A `break` or `continue` outside a loop jumps nowhere, so the statements after it stay reachable for the
      // flow analysis, as in Roslyn.
      case 'break': {
        if (context.fn.breakDepth > 0) return { kind: 'break', row, step: 'none' };
        this.error(statement, 'CS0139', 'break または continue に対応するループがありません');
        return { kind: 'empty', row, step: 'none' };
      }
      case 'continue': {
        if (context.fn.continueDepth > 0) return { kind: 'continue', row, step: 'none' };
        this.error(statement, 'CS0139', 'break または continue に対応するループがありません');
        return { kind: 'empty', row, step: 'none' };
      }
      case 'return': {
        return this.bindReturn(statement, context);
      }
      case 'throw': {
        return this.bindThrowStatement(statement, context);
      }
      case 'try': {
        return this.bindTry(statement, context);
      }
      case 'labeled': {
        const label = this.findLabel(statement.label, context) as LabelSymbol;
        return {
          kind: 'labeled',
          label,
          statement: this.bindStatement(statement.statement, context),
          row,
          step: 'none',
        };
      }
      case 'goto': {
        return this.bindGoto(statement, context);
      }
      case 'lock': {
        return this.bindLock(statement, context);
      }
      case 'checked': {
        return this.inCheckedContext(statement.isChecked, () => this.bindBlock(statement.body, context));
      }
      case 'using': {
        return this.bindUsingStatement(statement, context);
      }
    }
  }

  /** The label of a name that a `goto` in the context may jump to: one of its block's or an enclosing block's. */
  private findLabel(name: string, context: BindContext): LabelSymbol | undefined {
    for (const scope of context.scope.chain()) {
      if (scope.owner !== context.fn) return undefined;
      const label = scope.labels.get(name);
      if (label) return label;
    }
    return undefined;
  }

  private bindGoto(statement: Extract<Statement, { kind: 'goto' }>, context: BindContext): BoundStatement {
    const { row, target } = statement;
    const missing = (text: string): BoundStatement => {
      this.error(
        target.kind === 'case' ? target.value : { row, column: statement.column + 5 },
        'CS0159',
        `goto ステートメントのスコープに '${text}' というラベルはありません`
      );
      return { kind: 'empty', row, step: 'none' };
    };
    if (context.fn.finallyDepth > 0) this.error(statement, 'CS0157', 'コントロールが finally 句の本体から出られません');
    if (target.kind === 'label') {
      const label = this.findLabel(target.name, context);
      if (!label) return missing(target.name);
      label.isUsed = true;
      return { kind: 'goto', target: label, row, step: 'none' };
    }
    const pending = context.fn.switches.at(-1);
    if (!pending) {
      this.error(statement, 'CS0153', 'goto は switch ステートメント内でのみ有効です');
      return { kind: 'empty', row, step: 'none' };
    }
    const bound: Extract<BoundStatement, { kind: 'goto' }> = { kind: 'goto', target: undefined, row, step: 'none' };
    if (target.kind === 'default') {
      pending.gotos.push({ statement: bound, value: undefined, row, text: 'default:' });
      return bound;
    }
    const value = this.bindAs(target.value, pending.governingType, context);
    if (value.kind !== 'constant') {
      if (value.type.kind !== 'error') this.error(target.value, 'CS0150', '定数値が必要です');
      return { kind: 'empty', row, step: 'none' };
    }
    pending.gotos.push({
      statement: bound,
      value: value.value,
      row: target.value.row,
      text: `case ${labelText(value.value, value.type)}:`,
    });
    return bound;
  }

  private bindLock(statement: Extract<Statement, { kind: 'lock' }>, context: BindContext): BoundStatement {
    const value = this.bindTypedValue(statement.value, context);
    if (value.type.kind !== 'error' && !isReferenceType(value.type) && value.type.kind !== 'null')
      this.error(
        statement.value,
        'CS0185',
        `'${displayType(value.type)}' は lock ステートメントによって要求された参照型ではありません`
      );
    const body = this.bindEmbedded(statement.body, context);
    return { kind: 'lock', value, body, row: statement.row, step: 'none' };
  }

  private bindExpressionStatement(
    statement: Extract<Statement, { kind: 'expression' }>,
    context: BindContext
  ): BoundStatement {
    this.unusedValue = statement.expression;
    const expression = this.bindValue(statement.expression, context);
    // `new();` creates an object, which a statement may do, of no type that Roslyn can find (CS8754); any other value
    // without a type is no statement (CS0201).
    if (expression.kind === 'unbound' && expression.node.kind === 'implicitNew') {
      const created = this.typedValue(expression, statement.expression);
      return { kind: 'expression', expression: created, row: statement.row, step: 'none' };
    }
    const resolved =
      expression.kind === 'unbound'
        ? this.convert(expression, this.naturalTypeOf(expression) ?? ERROR_TYPE, statement)
        : expression;
    this.requireStatementExpression(resolved, statement.expression);
    return { kind: 'expression', expression: resolved, row: statement.row, step: this.expressionStepKind(resolved) };
  }

  private bindDeconstruction(
    statement: Extract<Statement, { kind: 'deconstruction' }>,
    context: BindContext
  ): BoundStatement {
    const { row } = statement;
    const value = this.deconstructedValue(statement.value, context);
    const target = this.declareDeconstructed(statement.designation, undefined, value.type, context);
    const expression: BoundExpression = { kind: 'deconstructAssign', targets: target, value, type: VOID_TYPE, row };
    return { kind: 'expression', expression, row, step: 'step' };
  }

  private bindThrowStatement(statement: Extract<Statement, { kind: 'throw' }>, context: BindContext): BoundStatement {
    const { row } = statement;
    if (!statement.value) {
      if (context.fn.catchDepth === 0)
        this.error(statement, 'CS0156', '引数なしの throw ステートメントは catch 句以外では使えません');
      return { kind: 'throw', value: undefined, row, step: 'none' };
    }
    return {
      kind: 'throw',
      value: this.bindThrowValue(statement.value, context, statement.value),
      row,
      step: 'none',
    };
  }

  /** How an expression statement records its step: one that only calls or creates objects may leave it to its calls. */
  private expressionStepKind(expression: BoundExpression): StepKind {
    // C# removes a call of a partial method without an implementation, so it records no step.
    if (expression.kind === 'call' && expression.method.isRemovedPartial) return 'none';
    if (expression.kind === 'call' || expression.kind === 'invokeDelegate' || expression.kind === 'new')
      return 'callsOnly';
    if (
      expression.kind === 'conditionalAccess' &&
      (expression.access.kind === 'call' || expression.access.kind === 'invokeDelegate')
    )
      return 'callsOnly';
    if (expression.kind === 'assign' && isObjectCreation(expression.value)) return 'callsOnly';
    return 'step';
  }

  /** Binds the statement of an `if`, a loop, or `else`, which has its own scope for the variables its expressions declare. */
  private bindEmbedded(statement: Statement, context: BindContext): BoundStatement {
    const scope = new LocalScope(context.scope, context.fn);
    const bound = this.bindStatement(statement, { scope, fn: context.fn });
    if (statement.kind === 'expression' && bound.kind === 'expression' && bound.expression.kind === 'assign' && false)
      return bound;
    if (scope.locals.length === 0) return bound;
    return {
      kind: 'block',
      statements: [bound],
      capturedLocals: [],
      locals: scope.locals,
      row: statement.row,
      step: 'none',
    };
  }

  private inLoop<T>(context: BindContext, bind: () => T): T {
    context.fn.breakDepth++;
    context.fn.continueDepth++;
    try {
      return bind();
    } finally {
      context.fn.breakDepth--;
      context.fn.continueDepth--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindLocalDeclaration(
    statement: Extract<Statement, { kind: 'localDeclaration' }>,
    context: BindContext
  ): BoundStatement {
    const isVar = statement.type.kind === 'varType' && !this.findTypeInScope('var', 0, context.fn.typeContext);
    if (isVar && statement.declarators.length > 1) {
      this.error(statement, 'CS0819', '暗黙的に型指定された変数は、複数の宣言子を持つことができません');
    }
    if (isVar && statement.isConst)
      this.error(statement, 'CS0822', '暗黙的に型指定された変数を定数にすることはできません');
    const declaredType = isVar ? undefined : this.resolveType(statement.type, context.fn.typeContext);
    const statements: BoundStatement[] = statement.declarators.map((declarator) =>
      this.bindDeclarator(declarator, declaredType, statement.isConst, context)
    );
    const hasInitializer = statement.declarators.some((declarator) => declarator.initializer !== undefined);
    if (!hasInitializer)
      return {
        kind: 'block',
        statements,
        capturedLocals: [],
        locals: [],
        row: statement.row,
        step: 'none',
        isDeclarationGroup: true,
      } as BoundBlock;
    const allCreations = statements.every(
      (bound) => bound.kind === 'localDeclaration' && bound.value !== undefined && isObjectCreation(bound.value)
    );
    if (statements.length === 1)
      return {
        ...(statements[0] as BoundStatement),
        row: statement.row,
        step: statement.isConst ? 'none' : allCreations ? 'callsOnly' : 'step',
      } as BoundStatement;
    return {
      kind: 'block',
      statements,
      capturedLocals: [],
      locals: [],
      row: statement.row,
      step: statement.isConst ? 'none' : allCreations ? 'callsOnly' : 'step',
      isDeclarationGroup: true,
    } as BoundBlock;
  }

  private bindDeclarator(
    declarator: VariableDeclarator,
    declaredType: Type | undefined,
    isConst: boolean,
    context: BindContext
  ): BoundStatement {
    const { initializer } = declarator;
    const inferred = declaredType ? { type: declaredType } : this.inferLocalType(declarator, context);
    const { type } = inferred;
    let { value } = inferred;
    if (type.kind === 'named' && type.symbol.isStatic) {
      this.error(declarator, 'CS0723', `スタティック型 '${displayType(type)}' の変数を宣言することはできません`);
    }
    // The variable is in scope in its own initializer, where using it is an error of definite assignment.
    const local = this.declareLocal(declarator.name, type, declarator, context);
    if (initializer && !value) {
      value =
        initializer.kind === 'arrayInitializer'
          ? this.bindArrayInitializer(initializer, type, context)
          : this.bindAs(initializer, type, context);
    }
    if (isConst) this.checkLocalConstant(declarator, local, value, type);
    return { kind: 'localDeclaration', local, value, row: declarator.row, step: 'none' };
  }

  /** The type of an implicitly typed local, from its initializer, which it binds when that gives the type. */
  private inferLocalType(
    declarator: VariableDeclarator,
    context: BindContext
  ): { type: Type; value?: BoundExpression } {
    const { initializer } = declarator;
    if (!initializer) {
      this.error(declarator, 'CS0818', '暗黙的に型指定された変数は初期化される必要があります');
      return { type: ERROR_TYPE };
    }
    if (initializer.kind === 'arrayInitializer') {
      this.error(declarator, 'CS0820', '配列初期化子で暗黙的に型指定された変数を初期化することはできません');
      return { type: ERROR_TYPE };
    }
    const bound = this.bindValue(initializer, context);
    if (bound.type.kind === 'null' && bound.kind !== 'unbound') {
      this.error(declarator, 'CS0815', '<null> を暗黙的に型指定された変数に割り当てることはできません');
      return { type: ERROR_TYPE };
    }
    if (bound.type.kind === 'void') {
      this.error(declarator, 'CS0815', 'void を暗黙的に型指定された変数に割り当てることはできません');
      return { type: ERROR_TYPE };
    }
    if (bound.kind !== 'unbound') return { type: bound.type, value: bound };
    const natural = this.naturalTypeOf(bound);
    if (!natural) {
      this.reportWithoutNaturalType(bound, declarator);
      return { type: ERROR_TYPE };
    }
    return { type: natural, value: this.convert(bound, natural, declarator) };
  }

  protected reportWithoutNaturalType(bound: Extract<BoundExpression, { kind: 'unbound' }>, declarator: Position): void {
    const what = bound.node.kind === 'lambda' || bound.methodGroup ? undefined : bound.node.kind;
    if (what === 'default') this.error(declarator, 'CS8716', "'default' リテラルにターゲット型がありません。");
    else if (what === 'implicitNew') this.error(declarator, 'CS8754', "'new()' のターゲット型がありません");
    else if (what === 'collection') this.error(declarator, 'CS9176', 'コレクション式のターゲット型がありません。');
    else if (what === 'switch') this.error(bound.node, 'CS8506', 'switch 式に最適な型が見つかりませんでした。');
    else if (what === 'conditional') this.reportConditionalWithoutType(bound.node);
    else if (what === 'tuple')
      this.error(declarator, 'CS0815', `(${'?'}) を暗黙的に型指定された変数に割り当てることはできません`);
    else this.error(declarator, 'CS8917', 'デリゲート型を推論できませんでした。');
  }

  private checkLocalConstant(
    declarator: VariableDeclarator,
    local: LocalSymbol,
    value: BoundExpression | undefined,
    type: Type
  ): void {
    local.isConst = true;
    // The parser rejects a constant without a value, so `value` is the initializer's.
    if (value?.kind === 'constant') local.constantValue = value.value;
    else if (value && value.type.kind !== 'error')
      this.error(declarator, 'CS0133', `'${declarator.name}' に割り当てられた式は定数でなければなりません`);
    if (type.kind !== 'error' && !this.isConstantType(type))
      this.error(declarator, 'CS0283', `型 '${displayType(type)}' を const 宣言することはできません`);
  }

  /** Whether a type may be that of a constant. */
  protected isConstantType(type: Type): boolean {
    const special = specialOf(type);
    if (special && LITERAL_TYPES.has(special)) return true;
    if (type.kind === 'named' && type.symbol.kind === 'enum') return true;
    return isReferenceType(type);
  }

  private bindFor(statement: Extract<Statement, { kind: 'for' }>, context: BindContext): BoundStatement {
    const scope = new LocalScope(context.scope, context.fn);
    const inner: BindContext = { scope, fn: context.fn };
    const initializers: BoundStatement[] = [];
    if (statement.initializer?.kind === 'declaration') {
      const declaration = statement.initializer;
      const bound = this.bindLocalDeclaration(
        {
          kind: 'localDeclaration',
          isConst: false,
          type: declaration.type,
          declarators: declaration.declarators,
          row: statement.row,
          column: statement.column,
        },
        inner
      );
      initializers.push(bound);
    } else if (statement.initializer) {
      for (const expression of statement.initializer.expressions) {
        const bound = this.bindValue(expression, inner);
        this.requireStatementExpression(bound, expression);
        initializers.push({ kind: 'expression', expression: bound, row: statement.row, step: 'none' });
      }
    }
    const condition = statement.condition ? this.bindCondition(statement.condition, inner) : undefined;
    const updates = statement.updates.map((update) => {
      const bound = this.bindValue(update, inner);
      this.requireStatementExpression(bound, update);
      return bound;
    });
    const body = this.inLoop(inner, () => this.bindEmbedded(statement.body, inner));
    return {
      kind: 'for',
      initializers,
      condition,
      updates,
      body,
      capturedLocals: [],
      locals: scope.locals,
      row: statement.row,
      step: 'step',
    };
  }

  // code-gauge-allow functionNcss -- How foreach finds its elements: arrays, strings, and the GetEnumerator pattern.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindForeach(statement: Extract<Statement, { kind: 'foreach' }>, context: BindContext): BoundStatement {
    const collection = this.bindTypedValue(statement.collection, context);
    const scope = new LocalScope(context.scope, context.fn);
    const inner: BindContext = { scope, fn: context.fn };
    let iteration: ForeachKind;
    let elementType: Type;
    const type = collection.type;
    if (type.kind === 'error') {
      iteration = { kind: 'array', rank: 1 };
      elementType = ERROR_TYPE;
    } else if (type.kind === 'array') {
      iteration = { kind: 'array', rank: type.rank };
      elementType = type.element;
    } else if (specialOf(type) === 'string') {
      iteration = { kind: 'string' };
      elementType = this.specialType('char');
    } else {
      const found = this.enumeratorPattern(type, statement.collection, inner);
      if (!found) {
        const display = collection.kind === 'unbound' ? 'ラムダ式' : displayType(type);
        this.error(
          statement.collection,
          'CS1579',
          `'${display}' は 'GetEnumerator' のパブリック インスタンスまたは拡張機能の定義を含んでいないため、型 '${display}' の変数に対して foreach ステートメントを使用することはできません`
        );
        iteration = { kind: 'array', rank: 1 };
        elementType = ERROR_TYPE;
      } else {
        iteration = found.iteration;
        elementType = found.elementType;
      }
    }
    const isVar = statement.type.kind === 'varType';
    const declaredType = isVar ? elementType : this.resolveType(statement.type, context.fn.typeContext);
    let variable: LocalSymbol;
    let deconstruction: BoundExpression | undefined;
    let elementConversion: BoundExpression | undefined;
    if (statement.variable.kind === 'parenthesized') {
      variable = new LocalSymbol('\0element', elementType, statement.row, statement.column);
      variable.isHidden = true;
      context.fn.addLocal(variable);
      const targets = this.declareDeconstructed(
        statement.variable,
        isVar ? undefined : declaredType,
        elementType,
        inner
      );
      deconstruction = {
        kind: 'deconstructAssign',
        targets,
        value: { kind: 'local', local: variable, type: elementType, row: statement.row },
        type: VOID_TYPE,
        row: statement.row,
      };
      for (const local of scope.locals) {
        local.isReadonly = true;
      }
    } else if (statement.variable.kind === 'discard') {
      variable = new LocalSymbol('\0element', elementType, statement.row, statement.column);
      variable.isHidden = true;
      context.fn.addLocal(variable);
    } else {
      variable = this.declareLocal(statement.variable.name, declaredType, statement.variable, inner);
      variable.isReadonly = true;
      if (!sameType(declaredType, elementType)) {
        elementConversion = this.convert(
          { kind: 'compoundOperand', type: elementType, row: statement.row },
          declaredType,
          statement,
          'explicit'
        );
      }
    }
    const body = this.inLoop(inner, () => this.bindEmbedded(statement.body, inner));
    const storesAnswer = this.isAnswered(declaredType) || statement.variable.kind === 'parenthesized';
    return {
      kind: 'foreach',
      collection,
      iteration,
      variable,
      deconstruction,
      locals: scope.locals,
      body,
      elementConversion,
      bindingStoresAnswer: storesAnswer,
      row: statement.row,
      step: 'step',
    };
  }

  /**
   * Reports CS0201 for an expression that stands as a statement but is not one that may. An expression that failed to
   * bind is judged by its syntax, as Roslyn does, so that `x.Missing;` reports both errors and `Missing();` one.
   */
  private requireStatementExpression(expression: BoundExpression, node: Expression): void {
    if (expression.type.kind === 'error' ? isStatementSyntax(node) : this.isStatementExpression(expression)) return;
    // An instance compound assignment operator binds to a call followed by the target's value.
    if (expression.kind === 'sequence' && isStatementSyntax(node)) return;
    this.error(
      node,
      'CS0201',
      '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
    );
  }

  /** Whether learners write down a variable's value in a trace: numbers, characters, booleans, and strings. */
  protected isAnswered(type: Type): boolean {
    const special = specialOf(nullableUnderlying(type) ?? type);
    if (special && LITERAL_TYPES.has(special)) return true;
    return type.kind === 'named' && type.symbol.kind === 'enum';
  }

  /**
   * The one resolver of `foreach`'s enumeration pattern (C# spec §13.9.5), whose result the loop's execution follows:
   * a public instance `GetEnumerator()`, else an implemented `IEnumerable`'s; on what it returns, a public instance
   * `bool MoveNext()` and a public instance `Current` with a getter; and disposal through `IDisposable` only.
   */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private enumeratorPattern(
    type: Type,
    position: Position,
    context: BindContext
  ): { iteration: ForeachKind; elementType: Type } | undefined {
    const lookup = (receiverType: Type, name: string): MemberLookup | undefined =>
      this.lookupMember(receiverType, name, context.fn.typeContext).found;
    let getEnumerator = lookup(type, 'GetEnumerator');
    let owner: NamedType | undefined;
    let method: MethodSymbol | undefined;
    if (getEnumerator?.kind === 'methods') {
      const candidate = getEnumerator.candidates.find(
        (option) =>
          option.method.parameters.length === 0 && !option.method.isStatic && option.method.access === 'public'
      );
      if (candidate) {
        method = candidate.method;
        owner = candidate.owner;
      }
    }
    if (!method) {
      const enumerable = this.findImplementedEnumerable(type);
      if (!enumerable) return undefined;
      getEnumerator = lookup(enumerable, 'GetEnumerator');
      if (getEnumerator?.kind !== 'methods') return undefined;
      const candidate = getEnumerator.candidates.find((option) => option.method.parameters.length === 0);
      if (!candidate) return undefined;
      method = candidate.method;
      owner = candidate.owner;
    }
    const enumeratorType = substitute(method.returnType, substitutionOf(owner as NamedType));
    const moveNext = lookup(enumeratorType, 'MoveNext');
    const current = lookup(enumeratorType, 'Current');
    // The pattern reads Current through a public instance getter, so a property without one is no Current for it.
    if (
      moveNext?.kind !== 'methods' ||
      current?.kind !== 'property' ||
      current.property.getter?.access !== 'public' ||
      current.property.isStatic
    ) {
      this.error(position, 'CS0117', `'${displayType(enumeratorType)}' に 'Current' の定義がありません`);
      return undefined;
    }
    // The pattern calls a public instance MoveNext() that returns bool.
    const moveNextMethod = moveNext.candidates.find(
      ({ method: candidate }) =>
        candidate.parameters.length === 0 &&
        !candidate.isStatic &&
        candidate.access === 'public' &&
        specialOf(candidate.returnType) === 'bool'
    )?.method;
    if (!moveNextMethod) {
      this.error(position, 'CS0117', `'${displayType(enumeratorType)}' に 'MoveNext' の定義がありません`);
      return undefined;
    }
    const elementType = substitute(current.property.type, substitutionOf(current.owner));
    const disposable = this.library.typeNamed('System.IDisposable');
    return {
      iteration: {
        kind: 'enumerator',
        getEnumerator: method,
        moveNext: moveNextMethod,
        current: current.property,
        enumeratorType,
        receiverIsStruct: enumeratorType.kind === 'named' && enumeratorType.symbol.isValueType,
        dispose: disposable.methods.find((candidate) => candidate.name === 'Dispose') as MethodSymbol,
        disposable: disposable.declaredType,
      },
      elementType,
    };
  }

  /** The `IEnumerable<T>` that a type implements, or the non-generic `IEnumerable`. */
  private findImplementedEnumerable(type: Type): Type | undefined {
    const generic = this.library.typeNamed('System.Collections.Generic.IEnumerable', 1);
    const faces =
      type.kind === 'named' || type.kind === 'typeParameter'
        ? this.searchChain(type).flatMap((owner) =>
            owner.symbol.kind === 'interface' ? [owner] : this.allInterfaces(owner)
          )
        : [];
    const matches = faces.filter((face) => face.symbol === generic);
    if (matches.length === 1) return matches[0];
    const nonGeneric = this.library.typeNamed('System.Collections.IEnumerable');
    if (faces.some((face) => face.symbol === nonGeneric)) return namedType(nonGeneric);
    return undefined;
  }

  private bindSwitch(statement: Extract<Statement, { kind: 'switch' }>, context: BindContext): BoundStatement {
    const value = this.bindTypedValue(statement.value, context);
    const scope = new LocalScope(context.scope, context.fn);
    const temporary = new LocalSymbol('\0switch', value.type, statement.row, statement.column);
    temporary.isHidden = true;
    context.fn.addLocal(temporary);
    const seen: SwitchLabelsSeen = { constants: [], hasDefault: false, handled: [] };
    const pending: PendingSwitch = { governingType: value.type, gotos: [] };
    context.fn.breakDepth++;
    context.fn.switches.push(pending);
    let sections: BoundSwitchSection[];
    try {
      sections = statement.sections.map((section) => {
        const sectionScope = new LocalScope(scope, context.fn);
        const sectionContext: BindContext = { scope: sectionScope, fn: context.fn };
        const labels = section.labels.map((label) => this.bindSwitchLabel(label, value, sectionContext, seen));
        const patternLocals = new Set(sectionScope.locals);
        // Labels in a section belong to the switch block, which every section's `goto` may reach.
        this.predeclare(section.statements, sectionContext, scope);
        const statements = this.bindStatements(section.statements, sectionContext);
        // The sections of a switch share one scope for the locals their statements declare (C# spec §13.8.3), while
        // the variables of a case's patterns belong to its section.
        for (const local of sectionScope.locals) if (!patternLocals.has(local)) scope.variables.set(local.name, local);
        return {
          labels,
          statements,
          row: section.row,
          locals: sectionScope.locals,
          syntax: section,
        } as BoundSwitchSection & { syntax: SwitchSection };
      });
    } finally {
      context.fn.breakDepth--;
      context.fn.switches.pop();
    }
    this.aimSwitchGotos(pending, sections);
    // Roslyn closes a switch without `default` whose unguarded patterns together match every value of its input.
    const isComplete =
      value.type.kind !== 'error' &&
      this.patternSpaces.isSubsumed(seen.handled, { kind: 'any', local: undefined, inputType: value.type });
    return { kind: 'switch', value, sections, temporary, isComplete, row: statement.row, step: 'none' };
  }

  /** Points each `goto case` and `goto default` of a switch at the section with that label. */
  private aimSwitchGotos(pending: PendingSwitch, sections: BoundSwitchSection[]): void {
    for (const jump of pending.gotos) {
      const target = sections.find((section) =>
        section.labels.some((label) => {
          if (label === 'default') return jump.value === undefined && jump.text === 'default:';
          const constant = label.guard ? undefined : this.constantOfPattern(label.pattern);
          return (
            constant?.kind === 'constant' &&
            jump.text !== 'default:' &&
            constantKey(constant.value) === constantKey(jump.value)
          );
        })
      );
      if (target) jump.statement.target = target;
      else this.error(jump.row, 'CS0159', `goto ステートメントのスコープに '${jump.text}' というラベルはありません`);
    }
  }

  /** Binds a case label, reporting a duplicate constant or default and a case that an earlier one covers. */
  private bindSwitchLabel(
    label: SwitchLabel,
    value: BoundExpression,
    context: BindContext,
    seen: SwitchLabelsSeen
  ): BoundSwitchSection['labels'][number] {
    if (label.kind === 'default') {
      if (seen.hasDefault)
        this.error(label, 'CS0152', "switch ステートメントに、ラベル値が 'default' の case が複数含まれています");
      seen.hasDefault = true;
      return 'default';
    }
    const pattern = this.bindPattern(label.pattern, value.type, context);
    const guard = label.guard ? this.bindAs(label.guard, this.boolType, context) : undefined;
    const constant = this.constantOfPattern(pattern);
    let isDuplicate = false;
    if (constant && !guard) {
      const constantValue = (constant as Extract<BoundExpression, { kind: 'constant' }>).value;
      const key = constantKey(constantValue);
      isDuplicate = seen.constants.includes(key);
      if (isDuplicate)
        this.error(
          label,
          'CS0152',
          `switch ステートメントに、ラベル値が '${labelText(constantValue, constant.type)}' の case が複数含まれています`
        );
      seen.constants.push(key);
    }
    if (!isDuplicate && value.type.kind !== 'error' && this.patternSpaces.isSubsumed(seen.handled, pattern))
      this.error(
        label,
        'CS8120',
        'switch ケースに到達できません。以前のケースで既に処理されたか、一致させることができません。'
      );
    if (!guard) seen.handled.push(...this.patternSpaces.under(pattern));
    return { pattern, guard };
  }

  private bindReturn(statement: Extract<Statement, { kind: 'return' }>, context: BindContext): BoundStatement {
    const { fn } = context;
    if (fn.finallyDepth > 0) this.error(statement, 'CS0157', 'コントロールが finally 句の本体から出られません');
    if (fn.returnType === undefined) {
      // A lambda whose return type is being inferred collects the types its returns return.
      if (!statement.value) return { kind: 'return', value: undefined, row: statement.row, step: 'none' };
      const value = this.bindValue(statement.value, context);
      fn.returnsValue = true;
      fn.returnTypes.push(value.type);
      return { kind: 'return', value, row: statement.row, step: 'none' };
    }
    const describe = (): string => (fn.kind === 'lambda' ? 'ラムダ式' : this.describeMethod(fn.method));
    if (!statement.value) {
      if (fn.returnType.kind !== 'void' && fn.returnType.kind !== 'error')
        this.error(statement, 'CS0126', `'${displayType(fn.returnType)}' に変換可能な型のオブジェクトが必要です`);
      return { kind: 'return', value: undefined, row: statement.row, step: 'none' };
    }
    if (fn.returnType.kind === 'void') {
      const value = this.bindValue(statement.value, context);
      if (fn.kind === 'lambda')
        this.error(statement, 'CS8030', 'void に変換されデリゲートを返す匿名関数は、値を返すことができません');
      else
        this.error(
          statement,
          'CS0127',
          `'${describe()}' は void 型を返すため、キーワード return の後にオブジェクト式を指定することはできません`
        );
      return { kind: 'return', value, row: statement.row, step: 'none' };
    }
    const value = this.bindAs(statement.value, fn.returnType, context);
    return { kind: 'return', value, row: statement.row, step: 'none' };
  }

  protected describeMethod(method: MethodSymbol): string {
    return import.meta ? this.methodDisplay(method) : '';
  }

  protected abstract methodDisplay(method: MethodSymbol): string;

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private bindTry(statement: Extract<Statement, { kind: 'try' }>, context: BindContext): BoundStatement {
    const body = this.bindBlock(statement.body, context);
    const exceptionType = namedType(this.library.specials.get('exception') as TypeSymbol);
    const caught: Type[] = [];
    const catches: BoundCatch[] = statement.catches.map((clause) => {
      const scope = new LocalScope(context.scope, context.fn);
      const inner: BindContext = { scope, fn: context.fn };
      const type = clause.type ? this.resolveType(clause.type, context.fn.typeContext) : exceptionType;
      if (type.kind !== 'error' && !this.conversions.implicit(type, exceptionType)) {
        this.error(
          clause.type ?? clause,
          'CS0155',
          'キャッチ、または スローされた型は System.Exception から派生したものでなければなりません。'
        );
      }
      const earlier = caught.find((previous) => this.conversions.implicit(type, previous) !== undefined);
      if (earlier && !clause.filter && type.kind !== 'error') {
        this.error(
          clause.type ?? clause,
          'CS0160',
          `前の catch 句はこれ、またはスーパー型 ('${displayType(earlier)}') の例外のすべてを既にキャッチしました`
        );
      }
      if (!clause.filter) caught.push(type);
      const local = clause.name ? this.declareLocal(clause.name, type, clause, inner) : undefined;
      const filter = clause.filter ? this.bindAs(clause.filter, this.boolType, inner) : undefined;
      context.fn.catchDepth++;
      let catchBody: BoundBlock;
      try {
        catchBody = this.bindBlock(clause.body, inner);
      } finally {
        context.fn.catchDepth--;
      }
      return { type, local, locals: scope.locals, filter, body: catchBody, row: clause.row };
    });
    let finallyBlock: BoundBlock | undefined;
    if (statement.finally) {
      context.fn.finallyDepth++;
      const savedBreak = context.fn.breakDepth;
      const savedContinue = context.fn.continueDepth;
      context.fn.breakDepth = 0;
      context.fn.continueDepth = 0;
      try {
        finallyBlock = this.bindBlock(statement.finally, context);
      } finally {
        context.fn.finallyDepth--;
        context.fn.breakDepth = savedBreak;
        context.fn.continueDepth = savedContinue;
      }
    }
    return { kind: 'try', body, catches, finally: finallyBlock, row: statement.row, step: 'none' };
  }

  /** The full name of an exception type, as CS0160 shows it. */

  /** Declares a local function's signature, which its block knows from its start. */
  protected declareLocalFunction(declaration: MethodDeclaration, context: BindContext): MethodSymbol {
    const owner = context.fn.method.owner;
    const method = new MethodSymbol(declaration.name, owner, 'localFunction');
    // A local function takes only these modifiers; an access modifier, as on a method, is an error.
    for (const modifier of declaration.modifiers.set) {
      if (!LOCAL_FUNCTION_MODIFIERS.has(modifier))
        this.error(declaration.row, 'CS0106', `修飾子 '${modifier}' がこの項目に対して有効ではありません`);
    }
    method.isStatic = declaration.modifiers.set.has('static') || context.fn.isStatic;
    method.row = declaration.row;
    method.declaration = declaration;
    method.typeParameters = declaration.typeParameters.map(
      (parameter, index) => new (this.typeParameterClass())(parameter.name, method, index, undefined)
    );
    const typeContext = {
      ...context.fn.typeContext,
      methodTypeParameters: [...context.fn.typeContext.methodTypeParameters, ...method.typeParameters],
    };
    this.applyConstraints(method.typeParameters, declaration.constraints, typeContext);
    this.methodContexts.set(method, typeContext);
    method.returnType = this.resolveType(declaration.returnType, typeContext);
    method.parameters = this.resolveParameters(declaration.parameters, typeContext, undefined);
    if (declaration.parameters.some((parameter) => parameter.isThis))
      this.error(declaration, 'CS1106', '拡張メソッドは、非ジェネリック静的クラスで定義される必要があります');
    if (context.scope.localFunctions.has(declaration.name) || context.scope.variables.has(declaration.name)) {
      this.error(
        declaration,
        'CS0128',
        `'${declaration.name}' という名前のローカル変数または関数はこのスコープで既に定義されています`
      );
    }
    context.scope.localFunctions.set(declaration.name, method);
    this.localFunctionScopes.set(method, context.scope);
    return method;
  }

  protected abstract typeParameterClass(): typeof TypeParameterSymbol;

  private readonly localFunctionScopes = new Map<MethodSymbol, LocalScope>();

  private bindLocalFunctionBody(declaration: MethodDeclaration, context: BindContext): void {
    const method = context.scope.localFunctions.get(declaration.name);
    if (!method || method.declaration !== declaration) return;
    const typeContext = this.methodContexts.get(method) as TypeContext;
    const isStatic = declaration.modifiers.set.has('static');
    const fn = new FunctionScope(
      method,
      context.fn,
      typeContext,
      method.returnType,
      context.fn.isStatic || isStatic,
      isStatic ? undefined : context.fn.thisType,
      'localFunction'
    );
    if (isStatic) (method as { isStaticLambda?: boolean }).isStaticLambda = true;
    const scope = new LocalScope(context.scope, fn);
    const inner: BindContext = { scope, fn };
    for (const parameter of method.parameters) this.declareParameter(parameter, inner);
    method.body = this.bindMethodBody(declaration.body, inner, method.returnType);
    // A local function written in a `checked` or `unchecked` block is in its context, as lambdas are.
    if (this.checkedContext !== undefined) markOverflowChecks(method.body, this.checkedContext);
    method.captures = [...fn.captures];
    this.recordCaptureList(fn, (captures) => {
      method.captures = captures;
    });
    this.finishFunction(method, fn);
  }

  /** Declares a method's parameter as a local of its body. */
  declareParameter(parameter: ParameterSymbol, context: BindContext): LocalSymbol {
    const local = new LocalSymbol(
      parameter.name,
      parameter.type,
      parameter.position?.row ?? 0,
      parameter.position?.column ?? 0
    );
    local.isParameter = true;
    local.refKind = parameter.refKind;
    if (context.scope.isDeclaredOutside(parameter.name)) {
      this.error(
        parameter.position ?? 0,
        'CS0136',
        `ローカルまたはパラメーター '${parameter.name}' は、その名前が外側のローカルのスコープでローカルやパラメーターの定義に使用されているため、このスコープでは宣言できません`
      );
    }
    local.isTransparent = parameter.name.startsWith(TRANSPARENT_PREFIX);
    context.fn.addLocal(local);
    context.scope.variables.set(parameter.name, local);
    return local;
  }

  /** Binds a method's block or expression body. */
  protected bindMethodBody(
    body: Block | Expression | undefined,
    context: BindContext,
    returnType: Type
  ): BoundBlock | undefined {
    if (!body) return undefined;
    if (body.kind === 'block') return this.bindBlock(body, context, false);
    const saved = this.allowsThrowExpression;
    this.allowsThrowExpression = true;
    try {
      if (returnType.kind === 'void') {
        const value = this.bindValue(body, context);
        this.requireStatementExpression(value, body);
        return blockOf(
          { kind: 'expression', expression: value, row: body.row, step: this.expressionStepKind(value) },
          body.row
        );
      }
      // A `throw` expression converts to any return type.
      const value = body.kind === 'throw' ? this.bindValue(body, context) : this.bindAs(body, returnType, context);
      return blockOf({ kind: 'return', value, row: body.row, step: 'none' }, body.row);
    } finally {
      this.allowsThrowExpression = saved;
    }
  }

  /** Runs the checks that need a function's whole body: reachability and definite assignment. */
  protected abstract finishFunction(method: MethodSymbol, fn: FunctionScope): void;
}

/** Whether an expression only creates objects, whose constructors' steps show what creating them did. */
export function isObjectCreation(expression: BoundExpression): boolean {
  if (expression.kind === 'convert') return isObjectCreation(expression.operand);
  if (expression.kind === 'newArray')
    return (
      expression.elements !== undefined && expression.elements.length > 0 && expression.elements.every(isObjectCreation)
    );
  return expression.kind === 'new';
}

function constantKey(value: unknown): unknown {
  if (value !== undefined && typeof value === 'object') return String(value);
  return value;
}

/** A case label's constant as Roslyn shows it: a string quoted, a char as itself, `True`, and `null`. */
function labelText(value: unknown, type: Type): string {
  if (value === undefined) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (specialOf(type) === 'char') return String.fromCodePoint(value as number);
  return constantText(value);
}

/** A block of one statement, which an expression-bodied member's body becomes. */
function blockOf(statement: BoundStatement, row: number): BoundBlock {
  return { kind: 'block', statements: [statement], capturedLocals: [], locals: [], row, step: 'none' };
}

/** Whether an expression's syntax may stand as a statement: a call, `new`, an increment, or an assignment. */
function isStatementSyntax(node: Expression): boolean {
  if (node.kind === 'conditionalAccess') return isStatementSyntax(node.access);
  return ['invocation', 'new', 'implicitNew', 'increment', 'assign', 'throw'].includes(node.kind);
}

/**
 * The names a statement declares in its enclosing block: its declarators and deconstruction, and the `out` variables
 * and pattern variables of the expressions whose variables C# scopes to that block (an expression statement, a
 * declaration's initializers, and the expression of an `if`, a `switch`, a `return`, or a `throw`).
 */
function namesDeclaredInBlock(statement: Statement): string[] {
  const names: string[] = [];
  switch (statement.kind) {
    case 'localDeclaration': {
      for (const declarator of statement.declarators) names.push(declarator.name);
      collectDesignatedNames(
        statement.declarators.map((declarator) => declarator.initializer),
        names
      );
      break;
    }
    case 'deconstruction': {
      collectDesignatedNames(statement, names);
      break;
    }
    case 'expression': {
      collectDesignatedNames(statement.expression, names);
      break;
    }
    case 'if': {
      collectDesignatedNames(statement.condition, names);
      break;
    }
    case 'switch':
    case 'return':
    case 'throw': {
      collectDesignatedNames(statement.value, names);
      break;
    }
  }
  return names;
}

/** Adds the names of the variables a syntax node designates, outside the nodes that scope their own variables. */
function collectDesignatedNames(node: unknown, names: string[]): void {
  if (Array.isArray(node)) {
    for (const element of node) collectDesignatedNames(element, names);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const kind = (node as { kind?: unknown }).kind;
  // A lambda, a query, and a switch expression's arms scope their own variables.
  if (kind === 'lambda' || kind === 'query') return;
  if (kind === 'switch' && 'arms' in node && 'value' in node) {
    collectDesignatedNames(node.value, names);
    return;
  }
  if (kind === 'single' && 'name' in node) names.push((node as { name: string }).name);
  for (const value of Object.values(node)) collectDesignatedNames(value, names);
}
