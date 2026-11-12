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
    'whitespace before a token that does not match, which a failed call consumes',
    'Scanner sc = new Scanner(System.in); try { sc.nextInt(); } catch (InputMismatchException e) { System.out.println("[" + sc.nextLine() + "]"); }',
    '  bad rest',
    '[bad rest]\n',
  ],
  [
    'full-width and other Unicode digits',
    'Scanner sc = new Scanner(System.in); System.out.println(sc.hasNextInt() + " " + sc.nextInt() + " " + sc.nextLong() + " " + sc.nextDouble());',
    '１２３ ١٢٣ ３.５',
    'true 123 123 3.5\n',
  ],
  [
    'a digit outside the BMP, which is no digit to Java',
    'Scanner sc = new Scanner(System.in); System.out.println(sc.hasNextInt() + " " + sc.hasNextLong() + " " + sc.hasNextDouble()); try { sc.nextInt(); } catch (InputMismatchException e) { System.out.println(sc.next()); }',
    '\u{1D7D9}',
    'false false false\n\u{1D7D9}\n',
  ],
  [
    'scanners made for each read, which take the lines they read ahead',
    'for (int i = 0; i < 3; i++) { Scanner sc = new Scanner(System.in); System.out.println(sc.hasNextInt() ? sc.nextInt() : -1); }',
    '1 2\n3\n',
    '1\n3\n-1\n',
  ],
  [
    'a scanner and a reader of the same input',
    'Scanner sc = new Scanner(System.in); int n = sc.nextInt(); BufferedReader br = new BufferedReader(new InputStreamReader(System.in)); System.out.println(n + " " + br.readLine() + " " + sc.nextLine());',
    '1 a\nb\n',
    '1 b  a\n',
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

test.each([
  [
    'a buffered writer, which passes on full buffers only',
    'StringWriter s = new StringWriter(); BufferedWriter w = new BufferedWriter(s, 4); w.write("abc"); w.write("de"); System.out.println(s); w.write("fghijk"); System.out.println(s);',
    {},
    'abcd\nabcdefgh\n',
  ],
  [
    'a buffered writer given arrays and chars',
    "StringWriter s = new StringWriter(); BufferedWriter w = new BufferedWriter(s, 4); w.write(\"ab\"); w.write(new char[] { 'c', 'd', 'e', 'f', 'g' }); System.out.println(s); w.write(new char[] { 'h', 'i' }); w.write(new char[] { 'j', 'k', 'l' }); System.out.println(s); for (char c : \"mnop\".toCharArray()) w.write(c); System.out.println(s); w.write('q'); System.out.println(s);",
    {},
    'abcdefg\nabcdefghi\nabcdefghijklm\nabcdefghijklm\n',
  ],
  [
    'a file that a reader reads after the program rewrites it',
    'FileInputStream in = new FileInputStream("x"); Files.writeString(Path.of("x"), "new"); System.out.println((char) in.read());',
    { x: 'old' },
    'n\n',
  ],
  [
    'a copy or a move of a file to itself',
    'Files.copy(Path.of("x"), Path.of("./x"), StandardCopyOption.REPLACE_EXISTING); Files.move(Path.of("x"), Path.of("x")); System.out.println(Files.readString(Path.of("x")));',
    { x: 'old' },
    'old\n',
  ],
  [
    'streams of files closed by try-with-resources',
    'try (java.util.stream.Stream<String> lines = Files.lines(Path.of("x"))) { System.out.println(lines.count()); } java.util.stream.Stream<String> s = java.util.stream.Stream.of("a"); s.close(); try { s.count(); } catch (IllegalStateException e) { System.out.println(e.getMessage()); }',
    { x: 'a\nb' },
    '2\nstream has already been operated upon or closed\n',
  ],
  [
    'a copy that replaces a file with a directory',
    'Files.createDirectory(Path.of("d")); Files.copy(Path.of("d"), Path.of("x"), StandardCopyOption.REPLACE_EXISTING); System.out.println(Files.isDirectory(Path.of("x")));',
    { x: 'old' },
    'true\n',
  ],
  [
    'a writer still open on a file that a copy replaces',
    'FileOutputStream out = new FileOutputStream("x", true); Files.writeString(Path.of("y"), "hello"); Files.copy(Path.of("y"), Path.of("x"), StandardCopyOption.REPLACE_EXISTING); out.write(33); out.close(); System.out.println(Files.readString(Path.of("x")));',
    { x: 'old' },
    'hello\n',
  ],
  [
    'an exclusive creation over a directory',
    'Files.createDirectory(Path.of("d")); try { Files.createFile(Path.of("d")); } catch (FileAlreadyExistsException e) { System.out.println("exists " + e.getMessage()); }',
    {},
    'exists d\n',
  ],
  [
    'a write past the end of a file another writer truncated',
    'FileOutputStream first = new FileOutputStream("x"); first.write(65); first.write(66); FileOutputStream second = new FileOutputStream("x"); first.write(67); first.close(); second.close(); System.out.println(Files.readString(Path.of("x")).replace((char) 0, \'.\'));',
    {},
    '..C\n',
  ],
  [
    'a PrintWriter that closes without failing',
    'PrintWriter p = new PrintWriter(new StringWriter()); p.println(1); p.close(); System.out.println(p.checkError());',
    {},
    'false\n',
  ],
  [
    'a deletion through a path whose parent is a file',
    'System.out.println(Files.deleteIfExists(Path.of("none"))); try { Files.deleteIfExists(Path.of("x/child")); } catch (IOException e) { System.out.println(e); }',
    { x: 'old' },
    'false\njava.nio.file.FileSystemException: x/child: Not a directory\n',
  ],
  [
    'a pipeline consumed after the stream of a file that starts it closes',
    'java.util.stream.Stream<String> lines = Files.lines(Path.of("x")); java.util.stream.Stream<String> mapped = lines.map(s -> s); java.util.stream.Stream<String> sorted = Files.lines(Path.of("x")).sorted(); lines.close(); try { mapped.count(); } catch (IllegalStateException e) { System.out.println("closed"); } try { mapped.forEach(System.out::println); } catch (IllegalStateException e) { System.out.println("used"); } sorted.close(); System.out.println(Files.lines(Path.of("x")).filter(s -> true).count());',
    { x: 'old' },
    'closed\nused\n1\n',
  ],
  [
    'a reader by path that reads the file as rewritten',
    'BufferedReader r = Files.newBufferedReader(Path.of("x")); Files.writeString(Path.of("x"), "new"); System.out.println(r.readLine());',
    { x: 'old' },
    'new\n',
  ],
  [
    'a stream of lines consumed after the file is rewritten',
    'java.util.stream.Stream<String> s = Files.lines(Path.of("x")); Files.writeString(Path.of("x"), "new"); System.out.println(s.findFirst().get());',
    { x: 'old' },
    'new\n',
  ],
  [
    'a copy to a missing directory',
    'Files.createDirectory(Path.of("d")); for (String from : new String[] { "x", "d" }) { try { Files.copy(Path.of(from), Path.of("missing/y")); } catch (IOException e) { System.out.println(e); } }',
    { x: 'old' },
    'java.nio.file.NoSuchFileException: missing/y\njava.nio.file.NoSuchFileException: missing/y\n',
  ],
  [
    'the readiness of readers at their end',
    'StringReader r = new StringReader("a"); r.read(); BufferedReader f = new BufferedReader(new FileReader("x")); f.readLine(); System.out.println(r.ready() + " " + new BufferedReader(new StringReader("")).ready() + " " + f.ready());',
    { x: 'old' },
    'true true false\n',
  ],
  [
    'a move to a missing directory',
    'try { Files.move(Path.of("x"), Path.of("missing/y")); } catch (IOException e) { System.out.println(e); }',
    { x: 'old' },
    'java.nio.file.NoSuchFileException: x -> missing/y\n',
  ],
  [
    'the size of a directory and a reader that skips backward',
    'Files.createDirectory(Path.of("d")); StringReader r = new StringReader("abc"); r.read(); r.read(); System.out.println(Files.size(Path.of("d")) + " " + r.skip(-5) + " " + (char) r.read() + " " + new File("d/.").delete());',
    {},
    '4096 -2 a false\n',
  ],
  [
    'a stream of lines of a closed reader',
    'BufferedReader r = new BufferedReader(new StringReader("a")); java.util.stream.Stream<String> s = r.lines(); r.close(); try { s.count(); } catch (UncheckedIOException e) { System.out.println(e.getMessage() + " " + e.getCause()); }',
    {},
    'java.io.IOException: Stream closed java.io.IOException: Stream closed\n',
  ],
  [
    'directories made again',
    'System.out.println(new File("d/e").mkdirs() + " " + new File("d/e").mkdirs());',
    {},
    'true false\n',
  ],
])('Java handles %s', (_, body, files, stdout) => {
  expect(runJava(body, { files })).toMatchObject({ stdout, uncaughtException: undefined });
});

test('an unclosed FileWriter keeps only the full buffers it passed on', () => {
  const execution = executeProgram('java', main('FileWriter w = new FileWriter("a.txt"); w.write("x".repeat(8193));'));
  expect(execution).toMatchObject({ kind: 'executed', finalFiles: { 'a.txt': 'x'.repeat(8192) } });
});

test('an unclosed FileWriter keeps an exactly full buffer to itself', () => {
  const execution = executeProgram('java', main('FileWriter w = new FileWriter("a.txt"); w.write("x".repeat(8192));'));
  expect(execution).toMatchObject({ kind: 'executed', finalFiles: { 'a.txt': '' } });
});

test('writes to a file deleted while open count toward the storage limit', () => {
  expect(
    runJava(
      'String text = Files.readString(Path.of("data")); Files.delete(Path.of("data")); FileWriter w = new FileWriter("a"); Files.writeString(Path.of("a"), text); Files.delete(Path.of("a")); w.write(text); w.flush(); Files.writeString(Path.of("b"), text);',
      { files: { data: 'x'.repeat(600_000) } }
    )
  ).toEqual({ kind: 'limitExceeded', limit: 'storage' });
});

test('the storage limit counts the files that exist, not the files deleted or replaced', () => {
  expect(
    runJava(
      'String big = "x".repeat(10000); for (int i = 0; i < 200; i++) { try (FileWriter w = new FileWriter("tmp.txt")) { w.write(big); } new File("tmp.txt").delete(); Files.writeString(Path.of("a"), big); Files.move(Path.of("a"), Path.of("b"), StandardCopyOption.REPLACE_EXISTING); }'
    )
  ).toMatchObject({ finalFiles: { b: 'x'.repeat(10_000) }, uncaughtException: undefined });
});

test('a deeply nested path is charged to the run, which ends with a result', () => {
  const deep = `${'a/'.repeat(30_000)}f`;
  expect(
    executeProgram(
      'javascript',
      `require('fs').mkdirSync('a/'.repeat(30000), { recursive: true }); require('fs').writeFileSync('${deep}', 'x');`
    )
  ).toMatchObject({ kind: 'executed', finalFiles: { [deep]: 'x' } });
  expect(
    executeProgram('javascript', `for (;;) require('fs').mkdirSync('a/'.repeat(30000), { recursive: true });`)
  ).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('Java lets programs use StringWriter and close a StringReader without handling IOException', () => {
  const source = `import java.io.*;\nclass Main {\n  public static void main(String[] args) {\n    StringWriter s = new StringWriter();\n    s.write("a");\n    s.append('b').flush();\n    new StringReader("c").close();
    try {
      s.write(new char[] { 'd' });
    } catch (IOException e) {
      System.out.println(e);
    }\n    System.out.println(s);\n  }\n}`;
  expect(executeProgram('java', source)).toMatchObject({ kind: 'executed', stdout: 'abd\n' });
});

test.each([
  ['a StringWriter', 'StringWriter w = new StringWriter();'],
  ['the buffer of a BufferedWriter', 'BufferedWriter w = new BufferedWriter(new StringWriter(), 3000000);'],
])('%s grows only within the length of one string', (_, declaration) => {
  expect(
    runJava(`${declaration} String x = "x".repeat(100000); for (int i = 0; i < 100; i++) w.write(x);`)
  ).toMatchObject({ uncaughtException: 'java.lang.OutOfMemoryError: Java heap space' });
});

test('a program may open many buffered writers', () => {
  expect(
    runJava(
      'for (int i = 0; i < 300; i++) { try (PrintWriter p = new PrintWriter(new BufferedWriter(new FileWriter("f" + i)))) { p.print(i); } }'
    )
  ).toMatchObject({ uncaughtException: undefined, finalFiles: expect.objectContaining({ f299: '299' }) });
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
    "const fs = require('node:fs'); console.log(fs.mkdirSync('a/b', { recursive: true })); fs.writeFileSync('a/b/c.txt', 'x'); fs.writeFileSync('a/b/c.txt', 'y', { flag: 'a' }); fs.appendFileSync('a/b/c.txt', 'z'); fs.renameSync('in.txt', 'a/b/../in.txt'); fs.mkdirSync('a/b/../c/../e', { recursive: true }); fs.rmdirSync('a/e'); fs.rmdirSync('a/c'); console.log(fs.readdirSync('a'), fs.existsSync('in.txt')); fs.unlinkSync('a/in.txt');",
    { stdout: "a\n[ 'b', 'in.txt' ] false\n", stderr: '', finalFiles: { 'a/b/c.txt': 'xyz' } },
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
  [
    "require('fs').readFileSync('missing/../d/f.txt')",
    "Error: ENOENT: no such file or directory, open 'missing/../d/f.txt'",
  ],
  ["require('fs').writeFileSync('d/f.txt/.', 'x')", "Error: ENOTDIR: not a directory, open 'd/f.txt/.'"],
  ["require('fs').writeFileSync('d/f.txt/', 'x')", "Error: ENOTDIR: not a directory, open 'd/f.txt/'"],
  ["require('fs').writeFileSync('new/', 'x')", "Error: EISDIR: illegal operation on a directory, open 'new/'"],
  ["require('fs').renameSync('d/f.txt', 'g/')", "Error: ENOTDIR: not a directory, rename 'd/f.txt' -> 'g/'"],
  ["require('fs').readFileSync('')", "Error: ENOENT: no such file or directory, open ''"],
  ["require('fs').rmdirSync('d/.')", "Error: EINVAL: invalid argument, rmdir 'd/.'"],
  ["require('fs').renameSync('d/.', 'e')", "Error: EINVAL: invalid argument, rename 'd/.' -> 'e'"],
  ["if (require('fs').existsSync('')) throw new Error('exists');", undefined],
  ["require('fs').readFileSync('d/f.txt/../f.txt')", "Error: ENOTDIR: not a directory, open 'd/f.txt/../f.txt'"],
  ["require('fs').writeFileSync('d/f.txt', 'x', { flag: 'wx' })", "Error: EEXIST: file already exists, open 'd/f.txt'"],
  [
    "require('fs').writeFileSync('none.txt', 'x', { flag: 'r+' })",
    "Error: ENOENT: no such file or directory, open 'none.txt'",
  ],
  [
    "require('fs').writeFileSync('a.txt', 'x', { flag: 'q' })",
    "TypeError: The argument 'flags' is invalid. Received 'q'",
  ],
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
  expect(executeProgram('javascript', "console.log('x'.repeat(60000)); console.error('y'.repeat(60000));")).toEqual({
    kind: 'limitExceeded',
    limit: 'output',
  });
});
