<?php
class D{function __construct(public $n){}function __destruct(){echo "d{$this->n};";}}
$r=array_reduce([1,2,3],function($c,$x){echo "f$x;";return new D($x);});echo 'done;';unset($r);echo "\n";
$r=array_reduce([1,2,3,4],function($c,$x){echo "f$x;";return new D($x);},new D(0));echo 'done;';unset($r);echo "\n";
$keep=[];$r=array_reduce([1,2,3],function($c,$x)use(&$keep){if($c)$keep[]=$c;return new D($x);});echo 'done;';unset($r);unset($keep);echo "\n";
$r=array_reduce([1,2,3],fn($c,$x)=>$c,new D(9));echo 'done;';unset($r);echo "\n";
