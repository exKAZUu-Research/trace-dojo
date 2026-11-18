<?php
function show($fn) {try {$fn();} catch (Throwable $error) {echo $error->getMessage(), "\n";}}
show(fn()=>assert((fn()=>0) === null));
show(fn()=>assert(false && fn()=>0));
show(fn()=>assert(false && (fn()=>0)));
show(fn()=>assert(false && function(){if(true){echo 1;}elseif(false){echo 2;}elseif(false){echo 3;}else{echo 4;}}));
show(fn()=>assert(false && function(){if(true){echo 1;}else if(false){echo 2;}else{echo 3;}}));
show(fn()=>assert(false && function(){if(true){echo 1;}else {if(false){echo 2;}}}));
show(fn()=>assert(false && function(){;;{echo 7;}while(false){break;}do{continue 1;}while(false);for(;;)break;return function(){return 1;};}));
show(fn()=>assert(false && function(){foreach(['a'=>1] as $k=>&$v){unset($v,$k);}global $a,$b;static $a=1,$b;throw new Exception;}));
show(fn()=>assert(false && function(){try{throw new Exception;}catch(LogicException|RuntimeException $e){echo 0;}finally{echo 'f';}}));
show(fn()=>assert(false && function(){goto end;end:switch(1){case 2: echo 3;break;default:return match(0){0=>fn()=>2};}}));
show(fn()=>assert(false && function(){echo 1, 2; print 2; @print 3; function nested(int $x=3){return $x;}}));
show(fn()=>assert(false && function(){
    if (true) {
        return function() { return function() { return 1; }; };
    }
}));
show(fn()=>assert(false && ('text' === (fn()=>function(){return 4;}))));
show(function(){
    foreach (['x', 'X', 'x-y', '0', 'hello world', '猫'] as $name) $$name = 0;
    show(fn()=>assert(false && ${'x'}));
    show(fn()=>assert(false && ${'X'}));
    show(fn()=>assert(false && ${'x-y'}));
    show(fn()=>assert(false && ${'0'}));
    show(fn()=>assert(false && ${'hello world'}));
    show(fn()=>assert(false && ${'猫'}));
});
