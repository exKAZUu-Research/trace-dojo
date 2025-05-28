'use client';

import type React from 'react';
import { useEffect, useState } from 'react';
import { SessionAuth } from 'supertokens-auth-react/recipe/session';

type Props = Parameters<typeof SessionAuth>[0];

export const SessionAuthForNextJs: React.FC<Props> = (props: Props) => {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(true);
  }, []);

  if (!isLoaded) return props.children;

  return (
    // cf. https://supertokens.com/docs/emailpassword/common-customizations/sessions/claims/claim-validators#on-the-frontend-3
    <SessionAuth>{props.children}</SessionAuth>
  );
};
