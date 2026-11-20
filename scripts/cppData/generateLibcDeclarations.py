"""Emit the global C declarations and std names visible through each Apple Clang 21 arm64 header."""

import json
import re
import subprocess
import tempfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TREE_NODE = re.compile(r"^((?:[| ] )*)(?:\|-|`-)(\w+) (.*)")
TYPE_NAME = re.compile(r"\b\w+\b")
USING_SHADOW = re.compile(r" (\w+) 0x\w+ '([^']+)'(?: '([^']+)')?")
NAMED_TAG = re.compile(r" (?:struct|class|union|enum) ([A-Za-z]\w*)(?: definition)?$")
SEMANTIC_PARENT = re.compile(r"^0x\w+ parent 0x\w+")
STD_FUNCTIONS = {"FunctionDecl": "stdFunction", "FunctionTemplateDecl": "stdTemplate"}
USING_KINDS = {
    "Function": "function", "FunctionTemplate": "template", "Var": "var",
    **dict.fromkeys(("Typedef", "TypeAlias", "TypeAliasTemplate", "ClassTemplate", "CXXRecord", "Record", "Enum"), "type"),
}
STD_OTHER_NAMES = {
    "ClassTemplateDecl", "ConceptDecl", "CXXRecordDecl", "EnumDecl", "NamespaceAliasDecl",
    "NamespaceDecl", "TypeAliasDecl", "TypeAliasTemplateDecl", "TypedefDecl", "VarDecl", "VarTemplateDecl",
}
STD_ALIAS_TARGET = re.compile(r"(?:std::)?([A-Za-z_]\w*)(?:<|$)")


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
    for name, function_like in re.findall(r"^#define ([A-Za-z]\w*)(\(|(?= |$))", macros, re.M):
        symbols.add((name, "functionMacro" if function_like else "macro", ""))
    for name, kind in std_nodes(result.stdout):
        if name.isidentifier() and not name.startswith("_"):
            symbols.add((name, kind, ""))
    return symbols


def global_symbols(tree):
    aliases = {}
    declarations = set()
    for category, syntax, has_body in global_nodes(tree):
        if category not in {"TypedefDecl", "TypeAliasDecl", "FunctionDecl", "VarDecl"}:
            declaration = other_global_symbol(category, syntax)
            if declaration:
                declarations.add(declaration)
            continue
        head, sep, full_type = syntax.partition(" '")
        if not sep:
            continue
        name = head.rsplit(None, 1)[-1]
        signature = full_type.split("'", 1)[0]
        if category in {"TypedefDecl", "TypeAliasDecl"}:
            if name not in TYPE_NAME.findall(signature):
                aliases[name] = signature
            declarations.add((name, "type", ""))
            continue
        kind = "var" if category == "VarDecl" else "definition" if has_body else "function"
        declarations.add((name, kind, signature))

    symbols = {
        (name, kind, normalize_type(signature, aliases))
        for name, kind, signature in declarations
        if name.isidentifier() and not name.startswith("_")
    }
    return symbols


def other_global_symbol(category, syntax):
    if category == "UsingShadowDecl":
        imported = using_symbol(syntax)
        if imported:
            name, kind, signature = imported
            return name, "using" if kind in {"function", "template"} else kind, signature
    if category in {"RecordDecl", "CXXRecordDecl", "EnumDecl"}:
        tag = NAMED_TAG.search(syntax)
        if tag:
            return tag[1], "type", ""


