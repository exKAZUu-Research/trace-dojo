import { Box, type BoxProps, Stack } from '@chakra-ui/react';
import React from 'react';

import { APP_AUTHOR } from '../../constants';

export const DefaultFooter: React.FC<BoxProps> = (props) => {
  return (
    <Box px={4} {...props}>
      <Stack borderTopWidth={1} color="gray.500" direction="row" fontSize="sm" gap={8} py={4}>
        <div>&copy; {APP_AUTHOR}</div>
      </Stack>
    </Box>
  );
};
