import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
import type { ProgramInput } from '../../src/interpreter/programIo';

const main = (body: string): string =>
  `import java.io.*;\nimport java.nio.file.*;\nimport java.util.*;\n\npublic class Main {\n  public static void main(String[] args) throws Exception {\n    ${body}\n  }\n}`;

function runJava(body: string, input?: ProgramInput): unknown {
  const execution = executeProgram('java', main(body), input);
  if (execution.kind !== 'executed') return execution;
  const { stdout, stderr, finalFiles, uncaughtException } = execution;
  return { stdout, stderr, finalFiles, uncaughtException };
}

function runJavaScript(source: string, input?: ProgramInput): unknown {
  const execution = executeProgram('javascript', source, input);
  if (execution.kind !== 'executed') return execution;
  const { stdout, stderr, finalFiles, uncaughtException } = execution;
  return { stdout, stderr, finalFiles, uncaughtException };
}

test.each([
  [
    'tokens and the rest of a line',
    'Scanner sc = new Scanner(System.in); int n = sc.nextInt(); long sum = 0; for (int i = 0; i < n; i++) sum += sc.nextLong(); System.out.println(sum + "|" + sc.nextLine() + "|" + sc.nextLine() + "|" + sc.hasNextLine());',
    '3\n1 2 3000000000\nAlice Bob\n',
    '3000000003||Alice Bob|false\n',
  ],
  [
    'a token that does not match, which stays unread',
    'Scanner sc = new Scanner(System.in); try { sc.nextInt(); } catch (InputMismatchException e) { System.out.println(sc.hasNextInt() + " " + sc.next() + " " + sc.nextDouble() + " " + sc.nextBoolean()); }',
    'abc 1,500.5 TRUE',
    'false abc 1500.5 true\n',
  ],
  [
    'an int out of range',
    'Scanner sc = new Scanner(System.in); try { sc.nextInt(); } catch (InputMismatchException e) { System.out.println(e.getMessage() + " " + sc.nextLong()); }',
    '2147483648',
    'For input string: "2147483648" 2147483648\n',
  ],
  [
    'a closed scanner, which closes standard input for later scanners',
    'Scanner sc = new Scanner(System.in); System.out.println(sc.next()); sc.close(); System.out.println(new Scanner(System.in).hasNext()); try { sc.next(); } catch (IllegalStateException e) { System.out.println(e.getMessage()); }',
    'a b',
    'a\nfalse\nScanner closed\n',
  ],
  [
    'lines from a BufferedReader',
    'BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); String line; while ((line = br.readLine()) != null) System.out.println("[" + line + "]");',
    'x\r\ny\n\nz',
    '[x]\n[y]\n[]\n[z]\n',
  ],
  [
    'lines from IO.readln',
    'String a = IO.readln("name? "); String b = IO.readln(); IO.println(a + "," + b);',
    'Ann',
    'name? Ann,null\n',
  ],
  [
    'the UTF-8 bytes of System.in',
    'int b; StringBuilder sb = new StringBuilder(); while ((b = System.in.read()) != -1) sb.append(b).append(" "); System.out.println(sb);',
    'aé',
    '97 195 169 \n',
  ],
])('Java reads standard input: %s', (_, body, stdin, stdout) => {
  expect(runJava(body, { stdin })).toMatchObject({ stdout, uncaughtException: undefined });
});

test('Java writes standard error apart from standard output', () => {
  expect(
    runJava('System.out.print("out"); System.err.println("err"); System.err.printf("%d%n", 1); System.out.write(65);')
  ).toEqual({ stdout: 'outA', stderr: 'err\n1\n', finalFiles: {}, uncaughtException: undefined });
});

