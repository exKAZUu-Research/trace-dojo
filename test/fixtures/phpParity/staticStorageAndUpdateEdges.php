<?php
class State {
    public static int $number;
    public static ?int $nullable;
    public static array $items;
    private static int $private=1;
    protected static int $protected=2;
    public static function inspect() {var_dump(self::$private,self::$protected);}
    public static function bind(&$source) {self::$private=&$source;}
}
var_dump(isset(State::$number),isset(State::$nullable),isset(State::$missing));
echo State::$number??42,' ',State::$nullable??43,' ',State::$private??44,' ',State::$protected??45,"\n";
echo State::$number??=42,' ',State::$nullable??=43,"\n";
var_dump(isset(State::$number),isset(State::$nullable));
State::$items[]=5;var_dump(State::$items);
function fallback() {echo 'fallback ';return 9;}
foreach (['private','protected','missing'] as $name) {
    try {State::$$name??=fallback();}catch(Throwable $e){echo $e->getMessage(),"\n";}
}
$field='number';$alias='field';
echo State::$$field,' ',State::${$field},' ',State::$$$alias,"\n";
$source=5;
foreach (['private','protected'] as $name) {
    try {State::$$name=&$source;}catch(Throwable $e){echo $e->getMessage(),"\n";}
}
State::inspect();
State::bind($source);$source=6;State::inspect();
$a=1;$GLOBALS['x']=&$a;$a=2;echo $x,"\n";
function globalAlias() {$local=3;$GLOBALS['fromFunction']=&$local;$local=4;}
globalAlias();echo $fromFunction,"\n";
$name='this';try {$$name=&$a;echo 'never';}catch(Throwable $e){echo $e->getMessage(),"\n";}
try {get_class();}catch(Throwable $e){echo $e->getMessage(),"\n";}
$s='abc';
try {$s[0].=fallback();}catch(Throwable $e){echo $e->getMessage(),"\n";}
try {$s[0]++;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try {++$s[1];}catch(Throwable $e){echo $e->getMessage(),"\n";}
try {$s[0][0]='z';}catch(Throwable $e){echo $e->getMessage(),"\n";}
echo $s[0]??='z',"\n";
class ValueParent {function f($x){return $x;}}
class ReferenceChild extends ValueParent {function &f($x){return $x;}}
class ReferenceParent {function &f($x){return $x;}}
class ReferenceChildToo extends ReferenceParent {function &f($x){return $x;}}
echo (new ReferenceChild)->f(3),' ',(new ReferenceChildToo)->f(4),"\n";
$name = new stdClass;
foreach ([
    fn() => ValueParent::$$name,
    fn() => ValueParent::$$name = 1,
    fn() => isset(ValueParent::$$name),
    function() use ($name) {unset(ValueParent::$$name);},
] as $operation) {
    try { $operation(); }
    catch (Throwable $error) {
        echo $error->getPrevious()?->getMessage() ?? '-', ' | ', $error->getMessage(), "\n";
    }
}
