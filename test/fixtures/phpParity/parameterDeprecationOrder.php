<?php
function explicitlyNullable(?int $first = null, $last) {}
function unionNullable(int|null $first = null, $last) {}
function mixedNullable(mixed $first = null, $last) {}
function beforeTwo($first = [], $second, $third = 1, $last) {}
function paramOrder($first = 1, int $nullable = null, $last) {}
function qualifiedNull(int $first = \null, $last) {}
echo "compiled\n";
