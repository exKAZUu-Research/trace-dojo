import type { NextPage } from 'next';

import type { CourseId, ProgramId } from '../../../../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../../../../utils/session';

import { BaseProblem } from './BaseProblem';

const ProblemPage: NextPage<{ params: { courseId: CourseId; programId: ProgramId } }> = async ({ params }) => {
  const session = await getNonNullableSessionOnServer();

  return <BaseProblem courseId={params.courseId} programId={params.programId} userId={session.getUserId()} />;
};

export default ProblemPage;
