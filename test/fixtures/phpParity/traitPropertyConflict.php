<?php
trait T{public int $x=1;}trait U{public int $x=2;}class A{use T,U;}echo 'never';
