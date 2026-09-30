'use client';

import type { Ref } from 'react';
import type { IconType } from 'react-icons';
import { MdCode, MdEditNote } from '@/infrastructures/useClient/icons';
import { Button, Heading, Icon, SimpleGrid, Text, VStack } from '@/infrastructures/useClient/chakra';

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
      title="通常問題"
      description="盤面や変数の実行結果を作る問題です。"
      icon={MdCode}
      onClick={() => onSelect('regular')}
      buttonRef={regularButtonRef}
    />
    <Choice
      disabled={isPending}
      title="穴埋め問題"
      description="プログラムの空欄を埋める問題です。"
      icon={MdEditNote}
      onClick={() => onSelect('fillInBlank')}
    />
  </SimpleGrid>
);

const Choice: React.FC<{
  disabled: boolean;
  title: string;
  description: string;
  icon: IconType;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}> = ({ disabled, title, description, icon, onClick, buttonRef }) => (
  <Button
    ref={buttonRef}
    disabled={disabled}
    height="auto"
    minH="9rem"
    bg="white"
    borderWidth="1px"
    borderColor="gray.200"
    color="gray.800"
    _hover={{ borderColor: 'brand.400', bg: 'brand.50', shadow: 'md' }}
    _focusVisible={{ borderColor: 'brand.500', bg: 'brand.50', boxShadow: 'outline' }}
    justifyContent="start"
    p={6}
    textAlign="left"
    whiteSpace="normal"
    onClick={onClick}
  >
    <VStack align="start" spacing={3}>
      <Icon aria-hidden="true" as={icon} color="brand.500" boxSize={7} />
      <VStack align="start" spacing={2}>
        <Heading size="md">{title}</Heading>
        <Text fontWeight="normal">{description}</Text>
      </VStack>
    </VStack>
  </Button>
);
