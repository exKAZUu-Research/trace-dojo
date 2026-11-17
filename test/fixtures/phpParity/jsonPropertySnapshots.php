<?php
class M implements JsonSerializable{public $f;function jsonSerialize():mixed{($this->f)();return 1;}}
foreach(['replace','unset','reference'] as $mode){$m=new M;$v=2;$o=(object)['a'=>$m,'b'=>2];if($mode==='reference')$o->b=&$v;$m->f=function()use($o,&$v,$mode){$o->c=3;if($mode==='unset')unset($o->b);else $o->b=4;};var_dump(json_encode($o));}
class Declared{public $a;public $b=2;}
$m=new M;$o=new Declared;$o->a=$m;$m->f=function()use($o){$o->b=4;};var_dump(json_encode($o));

$m=new M;$v=2;$array=[$m,&$v];$m->f=function()use(&$v){$v=4;};var_dump(json_encode($array));
class D{function __destruct(){echo 'destroy;';}}
$m=new M;$o=(object)['a'=>$m,'b'=>new D];$m->f=function()use($o){unset($o->b);};
function afterJson($a,$b){echo 'done;';}
function nextArg(){echo 'next;';return 0;}
afterJson(json_encode($o),nextArg());
