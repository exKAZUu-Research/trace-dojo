<?php
class D{function __construct(public $n){}function __destruct(){echo $this->n,':destroy;';}}
foreach(['SplQueue','SplStack','SplFixedArray','SplMinHeap','ArrayObject'] as $name){
 echo $name,':';$s=$name==='SplFixedArray'?new SplFixedArray(2):new $name;$d=new D($name);
 if($name==='SplMinHeap'){$s->insert($d);$s->insert($d);}elseif($name==='SplFixedArray'){$s[0]=$d;$s[1]=$d;}else{$s[]=$d;$s[]=$d;}
 $copy=clone $s;unset($d,$s);echo 'retained;';
 if($name==='SplMinHeap')$copy->extract();elseif($name==='SplQueue'||$name==='SplStack')$copy->pop();else unset($copy[0]);echo 'one;';
 if($name==='SplMinHeap')$copy->extract();elseif($name==='SplQueue'||$name==='SplStack')$copy->pop();else unset($copy[1]);echo 'none;';unset($copy);echo "\n";
}
$s=new SplObjectStorage;$a=new stdClass;$b=new stdClass;$d=new D('info');$s[$a]=$d;$s[$b]=$d;unset($d);unset($s[$a]);echo 'one-info;';unset($s[$b]);echo "none-info;\n";
$q=new SplQueue;$d=new D('replace');$q->push($d);unset($d);$q[0]=null;echo 'replaced;';
$f=new SplFixedArray(2);$d=new D('resize');$f[1]=$d;unset($d);$f->setSize(1);echo 'resized;';
