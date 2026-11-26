import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// Every expected output below is what GNU Bash 5.3 printed for the same program, run as `main.sh` in an
// `en_US.UTF-8` locale.

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

test('an associative array counts from its declaration, rejects an empty key, and slices from its first element', () => {
  const program = `declare -A count
for w in b a b; do (( count[$w]++ )); done
declare -p count
k=; count[$k]=1; echo dropped
echo "[\${count[$k]}]" $(( count[$k] ))
declare -A n=([one]=1 [two]=2 [three]=3 [four]=4)
echo "\${n[@]}" "|" "\${n[@]:1:2}" "|" "\${n[@]: -1}"
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'declare -A count=([b]="2" [a]="1" )\n[] 0\n4 2 3 1 | 4 2 | 1\n',
    stderr: [
      'main.sh: line 4: count[$k]: bad array subscript',
      'main.sh: line 5: count: bad array subscript',
      'main.sh: line 5: count[]: bad array subscript',
      'main.sh: line 5: count[]: bad array subscript',
      '',
    ].join('\n'),
  });
});

test('a bad loop count leaves every loop, extra operands abandon the line, and a non-numeric count exits', () => {
  const program = `for i in 1 2; do for j in 1 2; do break 0; done; echo inner; done; echo "status $?"
for i in 1 2; do if (( i == 2 )); then break; fi; false; done; echo "status $?"
echo \`echo "a \\\`echo b\\\`"\`
for i in 1; do break 1 2; done; echo dropped
for i in 1; do continue x; done
echo never
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'status 1\nstatus 0\na b\n',
    stderr: [
      'main.sh: line 1: break: 0: loop count out of range',
      'main.sh: line 4: break: too many arguments',
      'main.sh: line 5: continue: x: numeric argument required',
      '',
    ].join('\n'),
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

test('printf rounds and pads as Bash does, counting bytes, and echo -e reads escapes', () => {
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

test('whole-variable namerefs, declare -g globals, and temporary scalar prefixes work while niche combinations fail explicitly', () => {
  const program = `f() {
  local -n ref=$1
  local shadow=inner
  declare -gi global_sum=2+3
  ref[k]=updated
  echo "\${FUNCNAME[0]}|$shadow|\${ref[k]}|$global_sum"
}
declare -A box=([k]=old)
shadow=outer
TMP=scoped f box
echo "$shadow|\${box[k]}|$global_sum|\${TMP-unset}"
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'f|inner|updated|5\nouter|updated|5|unset\n',
    stderr: '',
  });
  for (const unsupported of [
    'p=temp export p=new\n',
    'f() { local TMP; }; TMP=scoped f\n',
    'x=1; declare -a x\n',
    'a=(1 2); local_fn() { local -n r="a[0]"; }; local_fn\n',
    'PIPESTATUS=(1)\n',
    'unset RANDOM\n',
    'f() { local PATH=x; declare -g PATH; }; f; echo "${PATH-unset}"\n',
  ]) {
    expect(executeProgram('bash', unsupported)).toMatchObject({
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
});

test('a syntax error rejects the program before it runs, naming the token and line Bash reports', () => {
  expect(executeProgram('bash', 'echo a\nif then\n  echo b\nfi\n')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: "構文エラーです（syntax error near unexpected token `then'）。" }],
  });
  expect(executeProgram('bash', 'echo a\nif true; then\n  echo b\n')).toEqual({
    kind: 'compileError',
    diagnostics: [
      { row: 3, message: "構文エラーです（syntax error: unexpected end of file from `if' command on line 2）。" },
    ],
  });
  // The grammar accepts some programs Bash rejects, and the token Bash stops at is not where the grammar fails.
  expect(executeProgram('bash', 'for i in 1 2 3 do echo $i; done\n')).toMatchObject({
    diagnostics: [{ row: 0, message: "構文エラーです（syntax error near unexpected token `done'）。" }],
  });
  expect(executeProgram('bash', 'echo a\nin\n')).toMatchObject({
    diagnostics: [{ row: 1, message: "構文エラーです（syntax error near unexpected token `in'）。" }],
  });
  expect(executeProgram('bash', '[[ a b ]]\n')).toMatchObject({
    diagnostics: [
      { row: 0, message: "構文エラーです（unexpected token `b', conditional binary operator expected）。" },
    ],
  });
  expect(executeProgram('bash', 'for (( i = $(echo 1); i < 2; i++ )); do echo $i; done\n')).toMatchObject({
    stdout: '1\n',
  });
  expect(executeProgram('bash', 'x=$(\necho $(fi))\n')).toMatchObject({
    diagnostics: [
      { row: 1, message: "構文エラーです（syntax error near unexpected token `fi' while looking for matching `)'）。" },
    ],
  });
});

