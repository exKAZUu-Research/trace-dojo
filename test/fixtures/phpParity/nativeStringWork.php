<?php
class Replacement {
    function __construct(public string $text) {}
    function __toString(): string {
        echo "cast $this->text\n";
        if ($this->text === 'throw') throw new Exception('replacement');
        $GLOBALS['currentReplacement'] = 'next';
        return $this->text;
    }
}
$currentReplacement = 'initial';
echo strtr('aaa', ['unused' => new Replacement('throw'), 'a' => new Replacement('x')]), "\n";
$currentReplacement = 'initial';
echo strtr('ab', ['a' => new Replacement('x'), 'b' => &$currentReplacement]), "\n";
try { fprintf(null, '%s', new Replacement('throw')); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
try { vfprintf(4, '%s', [new Replacement('throw')]); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
try { fprintf(1, new Replacement('throw')); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
var_dump(phpversion(), phpversion(null), phpversion(''), phpversion('jSoN'), phpversion('Core'), phpversion('unavailable'));
foreach (["\u{061C}", "\u{180E}", "\u{2066}", "\u{200D}", 'x'] as $text) {
    echo preg_match('/^[[:graph:]]$/u', $text), preg_match('/^[[:print:]]$/u', $text),
         preg_match('/^[[:^graph:]]$/u', $text), preg_match('/^[^[:graph:]]$/u', $text), "\n";
}
var_dump(wordwrap('aaababaaba', 3, 'aba', true));
var_dump(strip_tags('<a>x</a><b>y</b><c>z</c>', "x<a><b>\0<c>"));
var_dump(bin2hex(ucwords("ab\0cd-ef", "\0-")), bin2hex(strpbrk("ab\0cd", "\0")), strspn("\0aa", "\0a"), strcspn("aa\0", "\0"));
foreach ([
    fn($value) => printf('printf=[%5s|%s]', $value, $value),
    fn($value) => vprintf('vprintf=[%5s|%s]', [$value, $value]),
    fn($value) => fprintf(STDOUT, 'fprintf=[%5s|%s]', $value, $value),
    fn($value) => vfprintf(STDOUT, 'vfprintf=[%5s|%s]', [$value, $value]),
    fn($value) => sprintf('sprintf=[%5s|%s]', $value, $value),
    fn($value) => vsprintf('vsprintf=[%5s|%s]', [$value, $value]),
] as $format) {
    try { $format(new Replacement('throw')); }
    catch (Exception $error) { echo " caught ", $error->getMessage(), "\n"; }
}
foreach ([fn() => strtr('abc', 'a', []), fn() => strtr('abc', [], []), fn() => strtr('abc', 'a'),
          fn() => strtr('abc', 'a', null), fn() => strtr('abc', from: ['a' => 'x']),
          fn() => strtr('abc', to: 'z', from: 'b')] as $translate) {
    try { var_dump($translate()); }
    catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
