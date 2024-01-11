import type { NextPage } from 'next';

import { getSessionOnServerPage } from '../../../utils/session';

const CoursePage: NextPage = async () => {
  const session = await getSessionOnServerPage();

  return (
    <main>
      <div>UserID on Supertokens: {session.getUserId()}</div>
      <h1>Courses</h1>
    </main>
  );
};

export default CoursePage;
