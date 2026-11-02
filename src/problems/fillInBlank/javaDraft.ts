import { z } from 'zod';

const prefix = 'trace-dojo:java-draft:';
const sourceLimit = 100_000;
const contextSchema = z.object({
  userId: z.string().min(1),
  mode: z.enum(['ordinary', 'challenge']),
  courseId: z.string(),
  lectureId: z.string(),
  problemId: z.string(),
  sessionId: z.number(),
  seed: z.string().optional(),
});
const draftSchema = z.object({
  version: z.literal(1),
  context: contextSchema,
  baseline: z.string().max(sourceLimit),
  code: z.string().max(sourceLimit),
  writtenAt: z.number().finite(),
});
export type JavaDraftContext = z.infer<typeof contextSchema>;
export interface JavaDraftRestoration {
  code: string;
  failed: boolean;
}

export function javaDraftKey(context: JavaDraftContext): string {
  return prefix + JSON.stringify(contextSchema.parse(context));
}

export function restoreJavaDraft(key: string, baseline: string, completed: boolean): JavaDraftRestoration {
  if (completed) return { code: baseline, failed: !removeJavaDraft(key) };
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { code: baseline, failed: false };
    const draft = parseDraft(raw);
    if (!draft || javaDraftKey(draft.context) !== key || draft.baseline !== baseline) {
      return { code: baseline, failed: !removeJavaDraft(key) };
    }
    return { code: draft.code, failed: false };
  } catch {
    return { code: baseline, failed: true };
  }
}

export function saveJavaDraft(context: JavaDraftContext, baseline: string, code: string): boolean {
  const key = javaDraftKey(context);
  if (code === baseline) return removeJavaDraft(key);
  if (code.length > sourceLimit || baseline.length > sourceLimit) return false;
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, context, baseline, code, writtenAt: Date.now() }));
    const entries: { key: string; writtenAt: number }[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const candidate = localStorage.key(index);
      if (!candidate?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(candidate);
      const draft = raw === null ? undefined : parseDraft(raw);
      if (draft && javaDraftKey(draft.context) === candidate)
        entries.push({ key: candidate, writtenAt: draft.writtenAt });
    }
    const oldest = entries.filter((entry) => entry.key !== key).toSorted((a, b) => a.writtenAt - b.writtenAt);
    for (const entry of oldest.slice(0, Math.max(0, entries.length - 20))) localStorage.removeItem(entry.key);
    return true;
  } catch {
    return false;
  }
}

export function removeJavaDraft(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function parseDraft(raw: string): z.infer<typeof draftSchema> | undefined {
  try {
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
