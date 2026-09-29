'use client';

import type { Ref } from 'react';
import { Button, Heading, SimpleGrid, Text, VStack } from '@/infrastructures/useClient/chakra';

export type ChallengeProblemFormat = 'regular' | 'fillInBlank';
interface Props {
  isPending: boolean;
  onSelect: (format: ChallengeProblemFormat) => void | Promise<void>;
  regularButtonRef?: Ref<HTMLButtonElement>;
}

export const ChallengeSelection: React.FC<Props> = ({ isPending, onSelect, regularButtonRef }) => (
  <SimpleGrid columns={{ base: 1, md: 2 }} gap={5}>
    <Choice
      disabled={isPending}
      title="実行結果・ステップ実行"
      description="盤面や変数の実行結果を作る問題です。"
      onClick={() => onSelect('regular')}
      buttonRef={regularButtonRef}
    />
    <Choice
      disabled={isPending}
      title="穴埋め問題"
      description="プログラムの空欄を埋める問題です。"
      onClick={() => onSelect('fillInBlank')}
    />
  </SimpleGrid>
);

const Choice: React.FC<{
  disabled: boolean;
  title: string;
  description: string;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}> = ({ disabled, title, description, onClick, buttonRef }) => (
  <Button
    ref={buttonRef}
    disabled={disabled}
    height="auto"
    justifyContent="start"
    p={6}
    textAlign="left"
    whiteSpace="normal"
    onClick={onClick}
  >
    <VStack align="start" spacing={2}>
      <Heading size="md">{title}</Heading>
      <Text fontWeight="normal">{description}</Text>
    </VStack>
  </Button>
);
