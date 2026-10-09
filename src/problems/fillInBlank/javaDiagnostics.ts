import { z } from 'zod';

export const javaDiagnosticsSchema = z
  .array(
    z.object({
      message: z.string().min(1).max(240),
      line: z.number().int().positive().optional(),
    })
  )
  .min(1)
  .max(20);

export type JavaDiagnostic = z.infer<typeof javaDiagnosticsSchema>[number];

export function readJavaDiagnostics(value: unknown, lineCount: number): JavaDiagnostic[] | undefined {
  const parsed = javaDiagnosticsSchema.safeParse(value);
  if (!parsed.success || parsed.data.some((diagnostic) => diagnostic.line !== undefined && diagnostic.line > lineCount))
    return;
  return parsed.data;
}
