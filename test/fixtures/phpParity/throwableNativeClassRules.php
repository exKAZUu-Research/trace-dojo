<?php
class UserFailure extends Exception {}
foreach ([new Exception, new Error, new TypeError, new UserFailure] as $exception) {
    try { clone $exception; }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
try { new Exception('message', 0, 1); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
try { new ErrorException('message', 0, 1, 'file', 1, 'invalid'); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
