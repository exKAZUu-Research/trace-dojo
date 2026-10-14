// Refresh with bun scripts/updateJavaChallengeMetadata.ts after editing the catalog.
import type { JavaChallengeDefinition } from './types';

export const javaChallengeMetadata: Record<
  string,
  Pick<JavaChallengeDefinition, 'title' | 'courseId' | 'lectureIndex' | 'problemFormat'>
> = {
  javaI1CornerApproachBlank: {
    title: '角のある道（1）',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    problemFormat: 'fillInBlank',
  },
  javaI1CornerTurnBug: {
    title: '角のある道（2）',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    problemFormat: 'bugFix',
  },
  javaI2CoordinateUpdateUpdateBug: {
    title: '変数で決める出発点（1）',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    problemFormat: 'bugFix',
  },
  javaI3CountedLineConditionTypeBug: {
    title: '繰り返して描く直線（3）',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    problemFormat: 'bugFix',
  },
  javaI4BranchStairComparisonBug: {
    title: '条件に合わせて曲がる道（2）',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    problemFormat: 'bugFix',
  },
  javaI5SwitchCascadeBug2: {
    title: '連続して描く道（修正2）',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    problemFormat: 'bugFix',
  },
  javaI6ContinueSkipBug1: {
    title: '休みながら進む線（修正1）',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    problemFormat: 'bugFix',
  },
  javaI7ReturnChoiceBug1: {
    title: '長さを選ぶ道（修正1）',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    problemFormat: 'bugFix',
  },
  javaI8ArrayRouteBug1: {
    title: '配列で決める道（修正1）',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    problemFormat: 'bugFix',
  },
  javaB2Early_sharedReference_bugFix_otherObject: {
    title: 'バグ修正：２つの名前で描く道',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    problemFormat: 'bugFix',
  },
  javaB2Early_constructorSpeed_bugFix_shadowedField: {
    title: 'バグ修正：歩幅を持つ亀',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    problemFormat: 'bugFix',
  },
  javaB2Early_boundedAccessor_bugFix_acceptNegative: {
    title: 'バグ修正：安全な歩幅の設定',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    problemFormat: 'bugFix',
  },
  javaB2Early_sharedSpeed_bugFix_instanceSpeed: {
    title: 'バグ修正：共有する歩幅',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    problemFormat: 'bugFix',
  },
  tu2PolymorphicStrideBug1: {
    title: 'バグ修正：親の型で歩く亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
  },
  tu2OverloadDefaultBug1: {
    title: 'バグ修正：引数で選ぶ道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
  },
  tu2ExceptionPropagationBug1: {
    title: 'バグ修正：呼び出しを戻る例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
  },
  tu2MatrixRowsBug1: {
    title: 'バグ修正：行ごとの歩数',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
  },
  testTurnBug: {
    title: 'バグ修正：亀の向き',
    courseId: 'test',
    lectureIndex: 0,
    problemFormat: 'bugFix',
  },
  testForConditionBug: {
    title: 'バグ修正：for文の条件',
    courseId: 'test',
    lectureIndex: 0,
    problemFormat: 'bugFix',
  },
};
