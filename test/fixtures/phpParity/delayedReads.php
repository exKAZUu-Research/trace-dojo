<?php
class OldObject { public $number = [1]; function check() { return 'old'; } }
class NewObject { public $number = [9]; function check() { return 'new'; } }
function changeReceiver($result) {
    global $object;
    $object = new NewObject;
    return $result;
}
$object = new OldObject;
var_dump($object->number[changeReceiver(0)]);
$object = new OldObject;
var_dump($object?->number[changeReceiver(0)]);
$object = new OldObject;
var_dump($object->{changeReceiver('check')}());
$object = new OldObject;
var_dump($object?->{changeReceiver('check')}());
$object = null;
var_dump($object?->{changeReceiver('check')}(), $object);
$object = null;
var_dump(isset($object->{changeReceiver('number')}));
$object = null;
var_dump(empty($object->{changeReceiver('number')}));
$object = null;
var_dump($object->{changeReceiver('number')} ?? 'missing');
$object = null;
var_dump(isset($object?->{changeReceiver('number')}[changeReceiver(0)]), $object);
$data = [[1, 2], [3, 4]];
$index = 0;
var_dump($data[$index][$index++]);
$index = 0;
var_dump($data[$index][$index++] ?? 0);
class MagicRead {
    function __get($key) { echo "get "; return [42]; }
}
function makeReceiver() { echo "receiver "; return new MagicRead; }
function getOffset() { echo "offset "; return 0; }
var_dump(makeReceiver()->virtual[getOffset()]);
class StaticData { public static $data = [1]; }
function updateStaticData() { StaticData::$data = [9]; return 0; }
var_dump(StaticData::$data[updateStaticData()]);
$index = 1;
var_dump([$index => $index++]);
function choose() { global $subject; $subject = 2; return 2; }
$subject = 1;
switch ($subject) {
    case choose(): echo "switch hit\n"; break;
    default: echo "switch miss\n";
}
$subject = 1;
echo match ($subject) { choose() => 'match hit', default => 'match miss' }, "\n";
$index = 1;
var_dump(max($index, $index++));
function offsetAndReplace() { global $text; $text = 'new'; return 1; }
$text = 'old';
var_dump(substr($text, offsetAndReplace()));
$array = [];
$array[$undefinedKey] = $undefinedValue;
try { $array[[]] = $unread; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$string = 'abc';
try { $string['word'] = $unread; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$scalar = 3;
try { $scalar[0] = $unread; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
