<?php
function show($fn) {
    try { $fn(); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
show(fn()=>assert(false && function(){
    class A{
        const X=1, Z=3;
        final const int W=7;
        var $old, $older;
        public int $prop;
        public readonly int $ro;
        public private(set) int $write;
        function f(){return 1;}
        private static function h(int &$n=0): void{}
        protected bool $first=true,$second=false;
    }
}));
show(fn()=>assert(false && function(){
    interface I{function f();}
    interface J extends I, Countable{public const NAME="hi"; public int $p{get;}}
    trait T{function f(){return 1;}}
}));
show(fn()=>assert(false && function(){
    trait T1{function g(){}}
    trait T2{function g(){}}
    class Base{}
    abstract class AbstractA extends Base{
        use T1,T2 {T1::g insteadof T2; T2::g as protected g2;}
        abstract protected function f();
        public int $p{set(int $input) {$this->p = $input;} get=>$this->p;}
    }
    $obj = new class(2) extends Base { public function __construct(final public int $x){} };
}));
show(fn()=>assert(false && function(){
    readonly class Box {public int $x; public function __construct(public int $y){}}
}));
