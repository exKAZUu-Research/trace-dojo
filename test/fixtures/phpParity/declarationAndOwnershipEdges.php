<?php
class NativeOverride extends ArrayObject {function count(){return 9;}}
class ReferenceAccess implements ArrayAccess {
    private $values = [];
    function offsetExists(mixed $offset):bool{return isset($this->values[$offset]);}
    function &offsetGet($key){return $this->values[$key];}
    function offsetSet(mixed $offset,mixed $value):void{$this->values[$offset]=$value;}
    function offsetUnset(mixed $offset):void{unset($this->values[$offset]);}
}
class Uninitialized {
    public array $items;
    function __isset($name) {echo 'isset';return false;}
}
$u = new Uninitialized;
unset($u->items[0]);
echo "quiet\n";
class HookedUnset {
    private array $storage = [1,2];
    public array $items {get {echo 'get';return $this->storage;}set {$this->storage=$value;}}
}
$u = new HookedUnset;
try {unset($u->items[0]);}catch(Throwable $e){echo $e->getMessage();}
echo "done\n";
class NarrowSet {
    public private(set) int $a = 1;
    public protected(set) int $b = 2;
    function __construct(public private(set) int $p = 3, public protected(set) int $q = 4) {}
}
class ChildSet extends NarrowSet {
    function remove() {unset($this->a);}
}
$u = new ChildSet;
foreach (['a','b','p','q'] as $name) {
    try {unset($u->$name);}catch (Throwable $e) {echo $e->getMessage(),"\n";}
}
try {$u->remove();}catch (Throwable $e) {echo $e->getMessage(),"\n";}
var_dump($u->a,$u->b,$u->p,$u->q);
foreach ([9290075400000050.0,1000000000000050.0,929007540000005*10.0,1e15+50,929007540000005.0] as $v) {
    echo $v,' ',sprintf('%.14g',$v),' ';print_r($v);echo "\n";
}
const LENGTH = strlen(...);
const MAPPER = array_map(...);
const STATIC_CLOSURE = static function ($x) {return $x+1;};
echo (LENGTH)('abc'),"\n";
var_dump((MAPPER)(STATIC_CLOSURE,[1,2]));
class DeclaredBase {function f():int{return 5;}}
class Intermediate extends DeclaredBase {}
class GoodOverride extends Intermediate {function f():int{return 6;}}
echo (new GoodOverride)->f(),"\n";
class InheritedCount {function count(){return 3;}}
class NewlyCountable extends InheritedCount implements Countable {}
class AlreadyCountable extends NewlyCountable {}
echo (new AlreadyCountable)->count(),"\n";
class RefHookUnset {
    private array $storage=[1,2];
    public array $items {&get {echo 'refget';return $this->storage;}}
}
$u=new RefHookUnset;
unset($u->items[0]);
var_dump($u->items);
