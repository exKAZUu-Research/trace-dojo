import type { NextPage } from 'next';

import { getNonNullableSessionOnServer } from '../../../utils/session';

const CoursePage: NextPage = async () => {
  const session = await getNonNullableSessionOnServer();

  return (
    <main>
      <div>UserID: {session.getUserId()}</div>
      <h1>Courses</h1>
    </main>
  );
};

export default CoursePage;
