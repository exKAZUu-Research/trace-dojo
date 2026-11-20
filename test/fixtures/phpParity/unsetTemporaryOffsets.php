<?php
function result() { return [[1, 2], [3, 4]]; }
$row = [[1, 2], [3, 4]];
function &borrow() { global $row; return $row; }
class RowProvider {
    function row() { return ['value' => 1]; }
    static function staticRow() { return ['value' => 2]; }
}
$provider = new RowProvider;
$callback = fn() => ['value' => 3];
unset(result()[0]);
unset(result()[1][0]);
unset($provider->row()['value']);
unset(RowProvider::staticRow()['value']);
unset($callback()['value']);
unset(borrow()[1][0]);
var_dump($row);
$null = null;
$scope = ['', [], new stdClass, 1.5, '1x', true, $null];
foreach ($scope as $key) {
    $text = 'text';
    try { unset($text[$key][0]); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
$a = ['' => [1], 'key' => [0, '' => 'empty']];
unset($a['key'][$null]);
unset($a[$null][0]);
unset($a[$null]);
var_dump($a);
try { unset($a['key'][[]][0]); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
try { unset($a['key'][[]]); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
foreach ([new ArrayObject(['key' => [0]]), new ArrayIterator(['key' => [0]])] as $container) {
    unset($container['missing'][0]);
    try { unset($container[[]][0]); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
    unset($container['key'][0]);
    var_dump($container['key']);
}
