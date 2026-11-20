<?php
class UnsetMagic {
    public int $value = 1;
    function __get($name) { echo 'get;'; return 1; }
    function __set($name, $value) { echo 'set;'; }
}
class PrivateMagic {
    private int $value = 1;
    function __get($name) { echo 'get;'; return 1; }
    function __set($name, $value) { echo 'set;'; }
}
$unset = new UnsetMagic;
unset($unset->value);
foreach ([$unset, new PrivateMagic] as $magic) {
    try { $magic->value /= 0; } catch (Throwable $error) { echo get_class($error), "\n"; }
}
class ReadOnlyValue {
    public function __construct(public readonly int $value = 1) {}
    function checks() {
        try { $this->value /= 0; } catch (Throwable $error) { echo get_class($error), ':', $error->getMessage(), "\n"; }
    }
}
$readonly = new ReadOnlyValue;
foreach ([fn() => $readonly->value /= 0, fn() => $readonly->value -= [], fn() => $readonly->value += 1] as $check) {
    try { $check(); } catch (Throwable $error) { echo get_class($error), ':', $error->getMessage(), "\n"; }
}
$readonly->checks();
$array = [];
try { $array['element'] /= 0; } catch (Throwable $error) { echo get_class($error), "\n"; }
try { $array['nested']['element'] %= 0; } catch (Throwable $error) { echo get_class($error), "\n"; }
try { $absent /= 0; } catch (Throwable $error) { echo get_class($error), "\n"; }
var_dump($array, $absent);
class Containers {
    public static ?array $shared = null;
    public ?array $property = null;
}
$container = new Containers;
try { Containers::$shared['element'] /= 0; } catch (Throwable $error) { echo get_class($error), "\n"; }
try { $container->property['element'] /= 0; } catch (Throwable $error) { echo get_class($error), "\n"; }
var_dump(Containers::$shared, $container->property);

$handled = [];
set_error_handler(function () use (&$handled) { $handled['changed'] = 5; });
var_dump($handled['changed'] /= 0);
restore_error_handler();
var_dump($handled);
