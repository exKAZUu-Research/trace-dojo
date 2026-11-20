<?php
function t(...$a) { echo (new Exception)->getTraceAsString(), "\n"; }
t(1.0, 1e15, 1/3, 0.1 + 0.2, -0.0, 100.0, "a\nb", "tab\there\\x", "あいう", "0123456789abcdefgh", NAN, INF);
t(x: 1);
t(1, y: 2, z: [1]);
function u($p, $q) { echo (new Exception)->getTraceAsString(), "\n"; }
u(q: 2, p: 1);
function opt($a = null, $b = 5, $c = 7) { echo (new Exception)->getTraceAsString(), "\n"; print_r((new Exception)->getTrace()[0]['args']); }
opt(b: 2);
opt(1, c: 3);
function v($a, ...$rest) { print_r((new Exception)->getTrace()[0]['args']); throw new Exception("e"); }
v(1, 2, k: 3);
