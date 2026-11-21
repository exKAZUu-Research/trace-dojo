<?php
trait T{public int $x{get=>1;}}trait U{public int $x{get=>1;}}class A{use T,U;}echo 'never';
