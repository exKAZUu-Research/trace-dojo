<?php
class X{function __construct(public $name){}function __destruct(){echo $this->name,';';}}
$x=new X('value');$f=function()use($x){};unset($f,$x);echo 'after-value;';
$x=new X('reference');$f=function()use(&$x){};unset($f,$x);echo 'after-reference;';
$x=new X('arrow');$f=fn()=>$x;unset($f,$x);echo 'after-arrow;';
$f=function(){static $x;return $x??=new X('static');};$x=$f();$g=clone $f;unset($f,$x);echo 'before-clone;';unset($g);echo 'after-clone;';
function maker(){static $x;return $x??=new X('named');}$f=maker(...);$x=$f();unset($f,$x);echo 'end;';
