<?php
class Magic { static function __callStatic($n,$args){echo $n,json_encode($args),"\n";} function __call($n,$args){echo $n,json_encode($args),"\n";} }
$f=Magic::foo(...); echo "created\n"; $f(42);
$m=new Magic; $f=$m->foo(...); $f(a:1); call_user_func_array([$m,'q'],['k'=>3]);
function change(&$x){$x++;} $x=1;call_user_func_array('change',[&$x]);var_dump($x);
var_dump(preg_split('/(a)?(b)?(c)/','xcy',-1,PREG_SPLIT_DELIM_CAPTURE));
var_dump(htmlentities('@',ENT_QUOTES|ENT_HTML5),html_entity_decode('&colon;&NewLine;&NotEqualTilde;',ENT_QUOTES|ENT_HTML5));
var_dump(htmlentities("\u{2242}\u{338}",ENT_QUOTES|ENT_HTML5));
class Released {function __destruct(){echo 'destroy ';}}
$o=new stdClass; $o->x=new Released; echo ($o->x=null),'after',"\n";
class T {public int $x;} $t=new T;try{$r=&$t->x;}catch(Error $e){echo $e->getMessage(),"\n";}
function flag(int|bool $v){var_dump($v);} flag('123abc');
set_error_handler(function(){echo 'A';set_error_handler(function(){echo 'B';});}); trigger_error('first',E_USER_WARNING);trigger_error('second',E_USER_WARNING);restore_error_handler();restore_error_handler();
