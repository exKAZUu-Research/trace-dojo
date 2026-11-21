<?php
$x=1;$source=['x'=>&$x];
$spliced=[];array_splice($spliced,0,0,$source);
$zipped=array_map(null,$source,[2]);
$diff=array_udiff_assoc($source,[],fn($a,$b)=>$a<=>$b);
$intersection=array_uintersect_assoc($source,['x'=>1],fn($a,$b)=>$a<=>$b);
$shuffled=(new Random\Randomizer(new Random\Engine\Mt19937(1)))->shuffleArray($source);
$union=[]+$source;
$x=3;var_dump($spliced,$zipped,$diff,$intersection,$shuffled,$union);
$text='a';$a=[&$text];$grep=preg_grep('/a/',$a);$text='b';var_dump($grep);
$o=(object)['value'=>[1]];$o->value[0]=2;$copy=get_object_vars($o);$copy['value'][0]=3;var_dump($o->value,$copy['value']);
$value=1;$o=new stdClass;$o->value=&$value;$copy=get_object_vars($o);$value=4;var_dump($copy);
(function(){$varsValue=1;$varsAlias=&$varsValue;$vars=get_defined_vars();$varsValue=5;var_dump($vars['varsValue'],$vars['varsAlias']);})();
function inspectArrays($arg) {
    $arg[0]=2;
    $vars=get_defined_vars();$vars['arg'][0]=3;var_dump($arg);
    $args=func_get_args();$args[0][0]=4;var_dump($arg);
    $trace=debug_backtrace();$trace[0]['args'][0][0]=5;var_dump($arg);
}
inspectArrays([1]);
$i=new ArrayIterator([[1]]);$i[0][0]=2;$copy=iterator_to_array($i);$copy[0][0]=3;var_dump($i[0][0]);
$copy=iterator_to_array($i,false);$copy[0][0]=4;var_dump($i[0][0]);
$a=[[1]];$a[0][0]=2;$f=SplFixedArray::fromArray($a);$a[0][0]=3;var_dump($f[0][0]);
$copy=$f->toArray();$copy[0][0]=4;var_dump($f[0][0]);
$copy=$f->jsonSerialize();$copy[0][0]=5;var_dump($f[0][0]);
$cloned=clone $f;$cloned[0][0]=6;var_dump($f[0][0],$cloned[0][0]);
$a=[[1]];$a[0][]=2;$b=[]+$a;$b[0][]=3;var_dump($a,$b);
$unionValue=1;$unionSource=[&$unionValue];$unionResult=[]+$unionSource;unset($unionValue);$unionCopy=$unionResult;$unionResult[0]=2;var_dump($unionSource,$unionCopy);
