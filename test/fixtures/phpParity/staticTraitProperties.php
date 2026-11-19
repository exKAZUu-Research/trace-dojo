<?php trait T{public static $x=1;public static int $y=2;public static ?self $z=null;}trait U{use T;}class A{use U;}class B{use T;public static int $y=2;}var_dump(A::$x,A::$y,A::$z,B::$y);A::$x=4;var_dump(A::$x,B::$x);

$replacement = 3;
set_error_handler(function () use (&$replacement) { T::$x =& $replacement; return true; });
var_dump(T::$x);
T::$x = 6;
restore_error_handler();
var_dump($replacement);
