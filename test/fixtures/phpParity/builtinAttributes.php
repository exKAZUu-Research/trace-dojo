<?php
#[\Deprecated("use g()", since: "1.2")]
function f() { return 1; }

#[\NoDiscard("the result tells whether it worked")]
function save(): bool { echo "saving\n"; return true; }

#[\AllowDynamicProperties]
class Bag {}

class Plain {}

class Base { public function run() { return 'base'; } }

#[Attribute(Attribute::TARGET_CLASS)]
final class Child extends Base {
    #[\Deprecated] const OLD = 1;
    #[\Override] public function run() { return 'child'; }
    #[\Deprecated("no more")] public function legacy() { return 2; }
}

enum Mode { #[\Deprecated(since: "2.0")] case Old; case New; }

#[\Deprecated("t")]
trait Helper { public function help() { return 'help'; } }

function login($user, #[\SensitiveParameter] $password) { throw new Exception('failed'); }

echo f(), "\n";
save();
(void) save();
$saved = save();
$bag = new Bag();
$bag->x = 1;
$plain = new Plain();
$plain->x = 1;
echo (new Child())->run(), Child::OLD, (new Child())->legacy(), "\n";
var_dump(Mode::Old, Mode::New);

class UsesHelper { use Helper; }
echo (new UsesHelper())->help(), "\n";

try {
    login('bob', 'secret');
} catch (Exception $e) {
    echo $e->getTraceAsString(), "\n";
    var_dump($e->getTrace()[0]['args']);
}
var_dump((new SensitiveParameterValue('hidden'))->getValue());
