import { CONS_CON } from './builtinTypes';
import { unsupportedError } from './errors';
import type { FeatureGates } from './features';
import { overloadedList, overloadedListPattern, overloadedSequence } from './overloadedLists';
import { define, forceString, unit } from './primitives';
import type { Runtime } from './runtime';
import type {
  Alt,
  ChainItem,
  ConDecl,
  Constraint,
  Decl,
  DerivingClause,
  Expr,
  Guard,
  GuardedExpr,
  Literal,
  Name,
  Operator,
  Pat,
  QName,
  Rhs,
  SigType,
  SourceLiteral,
  Span,
  Stmt,
  TypeExpr,
  TyVarBinder,
} from './syntax';
import { THIS_MODULE } from './syntax';
import { chargeTypeWork } from './typeWorkBudget';
import { type ConValue, IOPrim, type Slot } from './values';

// What a splice's program stores for the compiler: its result, the errors it reports, or that it exited.
define(
  'storeSpliceResult',
  1,
  [],
  ([result], runtime) =>
    new IOPrim(
      'storeSpliceResult',
      () => {
        runtime.splice.result = result;
        return unit();
      },
      [result]
    )
);
define(
  'reportSpliceError',
  1,
  [],
  ([message], runtime) =>
    new IOPrim(
      'reportSpliceError',
      () => {
        runtime.splice.errors.push(forceString(message, runtime));
        return unit();
      },
      [message]
    )
);
define(
  'storeSpliceExit',
  1,
  [],
  ([message], runtime) =>
    new IOPrim(
      'storeSpliceExit',
      () => {
        runtime.splice.exit = forceString(message, runtime);
        return unit();
      },
      [message]
    )
);

/** What a splice gives, as the syntax the compiler grafts in its place. */
export type SpliceSyntax =
  | { kind: 'exp'; expr: Expr }
  | { kind: 'pat'; pat: Pat }
  | { kind: 'type'; type: TypeExpr }
  | { kind: 'decs'; decls: Decl[] };

/** The names a compilation gives the new names of its splices: one spelling per splice run and unique. */
export class SpliceNames {
  private count = 0;

  spell(occ: string): string {
    // A space makes the name one no program can write, so nothing captures it.
    return ` ${occ}_${this.count++}`;
  }
}

interface NameParts {
  occ: string;
  flavour: 'S' | 'Q' | 'U' | 'L' | 'G';
  module?: string;
  unique?: bigint;
  namespace?: 'var' | 'con' | 'type';
}

const UNAVAILABLE = {
  exp: 'この形の式を作るスプライス',
  pat: 'この形のパターンを作るスプライス',
  type: 'この形の型を作るスプライス',
  dec: 'この形の宣言を作るスプライス',
  con: 'この形の構成子（GADT の構成子など）を作るスプライス',
  lit: 'この形のリテラルを作るスプライス',
} as const;

/**
 * Decodes the evaluated Template Haskell tree a splice's program stored into the syntax the compiler reads, every
 * node at the splice's span. A new name a splice binds at its top level keeps its spelling, so the program refers to
 * it; one it binds inside gets a spelling of its own.
 */
export function decodeSplice(
  runtime: Runtime,
  result: Slot,
  span: Span,
  names: SpliceNames,
  site: FeatureGates<'convert'>
): SpliceSyntax {
  return new SpliceDecoder(runtime, span, names, site).splice(result);
}

class SpliceDecoder {
  /** The spelling of each new name of this splice, by its unique. */
  private readonly spellings = new Map<bigint, string>();

  constructor(
    private readonly runtime: Runtime,
    private readonly span: Span,
    private readonly names: SpliceNames,
    private readonly site: FeatureGates<'convert'>
  ) {}

  splice(slot: Slot): SpliceSyntax {
    const value = this.con(slot);
    const [field] = value.fields;
    switch (value.con.name) {
      case 'SpliceExp': {
        return { kind: 'exp', expr: this.exp(field) };
      }
      case 'SplicePat': {
        return { kind: 'pat', pat: this.pat(field) };
      }
      case 'SpliceType': {
        return { kind: 'type', type: this.type(field) };
      }
      case 'SpliceDecs': {
        const decs = this.list(field);
        for (const dec of decs) this.keepTopLevelBinders(dec);
        return { kind: 'decs', decls: decs.flatMap((dec) => this.dec(dec)) };
      }
      default: {
        throw new Error(`Unknown splice result ${value.con.name}`);
      }
    }
  }

  // Values

  private con(slot: Slot): ConValue {
    chargeTypeWork();
    return this.runtime.machine.force(slot) as ConValue;
  }

  private str(slot: Slot): string {
    const text = forceString(slot, this.runtime);
    chargeTypeWork(Math.ceil((text.length + 1) / 64));
    return text;
  }

  private int(slot: Slot): bigint {
    return this.runtime.machine.force(slot) as bigint;
  }

  private char(slot: Slot): string {
    return this.runtime.machine.force(slot) as string;
  }

  private list(slot: Slot): Slot[] {
    const items: Slot[] = [];
    let current = this.con(slot);
    while (current.con === CONS_CON) {
      items.push(current.fields[0]);
      current = this.con(current.fields[1]);
    }
    return items;
  }

  private maybe(slot: Slot): Slot | undefined {
    const value = this.con(slot);
    return value.con.name === 'Just' ? value.fields[0] : undefined;
  }

  /** A `NonEmpty`'s elements. */
  private nonEmpty(slot: Slot): Slot[] {
    const value = this.con(slot);
    return [value.fields[0], ...this.list(value.fields[1])];
  }

  private unavailable(what: keyof typeof UNAVAILABLE): never {
    throw unsupportedError(this.span, UNAVAILABLE[what]);
  }

  // Names