test.each([
  [
    'a writer that it closes',
    'try (PrintWriter out = new PrintWriter(new BufferedWriter(new FileWriter("out/a.txt")))) { out.println("x"); out.printf("%.1f%n", 1.25); }',
    { 'out/a.txt': 'x\n1.3\n' },
  ],
  [
    'a writer that it never closes, which loses its text as in Java',
    'FileWriter w = new FileWriter("a.txt"); w.write("lost"); PrintWriter p = new PrintWriter("b.txt"); p.println("lost");',
    { 'a.txt': '', 'b.txt': '' },
  ],
  [
    'a writer that appends',
    'try (FileWriter w = new FileWriter(new File("log.txt"), true)) { w.write("b"); w.write(\'c\'); }',
    { 'log.txt': 'abc' },
  ],
  [
    'paths with Files',
    String.raw`Path p = Path.of("d", "x.txt"); Files.createDirectories(p.getParent()); Files.writeString(p, "1\n"); Files.writeString(p, "2\n", StandardOpenOption.APPEND); Files.write(Paths.get("lines.txt"), List.of("a", "b")); Files.copy(p, Path.of("copy.txt")); Files.move(Path.of("copy.txt"), Path.of("d/moved.txt")); Files.delete(Path.of("log.txt"));`,
    { 'd/moved.txt': '1\n2\n', 'd/x.txt': '1\n2\n', 'lines.txt': 'a\nb\n', 'out/.keep': '' },
  ],
  [
    'directories and files with File',
    'File dir = new File("new/sub"); System.out.println(dir.mkdir() + " " + dir.mkdirs() + " " + new File(dir, "f.txt").createNewFile() + " " + Arrays.toString(dir.list()) + " " + new File("log.txt").renameTo(new File("new/log.txt")) + " " + new File("out/.keep").delete());',
    { 'new/log.txt': 'a', 'new/sub/f.txt': '' },
  ],
])('Java writes files: %s', (_, body, finalFiles) => {
  expect(runJava(body, { files: { 'log.txt': 'a', 'out/.keep': '' } })).toMatchObject({
    finalFiles,
    uncaughtException: undefined,
  });
});

test.each([
  [
    'files it opens to read',
    'try (BufferedReader br = new BufferedReader(new FileReader("in.txt"))) { System.out.println(br.readLine() + br.read() + br.ready()); } Scanner sc = new Scanner(new File("in.txt")); System.out.println(sc.nextLine() + sc.next() + sc.nextInt());',
    'ab98true\nabb12\n',
  ],
  [
    'files it reads by their paths',
    'Path p = Paths.get("./in.txt"); System.out.println(Files.readAllLines(p) + " " + Files.readString(p).length() + " " + Files.size(p) + " " + Files.exists(p) + " " + Files.isDirectory(Path.of("d")) + " " + p.normalize() + " " + p.toAbsolutePath() + " " + p.getFileName()); Files.lines(Path.of("d/日本.txt")).forEach(System.out::println);',
    '[ab, b, 12] 8 8 true true in.txt /./in.txt in.txt\n日本語\n',
  ],
  [
    'attributes of files',
    'File f = new File("d//日本.txt/"); System.out.println(f.getPath() + " " + f.getName() + " " + f.getParent() + " " + f.length() + " " + f.isFile() + " " + new File("d").isDirectory() + " " + new File("none").exists() + " " + f.getAbsolutePath());',
    'd/日本.txt 日本.txt d 10 true true false /d/日本.txt\n',
  ],
])('Java reads %s', (_, body, stdout) => {
  expect(runJava(body, { files: { 'in.txt': 'ab\nb\n12\n', 'd/日本.txt': '日本語\n' } })).toMatchObject({
    stdout,
    uncaughtException: undefined,
  });
});

test.each([
  [
    'a missing file to read',
    'new FileReader("none.txt");',
    'java.io.FileNotFoundException: none.txt (No such file or directory)',
  ],
  ['a directory to write', 'new FileWriter("d");', 'java.io.FileNotFoundException: d (Is a directory)'],
  ['a missing path', 'Files.readString(Path.of("none.txt"));', 'java.nio.file.NoSuchFileException: none.txt'],
  ['a file that exists', 'Files.createFile(Path.of("d/f.txt"));', 'java.nio.file.FileAlreadyExistsException: d/f.txt'],
  ['a directory that is not empty', 'Files.delete(Path.of("d"));', 'java.nio.file.DirectoryNotEmptyException: d'],
  [
    'a move onto a file',
    'Files.move(Path.of("d/f.txt"), Path.of("d/g.txt"));',
    'java.nio.file.FileAlreadyExistsException: d/g.txt',
  ],
  ['a scanner at the end of input', 'new Scanner("").nextLine();', 'java.util.NoSuchElementException: No line found'],
  ['a closed reader', 'Reader r = new StringReader("a"); r.close(); r.read();', 'java.io.IOException: Stream closed'],
])('Java throws for %s', (_, body, uncaughtException) => {
  expect(runJava(body, { files: { 'd/f.txt': '', 'd/g.txt': '' } })).toMatchObject({ uncaughtException });
});

