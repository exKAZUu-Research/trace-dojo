import { Link } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

import { courseIds, courseIdToName } from '../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../utils/session';

const CoursesPage: NextPage = async () => {
  const session = await getNonNullableSessionOnServer();

  return (
    <main>
      <div>UserID: {session.getUserId()}</div>
      <h1>Courses</h1>
      <ul>
        {courseIds.map((id) => (
          <li key={id}>
            <Link as={NextLink} href={`/courses/${id}`}>
              {courseIdToName[id]}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
};

export default CoursesPage;
