import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { z } from 'zod';

import { createWandboxExecutor } from '../../src/problems/fillInBlank/javaExecutors';

const requestSchema = z.object({ codes: z.array(z.object({ file: z.string(), code: z.string() })).min(1) });
export const diagnosticVerdictSchema = z.object({
  status: z.literal('incorrect'),
  detail: z.literal('Compile error.'),
  diagnostics: z
    .array(
      z.object({
        message: z.string().min(1).max(240),
        originalMessage: z.string().min(1).max(240).optional(),
        line: z.number().int().positive().optional(),
      })
    )
    .min(1)
    .max(20),
});

export async function withCompilerTransport<T>(
  reply: (file: string, program: string) => { status: string; compiler_error?: string; program_error?: string },
  run: (executor: ReturnType<typeof createWandboxExecutor>) => Promise<T>,
  createExecutor = createWandboxExecutor
): Promise<T> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { codes } = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(reply(codes[0].file, codes[0].code)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await run(createExecutor({ compileUrl: `http://127.0.0.1:${port}/compile` }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
