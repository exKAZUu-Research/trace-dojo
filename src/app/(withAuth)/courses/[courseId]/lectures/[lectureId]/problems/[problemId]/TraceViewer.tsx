'use client';

import type React from 'react';

import type { InstantiatedProblem } from '../../../../../../../../problems/instantiateProblem';

import { BoardViewer } from './BoardViewer';
import { Variables } from './Variables';

import { Box, Button, Card, Heading, HStack, VStack } from '@/infrastructures/useClient/chakra';

type Props = {
  currentTraceItemIndex: number;
  viewingTraceItemIndex: number;
  previousTraceItemIndex: number;
  problem: InstantiatedProblem;
  setViewingTraceItemIndex: React.Dispatch<React.SetStateAction<number>>;
};

export const TraceViewer: React.FC<Props> = (props: Props) => {
  return (
    <HStack alignItems="flex-start" as={Card} bg="gray.50" p={5}>
      <VStack align="center" flexBasis={0} flexGrow={3} spacing={6}>
        <VStack align="center">
          <Heading size="md" textAlign="center">
            {props.previousTraceItemIndex === props.viewingTraceItemIndex ? (
              <>
                <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[props.previousTraceItemIndex].sid)}行目
                </Box>
                の実行後（
                <Box as="span" border="2px solid #f56565" px={0.5} rounded="sm">
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[props.currentTraceItemIndex].sid)}行目
                </Box>
                の実行前）の盤面
              </>
            ) : (
              <>
                <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[props.viewingTraceItemIndex].sid)}行目
                </Box>
                の実行後の盤面
              </>
            )}
          </Heading>
        </VStack>

        <BoardViewer
          board={props.problem.traceItems[props.viewingTraceItemIndex]?.board}
          turtles={props.problem.traceItems[props.viewingTraceItemIndex]?.turtles}
        />
      </VStack>
      <Box alignItems="center" display="flex" flexBasis={0} flexDirection="column" flexGrow={2} textAlign="center">
        <HStack mb={4} spacing={4}>
          <Button
            colorScheme="brand"
            isDisabled={props.viewingTraceItemIndex <= 1}
            variant="outline"
            onClick={() => {
              props.setViewingTraceItemIndex((prev) => prev - 1);
            }}
          >
            1ステップ前を表示
          </Button>
          <Button
            colorScheme="brand"
            isDisabled={props.previousTraceItemIndex <= props.viewingTraceItemIndex}
            variant="outline"
            onClick={() => {
              props.setViewingTraceItemIndex((prev) => prev + 1);
            }}
          >
            1ステップ後を表示
          </Button>
        </HStack>
        <Box mt={4} w="100%">
          <Variables traceItemVars={props.problem.traceItems[props.viewingTraceItemIndex].vars} />
        </Box>
      </Box>
    </HStack>
  );
};
