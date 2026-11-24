<?php
function render(string $name, array $items): string {
    ob_start();
    ?>
<h1><?= htmlspecialchars($name) ?></h1>
<ul>
<?php foreach ($items as $item): ?>
  <li><?= $item ?></li>
<?php endforeach; ?>
</ul>
<?php
    return ob_get_clean();
}
$html = render("A & B", [1, 2]);
echo strlen($html), "\n", $html;
ob_start();
echo "a";
ob_start();
echo "b";
var_dump(ob_get_level(), ob_get_length());
$inner = ob_get_contents();
ob_end_flush();
$outer = ob_get_clean();
var_dump($inner, $outer);
ob_start();
echo "buffered\n";
fwrite(STDOUT, "written past the buffer\n");
ob_end_flush();
var_dump(ob_get_clean(), ob_end_flush(), ob_get_contents(), ob_get_length(), ob_get_level());
ob_start(fn($s) => "[" . $s . "]");
echo "callback";
ob_end_flush();
echo "\n";
ob_start(function ($buffer, $phase) { return "<$phase:" . $buffer . ">"; }, 4);
echo "12";
echo "345";
echo "6";
ob_flush();
echo "7";
ob_clean();
echo "8";
ob_end_clean();
echo "\n";
ob_start();
ob_start(fn($s) => strrev($s), 10);
$handlers = ob_list_handlers();
$status = ob_get_status(true);
ob_end_clean();
ob_end_clean();
print_r($handlers);
print_r($status);
ob_start(null, 0, PHP_OUTPUT_HANDLER_STDFLAGS ^ PHP_OUTPUT_HANDLER_REMOVABLE);
var_dump(ob_end_clean());
ob_start(function ($s) { echo "ignored"; return strtoupper($s); });
echo "output from a handler is deprecated\n";
ob_end_flush();
ob_start(function ($s) { throw new Exception("handler failed"); });
echo "passed along\n";
try {
    ob_end_flush();
} catch (Exception $e) {
    echo "caught ", $e->getMessage(), "\n";
}
ob_start(fn($s) => strtoupper($s));
echo "closed at the end\n";
