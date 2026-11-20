<?php
$r=new Random\Randomizer(new Random\Engine\Mt19937(1));
foreach (['write','reference','unset'] as $operation) {
    try {
        if ($operation==='write') $r->engine=new Random\Engine\Mt19937(2);
        if ($operation==='reference') $ref=&$r->engine;
        if ($operation==='unset') unset($r->engine);
    }catch(Throwable $e){echo $e->getMessage(),"\n";}
}
echo get_class($r->engine),"\n";
class Élève {}
class Пример {}
function frenchType(Élève $value):Élève{return $value;}
function cyrillicType(Пример $value):Пример{return $value;}
echo get_class(frenchType(new Élève)),' ',get_class(cyrillicType(new Пример)),"\n";
class TypedText {public Élève $first;public Пример $second;}
$o=new TypedText;$o->first=new Élève;$o->second=new Пример;echo get_class($o->first),' ',get_class($o->second),"\n";
var_dump(str_replace('x','y',[[1]]),str_ireplace('x','y',[[1]]));
$replacement=new Random\Engine\Mt19937(3);
try {$r->engine=&$replacement;}catch(Throwable $e){echo $e->getMessage(),"\n";}
function replaceEngine(&$engine){$engine=new Random\Engine\Mt19937(4);}
$before=$r->engine;replaceEngine($r->engine);var_dump($r->engine===$before);
$engineAlias=&$r->engine;$engineAlias=[1];$arrayAlias=[&$engineAlias];unset($engineAlias);$arrayCopy=$arrayAlias;$arrayAlias[0][0]=2;var_dump($arrayCopy);
