<?php
echo sprintf('%f|%e|%g|%F|%.3e|%G|%E', -0.0, -0.0, -0.0, -0.0, -0.0, -0.0, -0.0), "\n";
echo sprintf('%+f|%+e|%+g', -0.0, -0.0, -0.0), "\n";
echo sprintf('%f|%e|%5.1f|%g|%G|%E|%F', INF, -INF, -INF, INF, -INF, INF, -INF), "\n";
echo sprintf('[%f]|[%e]|[%5.1f]|[%g]', NAN, NAN, NAN, NAN), "\n";
echo sprintf('[%10f]|[%-10f]|[%010f]|[%+f]|[%+f]|[%+010f]|[%-+10f]', INF, INF, INF, INF, NAN, -INF, INF), "\n";
echo sprintf("[%'*10f]|[%010e]|[%3f]|[%.1f]", -INF, NAN, INF, NAN), "\n";
echo sprintf('%d|%d|%d|%d', INF, -INF, NAN, 1e20), "\n";
echo sprintf('%x|%u|%c|%o|%b', 1e20, -1e20, 1e30, INF, NAN), "\n";
echo sprintf('%d', 9.2233720368547758E+18), "\n";
echo sprintf('%d', 1.5), "\n";

echo sprintf('[%*d]', 5, 42), "\n";
echo sprintf('[%.*f]', 2, 3.14159), "\n";
echo sprintf('[%*.*f]', 10, 3, 3.14159), "\n";
echo sprintf('[%-*s]', 6, 'ab'), "\n";
echo sprintf('[%1$*2$d]', 42, 6), "\n";
echo sprintf('[%2$*1$d]', 6, 42), "\n";
echo sprintf('[%1$.*2$f]', 1.5, 3), "\n";
foreach ([
  fn() => sprintf('%*d', -5, 42),
  fn() => sprintf('%.*f', -2, 1.5),
  fn() => sprintf('%*d', '5', 42),
  fn() => sprintf('%*d', 5.0, 42),
  fn() => sprintf('%.*f', '2', 1.5),
  fn() => sprintf('%*d', 5),
  fn() => sprintf('%.*f', 2),
  fn() => sprintf('%*d'),
  fn() => sprintf('%.*f'),
  fn() => sprintf('%.*f', 60, 1),
  fn() => sprintf('%1$*d', 5, 42),
  fn() => sprintf('%0$*1$d', 5, 42),
] as $i => $f) {
  try { var_dump($f()); } catch (\Throwable $e) { echo $i, ' ', get_class($e), ': ', $e->getMessage(), "\n"; }
}

var_dump(number_format(PHP_INT_MAX));
var_dump(number_format(PHP_INT_MIN));
var_dump(number_format(PHP_INT_MAX, 2));
var_dump(number_format(-1234567));
var_dump(number_format(1234, 2, null, null));
var_dump(number_format(1234.5, 2, null, ' '));
var_dump(number_format(INF), number_format(-INF), number_format(NAN), number_format(INF, 2));
var_dump(number_format(1234567, -3));
var_dump(number_format(1234567, -2, ',', '.'));
var_dump(number_format(PHP_INT_MAX, -2));
var_dump(number_format(-0.4), number_format(-0.0, 2), number_format(0, 3));
var_dump(number_format(1234.5678, 2, '', ''));
var_dump(number_format(1234.5678, 2, 'abc', 'xyz'));
var_dump(number_format(1e20, 2));
var_dump(number_format(-1e-20, 2));
try { number_format('abc'); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { number_format([]); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(number_format('1234'));
var_dump(number_format('1234.5', 1));
var_dump(number_format(true));

var_dump(min(true,2), min(0,null), min(1,true), min('a',true), max(true,2), max(2,true), max([1],[1]));
var_dump(min(null,0), max(0,null), max(null,0), min(true,1), max(1,true), max(true,1));
var_dump(min('10', 10), min(10, '10'), max('10', 10), max(10, '10'), min(1.0, 1), min(1, 1.0), max(1.0, 1), max(1, 1.0));
var_dump(min([1,2,'1']), max(['a', 0, 'b']), min('abc', 0), max('abc', 0), min(0, 'abc'), max(0,'abc'));
var_dump(max([1, 2], [1, 3]), min([1,2],[3]), max('apple', 'banana'), max([0=>1], [1=>1]));
var_dump(min(true,2,3), max(2,true,1), min([true,2]), max([2,true]), min(0,null,0), max(null, false, 0));

var_dump(function_exists('log2'));
var_dump(base_convert('ffffffffffffffffffff', 16, 10));
var_dump(base_convert('18446744073709551616', 10, 16));
var_dump(base_convert('9223372036854775808', 10, 2));
var_dump(base_convert('zzzzzzzzzzzzzzzz', 36, 10));
var_dump(base_convert('1e100', 16, 36));
var_dump(round(1e15+0.5, 1));
try { log2(8); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }

echo sprintf('[%+010f]|[%+05f]|[%05f]|[%-05f]|[%+5f]', INF, NAN, -INF, NAN, -NAN), "\n";
echo sprintf('[%.2x]|[%.0o]|[%5.1b]|[%.s]|[%.0s]|[%5.s]|[%.X]', 255, 8, 5, 'abc', 'abc', 'abc', 255), "\n";
echo sprintf('[%.*g]|[%.*G]|[%.*h]|[%.*g]|[%.*g]', -1, 0.1, -1, 1e20, -1, 1234567.0, -1, 1/3, 0, 0.5), "\n";
echo sprintf('[%5c]|[%-5c]|[%u]|[%+u]|[%+d]|[%+05d]|[%-05d]|[%05s]|[%+s]', 65, 66, -1, 3, 0, 3, -3, 'ab', 'x'), "\n";
echo sprintf('%d|%d|%d|%x', '1e20', ' 12abc', '9999999999999999999', '1e100'), "\n";
echo sprintf('[%e]|[%.0e]|[%.1e]|[%g]|[%g]|[%g]', -1e-7, 12345.678, 9.96, 1e-5, 123456789.0, 0.0001), "\n";
echo sprintf('[%f]|[%.1f]|[%e]', -1e-7, -0.04, -1e-300), "\n";
try { echo sprintf('[%5.%]|[%-5%]|[%\'x5%]'); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
echo sprintf('[%5.%]|[%-5%]|[%\'x5%]', 1, 2, 3), "\n";
echo sprintf('[%.*s]', 2, 'abcdef'), "\n";
try { echo sprintf('%.*f', -1, 1.5); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo sprintf('%.*s', -1, 'abc'); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo sprintf('%*s %y', 'a', 'abc'); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo sprintf('%s %s %y', 'a'); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo sprintf('%*s %s %s', 3); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo vsprintf('%*s %s %s', [3]); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo fprintf(STDOUT, '%s %s', 3); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { echo printf('%s %s', 3); } catch (\Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
fprintf(STDOUT, "%.60f\n", 1);


foreach (['1e999', '-1e999 tail', '1e30', '-1e30'] as $numeric) {
    printf("%1\$05d|%1\$u|%1\$x|%1\$o|%1\$b\n", $numeric);
}
echo vsprintf("[%05d]\n", ['9e999']);
