import { z } from 'zod';

export const javaDiagnosticsSchema = z
  .array(
    z.object({
      message: z.string().min(1).max(240),
      originalMessage: z.string().min(1).max(240).optional(),
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

export const javaFeedbackSummary = 'コードを実行する前に、確認が必要な箇所が見つかりました。（コンパイルエラー）';
export const javaOriginalMessageLabel = '参考（Java のメッセージ）';

export function formatJavaDiagnostic(diagnostic: JavaDiagnostic): string {
  return `${diagnostic.message}${diagnostic.originalMessage ? `\n${javaOriginalMessageLabel}\n${diagnostic.originalMessage}` : ''}`;
}
