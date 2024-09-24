'use client';

import { ErrorBoundaryContent } from '../../components/organisms/ErrorBoundaryContent';

const Error: React.FC<{ error: Error & { digest?: string }; reset: () => void }> = ({ error, reset }) => {
  return <ErrorBoundaryContent error={error} reset={reset} />;
};

export default Error;
