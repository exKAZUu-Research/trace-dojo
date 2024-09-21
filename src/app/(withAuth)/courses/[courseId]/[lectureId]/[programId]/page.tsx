import type { NextPage } from 'next';

import { generateProblem } from '../../../../../../problems/generateProblem';
import type { CourseId, ProgramId } from '../../../../../../problems/problemData';
import { findSuspendedUserProblemSession } from '../../../../../../utils/fetch';
import { getNonNullableSessionOnServer } from '../../../../../../utils/session';
import { upsertUserProblemSession } from '../../../../../../utils/upsertUserProblemSession';

import { ProblemPageOnClient } from './pageOnClient';

type Props = {
  params: { courseId: CourseId; lectureId: string; programId: ProgramId };
};

const ProblemPage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer();
  const userId = session.superTokensUserId;
  const courseId = props.params.courseId;
  const lectureId = props.params.lectureId;
  const programId = props.params.programId;

  let userProblemSession = await findSuspendedUserProblemSession(userId, courseId, programId);

  if (!userProblemSession) {
    const problemVariableSeed = Date.now().toString();
    const problemType = 'executionResult';
    const startedAt = new Date();

    userProblemSession = await upsertUserProblemSession(
      // createするためにidに0を指定
      0,
      userId,
      courseId,
      lectureId,
      programId,
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

  if (!userProblemSession) return;

  const problem = generateProblem(
    userProblemSession.programId as ProgramId,
    'java',
    userProblemSession.problemVariablesSeed
  );

  if (!problem) return;

  return (
    <ProblemPageOnClient
      params={props.params}
      problem={problem}
      userId={session.superTokensUserId}
      userProblemSession={userProblemSession}
    />
  );
};

export default ProblemPage;
