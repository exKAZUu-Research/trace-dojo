import type { LanguageId } from '../problemData';

export interface PracticeDefinition {
  id: string;
  lectureIndex: number;
  title: string;
  program: Record<LanguageId, string>;
}