test('Bash reports a backquoted body it cannot parse when it runs it, and reads here-documents past their bodies', () => {
  expect(executeProgram('bash', 'x=`fi`; echo "[$x] $?"\n')).toMatchObject({
    kind: 'executed',
    stdout: '[] 2\n',
    stderr: [
      "main.sh: command substitution: line 1: syntax error near unexpected token `fi'",
      "main.sh: command substitution: line 1: `fi'",
      '',
    ].join('\n'),
  });
  expect(executeProgram('bash', 'cat <<EOF\nif then\nEOF\nfi\n')).toMatchObject({
    diagnostics: [{ row: 3, message: "構文エラーです（syntax error near unexpected token `fi'）。" }],
  });
  // An expansion error in the word of a `case` leaves Bash's line counter at the `case`, which numbers the next line.
  expect(executeProgram('bash', 'case $((1/0))\n in x) ;; esac\necho $LINENO\n')).toMatchObject({
    stdout: '2\n',
    stderr: 'main.sh: line 1: 1/0: division by 0 (error token is "0")\n',
  });
});

function nestedSubstitutions(depth: number): string {
  return `x=${'$('.repeat(depth)}${')'.repeat(depth)}\necho ok\n`;
}

test('a deep nesting and a huge printf field stop at a limit instead of exhausting the server', () => {
  // Reading each level twice would take 2^30 steps here.
  expect(executeProgram('bash', nestedSubstitutions(30))).toMatchObject({ kind: 'executed', stdout: 'ok\n' });
  expect(executeProgram('bash', nestedSubstitutions(20_000))).toMatchObject({ kind: 'compileError' });
  expect(executeProgram('bash', `printf '%999999999d' 1\n`)).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
  expect(executeProgram('bash', `printf '%.999999999f' 1\n`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('features this environment does not provide stop the program with a message', () => {
  expect(executeProgram('bash', 'echo a | cat\n')).toMatchObject({
    kind: 'executed',
    uncaughtException: '外部コマンド（cat）は、この採点環境では使えません。',
  });
  expect(executeProgram('bash', 'echo before\nls\necho after\n')).toMatchObject({
    kind: 'executed',
    stdout: 'before\n',
    uncaughtException: '外部コマンド（ls）は、この採点環境では使えません。',
  });
  expect(executeProgram('bash', 'echo $$\n')).toMatchObject({
    uncaughtException: 'プロセス番号（$$）は、この採点環境では使えません。',
  });
  expect(executeProgram('bash', 'eval x=1\n')).toMatchObject({
    uncaughtException: '文字列の評価（eval）は、この採点環境では使えません。',
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

test('input, files, pipes, process substitutions, and here-documents read and write as Java programs do', () => {
  const program = `total=0
while read -r name score; do
  echo "$name:$score" >> scores.txt
  total=$(( total + score ))
done
mapfile -t lines < scores.txt
upper() { while IFS= read -r l; do echo "\${l^^}"; done; }
printf '%s\\n' "\${lines[@]}" | upper
cat_lines() { while IFS= read -r l; do echo "> $l"; done < "$1"; }
cat_lines notes.txt
cat_lines <(echo "total $total")
upper <<EOF
here $total
EOF
echo missing > /nodir/x.txt
`;
  expect(
    executeProgram('bash', program, { stdin: 'alice 3\nbob 4\n', files: { 'notes.txt': 'first note\n' } })
  ).toMatchObject({
    kind: 'executed',
    stdout: 'ALICE:3\nBOB:4\n> first note\n> total 7\nHERE 7\n',
    stderr: 'main.sh: line 15: /nodir/x.txt: No such file or directory\n',
    finalFiles: { 'notes.txt': 'first note\n', 'scores.txt': 'alice:3\nbob:4\n' },
  });
});

test('background commands, output process substitutions, and coprocesses run in a fixed order', () => {
  // Bash runs these alongside the shell, so its order varies from run to run; this is one order it produces.
  const program = `job() { echo "job $1"; return "$1"; }
job 1 & job 2 &
echo main
wait -n; echo "first=$?"
up() { while read -r l; do echo "\${l^^}"; done; }
echo hello > >(up)
echo after
coproc C { up; }
echo ping >&"\${C[1]}"
read -r reply <&"\${C[0]}"
echo "reply=$reply"
echo late >&"\${C[1]}"
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: 'job 1\njob 2\nmain\nfirst=1\nHELLO\nafter\nreply=PING\n',
    uncaughtException: '動き終わった coproc（C）への書き込みは、この採点環境では使えません。',
  });
});

test('a coprocess left waiting for input ends quietly only where nothing would run after its input ends', () => {
  // Bash closes the coprocess's input as the shell ends, and runs what follows the `read` that was waiting.
  const loopOnly = `up() { while read -r l; do echo "\${l^^}"; done; }
coproc C { up; }
echo ping >&"\${C[1]}"
read -r reply <&"\${C[0]}"
echo "reply=$reply"
`;
  expect(executeProgram('bash', loopOnly)).toMatchObject({ kind: 'executed', stdout: 'reply=PING\n', stderr: '' });
  const withRest = `coproc { read x; echo "got $x"; read y; echo "y=[$y]" > out.txt; }
echo a >&"\${COPROC[1]}"
read -r z <&"\${COPROC[0]}"
echo "$z"
`;
  expect(executeProgram('bash', withRest)).toMatchObject({
    kind: 'executed',
    stdout: 'got a\n',
    uncaughtException: '入力を待ったまま残りの処理がある coproc は、この採点環境では使えません。',
  });
});

test('a command started with & reads the pipe or redirection its compound command or function gives, as in Bash', () => {
  const program = `f() { read v; echo "[$v]"; }
echo p | { f & wait; } 2>/dev/null
echo q | ( f & wait ) 2>&1
echo r | { ( f & wait ); }
{ { f & wait; } 2>/dev/null; } <<< n
g() { f & wait; } <<< def; g
( f & wait ) <<< sub
f & wait
coproc { { f & wait; }; }
echo z >&"\${COPROC[1]}"
read -r reply <&"\${COPROC[0]}"
echo "$reply"
`;
  expect(executeProgram('bash', program)).toMatchObject({
    kind: 'executed',
    stdout: '[p]\n[q]\n[]\n[]\n[def]\n[sub]\n[]\n[z]\n',
    stderr: '',
  });
});

test('a here-document the end of the input cuts off still reads its last line, blanks only included', () => {
  const show = 'c() { while IFS= read -r l; do echo "[$l]"; done; }\n';
  const warning = "main.sh: line 3: warning: here-document at line 2 delimited by end-of-file (wanted `EOF')\n";
  expect(executeProgram('bash', `${show}c <<EOF\nhello`)).toMatchObject({ stdout: '[hello]\n', stderr: warning });
  expect(executeProgram('bash', `${show}c <<-EOF\n\thello`)).toMatchObject({ stdout: '[hello]\n', stderr: warning });
  expect(executeProgram('bash', `${show}c <<EOF\n  `)).toMatchObject({ stdout: '[  ]\n', stderr: warning });
});
