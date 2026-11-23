<?php trait T{public static ?self $x;}class A{use T;}class B extends A{public static ?self $x;}echo 'never';
