import { Card, Heading, HStack, VStack, Box, Button } from '@chakra-ui/react';
import React from 'react';

import type { Problem } from '../../../../../../../../problems/generateProblem';
import { isTurtleTrace } from '../../../../../../../../problems/traceProgram';

import { BoardViewer } from './BoardViewer';
import { Variables } from './Variables';

type Props = {
  problem: Problem;
  focusTraceItemIndex: number;
  currentTraceItemIndex: number;
  setFocusTraceItemIndex: React.Dispatch<React.SetStateAction<number>>;
  previousTraceItemIndex: number;
};

export const TraceViewer: React.FC<Props> = (props: Props) => {
  const { focusTraceItemIndex, previousTraceItemIndex, setFocusTraceItemIndex } = props;
  return (
    <HStack alignItems="flex-start" as={Card} bg="gray.50" p={5}>
      <VStack align="stretch" flexBasis={0} flexGrow={2} spacing={6}>
        <VStack align="stretch">
          <Heading size="md">
            {previousTraceItemIndex === focusTraceItemIndex ? (
              <>
                <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex].sid)}行目
                </Box>
                を実行した後（
                <Box as="span" border="2px solid #f56565" px={0.5} rounded="sm">
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[props.currentTraceItemIndex].sid)}行目
                </Box>
                を実行する前）の盤面
              </>
            ) : (
              <>
                <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                  {props.problem.sidToLineIndex.get(props.problem.traceItems[focusTraceItemIndex].sid)}行目
                </Box>
                を実行した後の盤面
              </>
            )}
          </Heading>
        </VStack>

        <BoardViewer
          alignSelf="center"
          board={props.problem.traceItems[focusTraceItemIndex]?.board}
          turtles={Object.values(props.problem.traceItems[focusTraceItemIndex].vars ?? {}).filter(isTurtleTrace)}
        />
      </VStack>
      <Box flexBasis={0} flexGrow={3} textAlign="center">
        <Button
          colorScheme="brand"
          isDisabled={focusTraceItemIndex <= 1}
          mr="5%"
          mx="auto"
          variant="outline"
          w="40%"
          onClick={() => setFocusTraceItemIndex((prev) => prev - 1)}
        >
          1ステップ前を表示
        </Button>
        <Button
          colorScheme="brand"
          isDisabled={previousTraceItemIndex <= focusTraceItemIndex}
          ml="5%"
          mx="auto"
          variant="outline"
          w="40%"
          onClick={() => {
            setFocusTraceItemIndex((prev) => prev + 1);
          }}
        >
          1ステップ後を表示
        </Button>
        <Box mt={4}>
          <Variables traceItemVars={props.problem.traceItems[focusTraceItemIndex].vars} />
        </Box>
      </Box>
    </HStack>
  );
};