  private nameParts(slot: Slot): NameParts {
    const [occSlot, flavourSlot] = this.con(slot).fields;
    const occ = this.str(this.con(occSlot).fields[0]);
    const flavour = this.con(flavourSlot);
    switch (flavour.con.name) {
      case 'NameS': {
        return { occ, flavour: 'S' };
      }
      case 'NameQ': {
        return { occ, flavour: 'Q', module: this.str(this.con(flavour.fields[0]).fields[0]) };
      }
      case 'NameU':
      case 'NameL': {
        return { occ, flavour: flavour.con.name === 'NameU' ? 'U' : 'L', unique: this.int(flavour.fields[0]) };
      }
      case 'NameG': {
        const space = this.con(flavour.fields[0]).con.name;
        return {
          occ,
          flavour: 'G',
          module: this.str(this.con(flavour.fields[2]).fields[0]),
          namespace: space === 'VarName' ? 'var' : space === 'DataName' ? 'con' : 'type',
        };
      }
      default: {
        throw new Error(`Unknown name flavour ${flavour.con.name}`);
      }
    }
  }

  /** The spelling of a name the splice binds or refers to unqualified. */
  private spelling(parts: NameParts): string {
    if (parts.unique === undefined) return parts.occ;
    let spelled = this.spellings.get(parts.unique);
    if (!spelled) {
      spelled = this.names.spell(parts.occ);
      this.spellings.set(parts.unique, spelled);
    }
    return spelled;
  }

  /** A name the splice binds: a variable, a constructor, a type, or a type variable. */
  private binder(slot: Slot): Name {
    return { name: this.spelling(this.nameParts(slot)), span: this.span };
  }

  /** A name the splice refers to, a global one with the identity it has, which no binding the program has captures. */
  private ref(slot: Slot, namespace: 'var' | 'con' | 'type'): QName {
    const parts = this.nameParts(slot);
    const { span } = this;
    if (isSpecialSyntax(parts.occ)) return { name: parts.occ, span };
    // A new name the splice binds at its top level is this module's own, whatever else the program imports.
    if (parts.unique !== undefined && this.spellings.get(parts.unique) === parts.occ) {
      return { name: parts.occ, global: { module: THIS_MODULE, namespace }, span };
    }
    switch (parts.flavour) {
      case 'Q': {
        return { name: parts.occ, qualifier: parts.module, span };
      }
      case 'G': {
        return { name: parts.occ, global: { module: parts.module ?? '', namespace: parts.namespace ?? 'var' }, span };
      }
      case 'S':
      case 'U':
      case 'L': {
        return { name: this.spelling(parts), span };
      }
    }
  }

  private operator(slot: Slot): Operator {
    const isConstructor = /^[:A-Z]/.test(this.nameParts(slot).occ);
    return { ...this.ref(slot, isConstructor ? 'con' : 'var'), isConstructor };
  }

  /** Keeps the spelling of the new names a declaration binds at the top level, which the program refers to. */
  private keepTopLevelBinders(slot: Slot): void {
    const dec = this.con(slot);
    const keep = (nameSlot: Slot): void => {
      const parts = this.nameParts(nameSlot);
      if (parts.unique !== undefined) this.spellings.set(parts.unique, parts.occ);
    };
    switch (dec.con.name) {
      case 'FunD':
      case 'SigD':
      case 'TySynD':
      case 'KiSigD': {
        keep(dec.fields[0]);
        return;
      }
      case 'ValD': {
        for (const name of this.patBinders(dec.fields[0])) keep(name);
        return;
      }
      case 'TypeDataD': {
        keep(dec.fields[0]);
        for (const con of this.list(dec.fields[3])) for (const name of this.conBinders(con)) keep(name);
        return;
      }
      case 'DataD':
      case 'NewtypeD': {
        keep(dec.fields[1]);
        const cons = dec.con.name === 'DataD' ? this.list(dec.fields[4]) : [dec.fields[4]];
        for (const con of cons) for (const name of this.conBinders(con)) keep(name);
        return;
      }
      case 'ClassD': {
        keep(dec.fields[1]);
        for (const member of this.list(dec.fields[4])) {
          const inner = this.con(member);
          if (inner.con.name === 'SigD') keep(inner.fields[0]);
        }
        return;
      }
      default: {
        return;
      }
    }
  }

  private patBinders(slot: Slot): Slot[] {
    const pat = this.con(slot);
    switch (pat.con.name) {
      case 'VarP': {
        return [pat.fields[0]];
      }
      case 'AsP': {
        return [pat.fields[0], ...this.patBinders(pat.fields[1])];
      }
      case 'TupP':
      case 'ListP': {
        return this.list(pat.fields[0]).flatMap((inner) => this.patBinders(inner));
      }
      case 'ConP': {
        return this.list(pat.fields[2]).flatMap((inner) => this.patBinders(inner));
      }
      case 'InfixP':
      case 'UInfixP': {
        return [...this.patBinders(pat.fields[0]), ...this.patBinders(pat.fields[2])];
      }
      case 'ParensP':
      case 'TildeP':
      case 'BangP': {
        return this.patBinders(pat.fields[0]);
      }
      case 'SigP': {
        return this.patBinders(pat.fields[0]);
      }
      case 'ViewP': {
        return this.patBinders(pat.fields[1]);
      }
      case 'RecP': {
        return this.list(pat.fields[1]).flatMap((field) => this.patBinders(this.con(field).fields[1]));
      }
      default: {
        return [];
      }
    }
  }

  /** A constructor's name and its fields' names. */
  private conBinders(slot: Slot): Slot[] {
    const con = this.con(slot);
    switch (con.con.name) {
      case 'NormalC': {
        return [con.fields[0]];
      }
      case 'RecC': {
        return [con.fields[0], ...this.list(con.fields[1]).map((field) => this.con(field).fields[0])];
      }
      case 'InfixC': {
        return [con.fields[1]];
      }
      case 'ForallC': {
        return this.conBinders(con.fields[2]);
      }
      default: {
        return [];
      }
    }
  }

  // Literals

