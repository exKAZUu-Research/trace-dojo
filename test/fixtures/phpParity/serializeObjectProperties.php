<?php
class T { public int $n = 0; public string $s = ""; private $p = 1; protected $q = 2; }
var_dump(unserialize('O:1:"T":2:{s:1:"n";i:5;s:4:"' . "\0T\0" . 'p";i:9;}'));
var_dump(unserialize('O:1:"T":1:{s:1:"p";i:9;}'));
var_dump(unserialize('O:1:"T":1:{s:1:"q";i:9;}'));
var_dump(unserialize('O:1:"T":1:{s:4:"' . "\0*\0" . 'q";i:9;}'));
var_dump(unserialize('O:1:"T":1:{s:1:"z";i:9;}'));
var_dump(unserialize(serialize(new T)) == new T);
$t = new T; $t->n = 3; unset($t->s); $t->dyn = [1];
echo str_replace("\0", '~', serialize($t)), "\n";
$data = ['users' => [['name' => 'A', 'age' => 30], ['name' => 'B', 'age' => 25]], 'count' => 2, 'ok' => true, 'ratio' => 0.75];
$s = serialize($data);
echo $s, "\n", strlen($s), "\n";
var_dump(unserialize($s) === $data);
var_dump(unserialize('a:1:{i:0;O:1:"T":1:{s:1:"n";i:1;}}', ['allowed_classes' => false]));
var_dump(unserialize('i:1;x'));
var_dump(unserialize('O:1:"T":1:{s:1:"n";i:5;}x'));
var_dump(unserialize('O:1:"T"'));
var_dump(unserialize('O:1:"T":x:{}'));
var_dump(unserialize('O:2:"T":0:{}'));
var_dump(unserialize('O:1:"T":0:{'));
var_dump(unserialize('a:2:{i:0;i:1;i:0;i:2;}'));
var_dump(unserialize('a:1:{s:1:"a";a:1:{i:0;R:2;}}'));
$o = new stdClass;
$o->a = $o;
$copy = unserialize(serialize($o));
var_dump($copy->a === $copy);
