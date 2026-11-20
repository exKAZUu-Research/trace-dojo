<?php
class D {function __construct(public $n) {} function __destruct() {echo "-$this->n;";}}
function made($n) {return new D($n);}
function replace($a) {$a=5; echo "set;";var_dump(func_get_args());}
function remove($a) {unset($a);echo "unset;";var_dump(func_get_args());}
function reference(&$a) {$a=5;echo "reference;";var_dump(func_get_args());}
replace(new D(1));
replace(made(2));
remove(made(3));
reference(made(4));
function extras($a) {$a=6;echo "extras;";var_dump(func_get_args());}
extras(new D(5), new D(6));
function variadic(...$args) {$args[0]=7;echo "variadic;";var_dump(func_get_args());}
variadic(new D(7));
function named(...$args) {unset($args);echo 'named;';}
named(x:new D(8));
function namedRef(&...$args) {$args['x']=9;echo 'named-ref;';print_r((new Exception)->getTrace());}
$value=new D(9);namedRef(x:$value);
function positionalRef(&...$args) {$args[0]=10;echo 'positional-ref;';var_dump(func_get_args());}
$value=new D(10);positionalRef($value);
function typed(int ...$args) {$args[0]=11;$args['x']=12;var_dump(func_get_args());print_r((new Exception)->getTrace());}
typed('10',x:'11');
function defaulted($value=new D(12)) {$value=5;echo 'default;';}
defaulted();
function warned(&...$args){$args['x']=5;echo 'warned;';}
call_user_func_array('warned',['x'=>new D(13)]);
