'use client';

import { Box, Button, Flex, HStack, useDisclosure, VStack } from '@chakra-ui/react';
import { useRef } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import type { GeneratedProgram } from '../../../../../../problems/generateProgram';
import type { ProblemType } from '../../../../../../types';

import { Variables } from './Variables';

interface CheckpointProblemProps {
  setProblemType: (step: ProblemType) => void;
  problemProgram: GeneratedProgram;
  beforeCheckpointSid: number;
  createAnswerLog: (isPassed: boolean) => void;
  currentCheckpointSid: number;
  explanation?: Record<'title' | 'body', string>;
  selectedLanguageId: string;
  setBeforeCheckpointSid: (line: number) => void;
  setCurrentCheckpointSid: (line: number) => void;
}

export const CheckpointProblem: React.FC<CheckpointProblemProps> = ({
  beforeCheckpointSid,
  createAnswerLog,
  currentCheckpointSid,
  explanation,
  problemProgram,
  selectedLanguageId,
  setBeforeCheckpointSid,
  setCurrentCheckpointSid,
  setProblemType,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();
  const beforeCheckpointResult = problemProgram.traceItems.find((traceItem) => traceItem.sid === beforeCheckpointSid);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;

    createAnswerLog(isPassed);

    // TODO: 一旦アラートで表示
    if (isPassed) {
      setBeforeCheckpointSid(currentCheckpointSid);

      if (currentCheckpointSid === problemProgram.checkpointSids.at(-1)) {
        // 最終チェックポイントを正解した場合はその次の行からステップ問題に移行
        alert('正解です。このチェックポイントから1行ずつ回答してください');
        setCurrentCheckpointSid(currentCheckpointSid + 1);
        setProblemType('step');
      } else {
        alert('正解です。次のチェックポイントに進みます');
        setCurrentCheckpointSid(
          problemProgram.checkpointSids[problemProgram.checkpointSids.indexOf(currentCheckpointSid) + 1]
        );
      }
    } else {
      // 不正解の場合は最後に正解したチェックポイントからステップ問題に移行
      alert('不正解です。最後に正解したチェックポイントから1行ずつ回答してください');
      setCurrentCheckpointSid(beforeCheckpointSid + 1);
      setProblemType('step');
    }
  };

  return (
    <Flex gap="6" w="100%">
      <VStack spacing="10">
        <Box>茶色にハイライトされている行における盤面を作成してください。</Box>
        <Box>青色のハイライト時点の実行結果</Box>
        <Box>
          <TurtleGraphics
            ref={turtleGraphicsRef}
            beforeCheckpointSid={beforeCheckpointSid}
            currentCheckpointSid={currentCheckpointSid}
            isEnableOperation={false}
            problemProgram={problemProgram}
          />
        </Box>
        <Box>茶色のハイライト時点の実行結果</Box>
        <Box>
          <TurtleGraphics
            ref={turtleGraphicsRef}
            beforeCheckpointSid={beforeCheckpointSid}
            currentCheckpointSid={currentCheckpointSid}
            isEnableOperation={true}
            problemProgram={problemProgram}
          />
        </Box>
      </VStack>
      <VStack align="end" minW="50%" overflow="hidden">
        <HStack>
          <Button colorScheme="gray" onClick={onHelpModalOpen}>
            解答方法
          </Button>
          <CustomModal
            body="チェックポイント問題の解答方法の説明"
            isOpen={isHelpModalOpen}
            title="チェックポイント問題について"
            onClose={onHelpModalClose}
          />
          {explanation && (
            <>
              <Button colorScheme="gray" onClick={onExplanationModalOpen}>
                解説
              </Button>
              <CustomModal
                body={explanation.body}
                isOpen={isExplanationModalOpen}
                title={explanation.title}
                onClose={onExplanationModalClose}
              />
            </>
          )}
        </HStack>
        <Box h="640px" w="100%">
          <SyntaxHighlighter
            beforeCheckPointLine={beforeCheckpointSid}
            code={problemProgram.displayProgram}
            currentCheckPointLine={currentCheckpointSid}
            programmingLanguageId={selectedLanguageId}
          />
        </Box>
        <Variables
          // TODO: beforeCheckpointResult?.vars からキャラクタおよび変数の情報を取得するようにすること。
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          characterVariables={beforeCheckpointResult?.vars as any}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          variables={beforeCheckpointResult?.vars as any}
        />
        <HStack>
          <Button onClick={() => handleClickResetButton()}>リセット</Button>
          <Button onClick={() => handleClickAnswerButton()}>解答</Button>
        </HStack>
      </VStack>
    </Flex>
  );
};