  private literal(slot: Slot): Literal | undefined {
    const lit = this.con(slot);
    switch (lit.con.name) {
      case 'IntegerL': {
        return { kind: 'int', value: this.int(lit.fields[0]) };
      }
      case 'CharL': {
        return { kind: 'char', value: this.char(lit.fields[0]) };
      }
      case 'StringL': {
        // oxlint-disable-next-line typescript/no-misused-spread -- A Haskell string's characters are code points.
        return { kind: 'string', value: [...this.str(lit.fields[0])] };
      }
      case 'RationalL': {
        return undefined;
      }
      default: {
        return this.unavailable('lit');
      }
    }
  }

  /** A rational literal: the decimal it is when it has one, `n / d` as a fraction otherwise. */
  private rational(slot: Slot): { numerator: bigint; denominator: bigint; decimal?: string } {
    const ratio = this.con(this.con(slot).fields[0]);
    const numerator = this.int(ratio.fields[0]);
    const denominator = this.int(ratio.fields[1]);
    return { numerator, denominator, decimal: decimalOf(numerator < 0n ? -numerator : numerator, denominator) };
  }

  // Expressions

  // code-gauge-allow functionCognitiveComplexity -- One case per constructor of Template Haskell's Exp.
  private exp(slot: Slot): Expr {
    const { span } = this;
    const e = this.con(slot);
    const f = e.fields;
    switch (e.con.name) {
      case 'VarE':
      case 'UnboundVarE': {
        return { kind: 'var', name: this.ref(f[0], 'var'), span };
      }
      case 'ConE': {
        return { kind: 'con', name: this.ref(f[0], 'con'), span };
      }
      case 'LitE': {
        const lit = this.con(f[0]);
        if (lit.con.name === 'RationalL') {
          const { numerator, denominator, decimal } = this.rational(f[0]);
          if (decimal !== undefined && numerator >= 0n) {
            return { kind: 'lit', lit: { kind: 'frac', value: Number(decimal), text: decimal }, span };
          }
          const ratio: Expr = this.apply(
            { kind: 'support', name: '%', span },
            this.integer(numerator),
            this.integer(denominator)
          );
          return this.apply({ kind: 'support', name: 'fromRational', span }, ratio);
        }
        const literal = this.literal(f[0]) as Literal;
        if (literal.kind === 'int' && literal.value < 0n) {
          return { kind: 'paren', expr: { kind: 'neg', expr: this.integer(-literal.value), span }, span };
        }
        return { kind: 'lit', lit: literal, span };
      }
      case 'AppE': {
        const arg = this.con(f[1]);
        if (arg.con.name === 'TypeE') {
          return { kind: 'tyapp', expr: this.exp(f[0]), type: this.type(arg.fields[0]), required: true, span };
        }
        return { kind: 'app', fn: this.exp(f[0]), arg: this.exp(f[1]), span };
      }
      case 'AppTypeE': {
        return { kind: 'tyapp', expr: this.exp(f[0]), type: this.type(f[1]), span };
      }
      case 'InfixE': {
        return this.infix(this.maybe(f[0]), f[1], this.maybe(f[2]));
      }
      case 'UInfixE': {
        return { kind: 'chain', items: this.chain(slot), span };
      }
      case 'ParensE': {
        return { kind: 'paren', expr: this.exp(f[0]), span };
      }
      case 'LamE': {
        return { kind: 'lambda', pats: this.list(f[0]).map((p) => this.pat(p)), body: this.exp(f[1]), span };
      }
      case 'LamCaseE': {
        const name = ' case0';
        return {
          kind: 'lambda',
          pats: [{ kind: 'pvar', name: { name, span }, span }],
          body: {
            kind: 'case',
            scrutinee: { kind: 'var', name: { name, span }, span },
            alts: this.list(f[0]).map((m) => this.match(m)),
            span,
            what: String.raw`\case`,
          },
          span,
        };
      }
      case 'TupE': {
        const slots = this.list(f[0]).map((elem) => this.maybe(elem));
        if (slots.length === 1 && slots[0]) return { kind: 'paren', expr: this.exp(slots[0]), span };
        if (slots.every(Boolean)) return { kind: 'tuple', elems: slots.map((elem) => this.exp(elem as Slot)), span };
        const pats: Pat[] = [];
        const elems = slots.map((elem): Expr => {
          if (elem) return this.exp(elem);
          const name = ` section${pats.length}`;
          pats.push({ kind: 'pvar', name: { name, span }, span });
          return { kind: 'var', name: { name, span }, span };
        });
        return { kind: 'lambda', pats, body: { kind: 'tuple', elems, span }, span };
      }
      case 'CondE': {
        return { kind: 'if', cond: this.exp(f[0]), ifTrue: this.exp(f[1]), ifFalse: this.exp(f[2]), span };
      }
      case 'MultiIfE': {
        const branches = this.list(f[0]).map((alt) => this.guarded(alt));
        return {
          kind: 'case',
          scrutinee: { kind: 'con', name: { name: '()', span }, span },
          alts: [{ pat: { kind: 'pwild', span }, rhs: { body: { kind: 'guarded', branches }, where: [], span }, span }],
          span,
          what: 'multi-way if',
        };
      }
      case 'LetE': {
        return { kind: 'let', decls: this.decs(f[0]), body: this.exp(f[1]), span };
      }
      case 'CaseE': {
        return { kind: 'case', scrutinee: this.exp(f[0]), alts: this.list(f[1]).map((m) => this.match(m)), span };
      }
      case 'DoE':
      case 'MDoE': {
        if (this.maybe(f[0])) return this.unavailable('exp');
        const stmts = this.list(f[1]).map((s) => this.stmt(s));
        if (e.con.name === 'DoE' || stmts.length < 2) return { kind: 'do', stmts, span };
        const last = stmts.at(-1) as Stmt;
        return { kind: 'do', stmts: [{ kind: 'rec', stmts: stmts.slice(0, -1), segmented: true, span }, last], span };
      }
      case 'CompE': {
        const stmts = this.list(f[0]);
        const last = stmts.length > 0 ? this.con(stmts.at(-1) as Slot) : undefined;
        if (last?.con.name !== 'NoBindS') return this.unavailable('exp');
        const quals = stmts.slice(0, -1);
        const parallel = quals.length === 1 ? this.con(quals[0]) : undefined;
        if (parallel?.con.name === 'ParS') {
          const branches = this.list(parallel.fields[0]).map((branch) => this.list(branch).map((s) => this.stmt(s)));
          return {
            kind: 'comprehension',
            expr: this.exp(last.fields[0]),
            quals: branches[0] ?? [],
            parallel: branches.slice(1),
            span,
          };
        }
        return { kind: 'comprehension', expr: this.exp(last.fields[0]), quals: quals.map((s) => this.stmt(s)), span };
      }
      case 'ArithSeqE': {
        const range = this.con(f[0]);
        const parts = range.fields.map((part) => this.exp(part));
        const [next, to] =
          range.con.name === 'FromR'
            ? []
            : range.con.name === 'FromThenR'
              ? [parts[1]]
              : range.con.name === 'FromToR'
                ? [undefined, parts[1]]
                : [parts[1], parts[2]];
        const sequence: Extract<Expr, { kind: 'arith' }> = {
          kind: 'arith',
          from: parts[0],
          ...(next ? { next } : {}),
          ...(to ? { to } : {}),
          span,
        };
        return this.site.allows('overloadedLists') ? overloadedSequence(sequence) : sequence;
      }
      case 'ListE': {
        const list: Extract<Expr, { kind: 'list' }> = {
          kind: 'list',
          elems: this.list(f[0]).map((elem) => this.exp(elem)),
          span,
        };
        return this.site.allows('overloadedLists') ? overloadedList(list) : list;
      }
      case 'SigE': {
        return { kind: 'typed', expr: this.exp(f[0]), sig: this.sigType(f[1]), span };
      }
      case 'RecConE': {
        return { kind: 'recordCon', con: this.ref(f[0], 'con'), fields: this.fieldBinds(f[1]), span };
      }
      case 'RecUpdE': {
        return { kind: 'recordUpdate', expr: this.exp(f[0]), fields: this.fieldBinds(f[1]), span };
      }
      case 'LabelE': {
        return {
          kind: 'tyapp',
          expr: { kind: 'support', name: 'overloadedFromLabel', span },
          type: { kind: 'tlit', value: this.str(f[0]), span },
          span,
        };
      }
      case 'ImplicitParamVarE': {
        return { kind: 'implicit', name: this.str(f[0]), span };
      }
      case 'GetFieldE': {
        return { kind: 'projection', expr: this.exp(f[0]), field: this.str(f[1]), span };
      }
      case 'ProjectionE': {
        const name = ' record0';
        let body: Expr = { kind: 'var', name: { name, span }, span };
        for (const label of this.nonEmpty(f[0]))
          body = { kind: 'projection', expr: body, field: this.str(label), span };
        return { kind: 'lambda', pats: [{ kind: 'pvar', name: { name, span }, span }], body, span };
      }
      case 'LamCasesE':
      case 'UnboxedTupE':
      case 'UnboxedSumE':
      case 'StaticE':
      case 'TypedBracketE':
      case 'TypedSpliceE':
      case 'TypeE': {
        return this.unavailable('exp');
      }
      default: {
        throw new Error(`Unknown Exp constructor ${e.con.name}`);
      }
    }
  }

