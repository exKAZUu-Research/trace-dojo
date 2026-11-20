<?php
echo 'before;';foreach([1] as $k=>[&$v]){}echo 'after';
