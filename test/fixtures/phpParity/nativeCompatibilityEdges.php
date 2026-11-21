<?php
foreach([[-1=>1],['a'=>1]] as $bad){try{SplFixedArray::fromArray($bad);}catch(Throwable $e){echo $e->getMessage(),"\n";}}
var_dump(SplFixedArray::fromArray([1,2])->toArray());
$a=new ArrayIterator([1,2]);$b=clone $a;$b[0]=9;var_dump($a->getArrayCopy());try{$a->seek(50);}catch(Throwable $e){echo $e->getMessage(),"\n";}var_dump($a->valid(),$a->current(),$a->key());
$a=new ArrayObject; $a[][0]=1;var_dump($a->getArrayCopy());$x=2;try{$a[]=&$x;}catch(Throwable $e){echo $e->getMessage(),"\n";}
foreach(['+1.0','+1e0','1.5'] as $key){try{var_dump('abc'[$key]);}catch(Throwable $e){echo $e->getMessage(),"\n";}}
function introspect($a=1,$b=2,...$rest){var_dump(func_num_args(),func_get_args());}
introspect(b:9,extra:4);
try{call_user_func_array('introspect',['b'=>1,0=>2]);}catch(Throwable $e){echo $e->getMessage(),"\n";}
var_dump(is_callable([[], 'x'],false,$n),$n);
foreach([1,2,3] as $depth){var_dump(json_decode('[1]',true,$depth),json_last_error(),json_validate('[[]]',$depth),json_last_error());}
try{json_validate('',1,1);}catch(Throwable $e){echo $e->getMessage(),"\n";}var_dump(json_validate('',0));
var_dump(json_encode("\xff",JSON_INVALID_UTF8_IGNORE|JSON_INVALID_UTF8_SUBSTITUTE));
var_dump(mb_chr(256,'ASCII'),mb_ord("\xff",'UTF-8'),number_format(INF,1000000000));
var_dump(preg_replace_callback('/a/',function($m){preg_match('/./u',"\xff");return 'X';},'a'),preg_last_error());
class C {function __construct(public string $v){}function __toString():string{echo $this->v;return $this->v;}}
$a=[new C('a'),new C('b')];$b=[new C('b'),new C('c')];$c=array_intersect($a,$b);echo ' ',count($c),"\n";
class I implements IteratorAggregate {function getIterator():Traversable{return new ArrayIterator([1]);}}
foreach(new I as $v){echo $v,"\n";}