  private integer(value: bigint): Expr {
    return { kind: 'lit', lit: { kind: 'int', value }, span: this.span };
  }

  private apply(fn: Expr, ...args: Expr[]): Expr {
    let result = fn;
    for (const arg of args) result = { kind: 'app', fn: result, arg, span: this.span };
    return result;
  }

  /** An operator applied to optional operands: a binary application, a section, or the operator alone. */
  private infix(left: Slot | undefined, opSlot: Slot, right: Slot | undefined): Expr {
    const { span } = this;
    const opValue = this.con(opSlot);
    const named = ['VarE', 'ConE', 'UnboundVarE'].includes(opValue.con.name);
    if (!named) {
      const fn = this.exp(opSlot);
      if (left && right) return this.apply(fn, this.exp(left), this.exp(right));
      if (left) return this.apply(fn, this.exp(left));
      if (right) {
        const name = ' section0';
        const x: Expr = { kind: 'var', name: { name, span }, span };
        return {
          kind: 'lambda',
          pats: [{ kind: 'pvar', name: { name, span }, span }],
          body: this.apply(fn, x, this.exp(right)),
          span,
        };
      }
      return fn;
    }
    const op = this.operator(opValue.fields[0]);
    if (left && right) return { kind: 'binop', op, left: this.exp(left), right: this.exp(right), span };
    if (left) return { kind: 'leftSection', left: this.exp(left), op, span };
    if (right) return { kind: 'rightSection', op, right: this.exp(right), span };
    return op.isConstructor ? { kind: 'con', name: op, span } : { kind: 'var', name: op, span };
  }

  /** A chain of `UInfixE`s, which the renamer resolves by the operators' fixities. */
  private chain(slot: Slot): ChainItem<Expr>[] {
    const e = this.con(slot);
    if (e.con.name !== 'UInfixE') return [{ kind: 'operand', value: this.exp(slot) }];
    const op = this.con(e.fields[1]);
    if (!['VarE', 'ConE', 'UnboundVarE'].includes(op.con.name)) return this.unavailable('exp');
    return [
      ...this.chain(e.fields[0]),
      { kind: 'operator', op: this.operator(op.fields[0]) },
      ...this.chain(e.fields[2]),
    ];
  }

  private fieldBinds(slot: Slot): { field: QName; value: Expr; span: Span }[] {
    return this.list(slot).map((pair) => {
      const [name, value] = this.con(pair).fields;
      return { field: this.ref(name, 'var'), value: this.exp(value), span: this.span };
    });
  }

