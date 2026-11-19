import type {
  Block,
  Expression,
  MethodDeclaration,
  Position,
  Statement,
  SwitchSection,
  VariableDeclarator,
} from './ast';
import type { TypeContext } from './binderBase';
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
import type { BindContext } from './convertBinder';
import { constantText } from './convertBinder';
import type { MemberLookup } from './lookup';
import { PatternBinder } from './patternBinder';
import { TRANSPARENT_PREFIX } from './queries';
import { FunctionScope, LocalScope } from './scopes';
import {
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  type FieldSymbol,
  isReferenceType,
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
import { unavailableTypeOf } from './unavailable';

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
    const unavailable = unavailableTypeOf(name, simple);
    if (unavailable) this.unsupported(position, unavailable);
  }

  // code-gauge-allow functionNcss 40 -- Each conflict of a local's name has its own diagnostic.
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

  // code-gauge-allow functionNcss 60 -- Each kind of storage has its own rule for assignment.
  checkAssignable(
    target: BoundExpression,
    position: Position,
    context: BindContext,
    use: 'assign' | 'ref' | 'out' | 'compound' | 'initializer'
  ): BoundLValue {
    switch (target.kind) {
      case 'local': {
        const { local } = target;
        if (local.isReadonly) {
          this.error(
            position,
            'CS1656',
            `'${local.name}' は '${(local as { readonlyReason?: string }).readonlyReason ?? 'foreach 繰り返し変数'}' であるため、これに割り当てることはできません`
          );
        }
        return target;
      }
      case 'field': {
        this.checkReadonlyField(target.field, context, position);
        if (
          target.receiver.type.kind === 'named' &&
          target.receiver.type.symbol.isValueType &&
          !this.isVariable(target.receiver) &&
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
        if (
          target.type.kind === 'named' &&
          target.type.symbol.kind === 'struct' &&
          context.fn.method.kind === 'constructor'
        )
          return target;
        this.error(position, 'CS1604', "'this' は読み取り専用であるため、割り当てることはできません");
        return { kind: 'discard', type: ERROR_TYPE, row: position.row };
      }
      case 'constant': {
        if ((target as { local?: LocalSymbol }).local || this.isConstantName(position)) {
          this.error(position, 'CS0131', '代入式の左辺には変数、プロパティ、またはインデクサーを指定してください');
        } else {
          this.error(position, 'CS0131', '代入式の左辺には変数、プロパティ、またはインデクサーを指定してください');
        }
        return { kind: 'discard', type: ERROR_TYPE, row: position.row };
      }
      default: {
        if (target.type.kind !== 'error')
          this.error(position, 'CS0131', '代入式の左辺には変数、プロパティ、またはインデクサーを指定してください');
        return { kind: 'discard', type: ERROR_TYPE, row: position.row };
      }
    }
  }

  private isConstantName(_position: Position): boolean {
    return false;
  }

  private checkPropertyAssignable(
    target: Extract<BoundExpression, { kind: 'property' }>,
    position: Position,
    context: BindContext,
    use: string
  ): BoundLValue {
    const { property } = target;
    const setter = this.setterOf(property);
    const display = property.isIndexer
      ? `${displayTypeSymbol(target.owner.symbol, target.owner.args)}.this[${property.parameters.map((parameter) => displayType(substitute(parameter.type, substitutionOf(target.owner)))).join(', ')}]`
      : `${displayTypeSymbol(target.owner.symbol, target.owner.args)}.${property.name}`;
    if (!setter) {
      if (property.backingField && this.isInConstructorOf(property, context)) {
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
        `init 専用プロパティまたはインデクサー '${display}' を割り当てることができるのは、オブジェクト初期化子の中か、インスタンス コンストラクターまたは 'init' アクセサーの中の 'this' か 'base' 上のみです。`
      );
    }
    if (!this.isAccessible(setter.access, property.owner, context.fn.typeContext, target.receiver?.type)) {
      this.error(
        position,
        'CS0272',
        `アクセサー '${display}.set' にアクセスできないため、このコンテキストではプロパティまたはインデクサー '${display}' を使用できません`
      );
    }
    if (
      target.receiver &&
      target.receiver.type.kind === 'named' &&
      target.receiver.type.symbol.isValueType &&
      !this.isVariable(target.receiver) &&
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
    const method = context.fn.method;
    const inConstructor =
      (field.isStatic
        ? method.kind === 'staticConstructor'
        : method.kind === 'constructor' || (method.kind === 'setter' && method.property?.isInitOnly === true)) &&
      method.owner === field.owner &&
      context.fn.kind !== 'lambda';
    if (!inConstructor && context.fn.kind !== 'initializer') {
      if (field.isStatic)
        this.error(
          position,
          'CS0198',
          '静的な読み取り専用フィールドに割り当てることはできません (静的コンストラクターまたは変数初期化子では可)'
        );
      else
        this.error(
          position,
          'CS0191',
          '読み取り専用フィールドに割り当てることはできません (フィールドが定義されている型のコンストラクターか init 専用セッター、または変数初期化子では可)'
        );
    }
  }

  /** Whether an expression denotes a variable, whose struct value an assignment to a member changes in place. */
  protected isVariable(expression: BoundExpression): boolean {
    switch (expression.kind) {
      case 'local':
      case 'this':
      case 'element':
      case 'staticField':
      case 'compoundOperand': {
        return true;
      }
      case 'field': {
        return (
          !(expression.receiver.type.kind === 'named' && expression.receiver.type.symbol.isValueType) ||
          this.isVariable(expression.receiver)
        );
      }
      default: {
        return false;
      }
    }
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
        '非 ref を返すプロパティまたはインデクサーは out または ref パラメーターとして渡すことはできません'
      );
      return { kind: 'discard', type: ERROR_TYPE, row: node.row };
    }
    if (use === 'compound' && value.kind === 'property' && !this.getterOf(value.property)) {
      this.error(
        node,
        'CS0154',
        `プロパティまたはインデクサー '${displayTypeSymbol(value.owner.symbol)}.${value.property.name}' は get アクセサーがないため、このコンテキストでは使用できません`
      );
    }
    return this.checkAssignable(value, node, context, use);
  }

  private getterOf(property: PropertySymbol): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden)
      if (current.getter) return current.getter;
    return undefined;
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

  /** Makes a block's names known from its start: local functions to call, and locals that may not be used before their declarations. */
  protected predeclare(statements: Statement[], context: BindContext): void {
    for (const statement of statements) {
      if (statement.kind === 'localDeclaration')
        for (const declarator of statement.declarators) context.scope.declaredLater.add(declarator.name);
      if (statement.kind === 'localFunction') this.declareLocalFunction(statement.declaration, context);
    }
  }

  protected bindStatements(statements: Statement[], context: BindContext): BoundStatement[] {
    return statements.map((statement) => this.bindStatement(statement, context));
  }

  // code-gauge-allow functionNcss 100 -- One case per kind of statement.
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
        const expression = this.bindValue(statement.expression, context);
        const resolved =
          expression.kind === 'unbound'
            ? this.convert(expression, this.naturalTypeOf(expression) ?? ERROR_TYPE, statement)
            : expression;
        if (!this.isStatementExpression(resolved)) {
          this.error(
            statement.expression,
            'CS0201',
            '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
          );
        }
        return { kind: 'expression', expression: resolved, row, step: this.expressionStepKind(resolved) };
      }
      case 'localDeclaration': {
        return this.bindLocalDeclaration(statement, context);
      }
      case 'deconstruction': {
        const value = this.bindValue(statement.value, context);
        if (value.kind === 'unbound' && value.node.kind === 'tuple') {
          const elements = value.node.elements.map((element) => this.bindValue(element.value, context));
          void elements;
        }
        const target = this.declareDeconstructed(statement.designation, undefined, value.type, context);
        const expression: BoundExpression = { kind: 'deconstructAssign', targets: target, value, type: VOID_TYPE, row };
        return { kind: 'expression', expression, row, step: 'step' };
      }
      case 'localFunction': {
        this.bindLocalFunctionBody(statement.declaration, context);
        return { kind: 'empty', row, step: 'none' };
      }
      case 'if': {
        const condition = this.bindAs(statement.condition, this.boolType, context);
        const consequence = this.bindEmbedded(statement.consequence, context);
        const alternative = statement.alternative ? this.bindEmbedded(statement.alternative, context) : undefined;
        return { kind: 'if', condition, consequence, alternative, row, step: 'none' };
      }
      case 'while': {
        const condition = this.bindAs(statement.condition, this.boolType, context);
        const body = this.inLoop(context, () => this.bindEmbedded(statement.body, context));
        return { kind: 'while', condition, body, row, step: 'none' };
      }
      case 'do': {
        const body = this.inLoop(context, () => this.bindEmbedded(statement.body, context));
        const condition = this.bindAs(statement.condition, this.boolType, context);
        return { kind: 'do', body, condition, conditionRow: statement.conditionRow, row, step: 'none' };
      }
      case 'for': {
        return this.bindFor(statement, context);
      }
      case 'foreach': {
        return this.bindForeach(statement, context);
      }
      case 'switch': {
        return this.bindSwitch(statement, context);
      }
      case 'break': {
        if (context.fn.breakDepth === 0)
          this.error(
            statement,
            'CS0139',
            'break または continue が中断されるか、または続行される外側のループが存在しません'
          );
        return { kind: 'break', row, step: 'none' };
      }
      case 'continue': {
        if (context.fn.continueDepth === 0)
          this.error(
            statement,
            'CS0139',
            'break または continue が中断されるか、または続行される外側のループが存在しません'
          );
        return { kind: 'continue', row, step: 'none' };
      }
      case 'return': {
        return this.bindReturn(statement, context);
      }
      case 'throw': {
        if (!statement.value) {
          if (context.fn.catchDepth === 0)
            this.error(statement, 'CS0156', 'パラメーターなしの throw ステートメントは catch 句の外では使用できません');
          return { kind: 'throw', value: undefined, row, step: 'none' };
        }
        return {
          kind: 'throw',
          value: this.bindThrowValue(statement.value, context, statement.value),
          row,
          step: 'none',
        };
      }
      case 'try': {
        return this.bindTry(statement, context);
      }
    }
  }

  /** How an expression statement records its step: one that only calls or creates objects may leave it to its calls. */
  private expressionStepKind(expression: BoundExpression): StepKind {
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

  // code-gauge-allow functionNcss 60 -- The rules of local declarations, `var`, and `const`.
  private bindLocalDeclaration(
    statement: Extract<Statement, { kind: 'localDeclaration' }>,
    context: BindContext
  ): BoundStatement {
    const isVar = statement.type.kind === 'varType' && !this.findTypeInScope('var', 0, context.fn.typeContext);
    if (isVar && statement.declarators.length > 1) {
      this.error(statement, 'CS0819', '暗黙的に型指定された変数に複数の宣言子を含めることはできません');
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
    let type = declaredType;
    let value: BoundExpression | undefined;
    if (!type) {
      if (!initializer) {
        this.error(declarator, 'CS0818', '暗黙的に型指定された変数は初期化される必要があります');
        type = ERROR_TYPE;
      } else if (initializer.kind === 'arrayInitializer') {
        this.error(declarator, 'CS0820', '配列初期化子を使って暗黙的に型指定された変数を初期化することはできません');
        type = ERROR_TYPE;
      } else {
        const bound = this.bindValue(initializer, context);
        if (bound.type.kind === 'null' && bound.kind !== 'unbound') {
          this.error(declarator, 'CS0815', '<null> を暗黙的に型指定された変数に割り当てることはできません');
          type = ERROR_TYPE;
        } else if (bound.type.kind === 'void') {
          this.error(declarator, 'CS0815', 'void を暗黙的に型指定された変数に割り当てることはできません');
          type = ERROR_TYPE;
        } else if (bound.kind === 'unbound') {
          const natural = this.naturalTypeOf(bound);
          if (!natural) {
            const what = bound.node.kind === 'lambda' || bound.methodGroup ? undefined : bound.node.kind;
            if (what === 'default') this.error(declarator, 'CS8716', "'default' リテラルにターゲット型がありません。");
            else if (what === 'implicitNew') this.error(declarator, 'CS8754', "'new()' のターゲット型がありません");
            else if (what === 'collection')
              this.error(declarator, 'CS9176', 'コレクション式のターゲット型がありません。');
            else if (what === 'tuple')
              this.error(declarator, 'CS0815', `(${'?'}) を暗黙的に型指定された変数に割り当てることはできません`);
            else this.error(declarator, 'CS8917', 'デリゲート型を推論できませんでした。');
            type = ERROR_TYPE;
          } else {
            type = natural;
            value = this.convert(bound, natural, declarator);
          }
        } else {
          type = bound.type;
          value = bound;
        }
      }
    }
    // The variable is in scope in its own initializer, where using it is an error of definite assignment.
    const local = this.declareLocal(declarator.name, type, declarator, context);
    if (initializer && !value) {
      value =
        initializer.kind === 'arrayInitializer'
          ? this.bindArrayInitializer(initializer, type, context)
          : this.bindAs(initializer, type, context);
    }
    if (isConst) {
      local.isConst = true;
      if (!initializer) this.error(declarator, 'CS0145', 'const フィールドには値を指定する必要があります');
      else if (value?.kind !== 'constant') {
        if (value?.type.kind !== 'error')
          this.error(declarator, 'CS0133', `'${declarator.name}' に割り当てられた式は定数でなければなりません`);
      } else {
        local.constantValue = value.value;
      }
      if (type.kind !== 'error' && !this.isConstantType(type))
        this.error(declarator, 'CS0283', `型 '${displayType(type)}' を const として宣言することはできません`);
    }
    return { kind: 'localDeclaration', local, value, row: declarator.row, step: 'none' };
  }

  /** Whether a type may be that of a constant. */
  protected isConstantType(type: Type): boolean {
    const special = specialOf(type);
    if (
      special &&
      [
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
      ].includes(special)
    )
      return true;
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
        if (!this.isStatementExpression(bound))
          this.error(
            expression,
            'CS0201',
            '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
          );
        initializers.push({ kind: 'expression', expression: bound, row: statement.row, step: 'none' });
      }
    }
    const condition = statement.condition ? this.bindAs(statement.condition, this.boolType, inner) : undefined;
    const updates = statement.updates.map((update) => {
      const bound = this.bindValue(update, inner);
      if (!this.isStatementExpression(bound))
        this.error(
          update,
          'CS0201',
          '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
        );
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

  // code-gauge-allow functionNcss 80 -- How foreach finds its elements: arrays, strings, and the GetEnumerator pattern.
  private bindForeach(statement: Extract<Statement, { kind: 'foreach' }>, context: BindContext): BoundStatement {
    const collection = this.bindValue(statement.collection, context);
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
          `foreach ステートメントは、'${display}' が 'GetEnumerator' のパブリック インスタンスまたは拡張定義を含んでいないため、型 '${display}' の変数に対して使用できません`
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
        (local as { readonlyReason?: string }).readonlyReason = 'foreach 繰り返し変数';
      }
    } else if (statement.variable.kind === 'discard') {
      variable = new LocalSymbol('\0element', elementType, statement.row, statement.column);
      variable.isHidden = true;
      context.fn.addLocal(variable);
    } else {
      variable = this.declareLocal(statement.variable.name, declaredType, statement.variable, inner);
      variable.isReadonly = true;
      (variable as { readonlyReason?: string }).readonlyReason = 'foreach 繰り返し変数';
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

  /** Whether learners write down a variable's value in a trace: numbers, characters, booleans, and strings. */
  protected isAnswered(type: Type): boolean {
    const special = specialOf(nullableUnderlying(type) ?? type);
    if (
      special &&
      [
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
      ].includes(special)
    )
      return true;
    return type.kind === 'named' && type.symbol.kind === 'enum';
  }

  /** Finds `GetEnumerator()` and the `MoveNext()` and `Current` of what it returns, as `foreach` does. */
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
    if (moveNext?.kind !== 'methods' || current?.kind !== 'property') {
      this.error(position, 'CS0117', `'${displayType(enumeratorType)}' に 'Current' の定義がありません`);
      return undefined;
    }
    const moveNextMethod = moveNext.candidates.find((candidate) => candidate.method.parameters.length === 0)?.method;
    if (!moveNextMethod) return undefined;
    const elementType = substitute(current.property.type, substitutionOf(current.owner));
    const dispose = lookup(enumeratorType, 'Dispose');
    return {
      iteration: {
        kind: 'enumerator',
        getEnumerator: method,
        moveNext: moveNextMethod,
        current: current.property,
        enumeratorType,
        receiverIsStruct: enumeratorType.kind === 'named' && enumeratorType.symbol.isValueType,
        dispose: dispose?.kind === 'methods' ? dispose.candidates[0]?.method : undefined,
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

  // code-gauge-allow functionNcss 60 -- Switch sections, their labels, and duplicate cases.
  private bindSwitch(statement: Extract<Statement, { kind: 'switch' }>, context: BindContext): BoundStatement {
    const value = this.bindValue(statement.value, context);
    const scope = new LocalScope(context.scope, context.fn);
    const temporary = new LocalSymbol('\0switch', value.type, statement.row, statement.column);
    temporary.isHidden = true;
    context.fn.addLocal(temporary);
    const seenConstants: unknown[] = [];
    let hasDefault = false;
    let isExhausted = false;
    context.fn.breakDepth++;
    let sections: BoundSwitchSection[];
    try {
      sections = statement.sections.map((section) => {
        const sectionScope = new LocalScope(scope, context.fn);
        const sectionContext: BindContext = { scope: sectionScope, fn: context.fn };
        const labels = section.labels.map((label) => {
          if (label.kind === 'default') {
            if (hasDefault)
              this.error(label, 'CS0152', "switch ステートメントに、ラベル値が 'default' の case が複数含まれています");
            hasDefault = true;
            return 'default' as const;
          }
          const pattern = this.bindPattern(label.pattern, value.type, sectionContext);
          const guard = label.guard ? this.bindAs(label.guard, this.boolType, sectionContext) : undefined;
          if (isExhausted && value.type.kind !== 'error')
            this.error(label, 'CS8120', 'switch case は、既に前の case で処理されています。');
          const constant = this.constantOfPattern(pattern);
          if (constant && !guard) {
            const value = (constant as Extract<BoundExpression, { kind: 'constant' }>).value;
            const key = constantKey(value);
            if (seenConstants.includes(key))
              this.error(
                label,
                'CS0152',
                `switch ステートメントに、ラベル値が '${constantText(value)}' の case が複数含まれています`
              );
            seenConstants.push(key);
          }
          if (!guard && this.isIrrefutable(pattern, value.type)) isExhausted = true;
          return { pattern, guard };
        });
        this.predeclare(section.statements, sectionContext);
        const statements = this.bindStatements(section.statements, sectionContext);
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
    }
    return { kind: 'switch', value, sections, temporary, row: statement.row, step: 'none' };
  }

  private bindReturn(statement: Extract<Statement, { kind: 'return' }>, context: BindContext): BoundStatement {
    const { fn } = context;
    if (fn.finallyDepth > 0) this.error(statement, 'CS0157', 'コントロールが finally 句の本体から出ることはできません');
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
      if (fn.kind === 'lambda') this.error(statement, 'CS8030', 'void を返す匿名関数は、値を返すことができません');
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
          'キャッチされたり、スローされた型は System.Exception から派生しなければなりません'
        );
      }
      const earlier = caught.find((previous) => this.conversions.implicit(type, previous) !== undefined);
      if (earlier && !clause.filter && type.kind !== 'error') {
        this.error(
          clause.type ?? clause,
          'CS0160',
          `以前の catch 句はこれ、またはスーパー型 ('${this.exceptionDisplay(earlier)}') の例外のすべてを既にキャッチしました`
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
      return { type, local, filter, body: catchBody, row: clause.row };
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
  private exceptionDisplay(type: Type): string {
    if (type.kind !== 'named') return displayType(type);
    return type.symbol.isLibrary ? type.symbol.fullName : displayType(type);
  }

  /** Declares a local function's signature, which its block knows from its start. */
  protected declareLocalFunction(declaration: MethodDeclaration, context: BindContext): MethodSymbol {
    const owner = context.fn.method.owner;
    const method = new MethodSymbol(declaration.name, owner, 'localFunction');
    method.isStatic = declaration.modifiers.set.has('static') || context.fn.isStatic;
    method.enclosing = context.fn.method;
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
    method.captures = [...fn.captures];
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
        if (!this.isStatementExpression(value))
          this.error(
            body,
            'CS0201',
            '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
          );
        return {
          kind: 'block',
          statements: [{ kind: 'expression', expression: value, row: body.row, step: this.expressionStepKind(value) }],
          capturedLocals: [],
          locals: [],
          row: body.row,
          step: 'none',
        };
      }
      const value = this.bindAs(body, returnType, context);
      return {
        kind: 'block',
        statements: [{ kind: 'return', value, row: body.row, step: 'none' }],
        capturedLocals: [],
        locals: [],
        row: body.row,
        step: 'none',
      };
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
