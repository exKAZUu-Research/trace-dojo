<?php
class Reg extends SplObjectStorage { public $name = 'reg'; }
$r = new Reg; $r[new stdClass] = 'x';
var_dump($r);
print_r($r); echo "\n";
