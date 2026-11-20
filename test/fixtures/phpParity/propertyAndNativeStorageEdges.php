<?php
class T {public private(set) int $x=0 {set(int $v){echo 'set ';$this->x=$v;}} public function assign(){return $this->x=2;}}
$t=new T;try{$t->x=1;}catch(Throwable $e){echo $e->getMessage(),"\n";}var_dump($t->x,$t->assign(),$t->x);
class Upper {public string $x='old'{set(string $v){$this->x=strtoupper($v);}}}
$u=new Upper;var_dump($u->x='abc',$u->x);
class Magic {private string $x='old';function __set($name,$value){}}
$m=new Magic;var_dump($m->x='new');
class Typed {public int $x=1;}
$t=new Typed;$r=&$t->x;unset($t);$r='ok';var_dump($r);
$t=new Typed;$r=&$t->x;$u=clone $t;unset($t->x);try{$r='bad';}catch(TypeError $e){echo "caught ";}var_dump($u->x);
$o=(object)['x'=>1];$a=[&$o->x];unset($o);$b=[...$a];$b[0]=9;var_dump($a,$b);
class HashStorage extends SplObjectStorage {function getHash(object $o):string{echo 'hash ';return 'same';}}
$s=new HashStorage;$a=new stdClass;$b=new stdClass;$s[$a]=1;$s[$b]=2;var_dump(count($s),$s[$a]);$c=clone $s;var_dump(count($c));unset($s[$b]);var_dump(isset($s[$a]));
$f=SplFixedArray::fromArray([1,2]);$it=$f->getIterator();$f[1]=9;foreach($it as $v){echo $v,' ';}echo "\n";
foreach($f as $key=>$v){echo $v,' ';if($key===0)$f[1]=7;}echo "\n";
$f=SplFixedArray::fromArray([1,2]);foreach($f as $key=>$v){echo $v,' ';if($key===0){$f->setSize(3);$f[2]=8;}}echo "\n";
foreach(['c2a9','c3a9'] as $hex){var_dump(htmlentities(hex2bin($hex),ENT_QUOTES|ENT_HTML5,'ISO-8859-1'));}
foreach(['$&','$$',chr(36).chr(96),chr(36).chr(39)] as $sep){var_dump(number_format(1234,0,'.',$sep),number_format(1234.5,1,'.',$sep));}
foreach(['9223372036854775808','-9223372036854775809',' +9223372036854775808 '] as $key){$s='abc';try{$v=$s[$key];}catch(TypeError $e){echo 'read ';}var_dump(isset($s[$key]));try{$s[$key]='x';}catch(TypeError $e){echo 'write ';}echo $s,"\n";}
foreach(['/(a)*\1b/','/(a){0,2}\1b/','/(a)+\1b/'] as $p){var_dump(preg_match($p,'b'));}var_dump(preg_match('/(a)*\1b/','aab',$m),$m);
class MutableHash extends SplObjectStorage {function getHash(object $o):string{return $o->key;}}
$d=new MutableHash;$o=(object)['key'=>'a'];$d[$o]=1;$o->key='b';$d[$o]=2;var_dump(count($d));foreach($d as $item){var_dump($d->getInfo());}$c=clone $d;var_dump(count($c));
class CloneHash extends SplObjectStorage {function getHash(object $o):string{echo count($this),' ';return 'k';}}
$c=new CloneHash;$c[new stdClass]=1;$d=clone $c;echo "\n";
foreach(['ΑΣ','ΑΣ́Α','ΣΣΣ','AΣ B'] as $text){var_dump(mb_convert_case($text,MB_CASE_TITLE));}
foreach(['mb_strpos','mb_strrpos','mb_stripos','mb_strripos'] as $fn){var_dump($fn('éababababacÉ','abac'),$fn('éababababacÉ','é'));}
