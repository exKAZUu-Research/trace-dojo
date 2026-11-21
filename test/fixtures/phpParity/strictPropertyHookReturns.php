<?php
declare(strict_types=1);
class C {public int $x {get => "12";}}
try {echo (new C)->x;} catch(Throwable $error){echo $error->getMessage(), "\n";}
