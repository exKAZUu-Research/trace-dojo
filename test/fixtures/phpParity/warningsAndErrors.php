<?php
function level3($x) { return $x / 0; }
function level2(array $a) { return level3($a[0]); }
class Svc { public function run($v) { return level2([$v, "str", 1.5, null, true, new stdClass]); } public static function go() { return (new Svc)->run(42); } }
echo "before\n";
$o = new stdClass;
echo $o->missing ?? "dflt", "\n";
echo @$o->missing2, "|\n";
echo $o->missing3;
echo "\n";
$arr = [1, 2];
echo $arr[5] ?? 'none', "\n";
$s = "abc"; echo $s[10] ?? 'x', "\n";
echo intdiv(10, 3), "\n";
$str = "5 apples"; echo $str + 5, "\n";
echo "10" + "5.5", " ", "1e3" + 1, " ", null + 5, " ", true + true, "\n";
echo [1] == [1] ? "eq" : "ne", "\n";
$x = "123"; var_dump($x == 123, $x === "123", "abc" == 0, null == 0, "" == null, "0" == false, [] == false);
echo str_repeat("-", 3) . PHP_EOL;
Svc::go();
echo "never";
