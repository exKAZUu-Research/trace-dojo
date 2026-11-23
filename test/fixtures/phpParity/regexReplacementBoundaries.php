<?php
class RegexInput {
    function __construct(public string $label, public ?string $text) {}
    function __toString(): string {
        echo $this->label;
        if ($this->text === null) throw new Exception($this->label);
        return $this->text;
    }
}
$patterns = [new RegexInput('p', '/a/'), new RegexInput('q', '/b/')];
$replacements = [new RegexInput('r', 'b'), new RegexInput('s', 'x')];
var_dump(preg_replace($patterns, $replacements, [new RegexInput('1', 'a'), new RegexInput('2', 'a')]));
var_dump(preg_replace_callback([new RegexInput('p', '/a/')], fn($match) => 'x', ['aaa', 'a']));
$count = 42;
try {
    preg_replace_callback('/a/', function ($match) {
        static $invoked = 0;
        if (++$invoked === 2) throw new Exception('callback');
        return 'x';
    }, ['aaa', 'bbb', 'aa', new RegexInput('unused', 'a'), 'a'], -1, $count);
} catch (Exception $error) { echo $error->getMessage(), ':', $count, "\n"; }
$count = 42;
try { preg_replace(['/a/', '/b/'], ['b', new RegexInput('replacement', null)], ['a', 'a'], -1, $count); }
catch (Exception $error) { echo ':', $error->getMessage(), ':', $count, "\n"; }
$count = 42;
try { preg_replace_callback_array(['/a/' => fn() => throw new Exception('callback array')], 'a', -1, $count); }
catch (Exception $error) { echo $error->getMessage(), ':', $count, "\n"; }
$subject = 'aa' . chr(233) . chr(233);
var_dump(bin2hex(preg_replace('/(.)\1/i', 'X', $subject, 1)));
var_dump(array_map('bin2hex', preg_split('/(.)\1/i', $subject, 2)));
