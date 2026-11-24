<?php
class Known { public $v = 1; }
$cases = ['', 'b:0;', 'b:1;', 'i:5', 'i:5;junk', 'x', 's:5:"abc";', 's:3:"abc"', 'a:2:{i:0;i:1;}', 'a:1:{i:0;i:1;', 'a:1:{b:1;i:1;}',
  'O:7:"Unknown":1:{s:1:"a";i:1;}', 'O:5:"Known":1:{s:1:"v";i:7;}', 'O:5:"Known":1:{s:1:"w";i:7;}', 'd:0.5;', 'd:1e3;', 'd:.5;', 'N;', 'i:+3;', 'i:99999999999999999999;',
  'E:11:"Suit:Hearts";', 'E:5:"Known";', 'r:1;', 'a:1:{i:0;R:1;}', 'a:2:{i:0;i:1;i:1;R:2;}', 'a:2:{i:0;i:1;i:1;r:2;}', 'a:1:{s:1:"5";i:1;}', 'O:8:"stdClass":1:{i:0;i:1;}', 'a:-1:{}'];
foreach ($cases as $c) {
    echo "== $c\n";
    var_dump(unserialize($c));
}
var_dump(unserialize('O:5:"Known":1:{s:1:"v";i:7;}', ['allowed_classes' => false]));
var_dump(unserialize('O:5:"Known":1:{s:1:"v";i:7;}', ['allowed_classes' => ['known']]));
var_dump(unserialize('a:1:{i:0;O:5:"Known":0:{}}', ['allowed_classes' => ['Other']]));
try { unserialize('i:1;', ['allowed_classes' => 1]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$inc = unserialize('O:7:"Unknown":1:{s:1:"a";i:1;}');
echo serialize($inc), "\n";
var_dump(get_class($inc), $inc instanceof __PHP_Incomplete_Class);
var_dump(unserialize(false));
