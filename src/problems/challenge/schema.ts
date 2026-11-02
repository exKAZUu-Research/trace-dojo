import { z } from 'zod';

const editSchema = z.object({ id: z.string().min(1), before: z.string().min(1), after: z.string() }).strict();
export const challengeBaseSchema = z
  .object({
    id: z.string().regex(/^challengeI{1,2}[1-8][A-Z]\w*$/),
    title: z.string().min(1),
    courseId: z.enum(['tuBeginner1', 'tuBeginner2']),
    lectureIndex: z.number().int().min(0).max(7),
    java: z.string().min(1),
    instrumented: z.string().min(1),
    blanks: z.array(editSchema).min(1),
    bugs: z.array(editSchema.extend({ kind: z.enum(['logical', 'syntax']) })).min(1),
  })
  .strict();
