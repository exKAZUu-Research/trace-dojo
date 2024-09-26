import { Box, Button, Card, Heading, HStack, VStack } from '@chakra-ui/react';
import React from 'react';

import type { Problem } from '../../../../../../../../problems/generateProblem';
import { isTurtleTrace } from '../../../../../../../../problems/traceProgram';

import { BoardViewer } from './BoardViewer';
import { Variables } from './Variables';

type Props = {
  currentTraceItemIndex: number;
  focusTraceItemIndex: number;
  previousTraceItemIndex: number;
  problem: Problem;
  setFocusTraceItemIndex: React.Dispatch<React.SetStateAction<number>>;
};

export const TraceViewer: React.FC<Props> = (props: Props) => {
  return (
    <HStack alignItems="flex-start" as={Card} bg="gray.50" p={5}>
      <VStack align="stretch" flexBasis={0} flexGrow={2} spacing={6}>
        <VStack align="stretch">
          <Heading size="md">
            {props.previousTraceItemIndex === props.focusTraceItemIndex ? (
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
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[props.focusTraceItemIndex].sid)}行目
                </Box>
                の実行後の盤面
              </>
            )}
          </Heading>
        </VStack>

        <BoardViewer
          alignSelf="center"
          board={props.problem.traceItems[props.focusTraceItemIndex]?.board}
          turtles={Object.values(props.problem.traceItems[props.focusTraceItemIndex].vars ?? {}).filter(isTurtleTrace)}
        />
      </VStack>
      <Box flexBasis={0} flexGrow={3} textAlign="center">
        <Button
          colorScheme="brand"
          isDisabled={props.focusTraceItemIndex <= 1}
          mx="5%"
          variant="outline"
          w="40%"
          onClick={() => props.setFocusTraceItemIndex((prev) => prev - 1)}
        >
          1ステップ前を表示
        </Button>
        <Button
          colorScheme="brand"
          isDisabled={props.previousTraceItemIndex <= props.focusTraceItemIndex}
          mx="5%"
          variant="outline"
          w="40%"
          onClick={() => props.setFocusTraceItemIndex((prev) => prev + 1)}
        >
          1ステップ後を表示
        </Button>
        <Box mt={4}>
          <Variables traceItemVars={props.problem.traceItems[props.focusTraceItemIndex].vars} />
        </Box>
      </Box>
    </HStack>
  );
};
