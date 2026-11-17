<?php
function s(string $x) { var_dump($x); }
s(NAN);
var_dump((string)NAN);
echo NAN, "\n";
s(INF);
var_dump(str_repeat(NAN, 1));
function b(bool $x) { var_dump($x); } b(NAN);
