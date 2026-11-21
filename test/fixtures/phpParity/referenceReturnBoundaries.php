<?php
function &baseReference(){static $value=1;return $value;}
function &forwardReference(){return baseReference();}
$r=&forwardReference();$r=2;echo baseReference(),"\n";
function &dynamicReference(){static $value=3;$name='value';return $$name;}
$r=&dynamicReference();$r=4;echo dynamicReference(),"\n";
$o=(object)['value'=>5];$arrow=fn &()=> $o->value;$r=&$arrow();$r=6;echo $o->value,"\n";
function &otherReference(){static $value=9;return $value;}
class CleanupReference {function __destruct(){$unused=&otherReference();}}
function &withCleanup(){$cleanup=new CleanupReference;return baseReference();}
$r=&withCleanup();$r=7;echo baseReference(),"\n";
$callback=fn &()=> $o->value;
$r=&array_map($callback,[1]);$r[0]=8;echo $o->value,"\n";
class MagicPrivateReference {
    private $value=10;
    protected $items=[];
    function &__get($name){echo "get:$name\n";return $this->$name;}
    function show(){var_dump($this->value,$this->items);}
}
$magic=new MagicPrivateReference;
$alias=&$magic->value;$alias=11;
$magic->items[]=12;$magic->show();
class MagicPrivateValue {
    private $value=13;
    function __get($name){echo "copy:$name\n";return $this->$name;}
    function show(){var_dump($this->value);}
}
$magic=new MagicPrivateValue;$alias=&$magic->value;$alias=14;$magic->show();
