<?php
mt_srand(42); echo mt_rand(), " ", mt_rand(1, 100), " ", mt_rand(1, 6), " ", rand(), " ", rand(10, 20), "\n";
srand(5); echo rand(1, 10), rand(1, 10), rand(1, 10), "\n";
mt_srand(123); $a = range(1, 10); shuffle($a); echo implode(",", $a), "\n";
echo str_shuffle("abcdef"), " ", array_rand([10, 20, 30]), " ", implode(",", array_rand(['a' => 1, 'b' => 2, 'c' => 3, 'd' => 4], 2)), "\n";
echo mt_rand(0, PHP_INT_MAX), " ", mt_rand(-1000000000000, 1000000000000), " ", mt_getrandmax(), "\n";
mt_srand(7); for ($i = 0; $i < 5; $i++) echo mt_rand(1, 3); echo "\n";
echo round(3.14159, 2), round(2.5), round(-2.5), round(1234.5678, -2), floor(-3.5), ceil(4.1), abs(-7), sqrt(16), pow(2, 10), pow(2, -1), pow(2.0, 3), 10 ** 20, "\n";
echo intdiv(17, 5), 17 % 5, -17 % 5, fmod(17.5, 5), M_PI, pi(), exp(1), log(M_E), log10(1000), log(8, 2), "\n";
var_dump(max("apple", "banana"), max([1, 2], [1, 3]), min("10", 9), max(1, "2", 3.5), PHP_INT_MAX, PHP_INT_MIN, PHP_FLOAT_EPSILON, is_nan(NAN), is_infinite(-INF));
echo number_format(-0.4), number_format(1.5), number_format(2.675, 2), number_format(1e6), "\n";
echo base_convert('255', 10, 16), dechex(-1), decbin(255), bin2hex("abc"), "\n";
var_dump(round(-0.4), sin(0), cos(M_PI), atan2(1, 1), hypot(3, 4), deg2rad(180), 7 / 2, 6 / 2, 2 ** 0.5);
var_dump((int) 3.99, (int) -3.99, (int) "1e3", 0.1 + 0.2 === 0.3, abs(0.1 + 0.2 - 0.3) < PHP_FLOAT_EPSILON);