def std_nodes(tree):
    ancestors = []
    definitions = set()
    aliases = {}
    for line in tree.splitlines():
        match = TREE_NODE.match(line)
        if not match:
            continue
        prefix, category, syntax = match.groups()
        depth = len(prefix) // 2
        del ancestors[depth:]
        name, is_inline = declaration_name(category, syntax)
        in_std = in_std_namespace(ancestors) and not SEMANTIC_PARENT.match(syntax)
        if category == "CXXRecordDecl" and syntax.endswith(" definition"):
            if in_std:
                definitions.add(name)
            elif ancestors and ancestors[-1][:2] == ("ClassTemplateDecl", name) and in_std_namespace(ancestors[:-1]):
                definitions.add(name)
        ancestors.append((category, name, is_inline))
        if not in_std:
            continue
        symbol = std_symbol(category, name, syntax)
        if symbol:
            yield symbol
        if category in {"TypeAliasDecl", "TypedefDecl"}:
            target = STD_ALIAS_TARGET.match(syntax.partition(" '")[2].split("'", 1)[0])
            if target and target[1] != name:
                aliases[name] = target[1]
    definitions.update(defined_std_aliases(aliases, definitions))
    for name in definitions:
        yield name, "stdDefinition"


def std_symbol(category, name, syntax):
    if category == "UsingShadowDecl":
        imported = using_symbol(syntax)
        if imported:
            imported_name, kind, _ = imported
            return imported_name, f"std{kind.title()}" if kind in {"function", "template"} else "stdOther"
    if name and category in STD_FUNCTIONS:
        return name, STD_FUNCTIONS[category]
    if name and category in STD_OTHER_NAMES:
        return name, "stdOther"


def defined_std_aliases(aliases, definitions):
    for name, target in aliases.items():
        seen = {name}
        while target in aliases and target not in seen:
            seen.add(target)
            target = aliases[target]
        if target in definitions:
            yield name


def in_std_namespace(ancestors):
    return (
        bool(ancestors)
        and ancestors[0] == ("NamespaceDecl", "std", False)
        and all(node == "LinkageSpecDecl" or node == "NamespaceDecl" and inline for node, _, inline in ancestors[1:])
    )


def using_symbol(syntax):
    shadow = USING_SHADOW.search(syntax)
    if shadow:
        target, name, signature = shadow.groups()
        kind = USING_KINDS.get(target)
        if kind:
            return name, kind, "" if kind == "type" else signature or ""


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
        if all(node == "LinkageSpecDecl" for node in ancestors) and not SEMANTIC_PARENT.match(syntax):
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


MATH_WIDTHS = (
    ("double", "double", ""),
    ("float", "float", "f"),
    ("ldouble", "long double", "l"),
)


def math_families():
    source = Path("src/c/library/mathFunctions.ts").read_text()
    families = {"fma": 3}
    for family, arity in (("UNARY", 1), ("BINARY", 2)):
        block = source.split(f"export const {family}:", 1)[1].split("\n};", 1)[0]
        for name in re.findall(r"^  ([a-z]\w*)(?:,|:)", block, re.M):
            families[name] = arity
    return sorted(families.items())


def math_wrapper_calls(families):
    requests = [
        (name, arity, kind, argument, result, suffix)
        for name, arity in families
        for kind, argument, result, suffix in (
            ("integer", "int", "double", ""),
            *((kind, c_type, c_type, suffix) for kind, c_type, suffix in MATH_WIDTHS),
        )
    ]
    calls = defaultdict(dict)
    with ThreadPoolExecutor(4) as pool:
        for (name, _, kind, *_), symbol in zip(requests, pool.map(math_wrapper_symbol, requests)):
            if symbol:
                calls[name][kind] = symbol
    return calls


