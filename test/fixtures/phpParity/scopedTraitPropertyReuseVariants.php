<?php
trait T0{public static self $x;}class P0{}class A0 extends P0{use T0;}class B0 extends A0{use T0;}B0::$x=new B0;echo get_class(B0::$x),";";
trait T1{public static ?self $x;}class P1{}class A1 extends P1{use T1;}class B1 extends A1{use T1;}B1::$x=new B1;echo get_class(B1::$x),";";
trait T2{public static self|int $x;}class P2{}class A2 extends P2{use T2;}class B2 extends A2{use T2;}B2::$x=new B2;echo get_class(B2::$x),";";
trait T3{public static ?parent $x;}class P3{}class A3 extends P3{use T3;}class B3 extends A3{use T3;}B3::$x=new A3;echo get_class(B3::$x),";";
