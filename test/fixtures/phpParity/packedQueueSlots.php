<?php
$x=1;$a=[&$x,2,3];var_dump(array_shift($a));$x=4;var_dump($a);array_unshift($a,$x,5);$copy=$a;$a[0]=6;var_dump($a,$copy);
$x=7;$a=[0,&$x,2];array_shift($a);$x=8;var_dump($a);$copy=$a;$a[0]=9;var_dump($x,$copy);
class Q{function __construct(public $id){}function __destruct(){echo 'free ',$this->id,"\n";}}
$a=[new Q(1),new Q(2)];$q=array_shift($a);$q=null;array_unshift($a,new Q(3));$copy=$a;array_shift($a);unset($copy);var_dump(count($a));unset($a);
$a=[1,2,3];array_shift($a);$a['key']=4;array_unshift($a,5);var_dump($a);unset($a[1]);$a[]=6;var_dump($a);
$a=[1,2,3];array_unshift($a,0);foreach($a as &$v){echo $v,':';if($v===0)array_shift($a);}unset($v);echo "\n";var_dump($a);
$a=[1,2,3];foreach($a as &$v){echo $v,':';if($v===1)array_shift($a);}unset($v);echo "\n";var_dump($a);
