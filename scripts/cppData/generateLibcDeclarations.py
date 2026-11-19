"""Emit the global declarations visible through each accepted header on Apple Clang 21 for arm64."""

import json
import re
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TREE_NODE = re.compile(r"^((?:[| ] )*)(?:\|-|`-)(\w+) (.*)")
TYPE_NAME = re.compile(r"\b\w+\b")
USING_SHADOW = re.compile(r" (Function|FunctionTemplate|Var) 0x\w+ '([^']+)'(?: '([^']+)')?")

def probe(header):
    result = subprocess.run(
        ["clang++", "-std=c++20", "-x", "c++", "-fsyntax-only", "-Xclang", "-ast-dump", "-"],
        input=f"#include <{header}>\n", capture_output=True, text=True, check=True,
    )
    ancestors = []
    aliases = {}
    globals_ = set()
    for line in result.stdout.splitlines():
        match = TREE_NODE.match(line)
        if not match:
            continue
        prefix, category, declaration = match.groups()
        depth = len(prefix) // 2
        del ancestors[depth:]
        global_scope = all(node == "LinkageSpecDecl" for node in ancestors)
        ancestors.append(category)
        if not global_scope:
            continue
        if category == "UsingShadowDecl":
            shadow = USING_SHADOW.search(declaration)
            if shadow:
                target, name, signature = shadow.groups()
                globals_.add((name, "var" if target == "Var" else "using", signature or ""))
        if category not in {"TypedefDecl", "TypeAliasDecl", "FunctionDecl", "VarDecl"}:
            continue
        head, sep, full_type = declaration.partition(" '")
        if not sep:
            continue
        name = head.rsplit(None, 1)[-1]
        signature = full_type.split("'", 1)[0]
        if category in {"TypedefDecl", "TypeAliasDecl"}:
            if name not in TYPE_NAME.findall(signature):
                aliases[name] = signature
            continue
        globals_.add((name, "var" if category == "VarDecl" else "function", signature))

    def normalize(signature):
        signature = re.split(r"\s+(?:noexcept\b|__attribute__)", signature, maxsplit=1)[0]
        for _ in range(4):
            following = TYPE_NAME.sub(lambda match: aliases.get(match[0], match[0]), signature)
            if following == signature:
                break
            signature = following
        return re.sub(r"\b_(?:Nonnull|Nullable|Null_unspecified)\b", "", signature).strip()

    return {(name, kind, normalize(signature)) for name, kind, signature in globals_ if name.isidentifier() and not name.startswith("_")}


def main():
    target = subprocess.check_output(["clang++", "--version"], text=True)
    if not target.startswith("Apple clang version 21.") or not re.search(r"Target: arm64-apple-", target):
        raise SystemExit("Use Apple Clang 21 targeting arm64 macOS.")
    source = Path("src/cpp/library/headers.ts").read_text()
    headers = sorted(re.findall(r"^  '([^']+)',", source.split("const MISSING_HEADERS")[0], re.M))
    presence = defaultdict(list)
    with ThreadPoolExecutor(4) as pool:
        for header, globals_ in zip(headers, pool.map(probe, headers)):
            for declaration in globals_:
                presence[declaration].append(header)
    groups = sorted({tuple(found) for found in presence.values()})
    group_id = {group: i for i, group in enumerate(groups)}
    names = defaultdict(list)
    for (name, kind, signature), found in sorted(presence.items()):
        names[name].append([group_id[tuple(found)], kind, signature])
    output = Path("src/cpp/library/libcGlobalDeclarations.json")
    output.write_text(json.dumps({"headers": groups, "declarations": names}, indent=2) + "\n")
    subprocess.run(["bun", "fmt", "--no-script", "--no-config", str(output)], check=True)


if __name__ == "__main__":
    main()
