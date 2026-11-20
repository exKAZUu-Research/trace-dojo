<?php
class FailingDebug {function __debugInfo(){throw new Exception('bad');}}
try{var_dump(new FailingDebug);}catch(Throwable $e){echo 'caught';}finally{echo 'finally';}echo 'after';
