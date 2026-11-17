<?php
$s=new SplObjectStorage;$o=new stdClass;$s[$o]=[[1]];$s[$o][0][]=2;var_dump($s[$o]);
class ValueGetter {public $data=[[1]];function __get($name){return $this->data;}}
$s=new ValueGetter;$s->missing[0][]=2;var_dump($s->data);
class RefGetter {public $data=[[1]];function &__get($name){return $this->data;}}
$s=new RefGetter;$s->missing[0][]=2;var_dump($s->data);
class ValueOffset implements ArrayAccess {
 public $data=[[1]];
 function offsetExists(mixed $k):bool{return true;}
 function offsetGet(mixed $k):mixed{return $this->data;}
 function offsetSet(mixed $k,mixed $v):void{}
 function offsetUnset(mixed $k):void{}
}
$s=new ValueOffset;$s[0][0][]=2;var_dump($s->data);
function &arrayReference(){static $a=[1];return $a;}
arrayReference()[0]=2;arrayReference()[]=3;$r=&arrayReference()[0];$r=4;var_dump(arrayReference());
class ArrayReferenceObject {public $data=[5];function &get(){return $this->data;}static function &shared(){static $data=[6];return $data;}}
$o=new ArrayReferenceObject;$o->get()[]=7;ArrayReferenceObject::shared()[0]=8;var_dump($o->data,ArrayReferenceObject::shared());
class ReadonlyObject {function __construct(public readonly object $x=new stdClass){}}
foreach([new ReadonlyObject,new Random\Randomizer(new Random\Engine\Mt19937(1))] as $o){try{foreach($o as &$v){echo 'never';}}catch(Throwable $e){echo $e->getMessage(),"\n";}}
class StaticBase {public static int $x;public static ?array $a;public static ?int $i;}
class StaticChild extends StaticBase{}
try{StaticBase::$x[]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{StaticChild::$x['a']??=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{StaticChild::$x++;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{StaticChild::$x+=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{StaticBase::$i[]=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}
StaticChild::$a[]=1;var_dump(StaticBase::$a);
function valueArray(){return [1];}
$alias=&valueArray();$nested=[&$alias];unset($alias);var_dump($nested);
