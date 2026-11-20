<?php
try{new self;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{new static;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{self::f();}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{static::f();}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{$x=self::$v;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{$x=static::$v;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{$x=self::class;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{$x=static::class;}catch(Throwable $e){echo $e->getMessage(),"\n";}
try{parent::f();}catch(Throwable $e){echo $e->getMessage(),"\n";}
