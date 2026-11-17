<?php
$cases = [
  ['/(?>a+)ab/', 'aab'], ['/a++b/', 'aaab'], ['/a++a/', 'aaa'], ['/(a|ab)++c/', 'abc'], ['/(?>(a)|b)+c/', 'abac'],
  ['/a*+b/', 'aab'], ['/a?+a/', 'a'], ['/a{1,3}+a/', 'aaaa'], ['/(\w)++\1/', 'aab'], ['/(x)(?>y(z))\2/', 'xyzz'],
  ['/a(?i)b|c/', 'C'], ['/(a(?i)b|c)/', 'xAC'], ['/(?i:a)b/', 'AB'], ['/(?i:a)b/', 'Ab'], ['/a(?x) b # c
c/', 'abc'], ['/(?U)a+/', 'aaa'], ['/(?s).(?-s)./', "\n\n"], ['/(?m)^b/', "a\nb"], ['/(?i-s:a.)b/', "A\nb"],
  ['/(?^i)a/', 'A'], ['/(?n)(a)(?<x>b)/', 'ab'], ['/(?-i)a/i', 'A'], ['/(?i)(?-i)a/', 'A'], ['/(?:a(?i))b/', 'aB'],
  ['/[[:upper:]]/iu', 'é'], ['/[[:upper:]]/i', 'a'], ['/[[:upper:]]/iu', 'a'], ['/[^[:upper:]]/iu', 'A'], ['/[[:^upper:]]/iu', 'a'],
  ['/[[:lower:]x]/iu', 'X'], ['/(?i)[[:upper:]]/u', 'a'], ['/\p{Lu}/iu', 'a'],
  ['/(a)?\1b/', 'b'], ['/(a|)\1/', ''], ['/(a)?\1b/', 'xb'], ['/(a)?x\1/', 'x'], ['/(?<n>a)?b\k<n>/', 'b'],
  ['/\1(a)/', 'aa'], ['/(a\1)/', 'aa'], ['/(?:(a)|b)\1/', 'bb'],
  ['/a\Kb/', 'ab'], ['/(a\K|b)c/', 'acbc'], ['/\Ga/', 'aab'],
  ['/a++?/', 'a'], ['/a+?+/', 'a'], ['/(?z)a/', 'a'], ['/(?i/', 'a'], ['/(?=a\K)/', 'a'], ['/(?-)a/', 'a'], ['/(?^-i)a/', 'a'],
  ['/(?--i)a/', 'a'], ['/(?ii)a/', 'a'], ['/(?i)+a/', 'a'], ['/(?>a)+b/', 'aab'], ['/a{2,}+/', 'aaa'], ['/(?J)a/', 'a'],
  ['/(?i:a/', 'a'], ['/(?<=a\K)b/', 'ab'], ['/(?x-x)a b/', 'a b'], ['/a(?i)+/', 'a'], ['/\G+a/', 'a'], ['/a\K+/', 'a'],
];
foreach ($cases as [$p, $s]) {
  echo $p, ' ', json_encode($s), ' => ';
  $r = preg_match($p, $s, $m, PREG_OFFSET_CAPTURE);
  echo json_encode([$r, $m]), "\n";
}
var_dump(preg_replace('/a\K/', 'X', 'aaa'), preg_replace('/\Ga/', 'X', 'aab a'), preg_match_all('/a/A', 'aab', $m), $m);
var_dump(preg_split('/x*/', 'axb'), preg_split('/a??/', 'ab'), preg_replace('/|a/', '-', 'ab'), preg_match_all('/a??/', 'aa', $m), $m);
var_dump(preg_split('//u', 'aé'), preg_replace('/(?=a)|a/', '[$0]', 'aa'));
