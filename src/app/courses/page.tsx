import type { NextPage } from 'next';

import { HomePage } from '../../components/pages/homePage';

const CoursePage: NextPage = async () => {
  return (
    <main>
      <h1>Courses</h1>
      <HomePage />
    </main>
  );
};

export default CoursePage;