  private match(slot: Slot): Alt {
    const [pat, body, decs] = this.con(slot).fields;
    return { pat: this.pat(pat), rhs: this.rhs(body, decs), span: this.span };
  }

  private rhs(bodySlot: Slot, decsSlot: Slot): Rhs {
    const body = this.con(bodySlot);
    const where = this.decs(decsSlot);
    if (body.con.name === 'NormalB')
      return { body: { kind: 'plain', expr: this.exp(body.fields[0]) }, where, span: this.span };
    return {
      body: { kind: 'guarded', branches: this.list(body.fields[0]).map((pair) => this.guarded(pair)) },
      where,
      span: this.span,
    };
  }

  private guarded(slot: Slot): GuardedExpr {
    const [guardSlot, expr] = this.con(slot).fields;
    const guard = this.con(guardSlot);
    const guards: Guard[] =
      guard.con.name === 'NormalG'
        ? [{ kind: 'bool', expr: this.exp(guard.fields[0]), span: this.span }]
        : this.list(guard.fields[0]).map((stmt) => this.guardStmt(stmt));
    return { guards, expr: this.exp(expr), span: this.span };
  }

  private guardStmt(slot: Slot): Guard {
    const stmt = this.stmt(slot);
    switch (stmt.kind) {
      case 'bind': {
        return { kind: 'pat', pat: stmt.pat, expr: stmt.expr, span: this.span };
      }
      case 'let': {
        return { kind: 'let', decls: stmt.decls, span: this.span };
      }
      case 'exp': {
        return { kind: 'bool', expr: stmt.expr, span: this.span };
      }
      case 'transform':
      case 'rec': {
        return this.unavailable('exp');
      }
    }
  }

  private stmt(slot: Slot): Stmt {
    const { span } = this;
    const s = this.con(slot);
    switch (s.con.name) {
      case 'BindS': {
        return { kind: 'bind', pat: this.pat(s.fields[0]), expr: this.exp(s.fields[1]), span };
      }
      case 'LetS': {
        return { kind: 'let', decls: this.decs(s.fields[0]), span };
      }
      case 'NoBindS': {
        return { kind: 'exp', expr: this.exp(s.fields[0]), span };
      }
      case 'RecS': {
        return { kind: 'rec', stmts: this.list(s.fields[0]).map((inner) => this.stmt(inner)), span };
      }
      case 'ParS': {
        return this.unavailable('exp');
      }
      default: {
        throw new Error(`Unknown Stmt constructor ${s.con.name}`);
      }
    }
  }

  // Patterns

  // code-gauge-allow functionCognitiveComplexity -- One case per constructor of Template Haskell's Pat.
  private pat(slot: Slot): Pat {
    const { span } = this;
    const p = this.con(slot);
    const f = p.fields;
    switch (p.con.name) {
      case 'LitP': {
        const lit = this.con(f[0]);
        if (lit.con.name === 'RationalL') {
          const { numerator, decimal } = this.rational(f[0]);
          if (decimal === undefined) {
            throw unsupportedError(span, '有限の小数で書けない分数のパターン');
          }
          const literal: SourceLiteral = { kind: 'frac', value: Number(decimal), text: decimal };
          return { kind: 'plit', lit: literal, negative: numerator < 0n, span };
        }
        const literal = this.literal(f[0]) as Literal;
        if (literal.kind === 'int') {
          const negative = literal.value < 0n;
          const value = negative ? -literal.value : literal.value;
          return { kind: 'plit', lit: { kind: 'int', value, text: String(value) }, negative, span };
        }
        return { kind: 'plit', lit: { ...literal, text: '' }, negative: false, span };
      }
      case 'VarP': {
        return { kind: 'pvar', name: this.binder(f[0]), span };
      }
      case 'TupP': {
        const elems = this.list(f[0]).map((elem) => this.pat(elem));
        return elems.length === 1 ? elems[0] : { kind: 'ptuple', elems, span };
      }
      case 'ConP': {
        return { kind: 'pcon', con: this.ref(f[0], 'con'), args: this.list(f[2]).map((arg) => this.pat(arg)), span };
      }
      case 'InfixP': {
        return { kind: 'pcon', con: this.ref(f[1], 'con'), args: [this.pat(f[0]), this.pat(f[2])], span };
      }
      case 'UInfixP': {
        return { kind: 'pchain', items: this.patChain(slot), span };
      }
      case 'ParensP': {
        return this.pat(f[0]);
      }
      case 'TildeP': {
        return { kind: 'plazy', pat: this.pat(f[0]), span };
      }
      case 'BangP': {
        return { kind: 'pbang', pat: this.pat(f[0]), span };
      }
      case 'AsP': {
        return { kind: 'pas', name: this.binder(f[0]), pat: this.pat(f[1]), span };
      }
      case 'WildP': {
        return { kind: 'pwild', span };
      }
      case 'RecP': {
        const fields = this.list(f[1]).map((pair) => {
          const [name, inner] = this.con(pair).fields;
          return { field: this.ref(name, 'var'), pat: this.pat(inner), span };
        });
        return { kind: 'precord', con: this.ref(f[0], 'con'), fields, span };
      }
      case 'ListP': {
        const list: Extract<Pat, { kind: 'plist' }> = {
          kind: 'plist',
          elems: this.list(f[0]).map((elem) => this.pat(elem)),
          span,
        };
        return this.site.allows('overloadedLists') ? overloadedListPattern(list) : list;
      }
      case 'SigP': {
        return { kind: 'psig', pat: this.pat(f[0]), type: this.type(f[1]), span };
      }
      case 'ViewP': {
        return { kind: 'pview', expr: this.exp(f[0]), exprText: '', pat: this.pat(f[1]), span };
      }
      case 'OrP': {
        return { kind: 'por', alts: this.nonEmpty(f[0]).map((alt) => this.pat(alt)), span };
      }
      case 'UnboxedTupP':
      case 'UnboxedSumP':
      case 'TypeP':
      case 'InvisP': {
        return this.unavailable('pat');
      }
      default: {
        throw new Error(`Unknown Pat constructor ${p.con.name}`);
      }
    }
  }

