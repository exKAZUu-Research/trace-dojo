import type { ProgramRecording } from '../interpreter/interpreter';
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItem, TraceItemVariable } from '../problems/trace';
import { parseBash } from './parse';
import { runProgram } from './run';
import { type Frame, Runtime } from './runtime';
import { Shell } from './shell';
import {
  type ReadonlyAssociativeTable,
  type ReadonlyIndexedTable,
  sortedElements,
  type VariableView,
} from './variables';

const NODE_COST = 32;

// oxlint-disable-next-line unicorn/no-null -- Trace format represents null references as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

interface IndexedSnapshot {
  readonly version: number;
  readonly turtleEpoch: number;
  readonly hasTurtle: boolean;
  readonly denseValues: string[] | undefined;
  readonly displayNode: DisplayNode;
  readonly snapshotCost: number;
}

interface AssociativeSnapshot {
  readonly version: number;
  readonly turtleEpoch: number;
  readonly hasTurtle: boolean;
  readonly scalarEntries: readonly [string, string][];
  readonly displayNode: DisplayNode;
  readonly snapshotCost: number;
}

// code-gauge-allow duplicateLines -- Each language's trace entry point wires its runtime into the shared recorder in the same way.
export function traceBashProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parseBash(program, trace);
  const runtime = new Runtime(input);
  const shell = new Shell(runtime);
  const snapshotter = new TraceSnapshotter(runtime);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
    scalarVarsOf: (frame) => snapshotter.variablesOf(frame, false).vars,
    recordItem: (item) => snapshotter.recordItem(item),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  const run = runProgram(shell, parsed, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  snapshotter.chargeScalarMap(finalVars);
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/**
 * Pure frame-bounded variable projection with per-container snapshot reuse and cumulative trace-size accounting:
 * unchanged indexed and associative containers share immutable `DisplayNode` and dense `string[]` snapshots across steps.
 */
class TraceSnapshotter {
  private remainingTotal = LIMITS.maxDartTraceSize;
  private remainingSnapshot = LIMITS.maxTraceSize;
  private readonly indexedCache = new WeakMap<ReadonlyIndexedTable, IndexedSnapshot>();
  private readonly associativeCache = new WeakMap<ReadonlyAssociativeTable, AssociativeSnapshot>();
  private readonly objectCosts = new WeakMap<object, number>();
  private readonly chargedObjects = new WeakSet<object>();

  constructor(private readonly runtime: Runtime) {}

  variablesOf(frame: Frame, includeReferences: boolean): TraceVariables {
    this.remainingSnapshot = LIMITS.maxTraceSize;
    const { store } = frame;
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    for (const view of store.visibleViews(frame.scopeIndex)) {
      const resolved = store.resolveViewInFrame(view, frame.scopeIndex);
      if (!resolved || resolved.kind === 'unset') continue;
      this.addVariable(variables, view.name, resolved, includeReferences);
      if (view.attributes.has('n') && resolved.kind === 'associative') {
        this.addNamerefFields(variables, view.name, resolved.associative as ReadonlyAssociativeTable);
      }
    }
    return variables;
  }

  recordItem(item: TraceItem): TraceItem {
    this.chargeTotal(item.board.length + NODE_COST * (item.callLines.length + item.turtles.length * 4 + 1));
    this.chargeScalarMap(item.vars);
    for (const [name, node] of Object.entries(item.referenceVars)) {
      this.chargeTotal(name.length + 8);
      this.chargeSharedObject(node);
    }
    return item;
  }

  chargeScalarMap(vars: TraceItemVariable): void {
    for (const [name, value] of Object.entries(vars)) {
      this.chargeTotal(name.length);
      if (Array.isArray(value)) {
        this.chargeTotal(8);
        this.chargeSharedObject(value);
      } else {
        this.chargeTotal(NODE_COST + String(value).length);
      }
    }
  }

  private addVariable(variables: TraceVariables, name: string, view: VariableView, includeReferences: boolean): void {
    if (view.kind === 'unset') return;
    if (view.kind === 'scalar') {
      this.addScalarVariable(variables, name, view, includeReferences);
      return;
    }
    if (view.kind === 'indexed') {
      const snap = this.indexedSnapshot(view.indexed as ReadonlyIndexedTable);
      if (snap.denseValues) define(variables.vars, name, snap.denseValues);
      if (includeReferences) define(variables.referenceVars, name, snap.displayNode);
      return;
    }
    if (!includeReferences) return;
    const snap = this.associativeSnapshot(view.associative as ReadonlyAssociativeTable);
    define(variables.referenceVars, name, snap.displayNode);
  }

  private addScalarVariable(
    variables: TraceVariables,
    name: string,
    view: VariableView,
    includeReferences: boolean
  ): void {
    const text = view.scalar ?? '';
    if (this.runtime.isTurtleHandle(text)) {
      if (!includeReferences) return;
      const turtle = turtleNode(this.runtime, text);
      if (turtle) {
        this.spendSnapshot(NODE_COST * 3 + name.length);
        this.objectCosts.set(turtle, NODE_COST * 3);
        define(variables.referenceVars, name, turtle);
      }
      return;
    }
    if (view.nullReference && text === '') {
      if (includeReferences) {
        this.spendSnapshot(NODE_COST + name.length);
        define(variables.referenceVars, name, NULL_NODE);
      }
      return;
    }
    this.spendSnapshot(NODE_COST + name.length + text.length);
    define(variables.vars, name, text);
  }

  private addNamerefFields(variables: TraceVariables, alias: string, table: ReadonlyAssociativeTable): void {
    const snap = this.associativeSnapshot(table);
    for (const [key, element] of snap.scalarEntries) {
      const fieldName = `${alias}[${key}]`;
      this.spendSnapshot(NODE_COST + fieldName.length + element.length);
      define(variables.vars, fieldName, element);
    }
  }

  private indexedSnapshot(table: ReadonlyIndexedTable): IndexedSnapshot {
    const cached = this.indexedCache.get(table);
    if (this.isFreshSnapshot(cached, table.version)) {
      this.spendSnapshot(cached.snapshotCost);
      return cached;
    }
    const entries: Record<string, DisplayNode> = Object.create(null);
    const elements = sortedElements(table);
    let isDense = true;
    let hasTurtle = false;
    let displayCost = NODE_COST;
    let denseCost = NODE_COST;
    for (const [index, [key, element]] of elements.entries()) {
      const { child, isTurtle, valueCost } = this.indexedElementEntry(element);
      hasTurtle ||= isTurtle;
      isDense &&= key === BigInt(index) && !isTurtle;
      const keyText = String(key);
      const stepCost = keyText.length + valueCost;
      displayCost += stepCost;
      denseCost += 8 + element.length;
      this.spendSnapshot(stepCost + 8);
      define(entries, keyText, child);
    }
    const denseValues = isDense ? elements.map(([, element]) => element) : undefined;
    if (denseValues) this.objectCosts.set(denseValues, denseCost);
    const displayNode: DisplayNode = { kind: 'array', entries };
    this.objectCosts.set(displayNode, displayCost);
    const built: IndexedSnapshot = {
      version: table.version,
      turtleEpoch: this.runtime.turtleEpoch,
      hasTurtle,
      denseValues,
      displayNode,
      snapshotCost: displayCost + (denseValues ? denseCost : 0),
    };
    this.indexedCache.set(table, built);
    return built;
  }

  private indexedElementEntry(element: string): { child: DisplayNode; isTurtle: boolean; valueCost: number } {
    if (this.runtime.isTurtleHandle(element)) {
      return {
        child: turtleNode(this.runtime, element) ?? NULL_NODE,
        isTurtle: true,
        valueCost: NODE_COST * 3,
      };
    }
    return { child: { kind: 'value', value: element }, isTurtle: false, valueCost: NODE_COST + element.length };
  }

  private associativeSnapshot(table: ReadonlyAssociativeTable): AssociativeSnapshot {
    const cached = this.associativeCache.get(table);
    if (this.isFreshSnapshot(cached, table.version)) {
      this.spendSnapshot(cached.snapshotCost);
      return cached;
    }
    const entries: Record<string, DisplayNode> = Object.create(null);
    const scalarEntries: [string, string][] = [];
    let hasTurtle = false;
    let displayCost = NODE_COST;
    for (const [key, element] of table.entries()) {
      if (this.runtime.isTurtleHandle(element)) {
        hasTurtle = true;
        const turtle = turtleNode(this.runtime, element);
        if (turtle) {
          displayCost += key.length + NODE_COST * 3;
          this.spendSnapshot(key.length + NODE_COST * 3);
          define(entries, key, turtle);
        }
      } else {
        scalarEntries.push([key, element]);
        displayCost += key.length + NODE_COST + element.length;
        this.spendSnapshot(key.length + NODE_COST + element.length);
        define(entries, key, { kind: 'value', value: element });
      }
    }
    const displayNode: DisplayNode = { kind: 'object', entries };
    this.objectCosts.set(displayNode, displayCost);
    const built: AssociativeSnapshot = {
      version: table.version,
      turtleEpoch: this.runtime.turtleEpoch,
      hasTurtle,
      scalarEntries,
      displayNode,
      snapshotCost: displayCost,
    };
    this.associativeCache.set(table, built);
    return built;
  }

  private isFreshSnapshot<
    T extends { readonly version: number; readonly turtleEpoch: number; readonly hasTurtle: boolean },
  >(cached: T | undefined, version: number): cached is T {
    return (
      cached !== undefined &&
      cached.version === version &&
      (!cached.hasTurtle || cached.turtleEpoch === this.runtime.turtleEpoch)
    );
  }

  private chargeSharedObject(target: object): void {
    if (target === NULL_NODE || this.chargedObjects.has(target)) return;
    this.chargedObjects.add(target);
    this.chargeTotal(this.objectCosts.get(target) ?? NODE_COST);
  }

  private spendSnapshot(cost: number): void {
    this.remainingSnapshot -= cost;
    if (this.remainingSnapshot < 0) throw new ExecutionLimitError('trace');
  }

  private chargeTotal(cost: number): void {
    this.remainingTotal -= cost;
    if (this.remainingTotal < 0) throw new ExecutionLimitError('trace');
  }
}

function define(record: object, name: string, value: unknown): void {
  Object.defineProperty(record, name, { value, enumerable: true, configurable: true, writable: true });
}

function turtleNode(runtime: Runtime, text: string): DisplayNode | undefined {
  const turtle = runtime.turtleOf(text);
  if (!turtle) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}
