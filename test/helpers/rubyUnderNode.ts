import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

const resultsSchema = z.array(
  z.object({ kind: z.string(), limit: z.string().optional(), stdout: z.string().optional() })
);

export function rubyUnderNode(programs: string[]): z.infer<typeof resultsSchema> {
  const root = path.join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(path.join(root, 'ruby-node-'));
  try {
    const prepare = `const out=process.argv[1];const transpiler=new Bun.Transpiler({loader:'ts',target:'node'});for await(const file of new Bun.Glob('src/**/*.ts').scan('.'))await Bun.write(out+'/'+file,transpiler.transformSync(await Bun.file(file).text()));`;
    execFileSync('bun', ['--eval', prepare, temporary], { encoding: 'utf8', timeout: 30_000 });
    const loader = path.join(temporary, 'loader.mjs');
    writeFileSync(
      loader,
      `
import {registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
registerHooks({
  resolve(spec,context,next){
    try{return next(spec,context)}catch(error){
      if(spec.startsWith('.')&&context.parentURL)for(const suffix of ['.ts','/index.ts']){
        const url=new URL(spec+suffix,context.parentURL);
        if(existsSync(url))return {url:url.href,format:'module',shortCircuit:true};
      }
      throw error;
    }
  },
  load(url,context,next){
    if(url.startsWith('file:')&&url.endsWith('.json'))return {format:'module',source:'export default '+readFileSync(fileURLToPath(url),'utf8'),shortCircuit:true};
    if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:readFileSync(${JSON.stringify(temporary)}+'/'+fileURLToPath(url).slice(process.cwd().length+1),'utf8'),shortCircuit:true};
    return next(url,context);
  }
});`
    );
    const script = `import {executeProgram} from './src/interpreter/program.ts';console.log(JSON.stringify(${JSON.stringify(programs)}.map(program=>executeProgram('ruby',program))));`;
    const stdout = execFileSync('node', ['--import', loader, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return resultsSchema.parse(JSON.parse(stdout));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