  private patChain(slot: Slot): ChainItem<Pat>[] {
    const p = this.con(slot);
    if (p.con.name !== 'UInfixP') return [{ kind: 'operand', value: this.pat(slot) }];
    return [
      ...this.patChain(p.fields[0]),
      { kind: 'operator', op: this.operator(p.fields[1]) },
      ...this.patChain(p.fields[2]),
    ];
  }

  // Types

  // code-gauge-allow functionCognitiveComplexity -- One case per constructor of Template Haskell's Type.
  private type(slot: Slot): TypeExpr {
    const { span } = this;
    const t = this.con(slot);
    const f = t.fields;
    switch (t.con.name) {
      case 'ForallT': {
        const binders = this.list(f[0]).map((b) => this.tyVar(b));
        const context = this.cxt(f[1]);
        const body = this.type(f[2]);
        if (binders.length === 0 && context.length === 0) return body;
        return { kind: 'tforall', binders, context, body, span };
      }
      case 'AppT': {
        return this.typeApplication(slot);
      }
      case 'AppKindT': {
        return { kind: 'tkindapp', type: this.type(f[0]), kindArg: this.type(f[1]), span };
      }
      case 'SigT': {
        return { kind: 'tkinded', type: this.type(f[0]), kindSig: this.type(f[1]), span };
      }
      case 'VarT': {
        return { kind: 'tvar', name: this.binder(f[0]).name, span };
      }
      case 'ConT': {
        return { kind: 'tcon', name: this.ref(f[0], 'type'), span };
      }
      case 'PromotedT': {
        return { kind: 'tpromoted', name: this.ref(f[0], 'con'), span };
      }
      case 'InfixT': {
        const op: TypeExpr = { kind: 'tcon', name: this.ref(f[1], 'type'), span };
        return { kind: 'tapp', fn: { kind: 'tapp', fn: op, arg: this.type(f[0]), span }, arg: this.type(f[2]), span };
      }
      case 'ParensT': {
        return this.type(f[0]);
      }
      case 'TupleT': {
        const arity = Number(this.int(f[0]));
        return { kind: 'tcon', name: { name: arity === 0 ? '()' : `(${','.repeat(arity - 1)})`, span }, span };
      }
      case 'ArrowT': {
        return { kind: 'tcon', name: { name: '->', span }, span };
      }
      case 'ListT': {
        return { kind: 'tcon', name: { name: '[]', span }, span };
      }
      case 'EqualityT': {
        return { kind: 'tcon', name: { name: '~', span }, span };
      }
      case 'StarT':
      case 'ConstraintT': {
        const name = t.con.name === 'StarT' ? 'Type' : 'Constraint';
        return {
          kind: 'tcon',
          name: { name, global: { module: 'GHC.Internal.Types', namespace: 'type' }, span },
          span,
        };
      }
      case 'LitT': {
        const lit = this.con(f[0]);
        if (lit.con.name === 'NumTyLit') return { kind: 'tlit', value: this.int(lit.fields[0]), span };
        if (lit.con.name === 'StrTyLit') return { kind: 'tlit', value: this.str(lit.fields[0]), span };
        return this.unavailable('type');
      }
      case 'WildCardT': {
        throw unsupportedError(span, '型の中の _（PartialTypeSignatures）');
      }
      case 'ForallVisT':
      case 'UInfixT':
      case 'PromotedInfixT':
      case 'PromotedUInfixT':
      case 'UnboxedTupleT':
      case 'UnboxedSumT':
      case 'MulArrowT':
      case 'PromotedTupleT':
      case 'PromotedNilT':
      case 'PromotedConsT':
      case 'ImplicitParamT': {
        return this.unavailable('type');
      }
      default: {
        throw new Error(`Unknown Type constructor ${t.con.name}`);
      }
    }
  }

  /** An application of types, where `a -> b`, `[a]`, and `(a, b)` take the forms their syntax has. */
  private typeApplication(slot: Slot): TypeExpr {
    const { span } = this;
    const args: Slot[] = [];
    let head = this.con(slot);
    let headSlot = slot;
    while (head.con.name === 'AppT') {
      args.unshift(head.fields[1]);
      headSlot = head.fields[0];
      head = this.con(headSlot);
    }
    if (head.con.name === 'ArrowT' && args.length === 2) {
      return { kind: 'tfun', from: this.type(args[0]), to: this.type(args[1]), span };
    }
    if (head.con.name === 'ListT' && args.length === 1) return { kind: 'tlist', elem: this.type(args[0]), span };
    if (head.con.name === 'TupleT' && Number(this.int(head.fields[0])) === args.length && args.length > 1) {
      return { kind: 'ttuple', elems: args.map((arg) => this.type(arg)), span };
    }
    let result = this.type(headSlot);
    for (const arg of args) result = { kind: 'tapp', fn: result, arg: this.type(arg), span };
    return result;
  }

  private cxt(slot: Slot): Constraint[] {
    return this.list(slot).map((pred) => this.type(pred));
  }

  private tyVar(slot: Slot): TyVarBinder {
    const b = this.con(slot);
    const binder: TyVarBinder = { name: this.binder(b.fields[0]) };
    const flag = this.con(b.fields[1]).con.name;
    if (flag === 'InferredSpec') binder.inferred = true;
    if (b.con.name === 'KindedTV') binder.kind = this.type(b.fields[2]);
    return binder;
  }

  /** A signature's type, whose outermost `forall` and context become the signature's own. */
  private sigType(slot: Slot): SigType {
    const t = this.con(slot);
    if (t.con.name === 'ForallT') {
      const binders = this.list(t.fields[0]).map((b) => this.tyVar(b));
      return {
        context: this.cxt(t.fields[1]),
        type: this.type(t.fields[2]),
        span: this.span,
        ...(binders.length > 0 ? { forall: binders } : {}),
      };
    }
    return { context: [], type: this.type(slot), span: this.span };
  }

