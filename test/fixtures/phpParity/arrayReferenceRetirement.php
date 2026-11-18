<?php
function keepVariadic(&...$x){return $x;}
function storeVariadic(&...$x){$GLOBALS['saved']=$x;}
$a=[1];$rest=keepVariadic($a[0]);$rest[0]=2;var_dump($a,$rest);unset($rest);var_dump($a);
storeVariadic($a[0]);$saved[0]=3;var_dump($a);unset($saved);var_dump($a);
$b=[4];$outer=[&$b[0]];$nested=[$outer];unset($outer);$nested[0][0]=5;var_dump($b);unset($nested);var_dump($b);
$cycle=[&$b[0]];$cycle['self']=&$cycle;unset($cycle);var_dump($b);gc_collect_cycles();var_dump($b);
class Keeper {public $values;function __construct(&$x){$this->values=[&$x];}}
$k=new Keeper($b[0]);$k->self=$k;unset($k);var_dump($b);gc_collect_cycles();var_dump($b);
function defaults($x=[[1]]){$x[0][0]++;return $x;}
var_dump(defaults(),defaults());
function appendSuffix(&$value) {$value .= 'r';}
$forward = call_user_func_array(...);
foreach (['call_user_func_array', $forward] as $invoke) {
    $original = ['key' => 'A'];
    if (is_string($invoke)) call_user_func_array('appendSuffix', [&$original['key']]);
    else $invoke('appendSuffix', [&$original['key']]);
    $copy = $original;
    $copy['key'] = 'Z';
    var_dump($original, $copy);
}
$arguments = [&$original['key']];
call_user_func_array('appendSuffix', $arguments);
$copy = $original;
$copy['key'] = 'Z';
var_dump($original, $copy);
