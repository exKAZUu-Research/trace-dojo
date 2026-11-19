<?php
class JsonCleanupResult {
    function __destruct() {
        echo "release\n";
        throw new Exception("result cleanup");
    }
}
class JsonCleanupValue implements JsonSerializable {
    function __construct(private mixed $value) {}
    function jsonSerialize(): mixed {
        return [new JsonCleanupResult, $this->value];
    }
}
class JsonHookCleanupValue {
    public mixed $value { get => [new JsonCleanupResult, 1]; }
}
foreach ([
    [new JsonCleanupValue(chr(255)), JSON_THROW_ON_ERROR],
    [[new JsonCleanupValue(1), chr(255)], JSON_THROW_ON_ERROR],
    [new JsonCleanupValue(STDOUT), JSON_THROW_ON_ERROR | JSON_PARTIAL_OUTPUT_ON_ERROR],
    [[new JsonHookCleanupValue, chr(255)], JSON_THROW_ON_ERROR],
] as [$value, $flags]) {
    json_decode('invalid');
    try {
        json_encode($value, $flags);
    } catch (Throwable $error) {
        echo get_class($error), ' ', $error->getCode(), ' ', $error->getPrevious()?->getMessage() ?? 'none', "\n";
    }
    echo "last error ", json_last_error(), "\n";
}
