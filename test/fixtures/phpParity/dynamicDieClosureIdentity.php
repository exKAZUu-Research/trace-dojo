<?php
$name='die';$closures=[die(...),$name(...),Closure::fromCallable('die')];foreach($closures as $f){var_dump($f);try{$f([]);}catch(Throwable $e){echo $e->getMessage(),"\n";}}
