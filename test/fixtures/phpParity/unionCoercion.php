<?php
function u(int|string $x) { var_dump($x); }
u(1.5); u(2.0); u(1e20); u(NAN); u("1.5"); u(true);
function v(int|bool $x) { var_dump($x); } v(1.5); v("abc");
function w(float|string $x) { var_dump($x); } w(5); w(true);
function z(string|bool $x) { var_dump($x); } z(1.5); z(5);