  // Declarations

  private decs(slot: Slot): Decl[] {
    return this.list(slot).flatMap((dec) => this.dec(dec));
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per constructor of Template Haskell's Dec.
  private dec(slot: Slot): Decl[] {
    const { span } = this;
    const d = this.con(slot);
    const f = d.fields;
    switch (d.con.name) {
      case 'FunD': {
        const name = this.binder(f[0]);
        return this.list(f[1]).map((clauseSlot) => {
          const [pats, body, decs] = this.con(clauseSlot).fields;
          return {
            kind: 'funClause',
            name,
            args: this.list(pats).map((p) => this.pat(p)),
            rhs: this.rhs(body, decs),
            span,
          };
        });
      }
      case 'ValD': {
        const pat = this.pat(f[0]);
        const rhs = this.rhs(f[1], f[2]);
        if (pat.kind === 'pvar') return [{ kind: 'funClause', name: pat.name, args: [], rhs, span }];
        return [{ kind: 'patBind', pat, rhs, span }];
      }
      case 'SigD':
      case 'DefaultSigD': {
        return [
          {
            kind: 'sig',
            names: [this.binder(f[0])],
            sig: this.sigType(f[1]),
            span,
            ...(d.con.name === 'DefaultSigD' ? { isDefault: true } : {}),
          },
        ];
      }
      case 'KiSigD': {
        return [{ kind: 'kindSig', name: this.binder(f[0]), kindSig: this.type(f[1]), span }];
      }
      case 'TySynD': {
        const binders = this.list(f[1]).map((b) => this.tyVar(b));
        return [{ kind: 'typeSyn', name: this.binder(f[0]), ...this.params(binders), type: this.type(f[2]), span }];
      }
      case 'DataD':
      case 'NewtypeD': {
        const newtype = d.con.name === 'NewtypeD';
        const context = this.cxt(f[0]);
        const binders = this.list(f[2]).map((b) => this.tyVar(b));
        const kind = this.maybe(f[3]);
        const cons = newtype ? [this.conDecl(f[4])] : this.list(f[4]).map((con) => this.conDecl(con));
        return [
          {
            kind: 'data',
            name: this.binder(f[1]),
            ...this.params(binders),
            ...(kind ? { kindSig: this.type(kind) } : {}),
            ...(context.length > 0 ? { datatypeContext: context } : {}),
            cons,
            deriving: this.list(f[5]).flatMap((clause) => this.derivClause(clause)),
            span,
            ...(newtype ? { newtype: true } : {}),
          },
        ];
      }
      case 'ClassD': {
        const binders = this.list(f[2]).map((b) => this.tyVar(b));
        const fundeps = this.list(f[3]).map((fundep) => {
          const [from, to] = this.con(fundep).fields;
          return { from: this.list(from).map((n) => this.binder(n)), to: this.list(to).map((n) => this.binder(n)) };
        });
        return [
          {
            kind: 'class',
            context: this.cxt(f[0]),
            name: this.binder(f[1]),
            ...this.params(binders),
            fundeps,
            decls: this.decs(f[4]),
            span,
          },
        ];
      }
      case 'InstanceD': {
        const overlap = this.maybe(f[0]);
        const { cls, types } = this.instanceHead(f[2]);
        return [
          {
            kind: 'instance',
            context: this.cxt(f[1]),
            cls,
            types,
            decls: this.decs(f[3]),
            ...(overlap ? { overlap: this.con(overlap).con.name.toUpperCase() as 'OVERLAPS' } : {}),
            span,
          },
        ];
      }
      case 'StandaloneDerivD': {
        const strategySlot = this.maybe(f[0]);
        const { cls, types } = this.instanceHead(f[2]);
        if (types.length !== 1) return this.unavailable('dec');
        return [
          {
            kind: 'standaloneDeriving',
            context: this.cxt(f[1]),
            cls,
            type: types[0],
            ...(strategySlot ? this.strategy(strategySlot) : {}),
            span,
          },
        ];
      }
      case 'InfixD': {
        const [precSlot, dirSlot] = this.con(f[0]).fields;
        const dir = this.con(dirSlot).con.name;
        const assoc = dir === 'InfixL' ? 'infixl' : dir === 'InfixR' ? 'infixr' : 'infix';
        return [{ kind: 'fixity', assoc, prec: Number(this.int(precSlot)), ops: [this.binder(f[2])], span }];
      }
      case 'DefaultD': {
        return [{ kind: 'defaultTypes', types: this.list(f[0]).map((t) => this.type(t)), span }];
      }
      case 'RoleAnnotD': {
        const roles = this.list(f[1]).map((role) => {
          const name = this.con(role).con.name;
          return name === 'NominalR'
            ? 'nominal'
            : name === 'RepresentationalR'
              ? 'representational'
              : name === 'PhantomR'
                ? 'phantom'
                : undefined;
        });
        return [{ kind: 'roleAnnotation', name: this.ref(f[0], 'type'), roles, span }];
      }
      case 'TypeDataD': {
        const binders = this.list(f[1]).map((b) => this.tyVar(b));
        const kind = this.maybe(f[2]);
        return [
          {
            kind: 'data',
            name: this.binder(f[0]),
            ...this.params(binders),
            typeData: true,
            ...(kind ? { kindSig: this.type(kind) } : {}),
            cons: this.list(f[3]).map((con) => this.conDecl(con)),
            deriving: [],
            span,
          },
        ];
      }
      case 'ImplicitParamBindD': {
        return this.unavailable('dec');
      }
      default: {
        return this.unavailable('dec');
      }
    }
  }

  private params(binders: TyVarBinder[]): { params: Name[]; paramKinds?: (TypeExpr | undefined)[] } {
    const kinds = binders.map((binder) => binder.kind);
    return {
      params: binders.map((binder) => binder.name),
      ...(kinds.some(Boolean) ? { paramKinds: kinds } : {}),
    };
  }

  /** An instance's head, `C t1 t2`, as its class and types. */
  private instanceHead(slot: Slot): { cls: QName; types: TypeExpr[] } {
    const types: Slot[] = [];
    let head = this.con(slot);
    while (head.con.name === 'AppT') {
      types.unshift(head.fields[1]);
      head = this.con(head.fields[0]);
    }
    if (head.con.name !== 'ConT') return this.unavailable('dec');
    return { cls: this.ref(head.fields[0], 'type'), types: types.map((type) => this.type(type)) };
  }

  private strategy(slot: Slot): { strategy: DerivingClause['strategy']; via?: TypeExpr } {
    const s = this.con(slot);
    switch (s.con.name) {
      case 'StockStrategy': {
        return { strategy: 'stock' };
      }
      case 'AnyclassStrategy': {
        return { strategy: 'anyclass' };
      }
      case 'NewtypeStrategy': {
        return { strategy: 'newtype' };
      }
      default: {
        return { strategy: 'via', via: this.type(s.fields[0]) };
      }
    }
  }

  private derivClause(slot: Slot): DerivingClause[] {
    const [strategySlot, classes] = this.con(slot).fields;
    const strategy = this.maybe(strategySlot);
    const extra = strategy ? this.strategy(strategy) : {};
    return this.cxt(classes).map((type) => {
      if (type.kind !== 'tcon') return this.unavailable('dec');
      return { cls: type.name, ...extra, span: this.span };
    });
  }

  private conDecl(slot: Slot): ConDecl {
    const { span } = this;
    const c = this.con(slot);
    const f = c.fields;
    switch (c.con.name) {
      case 'NormalC':
      case 'RecC': {
        const record = c.con.name === 'RecC';
        const strict: number[] = [];
        const fields: TypeExpr[] = [];
        const fieldNames: Name[] = [];
        for (const [index, item] of this.list(f[1]).entries()) {
          const parts = this.con(item).fields;
          if (record) fieldNames.push(this.binder(parts[0]));
          const [bang, type] = record ? [parts[1], parts[2]] : [parts[0], parts[1]];
          if (this.isStrict(bang)) strict.push(index);
          fields.push(this.type(type));
        }
        return {
          name: this.binder(f[0]),
          fields,
          ...(strict.length > 0 ? { strictFields: strict } : {}),
          ...(record ? { fieldNames } : {}),
          isInfix: false,
          span,
        };
      }
      case 'InfixC': {
        const [leftBang, leftType] = this.con(f[0]).fields;
        const [rightBang, rightType] = this.con(f[2]).fields;
        const strict = [this.isStrict(leftBang) ? 0 : -1, this.isStrict(rightBang) ? 1 : -1].filter((i) => i >= 0);
        return {
          name: this.binder(f[1]),
          fields: [this.type(leftType), this.type(rightType)],
          ...(strict.length > 0 ? { strictFields: strict } : {}),
          isInfix: true,
          span,
        };
      }
      case 'ForallC': {
        const inner = this.conDecl(f[2]);
        const exVars = this.list(f[0]).map((b) => this.tyVar(b));
        const context = this.cxt(f[1]);
        return {
          ...inner,
          ...(exVars.length > 0 ? { exVars } : {}),
          ...(context.length > 0 ? { context } : {}),
        };
      }
      default: {
        return this.unavailable('con');
      }
    }
  }

  /** Whether a field is strict: marked `!`, or under the splice site's StrictData not marked `~`. */
  private isStrict(slot: Slot): boolean {
    const strictness = this.con(this.con(slot).fields[1]).con.name;
    return strictness === 'SourceStrict' || (strictness !== 'SourceLazy' && this.site.allows('strictData'));
  }
}

/** Names of special syntax, which every module has and no qualifier or identity names. */
function isSpecialSyntax(occ: string): boolean {
  return occ === '[]' || occ === '()' || occ === ':' || occ === '->' || /^\(,+\)$/.test(occ);
}

/** The finite decimal a fraction is, `2.25` for 9/4, or `undefined` when it has none. */
function decimalOf(numerator: bigint, denominator: bigint): string | undefined {
  // The decimal has as many digits as the larger count of 2s and 5s in the denominator, paid for before it is built.
  const twos = removeFactor(denominator, 2n);
  const fives = removeFactor(twos.rest, 5n);
  if (fives.rest !== 1n) return undefined;
  const digits = Math.max(twos.count, fives.count);
  chargeTypeWork(digits);
  const scale = 10n ** BigInt(digits);
  const scaled = numerator * (scale / denominator);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(digits, '0');
  return `${whole}.${digits === 0 ? '0' : fraction}`;
}

/**
 * How many times a prime divides a number, and what is left: by dividing by the prime's squarings, `p`, `p^2`, `p^4`,
 * ..., largest first, in a number of divisions logarithmic in the count, each paid for by its operands' size.
 */
function removeFactor(value: bigint, prime: bigint): { count: number; rest: bigint } {
  const powers: { power: bigint; exponent: number }[] = [];
  for (let power = prime, exponent = 1; divides(power, value); power *= power, exponent *= 2) {
    powers.push({ power, exponent });
  }
  let rest = value;
  let count = 0;
  for (const { power, exponent } of powers.toReversed()) {
    if (!divides(power, rest)) continue;
    rest /= power;
    count += exponent;
  }
  return { count, rest };
}

/** Whether a number divides another, paid for by their sizes. */
function divides(divisor: bigint, dividend: bigint): boolean {
  chargeTypeWork(wordsOf(dividend) + wordsOf(divisor));
  return dividend % divisor === 0n;
}

/** The size of a number in 64-bit words, which the cost of dividing it grows with. */
function wordsOf(value: bigint): number {
  return Math.ceil(value.toString(16).length / 16);
}
