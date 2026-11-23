// Refresh with bun scripts/updateIndependentChallengeBank.ts after editing the bank.
import type { ChallengeTarget } from './buildJavaDefinitions';

export const challengeTargets: Record<string, ChallengeTarget> = {
  challengeI1ForkReturn: {
    finalBoard: '#......\n#......\n###....\n#......\n#......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI1BackwardEast: {
    finalBoard: '#......\n#......\n###....\n..#....\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI1OpenArch: {
    finalBoard: '#......\n###....\n###....\n###....\n.#.....\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI1OffsetNotch: {
    finalBoard: '#......\n#......\n###....\n###....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI1CrossbarRetreat: {
    finalBoard: '##.....\n.#.....\n####...\n#......\n#......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI1ReverseHook: {
    finalBoard: '#......\n#......\n#.#....\n####...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI1StairRollback: {
    finalBoard: '#......\n##.....\n.##....\n.#.....\n.#.....\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI1BracketBranch: {
    finalBoard: '#......\n#......\n###....\n###....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI1OpposedArms: {
    finalBoard: '#......\n#......\n###....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI1BackwardCorner: {
    finalBoard: '###....\n..#....\n..##...\n...##..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI2SnapshotCoordinates: {
    finalBoard: '.......\n...#...\n..##...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI2CoordinateExchange: {
    finalBoard: '.......\n...#...\n.###...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI2OverwrittenCandidate: {
    finalBoard: '.......\n.......\n.......\n.##....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI2RemainderSplit: {
    finalBoard: '.......\n.......\n..##...\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI2ConstructionSnapshot: {
    finalBoard: '.......\n..#....\n..##...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI2DependencyDiamond: {
    finalBoard: '.......\n.......\n.#.....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI2SequentialAssignment: {
    finalBoard: '.......\n.......\n.......\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI2DivisionTiming: {
    finalBoard: '.......\n.......\n.......\n..##...\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI2CompoundDependency: {
    finalBoard: '.......\n.......\n.......\n..#....\n..###..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI2RetainedHistory: {
    finalBoard: '.......\n.......\n.......\n.......\n.###...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 5,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI3CountdownRetreat: {
    finalBoard: '.......\n..#....\n..##...\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI3StrideCounter: {
    finalBoard: '.......\n.......\n..###..\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI3ConsumedBudget: {
    finalBoard: '.......\n.#.....\n.#.....\n.#.....\n.##....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI3AccumulatedOrigin: {
    finalBoard: '.......\n...#...\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI3MultiplicativeStop: {
    finalBoard: '.......\n..#....\n..#....\n..#....\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI3ChainedLoops: {
    finalBoard: '.......\n..#....\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI3ShrinkingLimit: {
    finalBoard: '.......\n..#....\n..#....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI3PreupdatedBudget: {
    finalBoard: '.......\n....#..\n...##..\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI3RemainderOrigin: {
    finalBoard: '.......\n.......\n.#.....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI3ZeroPassSection: {
    finalBoard: '.......\n.......\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI4InnerCountdown: {
    finalBoard: '.......\n..#....\n..##...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI4EmptyInnerPass: {
    finalBoard: '.......\n.......\n..##...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI4GridAccumulator: {
    finalBoard: '.......\n....#..\n...##..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI4InnerAlternation: {
    finalBoard: '.......\n.......\n.......\n...##..\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI4DependentStart: {
    finalBoard: '.......\n.......\n..#....\n..#....\n..##...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 5,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI4UpdatedCondition: {
    finalBoard: '.......\n.......\n...###.\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI4IndependentConditions: {
    finalBoard: '.......\n.......\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI4NestedConditions: {
    finalBoard: '.......\n.......\n..#....\n..####.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI4BranchAssignment: {
    finalBoard: '.......\n.......\n..#....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI4LaggedState: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI5OverlappingRanges: {
    finalBoard: '.......\n.......\n..#....\n..#....\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI5DescendingCategories: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI5ComputedSelector: {
    finalBoard: '.......\n.......\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI5GroupedState: {
    finalBoard: '.......\n....#..\n...##..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI5DefaultTransition: {
    finalBoard: '.......\n.......\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI5CaseSequence: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI5SwitchThenCondition: {
    finalBoard: '.......\n.......\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI5AssignmentPriority: {
    finalBoard: '.......\n.......\n...#...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI5NestedSelection: {
    finalBoard: '.......\n.......\n..####.\n.....#.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI5StateCycle: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI6ThresholdBreak: {
    finalBoard: '.......\n...#...\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI6BreakBeforeAction: {
    finalBoard: '.......\n..#....\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI6BreakAfterAction: {
    finalBoard: '.......\n..#....\n..##...\n..#....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI6InnerBreak: {
    finalBoard: '.......\n.......\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI6SkippedSum: {
    finalBoard: '.......\n....#..\n...##..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI6ProgressBeforeContinue: {
    finalBoard: '.......\n..#....\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI6SkipThenStop: {
    finalBoard: '.......\n..#....\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI6GuardedExit: {
    finalBoard: '.......\n.......\n.......\n.......\n..#....\n..##...\n..##...',
    finalTurtles: [
      {
        x: 3,
        y: 5,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI6InnerContinue: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI6SwitchAndLoopExit: {
    finalBoard: '.......\n.......\n..#....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI7ValueSnapshot: {
    finalBoard: '.......\n..#....\n..#....\n..#....\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI7ObjectMutation: {
    finalBoard: '.......\n.......\n..#.#..\n..###..\n....#..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeI7ReturnedBudget: {
    finalBoard: '.......\n..#....\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI7EarlyReturnGuard: {
    finalBoard: '.......\n.......\n..##...\n...#...\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI7ArgumentOrder: {
    finalBoard: '.......\n.......\n...#...\n..##...\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI7NestedComposition: {
    finalBoard: '.......\n..#....\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI7ReturnSkipsSuffix: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI7LocalShadow: {
    finalBoard: '.......\n..#....\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI7PredicateAction: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI7CarriedReturn: {
    finalBoard: '.......\n..#....\n..#....\n..#....\n.##....\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI8ReverseArray: {
    finalBoard: '.......\n.#.....\n.##....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI8MutateBeforeRead: {
    finalBoard: '.......\n.....#.\n....##.\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI8AdjacentComparison: {
    finalBoard: '.......\n.......\n..###..\n....#..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeI8FirstMatch: {
    finalBoard: '.......\n.......\n.#.....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI8CopiedElement: {
    finalBoard: '.......\n.......\n.......\n..#....\n.##....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI8CharacterCount: {
    finalBoard: '.......\n..#....\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeI8ReverseCharacters: {
    finalBoard: '.......\n.......\n..#....\n.##....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI8StringEquality: {
    finalBoard: '.......\n.......\n....#..\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI8WordLengths: {
    finalBoard: '.......\n....#..\n...##..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeI8DelimiterStop: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII1SharedHeading: {
    finalBoard: '.......\n.......\n..#RR..\n..##...\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
      {
        x: 4,
        y: 2,
        color: 'R',
        dir: 'W',
      },
    ],
  },
  challengeII1SwapHandles: {
    finalBoard: '.......\n.......\n.##RR..\n.#.R...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'N',
      },
      {
        x: 3,
        y: 3,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII1RowAlias: {
    finalBoard: '.......\n.......\n..#BB..\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
      {
        x: 3,
        y: 2,
        color: 'B',
        dir: 'N',
      },
    ],
  },
  challengeII1ReplaceSlot: {
    finalBoard: '.......\n.......\n..#RR..\n..#R...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
      {
        x: 3,
        y: 3,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII1DetachAlias: {
    finalBoard: '.......\n.......\n..RBB..\n.RRB...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: 'R',
        dir: 'N',
      },
      {
        x: 3,
        y: 3,
        color: 'B',
        dir: 'N',
      },
    ],
  },
  challengeII1BlockedLane: {
    finalBoard: '.......\n.......\n..#....\n.##R...\n.#.R...\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'N',
      },
      {
        x: 3,
        y: 4,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII1RepeatedEntry: {
    finalBoard: '.......\n..##...\n..#RR..\n...R...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'E',
      },
      {
        x: 3,
        y: 3,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII1PassReference: {
    finalBoard: '.......\n.......\n..#BB..\n..#B...\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
      {
        x: 3,
        y: 3,
        color: 'B',
        dir: 'E',
      },
    ],
  },
  challengeII1KeepOriginal: {
    finalBoard: '.......\n.......\n..#RR..\n..#R...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
      {
        x: 3,
        y: 3,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII1ParameterRebind: {
    finalBoard: '.......\n...#B..\n..##B..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'S',
      },
      {
        x: 4,
        y: 1,
        color: 'B',
        dir: 'S',
      },
    ],
  },
  challengeII2ConsumeMoves: {
    finalBoard: '.......\n.......\n..##...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII2OrientedStart: {
    finalBoard: '.......\n.......\n..###..\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII2IndependentCounters: {
    finalBoard: '.......\n.......\n..#.#..\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII2FieldParameter: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII2StoredPartner: {
    finalBoard: '.......\n.......\n..###..\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII2DelayedRequest: {
    finalBoard: '.......\n...##..\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII2PairedFields: {
    finalBoard: '.......\n.......\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII2DerivedAllowance: {
    finalBoard: '.......\n.......\n..##...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII2ReplaceField: {
    finalBoard: '.......\n.......\n..#.B..\n..#.BB.\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
      {
        x: 5,
        y: 3,
        color: 'B',
        dir: 'S',
      },
    ],
  },
  challengeII2ComposedAction: {
    finalBoard: '.......\n.......\n..#....\n..###..\n....#..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII3RejectRequest: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII3SpendRequest: {
    finalBoard: '.......\n.......\n..#....\n..#....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII3ToggleMode: {
    finalBoard: '.......\n.......\n..##...\n..##...\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII3ResetCounter: {
    finalBoard: '.......\n....#..\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII3SavedGetter: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n...##..\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 5,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII3TransferCredit: {
    finalBoard: '.......\n...#...\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII3PairedUpdate: {
    finalBoard: '.......\n.......\n..####.\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII3ThresholdPulse: {
    finalBoard: '.......\n.......\n..#....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII3BoundedChanges: {
    finalBoard: '.......\n....#..\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII3ConsumeOldValue: {
    finalBoard: '.......\n...##..\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII4ConstructionTotal: {
    finalBoard: '.......\n.......\n..#.##.\n..##.#.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII4CommonBudget: {
    finalBoard: '.......\n.......\n..####.\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'W',
      },
      {
        x: 5,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII4DefaultSnapshot: {
    finalBoard: '.......\n...#...\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'S',
      },
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII4ResetShared: {
    finalBoard: '.......\n.......\n..#.##.\n..#..#.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'N',
      },
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII4PairUtility: {
    finalBoard: '.......\n.......\n..#BB..\n....#..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
      {
        x: 4,
        y: 3,
        color: 'B',
        dir: 'N',
      },
    ],
  },
  challengeII4SharedMode: {
    finalBoard: '.......\n.......\n..###..\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'S',
      },
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII4LocalAndGlobal: {
    finalBoard: '.......\n.......\n..###..\n....#..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII4OffsetReturn: {
    finalBoard: '.......\n.......\n..#RR..\n.##.R..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'W',
      },
      {
        x: 4,
        y: 3,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII4IssuedNumber: {
    finalBoard: '.......\n...#...\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'S',
      },
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII4ReadTiming: {
    finalBoard: '.......\n.......\n..#.##.\n..#..#.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'N',
      },
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII5ProtectedCounter: {
    finalBoard: '.......\n.......\n..##...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII5ReverseOrder: {
    finalBoard: '.......\n...#...\n..##...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'S',
      },
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII5SuperSuffix: {
    finalBoard: '.......\n.......\n..#....\n..##...\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII5ConstructorTransform: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII5TemplateDispatch: {
    finalBoard: '.......\n.......\n..#.#..\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII5ReboundBase: {
    finalBoard: '.......\n.#.....\n.##....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 1,
        color: '#',
        dir: 'S',
      },
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII5ArrayDispatch: {
    finalBoard: '.......\n.......\n...##..\n...##..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII5MixedHelpers: {
    finalBoard: '.......\n.......\n..#....\n..#....\n..#....\n..#....\n..#....',
    finalTurtles: [
      {
        x: 2,
        y: 6,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII5SuperChain: {
    finalBoard: '.......\n.......\n..###..\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII5StateOverride: {
    finalBoard: '.......\n.......\n..#.#..\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII6StoredDefault: {
    finalBoard: '.......\n.......\n.##....\n..#....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII6BooleanAndNumber: {
    finalBoard: '.......\n.......\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII6OneAndTwoFields: {
    finalBoard: '.......\n.......\n..##...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII6ObjectOrDefault: {
    finalBoard: '.......\n..#....\n..##RR.\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 1,
        color: '#',
        dir: 'S',
      },
      {
        x: 5,
        y: 2,
        color: 'R',
        dir: 'N',
      },
    ],
  },
  challengeII6TextAndCount: {
    finalBoard: '.......\n.......\n..#....\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII6InheritedSignature: {
    finalBoard: '.......\n..#....\n..#....\n..#....\n.##....\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII6DelegatedOverride: {
    finalBoard: '.......\n.......\n.###...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII6ChosenSuperSignature: {
    finalBoard: '.......\n.......\n...####\n....##.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 6,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII6ArrayOrScalar: {
    finalBoard: '.......\n....#..\n..###..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  challengeII6ArgumentOrder: {
    finalBoard: '.......\n.......\n..####.\n...RR..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 2,
        color: '#',
        dir: 'E',
      },
      {
        x: 4,
        y: 3,
        color: 'R',
        dir: 'W',
      },
    ],
  },
  challengeII7ValidateBeforeMove: {
    finalBoard: '.......\n.......\n..####.\n.....#.\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII7PartialProgress: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII7SkippedTrySuffix: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII7LocalRecovery: {
    finalBoard: '.......\n.......\n..#....\n.###...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII7RethrowHeading: {
    finalBoard: '.......\n.......\n..#....\n..###..\n....#..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII7SecondRequestRejected: {
    finalBoard: '.......\n.......\n..#....\n..#....\n..##...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII7BudgetException: {
    finalBoard: '.......\n.......\n..#....\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII7CatchEachIteration: {
    finalBoard: '.......\n.......\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII7CatchWholeLoop: {
    finalBoard: '.......\n.......\n..#....\n..#....\n..##...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII7TranslatedException: {
    finalBoard: '.......\n.......\n..#....\n..###..\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII8SelectedRowSum: {
    finalBoard: '.......\n....#..\n...##..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII8ColumnSum: {
    finalBoard: '.......\n.......\n...#...\n...##..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  challengeII8DiagonalComparison: {
    finalBoard: '.......\n.......\n.......\n..###..\n....#..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII8RaggedRows: {
    finalBoard: '.......\n.....#.\n....##.\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII8MatrixDependency: {
    finalBoard: '.......\n.......\n....#..\n...##..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII8AliasedRow: {
    finalBoard: '.......\n...#...\n.###...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII8LayerSelection: {
    finalBoard: '.......\n...#...\n...##..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII8CrossLayerSum: {
    finalBoard: '.......\n...#...\n...##..\n....#..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  challengeII8ReplaceNestedRow: {
    finalBoard: '.......\n.......\n...#...\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  challengeII8RaggedVolume: {
    finalBoard: '.......\n...#...\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
};
