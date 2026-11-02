export interface ChallengeEdit {
  id: string;
  before: string;
  after: string;
}

export interface ChallengeBase {
  id: string;
  title: string;
  courseId: 'tuBeginner1' | 'tuBeginner2';
  lectureIndex: number;
  java: string;
  instrumented: string;
  blanks: ChallengeEdit[];
  bugs: (ChallengeEdit & { kind: 'logical' | 'syntax' })[];
}