def math_nan_results(families):
    probe = """#include <bit>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <type_traits>
template<class T> using Word = std::conditional_t<sizeof(T) == 4, std::uint32_t, std::uint64_t>;
template<class T> constexpr Word<T> sign = Word<T>(1) << (sizeof(T) * 8 - 1);
template<class T> constexpr Word<T> quiet = Word<T>(1) << (sizeof(T) == 4 ? 22 : 51);
template<class T> constexpr Word<T> exponent = sign<T> - 2 * quiet<T>;

template<class T> T operand(unsigned digit, unsigned position) {
  if (digit == 0) return 1.25;
  Word<T> bits = exponent<T> | (0x40 + position);
  if (digit <= 2) bits |= quiet<T>;
  if (digit % 2 == 0) bits |= sign<T>;
  return std::bit_cast<T>(bits);
}

template<class T> char nan_result(T result, unsigned arity) {
  Word<T> bits = std::bit_cast<Word<T>>(result);
  Word<T> payload = bits & (quiet<T> - 1);
  bool is_quiet = bool(bits & quiet<T>);
  if ((bits & exponent<T>) != exponent<T> || (!is_quiet && !payload)) return '0';
  bool is_negative = bool(bits & sign<T>);
  if (payload < 0x40 || payload >= 0x40 + arity) return is_negative ? '1' : '0';
  return char('A' + (payload - 0x40) * 4 + is_negative * 2 + is_quiet);
}

template<class Function>
void probe(const char* name, const char* width, unsigned arity, unsigned patterns, Function call) {
  std::printf("%s %s 0", name, width);
  for (unsigned pattern = 1; pattern < patterns; ++pattern)
    std::putchar(nan_result(call(pattern), arity));
  std::puts("");
}
int main() {
"""
    for name, arity in families:
        if name in {"copysign", "fma"}:
            continue
        for width, c_type, _ in MATH_WIDTHS:
            arguments = ", ".join(f"operand<{c_type}>(p / {5**i} % 5, {i})" for i in range(arity))
            probe += f'  probe("{name}", "{width}", {arity}, {5**arity}, [](unsigned p) {{ return std::{name}({arguments}); }});\n'
    probe += "}\n"
    root = Path(".tmp")
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root) as directory:
        executable = str(Path(directory) / "mathNaNResults")
        subprocess.run(["clang++", "-std=c++20", "-O0", "-x", "c++", "-o", executable, "-"], input=probe, text=True, check=True)
        measured = subprocess.check_output([executable], text=True)
    results = defaultdict(dict)
    for row in measured.splitlines():
        name, width, rules = row.split()
        if rules.strip("0"):
            results[name][width] = rules
    return results


def math_wrapper_symbol(request):
    name, arity, _, argument, result, suffix = request
    params = ", ".join(f"{argument} a{i}" for i in range(arity))
    args = ", ".join(f"a{i}" for i in range(arity))
    code = f'#include <cmath>\nextern "C" {result} probe({params}) {{ return std::{name}({args}); }}\n'
    assembly = subprocess.run(
        ["clang++", "-std=c++20", "-O0", "-x", "c++", "-S", "-o", "-", "-"],
        input=code, capture_output=True, text=True, check=True,
    ).stdout
    for symbol in (name + suffix, name):
        if re.search(rf"^\s+b(?:l)?\s+_{re.escape(symbol)}\s*$", assembly, re.M):
            return symbol


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
    types = {}
    macros = {}
    function_macros = {}
    standard = defaultdict(list)
    std_definitions = {}
    for (name, kind, signature), found in sorted(presence.items()):
        group = group_id[tuple(found)]
        if kind == "macro":
            macros[name] = group
        elif kind == "functionMacro":
            function_macros[name] = group
        elif kind == "type":
            types[name] = group
        elif kind == "stdDefinition":
            std_definitions[name] = group
        elif kind.startswith("std"):
            standard[name].append([group, kind[3:].lower()])
        else:
            names[name].append([group, kind, signature])
    output = Path("src/cpp/library/libcGlobalDeclarations.json")
    families = math_families()
    output.write_text(json.dumps({
        "headers": groups,
        "declarations": names,
        "types": types,
        "macros": macros,
        "functionMacros": function_macros,
        "standard": standard,
        "stdDefinitions": std_definitions,
        "mathCalls": math_wrapper_calls(families),
        "mathNaNResults": math_nan_results(families),
    }, indent=2) + "\n")
    subprocess.run(["bun", "fmt", "--no-script", "--no-config", str(output)], check=True)


if __name__ == "__main__":
    main()
