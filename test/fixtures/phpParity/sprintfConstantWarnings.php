<?php
echo "before\n";
if (false) echo sprintf('%s', NAN);
echo sprintf(
    '%%%s/%d/%s',
    INF - INF,
    12,
    NAN
), "\n";
if (false) echo sprintf('%' . 's', NAN);
if (false) echo sprintf('%4s', NAN);
if (false) echo sprintf('%s', []);
echo sprintf('%s', (float) NAN), "\n";
echo "after\n";
