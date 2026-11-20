<?php
class LoggedIterator extends ArrayIterator {
    function current():mixed {echo "current;";return parent::current();}
    function key():string|int|null {echo "key;";return parent::key();}
    function next():void {echo "next;";parent::next();}
    function rewind():void {echo "rewind;";parent::rewind();}
}
echo iterator_count(new LoggedIterator([10,20])),"\n";
echo iterator_apply(new LoggedIterator([10,20]),function(){echo 'callback;';return true;}),"\n";
var_dump(iterator_to_array(new LoggedIterator([10,20]),false));
class OddKeys implements Iterator {
    private $i=0;
    function rewind():void{$this->i=0;}
    function valid():bool{return $this->i<4;}
    function next():void{$this->i++;}
    function current():mixed{return $this->i;}
    function key():mixed{return [true,null,1.5,'2'][$this->i];}
}
var_dump(iterator_to_array(new OddKeys));
foreach([new ArrayObject(['x'=>null]),new ArrayIterator(['x'=>null])] as $a){var_dump($a->offsetExists('x'),isset($a['x']),empty($a['x']));}
class CustomExists extends ArrayObject {function offsetExists(mixed $key):bool{echo 'exists;';return true;}}
var_dump(isset((new CustomExists)['x']));
class ConstantsScope {private const X=1;protected const Y=2;static function check(){var_dump(defined('ConstantsScope::X'),defined('ConstantsScope::Y'));}}
var_dump(defined('ConstantsScope::X'),defined('ConstantsScope::Y'));ConstantsScope::check();
try{func_get_arg(0);}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}
$f=static function(){return 1;};var_dump($f->bindTo(new stdClass));
var_dump(Closure::bind($f,new stdClass));
class BoundMethod {function m(){}}
$f=(new BoundMethod)->m(...);var_dump($f->bindTo(null),$f->bindTo(new stdClass));
$a=[2,1];foreach([[42],[SORT_DESC,SORT_ASC],[SORT_REGULAR,SORT_NUMERIC]] as $flags){try{array_multisort($a,...$flags);}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}}var_dump($a);
function traceOuter($x){traceInner('hi');}function traceInner($x){debug_print_backtrace(0,1);debug_print_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);}traceOuter(5);
foreach([new SplDoublyLinkedList,new SplStack,new SplQueue] as $list){$list->push(1);$list->rewind();var_dump($list->pop(),$list->valid(),$list->current());}
$fixed=new SplFixedArray(2);$fixed[1]='x';foreach([0,1,false,true,'0','1',1.5,-1,4,'a',null] as $key){try{var_dump($fixed->offsetExists($key));}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}}
