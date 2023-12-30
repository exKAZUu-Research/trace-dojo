'use client';

import React from 'react';
import { useSessionContext } from 'supertokens-auth-react/recipe/session';

export const HomeClientComponent: React.FC = () => {
  const session = useSessionContext();

  if (session.loading) {
    return <div>Loading...</div>;
  }

  if (session.doesSessionExist === false) {
    return <div>Session does not exist</div>;
  }

  return (
    <div>
      <div>
        <p>
          Client side component got userId: {session.userId}
          <br />
        </p>
      </div>
    </div>
  );
};
