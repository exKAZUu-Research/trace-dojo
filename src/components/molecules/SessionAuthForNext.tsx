'use client';

import React from 'react';
import { SessionAuth } from 'supertokens-auth-react/recipe/session';

type Props = Parameters<typeof SessionAuth>[0];

export const SessionAuthForNext: React.FC<Props> = (props: Props) => {
  return <SessionAuth {...props} />;
};
