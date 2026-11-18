<?php trait T{public static int $x=1;}trait U{use T;}class A{use U;public static int $x=2;}echo 'never';
