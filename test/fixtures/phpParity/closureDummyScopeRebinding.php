<?php class A{}function foo(){}foreach([foo(...),Closure::fromCallable('foo')] as $f){$g=$f->bindTo(new A);var_dump($g->bindTo(new A,null));var_dump($g->bindTo(null));var_dump($g->bindTo(new A));}
