<?php
trait T{public const int X=self::MISSING;}class A{use T;protected const int X=1;}echo 'never';
