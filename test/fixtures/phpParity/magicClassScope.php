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

class NestedPropertyContext {
    public $getter {
        get {
            static $local = __PROPERTY__;
            return new class(__PROPERTY__, $local) {
                const OUTER = __PROPERTY__;
                public $inside = [__PROPERTY__], $sameLine = __property__;
                function __construct(public $argument, public $staticLocal) {}
                function names($default=__PROPERTY__) { return [__PROPERTY__, $default]; }
            };
        }
    }
    public $backing;
    public $setter {
        set {
            $this->backing = new class { public $nested=__property__; };
            echo __PROPERTY__,"\n";
        }
    }
}
$context = new NestedPropertyContext;
$inner = $context->getter;
var_dump($inner->argument, $inner->staticLocal, $inner::OUTER, $inner->inside, $inner->sameLine, $inner->names());
$context->setter=3;
var_dump($context->backing->nested);

class OuterBinding {
    function make() { return fn()=>[fn()=>__class__, function(){return __class__;}]; }
}
$outer = (new OuterBinding)->make();
foreach ([\Closure::bind($outer,null,Beta::class),$outer->bindTo(null,Beta::class)] as $rebound) {
    foreach ($rebound() as $innerClosure) var_dump($innerClosure());
}

function globalLexicalName() { return __CLASS__; }
foreach ([globalLexicalName(...), \Closure::fromCallable(__NAMESPACE__ . '\\globalLexicalName')] as $named) {
    var_dump($named->bindTo(new Beta)());
}
