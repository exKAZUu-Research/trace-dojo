<?php
class RefAccess implements ArrayAccess {
    public $value=1;
    function offsetExists($key):bool {return true;}
    function &offsetGet($key):mixed {return $this->value;}
    function offsetSet($key,$value):void {}
    function offsetUnset($key):void {}
}
$a=new RefAccess;
$r=&$a[0];$r=2;echo $a->value,"\n";
function modify(&$value) {$value=3;}
modify($a[0]);echo $a->value,"\n";
$native=new ArrayObject([1]);$r=&$native[0];$r=4;echo $native[0],"\n";
foreach (['/😀++/u','/𠮷{2}+/u','/😀*+/u','/𠮷?+/u'] as $pattern) {
    var_dump(preg_match($pattern,'😀😀𠮷𠮷',$matches),$matches);
}
$subjects=['a',substr('あ',0,1),'b'];
var_dump(preg_grep('/./u',$subjects),preg_last_error());
var_dump(preg_grep('/./u',$subjects,PREG_GREP_INVERT),preg_last_error());
foreach ([0,-1] as $level) {
    try {echo dirname('foo/bar',$level);}catch(Throwable $e){echo $e->getMessage(),"\n";}
}
foreach (['/foo','/','///','/a//b///','foo/bar','a//b','foo/../bar','', '.', '..'] as $path) {
    foreach ([1,2,3,PHP_INT_MAX] as $level) echo $path,':',$level,':',dirname($path,$level),"\n";
}
