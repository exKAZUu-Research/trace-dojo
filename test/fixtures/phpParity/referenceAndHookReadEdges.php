<?php
foreach([[],[1],[[], 'x']] as $cb){var_dump(is_callable($cb,true,$name),$name);}
var_dump(bin2hex(json_decode('"a'."\xff".'b"',flags:JSON_INVALID_UTF8_IGNORE|JSON_INVALID_UTF8_SUBSTITUTE)));
var_dump(json_decode('{"a'."\xff".'b":1}',flags:JSON_INVALID_UTF8_IGNORE|JSON_INVALID_UTF8_SUBSTITUTE));
class W {public ?int $b {get => $this->b ?? 9;set(?int $v){$this->b=$v;}}public int $c {get => $this->c ?? 8;set(int $v){$this->c=$v;}}}
$w=new W;var_dump($w->b,$w->c,get_object_vars($w));
class U {public array $a;public ?array $b;}$u=new U;unset($u->a[0],$u->b[0]);echo "unset\n";
$a=new ArrayObject([1]);$x=5;$a[0]=&$x;$x=7;var_dump($a[0],$x);$s='abc';try{$s[]=&$x;}catch(Throwable $e){echo $e->getMessage(),"\n";}
$x=1;$a=['k'=>&$x];$i=array_intersect_assoc($a,['k'=>1]);$d=array_diff_assoc($a,['k'=>2]);$k=array_intersect_key($a,['k'=>2]);$x=3;var_dump($i,$d,$k);
var_dump(bin2hex(preg_replace('/a/u','x',"\xff",0)),preg_last_error());
var_dump(bin2hex(preg_replace_callback('/a/u',fn($m)=>'x',"\xff",0)),preg_last_error());
class It implements Iterator {function rewind(){}function valid(){return false;}function next(){}function key(){return 0;}function current(){return 1;}}
new It;
foreach([100000000000005.0,123456789012305.0,999999999999995.0,99999999999999.5,123456789012395.0,129999999999995.0,-999999999999995.0] as $v){echo $v,' ',sprintf('%.14g',$v),"\n";}
class F{}function unionType(iterable|F|null|int $x){}try{unionType(new stdClass);}catch(Throwable $e){echo $e->getMessage(),"\n";}
