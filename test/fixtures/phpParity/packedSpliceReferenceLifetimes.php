<?php class X{function __construct(public $id){}function __destruct(){echo "D$this->id;";}}$x=new X(1);$r=&$x;$a=[&$x,new X(2),[1]];$b=$a;$out=array_splice($a,0,2,[$r,[2]]);var_dump(count($a),count($b),count($out));unset($x,$r,$out,$b);echo 'end;';
$a=[];array_splice($a,0,0,[new X(3)]);unset($a);echo 'done;';
