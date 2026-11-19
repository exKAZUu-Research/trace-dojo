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

class JsonCleanupChain {
    function __construct(private int $position) {}
    function __destruct() {
        echo "release $this->position\n";
        if ($this->position === 1) exit("exit during first cleanup\n");
        throw new Exception("second cleanup");
    }
}
class JsonCleanupChainValue implements JsonSerializable {
    function jsonSerialize(): mixed {
        return [new JsonCleanupChain(1), new JsonCleanupChain(2), chr(255)];
    }
}
try {
    json_encode(new JsonCleanupChainValue, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    for (; $error !== null; $error = $error->getPrevious()) {
        echo get_class($error), ' ', $error->getCode(), ' ', $error->getMessage(), "\n";
    }
}
echo "continued\n";
