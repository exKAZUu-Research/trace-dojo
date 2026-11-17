<?php
foreach (['/a++?/', '/a+?+/', '/(?z)a/', '/(?i/', '/(?=a\K)/', '/(?-)a/', '/(?i-)a/', '/(?^-i)a/', '/(?--i)a/','/(?ii)a/', '/(?i)+a/', '/(?>a)+b/', '/a{2,}+/', '/(?xx)a b/', '/(?J)a/', '/(?i:a/', '/(?<=a\K)b/', '/(?!a\K)b/','/(?x-x)a b/', '/a(?i)/', '/(?i)(?-i)a/', '/(?:a(?i))b/'] as $p) {
  echo $p, ' => '; var_dump(preg_match($p, 'aaaB a b', $m)); print_r($m);
}
var_dump(preg_match('/[[:upper:]]/iu', 'A'), preg_match('/[[:^upper:]]/iu', 'A'), preg_match('/[[:^upper:]]/iu', 'a'), preg_match('/[^[:upper:]]/iu', 'A'), preg_match('/[^[:lower:]]/iu', 'A'), preg_match('/[[:lower:]]/iu', 'A'), preg_match('/[[:lower:]x]/iu', 'X'));
var_dump(preg_match('/(?i)[[:upper:]]/u', 'a'), preg_match('/[[:alpha:]]/iu', 'A'), preg_match('/[[:upper:]]/i', 'é'));
