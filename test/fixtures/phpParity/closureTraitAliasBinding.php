<?php class B{}trait T{function f(){}}class A{use T{f as g;}}$a=new A;foreach([$a->g(...),Closure::fromCallable([$a,'g'])] as $f){var_dump($f->bindTo(new B),Closure::bind($f,new B));}
