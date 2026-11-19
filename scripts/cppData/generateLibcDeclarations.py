"""Emit the global C declarations and std names visible through each Apple Clang 21 arm64 header."""

import json
import re
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TREE_NODE = re.compile(r"^((?:[| ] )*)(?:\|-|`-)(\w+) (.*)")
TYPE_NAME = re.compile(r"\b\w+\b")
USING_SHADOW = re.compile(r" (Function|FunctionTemplate|Var) 0x\w+ '([^']+)'(?: '([^']+)')?")
STD_FUNCTIONS = {"FunctionDecl", "FunctionTemplateDecl"}
STD_OTHER_NAMES = {
    "ClassTemplateDecl", "ConceptDecl", "CXXRecordDecl", "EnumDecl", "NamespaceAliasDecl",
    "NamespaceDecl", "TypeAliasDecl", "TypeAliasTemplateDecl", "TypedefDecl", "VarDecl", "VarTemplateDecl",
}


def probe(header):
    result = subprocess.run(
        ["clang++", "-std=c++20", "-x", "c++", "-fsyntax-only", "-Xclang", "-ast-dump", "-"],
        input=f"#include <{header}>\n", capture_output=True, text=True, check=True,
    )
    symbols = global_symbols(result.stdout)

    macros = subprocess.run(
        ["clang++", "-std=c++20", "-x", "c++", "-dM", "-E", "-"],
        input=f"#include <{header}>\n", capture_output=True, text=True, check=True,
    ).stdout
    for name in re.findall(r"^#define ([A-Za-z]\w*)(?= |$)", macros, re.M):
        symbols.add((name, "macro", ""))
    for name, kind in std_nodes(result.stdout):
        if name.isidentifier() and not name.startswith("_"):
            symbols.add((name, kind, ""))
    return symbols


def global_symbols(tree):
    aliases = {}
    declarations = set()
    for category, syntax, has_body in global_nodes(tree):
        if category == "UsingShadowDecl":
            shadow = USING_SHADOW.search(syntax)
            if shadow:
                target, name, signature = shadow.groups()
                declarations.add((name, "var" if target == "Var" else "using", signature or ""))
        if category not in {"TypedefDecl", "TypeAliasDecl", "FunctionDecl", "VarDecl"}:
            continue
        head, sep, full_type = syntax.partition(" '")
        if not sep:
            continue
        name = head.rsplit(None, 1)[-1]
        signature = full_type.split("'", 1)[0]
        if category in {"TypedefDecl", "TypeAliasDecl"}:
            if name not in TYPE_NAME.findall(signature):
                aliases[name] = signature
            continue
        kind = "var" if category == "VarDecl" else "definition" if has_body else "function"
        declarations.add((name, kind, signature))

    symbols = {
        (name, kind, normalize_type(signature, aliases))
        for name, kind, signature in declarations
        if name.isidentifier() and not name.startswith("_")
    }
    return symbols


def std_nodes(tree):
    ancestors = []
    for line in tree.splitlines():
        match = TREE_NODE.match(line)
        if not match:
            continue
        prefix, category, syntax = match.groups()
        depth = len(prefix) // 2
        del ancestors[depth:]
        name, is_inline = declaration_name(category, syntax)
        if ancestors and ancestors[0] == ("NamespaceDecl", "std", False):
            if all(node == "LinkageSpecDecl" or node == "NamespaceDecl" and inline for node, _, inline in ancestors[1:]):
                if category == "UsingShadowDecl":
                    shadow = USING_SHADOW.search(syntax)
                    if shadow:
                        target, imported, _ = shadow.groups()
                        yield imported, "stdOther" if target == "Var" else "stdFunction"
                elif name and category in STD_FUNCTIONS:
                    yield name, "stdFunction"
                elif name and category in STD_OTHER_NAMES:
                    yield name, "stdOther"
        ancestors.append((category, name, is_inline))


def declaration_name(category, syntax):
    if category not in STD_FUNCTIONS and category not in STD_OTHER_NAMES:
        return "", False
    head = syntax.partition(" '")[0]
    words = head.split()
    inline = category == "NamespaceDecl" and "inline" in words
    if category == "CXXRecordDecl" and words[-1] == "definition":
        words.pop()
    if category == "NamespaceDecl" and words[-1] == "inline":
        words.pop()
    return words[-1], inline


def global_nodes(tree):
    ancestors = []
    item = None
    for line in tree.splitlines():
        match = TREE_NODE.match(line)
        if not match:
            continue
        prefix, category, syntax = match.groups()
        depth = len(prefix) // 2
        del ancestors[depth:]
        if all(node == "LinkageSpecDecl" for node in ancestors):
            if item:
                yield item
            item = category, syntax, False
        elif item and category in {"CompoundStmt", "CXXTryStmt"} and ancestors[-1] == "FunctionDecl":
            if all(node == "LinkageSpecDecl" for node in ancestors[:-1]):
                item = item[0], item[1], True
        ancestors.append(category)
    if item:
        yield item


def normalize_type(signature, aliases):
    signature = re.split(r"\s+(?:noexcept\b|__attribute__)", signature, maxsplit=1)[0]
    for _ in range(4):
        following = TYPE_NAME.sub(lambda match: aliases.get(match[0], match[0]), signature)
        if following == signature:
            break
        signature = following
    return re.sub(r"\b_(?:Nonnull|Nullable|Null_unspecified)\b", "", signature).strip()


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
    macros = {}
    standard = defaultdict(list)
    for (name, kind, signature), found in sorted(presence.items()):
        group = group_id[tuple(found)]
        if kind == "macro":
            macros[name] = group
        elif kind in {"stdFunction", "stdOther"}:
            standard[name].append([group, kind == "stdFunction"])
        else:
            names[name].append([group, kind, signature])
    output = Path("src/cpp/library/libcGlobalDeclarations.json")
    output.write_text(
        json.dumps({"headers": groups, "declarations": names, "macros": macros, "standard": standard}, indent=2) + "\n"
    )
    subprocess.run(["bun", "fmt", "--no-script", "--no-config", str(output)], check=True)


if __name__ == "__main__":
    main()
