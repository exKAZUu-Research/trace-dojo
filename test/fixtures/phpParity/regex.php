<?php
var_dump(preg_match('/(\d+)-(\d+)/', 'tel: 03-1234', $m)); print_r($m);
var_dump(preg_match('/(?<year>\d{4})-(?<month>\d{2})/', 'on 2024-05-01', $m)); print_r($m);
echo preg_match_all('/\b(\w)(\w*)\b/', 'hello big world', $all), "\n"; print_r($all);
preg_match_all('/(\d)(x)?/', '1x2', $sets, PREG_SET_ORDER); print_r($sets);
echo preg_replace('/\s+/', ' ', "a   b \n c"), "|", preg_replace('/(\w+) (\w+)/', '$2 ${1}!', 'hello world'), "\n";
echo preg_replace_callback('/\d+/', fn($m) => $m[0] * 2, 'a1 b22 c333'), "\n";
print_r(preg_split('/[\s,]+/', "a, b  c,d")); print_r(preg_split('//', 'abc', -1, PREG_SPLIT_NO_EMPTY)); print_r(preg_split('//', 'abc'));
print_r(preg_split('/(-)/', 'a-b-c', -1, PREG_SPLIT_DELIM_CAPTURE)); print_r(preg_split('/,/', 'a,b,c', 2));
echo preg_quote("Hello.World?(1+1)"), " ", preg_quote("a/b#c", "/"), "\n";
print_r(preg_grep('/^\d+$/', ['1', 'a', '22']));
var_dump(preg_match('/^[a-z]+$/i', 'ABC'), preg_match('/colou?r/', 'The color'), preg_match('/^abc$/', "abc\n"), preg_match('/^abc$/D', "abc\n"));
var_dump(preg_match('/(\d+)/', 'abc 123 def', $m, PREG_OFFSET_CAPTURE)); print_r($m);
var_dump(preg_match('/日本/u', 'こんにちは日本', $m, PREG_OFFSET_CAPTURE)); print_r($m);
echo preg_replace('/(?<=a)b/', 'X', 'ab cb ab'), " ", preg_match('/a.c/s', "a\nc"), " ", preg_replace('/x # comment
  y/x', 'Z', 'xy'), "\n";
var_dump(@preg_match('/abc', 'abc'));
var_dump(preg_match('/[[:alpha:]]+/', '123abc', $m)); print_r($m);
echo preg_replace(['/a/', '/b/'], ['b', 'c'], 'ab'), "\n";
var_dump(preg_match('/(a)(b)?(c)/', 'ac', $m)); var_dump($m);
var_dump(preg_match('/(a)(b)?/', 'a', $m)); var_dump($m);
echo implode(",", str_split("abcdef", 2)), " ", ucwords("o'neil mc-donald"), "\n";
