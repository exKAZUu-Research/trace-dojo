<?php
error_reporting(0);
class FailingDebug {function __debugInfo(){throw new Exception('bad');}}
echo 'before';try{var_dump(new FailingDebug);}catch(Throwable $e){echo 'caught';}echo 'after';
