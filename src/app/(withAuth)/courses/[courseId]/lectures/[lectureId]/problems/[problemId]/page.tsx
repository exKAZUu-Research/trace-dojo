import type { NextPage } from 'next';

import { generateProblem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { findSuspendedUserProblemSession } from '../../../../../../../../utils/fetch';
import { getNonNullableSessionOnServer } from '../../../../../../../../utils/session';
import { upsertUserProblemSession } from '../../../../../../../../utils/upsertUserProblemSession';

import { ProblemPageOnClient } from './pageOnClient';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
};

const ProblemPage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer();
  const userId = session.superTokensUserId;
  const courseId = props.params.courseId;
  const lectureId = props.params.lectureId;
  const problemId = props.params.problemId;

  let userProblemSession = await findSuspendedUserProblemSession(userId, courseId, problemId);
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
      problemId,
      problemVariableSeed,
      problemType,
      0,
      0,
      undefined,
      startedAt,
      undefined,
      false
    );
    if (!userProblemSession) return;
  }

  const problem = generateProblem(
    userProblemSession.problemId as ProblemId,
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
