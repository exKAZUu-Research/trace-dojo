<?php
spl_autoload_register(function ($class) {
    echo "autoload($class)\n";
});
var_dump(class_exists('Foo'));
var_dump(class_exists('Foo', false));
var_dump(class_exists('\Bar'));
var_dump(interface_exists('IFoo'));
var_dump(method_exists('Nope', 'x'));
var_dump(is_a('Zed', 'Other', true));
var_dump($x instanceof Missing);
try { new Missing(); } catch (Error $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { Missing2::foo(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { echo Missing3::C; } catch (Error $e) { echo $e->getMessage(), "\n"; }
var_dump(class_exists('1abc'));
print_r(spl_autoload_functions());
$f = fn($c) => print("second($c)\n");
spl_autoload_register($f);
spl_autoload_register($f);
spl_autoload_register(fn($c) => print("first($c)\n"), true, true);
var_dump(class_exists('Q'));
var_dump(spl_autoload_unregister($f), spl_autoload_unregister($f));
var_dump(count(spl_autoload_functions()));
spl_autoload_call('Called');
var_dump(unserialize('O:3:"Ser":0:{}'));
class Base {}
var_dump(class_alias('Base', 'Alias'), get_class(new Alias), new Alias instanceof Base, class_exists('alias'));
var_dump(class_alias('Base', 'Alias'));
var_dump(class_alias('NoSuch', 'Alias2'));
var_dump(class_alias('stdClass', 'Std'));