test('Java requires programs to catch or declare the IOException of opening a file', () => {
  const source = `import java.io.*;\nclass Main {\n  public static void main(String[] args) {\n    new FileReader("a.txt");\n  }\n}`;
  expect(executeProgram('java', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 3 }] });
});

test('a PrintWriter reports the failures of a closed writer through checkError', () => {
  expect(
    runJava(
      'StringWriter s = new StringWriter(); PrintWriter p = new PrintWriter(new BufferedWriter(s)); p.print("a"); System.out.println(p.checkError() + s.toString()); p.close(); p.print("b"); System.out.println(p.checkError() + s.toString());'
    )
  ).toMatchObject({ stdout: 'falsea\ntruea\n', uncaughtException: undefined });
});

test('a trace records a model program that reads standard input', () => {
  const program = main(
    'Scanner sc = new Scanner(System.in);\n    int x = sc.nextInt();\n    System.out.println(x * 2);'
  );
  const trace = traceProgram('java', program, program, { stdin: '21' });
  expect(trace.traceItems.at(-1)?.vars).toEqual({ x: 21 });
  expect(trace.stdout).toBe('42\n');
});

test.each([
  [
    'reads standard input',
    String.raw`const fs = require('fs'); const [n, ...rest] = fs.readFileSync(0, 'utf8').trim().split('\n').map(Number); console.log(n, rest.reduce((a, b) => a + b, 0)); console.log(fs.readFileSync('/dev/stdin', 'utf8') === '');`,
    { stdout: '2 30\ntrue\n', stderr: '', finalFiles: { 'in.txt': 'abc' } },
  ],
  [
    'writes files',
    "const fs = require('node:fs'); console.log(fs.mkdirSync('a/b', { recursive: true })); fs.writeFileSync('a/b/c.txt', 'x'); fs.appendFileSync('a/b/c.txt', 'y'); fs.renameSync('in.txt', 'a/in.txt'); console.log(fs.readdirSync('a'), fs.existsSync('in.txt')); fs.unlinkSync('a/in.txt');",
    { stdout: "/a\n[ 'b', 'in.txt' ] false\n", stderr: '', finalFiles: { 'a/b/c.txt': 'xy' } },
  ],
  [
    'writes to the standard streams',
    "process.stdout.write('a'); process.stderr.write('b'); console.warn('c'); console.error('d'); console.info('e');",
    { stdout: 'ae\n', stderr: 'bc\nd\n', finalFiles: { 'in.txt': 'abc' } },
  ],
])('JavaScript %s', (_, source, expected) => {
  expect(runJavaScript(source, { stdin: '2\n10\n20\n', files: { 'in.txt': 'abc' } })).toEqual({
    ...expected,
    uncaughtException: undefined,
  });
});

test.each([
  ["require('fs').readFileSync('none.txt')", "Error: ENOENT: no such file or directory, open 'none.txt'"],
  ["require('fs').readFileSync('d')", 'Error: EISDIR: illegal operation on a directory, read'],
  ["require('fs').mkdirSync('d')", "Error: EEXIST: file already exists, mkdir 'd'"],
  ["require('fs').rmdirSync('d')", "Error: ENOTEMPTY: directory not empty, rmdir 'd'"],
  ["require('fs').renameSync('x', 'y')", "Error: ENOENT: no such file or directory, rename 'x' -> 'y'"],
  [
    "try { require('fs').unlinkSync('x'); } catch (e) { throw new Error(e.code + e.errno + e.syscall + e.path); }",
    'Error: ENOENT-2unlinkx',
  ],
  ["require('http')", "Error: Cannot find module 'http'"],
])('JavaScript throws as Node.js does: %s', (source, uncaughtException) => {
  expect(runJavaScript(source, { files: { 'd/f.txt': '' } })).toMatchObject({ uncaughtException });
});

test.each([
  ['Java', 'java', main('try (FileWriter w = new FileWriter("a.txt")) { while (true) w.write("x".repeat(1000)); }')],
  ['JavaScript', 'javascript', "for (;;) require('fs').appendFileSync('a.txt', 'x'.repeat(1000));"],
] as const)('%s stops a program that writes too much to files', (_, language, source) => {
  expect(executeProgram(language, source)).toEqual({ kind: 'limitExceeded', limit: 'storage' });
});

test('standard output and standard error share one limit', () => {
  expect(
    executeProgram('javascript', "for (;;) { console.log('x'.repeat(500)); console.error('y'.repeat(500)); }")
  ).toEqual({
    kind: 'limitExceeded',
    limit: 'output',
  });
});
