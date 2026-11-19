import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// Every expected output below is what GNU Bash 5.3 printed for the same program, run as `main.sh` in the
// `en_US.UTF-8` locale on arm64 macOS.

test('associative arrays list their keys in Bash hash order, and a seeded RANDOM repeats Bash sequence', () => {
  const program = `declare -A m=([b]=1 [a]=2 [c]=3 [zz]=4 [k1]=5 [k2]=6)
echo "\${!m[@]}"
declare -A big
for ((i = 0; i < 300; i++)); do big[key$i]=$i; done
keys=("\${!big[@]}"); echo "\${keys[0]} \${keys[100]} \${keys[299]}"
RANDOM=42; echo $RANDOM $RANDOM $RANDOM
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'c b a zz k1 k2\nkey143 key176 key49\n17772 26794 1435\n',
    stderr: '',
  });
});

test('an arithmetic error abandons the rest of its line, except in let, and invalid arithmetic fails only when run', () => {
  const program = `echo $((1/0)); echo same line
echo next line
x=$(( 08 )); echo "x=$x"
let "a = 1 +"; echo "let $?"
echo $(( 2 + )); echo dropped
echo end
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'next line\nlet 1\nend\n',
    stderr: [
      'main.sh: line 1: 1/0: division by 0 (error token is "0")',
      'main.sh: line 3: 08: value too great for base (error token is "08")',
      'main.sh: line 4: let: a = 1 +: arithmetic syntax error: operand expected (error token is "+")',
      'main.sh: line 5: 2 + : arithmetic syntax error: operand expected (error token is "+ ")',
      '',
    ].join('\n'),
  });
});

test('printf rounds and pads as macOS libc does, counting bytes, and echo -e reads escapes', () => {
  const program = `printf '%.0f %.0f %.2f %g %e %5.1f|%-6s|%05d|%x\\n' 0.5 2.5 1.005 0.0001 12345 3.14159 ab 42 255
printf '%d\\n' 3.5 12abc
printf '%5s|%.1s|\\n' 亀 ab
echo -e 'a\\tb\\x41\\0101\\c' never
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: '0 2 1.00 0.0001 1.234500e+04   3.1|ab    |00042|ff\n3\n12\n  亀|a|\na\tbAA',
    stderr: 'main.sh: line 2: printf: 3.5: invalid number\nmain.sh: line 2: printf: 12abc: invalid number\n',
  });
});

test('words split at IFS, and parameter expansion quotes patterns and replacements as Bash does', () => {
  const program = `x='a b  c'; set -- "a b" "" c
printf '<%s>' $x "$x" "$@" $@ "$*"; echo
IFS=' ,'; v=' ,b'; printf '<%s>' $v; echo; unset IFS
s=abcabc
echo "\${s#'a'}" "\${s//b/[&]}" "\${s/b/\\&}" "\${s:2:-1}" "\${s^^[ab]}" "\${u:-'q r'}" \${u:-'q r'}
echo {1..3} {a,b}x {05..10..2} a{,b}
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: [
      '<a><b><c><a b  c><a b><><c><a><b><c><a b  c>',
      '<><b>',
      "bcabc a[b]ca[b]c a&cabc cab ABcABc 'q r' q r",
      '1 2 3 ax bx 05 07 09 a ab',
      '',
    ].join('\n'),
  });
});

test('tests, readonly variables, and bad subscripts report errors and continue or abandon the line as Bash does', () => {
  const program = `[ abc -eq 1 ]; echo "st $?"
[ a b c ]; echo "st $?"
[[ a < B ]] && echo collated
[ a \\< B ] || echo bytewise
[[ abc =~ (a|ab)(c|bcd)? ]] && echo "\${BASH_REMATCH[*]}"
readonly r=1
r=2; echo dropped
r=3 echo "runs $?"
a=(1 2); echo "\${a[-5]}" next; a[-5]=x; echo dropped
nosuch; echo "st $?"
f() { break; echo after; }; for i in 1; do f; done
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'st 2\nst 2\ncollated\nbytewise\nabc ab c\nruns 1\n next\nst 127\nafter\n',
    stderr: [
      'main.sh: line 1: [: abc: integer expected',
      'main.sh: line 2: [: b: binary operator expected',
      'main.sh: line 7: r: readonly variable',
      'main.sh: line 8: r: readonly variable',
      'main.sh: line 9: a: bad array subscript',
      'main.sh: line 9: a[-5]: bad array subscript',
      'main.sh: line 10: nosuch: command not found',
      "main.sh: line 11: break: only meaningful in a `for', `while', or `until' loop",
      '',
    ].join('\n'),
  });
});

test('a syntax error rejects the program before it runs', () => {
  expect(executeProgram('bash', 'echo a\nif then\n  echo b\nfi\n')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: "構文エラーです（syntax error near unexpected token `then'）。" }],
  });
  expect(executeProgram('bash', 'echo a\nif true; then\n  echo b\n')).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 1, message: "構文エラーです（syntax error: unexpected end of file from `if' command on line 2）。" },
    ],
  });
});

test('features this environment does not provide stop the program with a message', () => {
  expect(executeProgram('bash', 'echo a | cat\n')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'パイプ（|）は、この採点環境では使えません。' }],
  });
  expect(executeProgram('bash', 'echo before\nls\necho after\n')).toMatchObject({
    kind: 'executed',
    stdout: 'before\n',
    uncaughtException: '外部コマンド（ls）は、この採点環境では使えません。',
  });
  expect(executeProgram('bash', 'echo *\n')).toMatchObject({
    uncaughtException: expect.stringContaining('ファイル名の展開'),
  });
  expect(executeProgram('bash', 'read x\n')).toMatchObject({
    uncaughtException: '標準入力（read）は、この採点環境では使えません。',
  });
});

test('a turtle error stops the program, and standard error is kept but separate', () => {
  const program = `turtle_new t 0 6
echo moving >&2
前に進む "$t"
echo never
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    stderr: 'moving\nmain.sh: line 3: 前に進む: Out of bounds: (0, 7)\n',
    uncaughtException: 'main.sh: line 3: 前に進む: Out of bounds: (0, 7)',
  });
});
