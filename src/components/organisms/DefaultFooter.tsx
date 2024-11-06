import type { BoxProps } from '@chakra-ui/react';
import React from 'react';

import { APP_AUTHOR } from '../../constants';

import { Box, HStack } from '@/infrastructures/useClient/chakra';

export const DefaultFooter: React.FC<BoxProps> = (props) => {
  return (
    <Box px={4} {...props}>
      <HStack borderTopWidth={1} color="gray.500" fontSize="sm" py={4} spacing={8}>
        <div>&copy; {APP_AUTHOR}</div>
      </HStack>
    </Box>
  );
};
