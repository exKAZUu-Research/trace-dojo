import type { UserProblemSession } from '@prisma/client';
import type { NextPage } from 'next';

import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../../../../utils/session';
import { getSuspendedUserProblemSession, upsertUserProblemSession } from '../../../../../lib/actions';

import { BaseProblem } from './BaseProblem';

const ProblemPage: NextPage<{
  params: { courseId: CourseId; languageId: VisibleLanguageId; programId: ProgramId };
}> = async ({ params }) => {
  const session = await getNonNullableSessionOnServer();
  const userId = session.getUserId();
  const courseId = params.courseId;
  // TODO: fix typo
  const languageId = params.languageId;
  const programId = params.programId;

  const suspendedSession: UserProblemSession | undefined = await getSuspendedUserProblemSession(
    userId,
    courseId,
    programId,
    languageId
  );

  let userProblemSession = suspendedSession;

  if (!userProblemSession) {
    const problemVariableSeed = Date.now().toString();
    const problemType = 'executionResult';
    const startedAt = new Date();

    userProblemSession = await upsertUserProblemSession(
      // createするためにidに0を指定
      0,
      userId,
      courseId,
      programId,
      languageId,
      problemVariableSeed,
      problemType,
      0,
      0,
      undefined,
      startedAt,
      undefined,
      false
    );
  }

  if (!userProblemSession) return <>undefined</>;

  return (
    <BaseProblem
      courseId={params.courseId}
      languageId={languageId}
      programId={params.programId}
      userId={session.getUserId()}
      userProblemSession={userProblemSession}
    />
  );
};

export default ProblemPage;
