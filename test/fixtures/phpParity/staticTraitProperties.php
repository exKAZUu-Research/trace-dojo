<?php trait T{public static $x=1;public static int $y=2;public static ?self $z=null;}trait U{use T;}class A{use U;}class B{use T;public static int $y=2;}var_dump(A::$x,A::$y,A::$z,B::$y);A::$x=4;var_dump(A::$x,B::$x);

$replacement = 3;
set_error_handler(function () use (&$replacement) { T::$x =& $replacement; return true; });
var_dump(T::$x);
T::$x = 6;
restore_error_handler();
var_dump($replacement);

foreach (['write', 'add', 'increment', 'read', 'invalid', 'numeric string', 'integral float', 'boolean', 'fractional add', 'concatenate'] as $operation) {
    $replacement = 2;
    $first = true;
    set_error_handler(function () use (&$replacement, &$first) {
        if ($first) {
            $first = false;
            T::$y =& $replacement;
            throw new Exception('trait access');
        }
        return true;
    });
    try {
        if ($operation === 'write') T::$y = 3;
        elseif ($operation === 'add') T::$y += 3;
        elseif ($operation === 'increment') T::$y++;
        elseif ($operation === 'invalid') T::$y = 'invalid';
        elseif ($operation === 'numeric string') T::$y = '3';
        elseif ($operation === 'integral float') T::$y = 4.0;
        elseif ($operation === 'boolean') T::$y = true;
        elseif ($operation === 'fractional add') T::$y += 4.5;
        elseif ($operation === 'concatenate') T::$y .= $missing;
        else var_dump(T::$y);
    } catch (Throwable $error) {
        echo get_class($error), ': ', $error->getMessage(), "\n";
    }
    restore_error_handler();
    var_dump($replacement);
}
