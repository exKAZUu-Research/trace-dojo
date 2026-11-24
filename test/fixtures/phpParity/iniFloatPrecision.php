<?php
$vals = [0.1, 1/3, 1e100, 123456789012345678.0, 2.5, -0.0, 1.0, 0.00001234];
foreach ([14, 17, 5, 0, -1, 20, 50] as $p) {
    var_dump(ini_set('precision', $p));
    echo implode(' ', $vals), "\n";
    print_r($vals[1]); echo "\n";
}
ini_set('precision', 14);
foreach ([-1, 17, 5, 0, 20, 50] as $p) {
    var_dump(ini_set('serialize_precision', $p));
    var_dump($vals[1], 1.0, 1e100);
    var_export($vals[1]); echo "\n";
    echo json_encode([0.1, 1.0]), "\n";
    echo serialize([0.1, 1/3, 1.0]), "\n";
}
var_dump(ini_get('precision'), ini_get('serialize_precision'));
var_dump(ini_set('precision', 'abc'));
echo 1/3, "\n";
var_dump(ini_get('precision'));
var_dump(ini_get('nonexistent'), ini_set('nonexistent', '1'));
var_dump(ini_get('display_errors'), ini_get('error_reporting'), ini_get('memory_limit'), ini_get('max_execution_time'), ini_get('date.timezone'), ini_get('default_charset'));
var_dump(ini_set('memory_limit', '256M'), ini_get('memory_limit'));
var_dump(ini_set('max_execution_time', 10), ini_get('max_execution_time'));
var_dump(set_time_limit(5), ini_get('max_execution_time'));
var_dump(ini_set('error_reporting', E_ALL & ~E_WARNING), error_reporting());
echo $undefined1;
var_dump(ini_set('display_errors', '0'));
echo $undefined2;
var_dump(ini_get('display_errors'));
ini_set('display_errors', '1');
echo $undefined3;
var_dump(ini_get('display_errors'));
var_dump(ini_set('date.timezone', 'Asia/Tokyo'), ini_get('date.timezone'));
var_dump(ini_set('date.timezone', 'Nowhere/City'), ini_get('date.timezone'));
var_dump(ini_set('default_charset', 'ISO-8859-1'), ini_get('default_charset'));
var_dump(ini_restore('precision'));
var_dump(ini_get('precision'));
