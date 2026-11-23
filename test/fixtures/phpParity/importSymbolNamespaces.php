<?php
namespace N {use \stdClass as X;use function \strlen as x;use const \PHP_EOL as X;var_dump(x('hi'),X==='\n');$x=new X;var_dump($x);}
namespace M {class X{}use M\X as X;function x(){return 3;}use function M\x as x;const Y=4;use const M\Y as Y;var_dump(x(),Y);}
namespace M {use stdClass as X;var_dump(new X);}
