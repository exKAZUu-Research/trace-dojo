<?php
namespace MagicDemo;
var_dump(__line__, __namespace__, __FiLe__ === __FILE__, __dir__ === __DIR__, __property__);
trait SourceTrait {
    function original() { echo __function__,':',__method__,':',__class__,':',__trait__,"\n"; }
    static function originalStatic() { echo __FUNCTION__,':',__METHOD__,"\n"; }
    function createClosure() { return fn()=>__class__; }
    public string $traitProperty {
        get { return __METHOD__.':'.__PROPERTY__.':'.__CLASS__.':'.__TRAIT__; }
    }
}
trait AliasTrait { use SourceTrait { original as intermediate; } }
class Alpha {
    use AliasTrait { intermediate as alias; originalStatic as aliasStatic; }
    public $named = __property__;
    public string $nameInfo {
        get { return __method__.':'.__property__.':'.(fn()=>__property__)(); }
    }
    public int $number=0 {
        set { echo __METHOD__,':',__PROPERTY__,"\n"; $this->number=$value; }
    }
    function ordinary() { return function() { return __class__; }; }
}
class Beta {}
$a = new Alpha;
$a->alias();
Alpha::aliasStatic();
var_dump($a->named, $a->nameInfo, $a->traitProperty);
$a->number=3;
$ordinary = $a->ordinary();
$fromTrait = $a->createClosure();
$fromGlobal = fn()=>__class__;
var_dump(\Closure::bind($ordinary, null, Beta::class)(), $ordinary->call(new Beta),
         $fromTrait->call(new Beta), \Closure::bind($fromGlobal, null, Beta::class)());
