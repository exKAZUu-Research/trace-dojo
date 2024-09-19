/* eslint-disable unicorn/filename-case */
// TODO: Remove the above line after the ESLint config is fixed.
'use client';

import { useEffect } from 'react';

const GlobalError: React.FC<{ error: Error & { digest?: string }; reset: () => void }> = ({ error, reset }) => {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html>
      <body>
        <h2>Error</h2>
        <button onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
};

export default GlobalError;
