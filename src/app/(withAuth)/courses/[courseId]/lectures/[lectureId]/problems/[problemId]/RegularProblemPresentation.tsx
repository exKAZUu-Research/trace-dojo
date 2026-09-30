'use client';

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { TraceViewer } from './TraceViewer';
import { Box, Card, Flex, Heading, HStack, Tag, VStack } from '@/infrastructures/useClient/chakra';
import type { InstantiatedProblem } from '@/problems/instantiateProblem';
import type { TraceItemVariable } from '@/problems/traceProgram';
import type { ProblemType } from '@/types';

export interface RegularProblemView {
  problemType: Exclude<ProblemType, 'fillInBlank'>;
  currentTraceItemIndex: number;
  previousTraceItemIndex: number;
  currentVariables: TraceItemVariable;
  initialVariables: Record<string, string>;
}

interface Props {
  problem: InstantiatedProblem;
  view: RegularProblemView;
  viewingTraceItemIndex: number;
  setViewingTraceItemIndex: Dispatch<SetStateAction<number>>;
  editor: ReactNode;
}

export const RegularProblemPresentation: React.FC<Props> = ({
  problem,
  view,
  viewingTraceItemIndex,
  setViewingTraceItemIndex,
  editor,
}) => (
  <>
    <Flex alignItems="stretch" gap={6}>
      <VStack align="stretch" flexBasis={0} flexGrow={1} minW={0} spacing={4}>
        <VStack align="stretch" as={Card} overflow="hidden" spacing={0}>
          <VStack align="stretch" borderBottomWidth="1px" p={5}>
            <HStack justifyContent="space-between">
              <Heading size="md">問題</Heading>
              {view.problemType === 'step' && (
                <Tag colorScheme="brand" fontWeight="bold" size="sm" variant="solid">
                  ステップ実行モード
                </Tag>
              )}
            </HStack>
            <Box>
              {view.problemType === 'step' && view.previousTraceItemIndex >= 1 && (
                <>
                  画面下部にある
                  <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                    {problem.sidToLineIndex.get(problem.traceItems[view.previousTraceItemIndex].sid)}行目
                  </Box>
                  を実行した後の盤面と変数の一覧表を参考に、
                </>
              )}
              {view.problemType === 'executionResult' ? (
                <Box as="span">
                  <Box as="span" fontWeight="bold">
                    プログラムを実行した後
                  </Box>
                  の盤面{Object.keys(view.initialVariables).length > 0 ? 'と、変数に記録されている値の一覧表' : ''}
                  を作成し、提出ボタンを押してください。
                </Box>
              ) : (
                <>
                  <Box as="span" fontWeight="bold">
                    <Box as="span" border="2px solid #f56565" px={0.5} rounded="sm">
                      {problem.sidToLineIndex.get(problem.traceItems[view.currentTraceItemIndex].sid)}行目
                    </Box>
                    を実行した後
                  </Box>
                  の盤面{Object.keys(view.initialVariables).length > 0 ? 'と、変数に記録されている値の一覧表' : ''}
                  を作成し、提出ボタンを押してください。
                </>
              )}
            </Box>
          </VStack>
        </VStack>
        <SyntaxHighlighter
          code={problem.displayProgram}
          programmingLanguageId="java"
          callerLines={
            view.problemType === 'step'
              ? problem.traceItems[view.currentTraceItemIndex].callStack.map((id) =>
                  problem.callerIdToLineIndex.get(id)
                )
              : undefined
          }
          currentFocusLine={
            view.problemType === 'step'
              ? problem.sidToLineIndex.get(problem.traceItems[view.currentTraceItemIndex].sid)
              : undefined
          }
          previousFocusLine={
            view.problemType === 'step'
              ? problem.sidToLineIndex.get(problem.traceItems[viewingTraceItemIndex].sid)
              : undefined
          }
        />
      </VStack>
      <VStack align="stretch" bgColor="gray.50" flexBasis={0} flexGrow={1} spacing="4">
        {editor}
      </VStack>
    </Flex>
    {view.problemType === 'step' && view.previousTraceItemIndex >= 1 && (
      <TraceViewer
        currentTraceItemIndex={view.currentTraceItemIndex}
        previousTraceItemIndex={view.previousTraceItemIndex}
        problem={problem}
        setViewingTraceItemIndex={setViewingTraceItemIndex}
        viewingTraceItemIndex={viewingTraceItemIndex}
      />
    )}
  </>
);

export const deriveRegularProblemView = (
  problem: InstantiatedProblem,
  problemType: Exclude<ProblemType, 'fillInBlank'>,
  traceItemIndex: number,
  adminPreviousIndex = false
): RegularProblemView => {
  if (problem.traceItems.length === 0) throw new Error('問題の実行トレースがありません。');
  const currentTraceItemIndex =
    problemType === 'executionResult'
      ? problem.traceItems.length - 1
      : // The definition may have changed after the session stored this index.
        Math.min(traceItemIndex, problem.traceItems.length - 1);
  const previousTraceItemIndex =
    problemType === 'executionResult'
      ? 0
      : adminPreviousIndex
        ? Math.min(traceItemIndex - 1, problem.traceItems.length - 1)
        : currentTraceItemIndex - 1;
  if (previousTraceItemIndex < 0) throw new Error('ステップ問題の実行トレースが不足しています。');
  const currentVariables =
    problemType === 'executionResult' ? problem.finalVars : problem.traceItems[currentTraceItemIndex].vars;
  return {
    problemType,
    currentTraceItemIndex,
    previousTraceItemIndex,
    currentVariables,
    initialVariables: getInitialVariables(
      problemType,
      problem.traceItems,
      previousTraceItemIndex,
      currentTraceItemIndex,
      currentVariables
    ),
  };
};

const getInitialVariables = (
  problemType: Exclude<ProblemType, 'fillInBlank'>,
  traceItems: InstantiatedProblem['traceItems'],
  previousIndex: number,
  currentIndex: number,
  current: TraceItemVariable
): Record<string, string> => {
  let adjustedPreviousIndex = previousIndex;
  let emptyNonGlobals = false;
  if (problemType === 'step') {
    const depth = traceItems[currentIndex].depth;
    while (adjustedPreviousIndex > 0 && depth !== traceItems[adjustedPreviousIndex].depth) {
      if (depth > traceItems[adjustedPreviousIndex].depth) {
        emptyNonGlobals = true;
        break;
      }
      adjustedPreviousIndex -= 1;
    }
    emptyNonGlobals ||=
      traceItems[currentIndex].callStack.at(-1) !== traceItems[adjustedPreviousIndex].callStack.at(-1);
  }
  return Object.fromEntries(
    Object.entries(current)
      .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
      .map(([key]) => {
        const first = key.slice(0, 1);
        const isGlobal = first === first.toUpperCase() && first !== first.toLowerCase();
        if (isGlobal) return [key, String(traceItems[previousIndex].vars[key] ?? '')];
        if (emptyNonGlobals) return [key, ''];
        return [key, String(traceItems[adjustedPreviousIndex].vars[key] ?? '')];
      })
  );
};
