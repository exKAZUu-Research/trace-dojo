/* eslint-disable unicorn/filename-case */
// TODO: Remove the above line after the ESLint config is fixed.
'use client';

import Error from 'next/error';

const NotFound: React.FC = () => {
  return <Error statusCode={404} />;
};

export default NotFound;
