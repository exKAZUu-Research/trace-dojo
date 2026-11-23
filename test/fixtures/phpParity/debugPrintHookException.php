<?php
class FailingDebug {function __debugInfo(){throw new Exception('bad');}}
try{print_r(new FailingDebug);}catch(Throwable $e){echo 'caught';}echo 'after';
