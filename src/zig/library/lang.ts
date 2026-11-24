import type { SourceFile } from '../ast';
import { parseZig } from '../parse';
import { addDecls } from '../semaBase';
import type { Namespace, StructType } from '../types';

/**
 * The declarations of Zig 0.17's `std.lang` (also `std.builtin`) that the language's builtins return or take, such as
 * `@typeInfo`'s `Type` and `@src`'s `SourceLocation`, as the library declares them.
 */
const SOURCE = `
pub const SourceLocation = struct {
    module: [:0]const u8,
    file: [:0]const u8,
    fn_name: [:0]const u8,
    line: u32,
    column: u32,
};

pub const Signedness = enum(u1) {
    signed,
    unsigned,
};

pub const CallModifier = enum {
    auto,
    never_tail,
    never_inline,
    no_suspend,
    always_tail,
    always_inline,
    compile_time,
};

pub const FloatMode = enum {
    strict,
    optimized,
};

pub const BranchHint = enum(u3) {
    none,
    likely,
    unlikely,
    cold,
    unpredictable,
};

pub const ReduceOp = enum {
    And,
    Or,
    Xor,
    Min,
    Max,
    Add,
    Mul,
};

pub const PrefetchOptions = struct {
    rw: Rw = .read,
    locality: u2 = 3,
    cache: Cache = .data,

    pub const Rw = enum(u1) {
        read,
        write,
    };

    pub const Cache = enum(u1) {
        instruction,
        data,
    };
};

pub const AddressSpace = enum(u5) {
    generic,
    gs,
    fs,
    ss,
};

pub const CallingConvention = union(enum(u8)) {
    auto,
    @"async",
    naked,
    @"inline",
    aarch64_aapcs_darwin,
};

pub const Type = union(enum) {
    @"type",
    @"void",
    @"bool",
    @"noreturn",
    int: Int,
    float: Float,
    pointer: Pointer,
    array: Array,
    @"struct": Struct,
    @"comptime_float",
    @"comptime_int",
    @"undefined",
    @"null",
    optional: Optional,
    error_union: ErrorUnion,
    error_set: ErrorSet,
    @"enum": Enum,
    @"union": Union,
    @"fn": Fn,
    @"opaque": Opaque,
    frame: Frame,
    @"anyframe": AnyFrame,
    vector: Vector,
    enum_literal,
    spirv: Spirv,

    pub const Int = struct {
        signedness: Signedness,
        bits: u16,
    };

    pub const Float = struct {
        bits: u16,
    };

    pub const Pointer = struct {
        size: Size,
        attrs: Attributes,
        child: type,
        sentinel_ptr: ?*const anyopaque,

        pub const Size = enum(u2) {
            one,
            many,
            slice,
            c,
        };

        pub const Attributes = struct {
            @"const": bool = false,
            @"volatile": bool = false,
            @"allowzero": bool = false,
            @"addrspace": ?AddressSpace = null,
            @"align": ?usize = null,
        };
    };

    pub const Array = struct {
        len: comptime_int,
        child: type,
        sentinel_ptr: ?*const anyopaque,
    };

    pub const ContainerLayout = enum(u2) {
        auto,
        @"extern",
        @"packed",
    };

    pub const Struct = struct {
        is_tuple: bool,
        layout: ContainerLayout,
        backing_integer: ?type,
        field_names: []const [:0]const u8,
        field_types: []const type,
        field_attrs: []const FieldAttributes,
        decl_names: []const [:0]const u8,

        pub const FieldAttributes = struct {
            @"comptime": bool = false,
            @"align": ?usize = null,
            default_value_ptr: ?*const anyopaque = null,
        };
    };

    pub const Optional = struct {
        child: type,
    };

    pub const ErrorUnion = struct {
        error_set: type,
        payload: type,
    };

    pub const ErrorSet = struct {
        error_names: ?[]const [:0]const u8,
    };

    pub const Enum = struct {
        tag_type: type,
        mode: Mode,
        field_names: []const [:0]const u8,
        field_values: []const comptime_int,
        decl_names: []const [:0]const u8,

        pub const Mode = enum { exhaustive, nonexhaustive };
    };

    pub const Union = struct {
        layout: ContainerLayout,
        tag_type: ?type,
        backing_integer: ?type,
        field_names: []const [:0]const u8,
        field_types: []const type,
        field_attrs: []const FieldAttributes,
        decl_names: []const [:0]const u8,

        pub const FieldAttributes = struct {
            @"align": ?usize = null,
        };
    };

    pub const Fn = struct {
        attrs: Attributes,
        is_generic: bool,
        return_type: ?type,
        param_types: []const ?type,
        param_attrs: []const ParamAttributes,

        pub const ParamAttributes = struct {
            @"noalias": bool = false,
        };

        pub const Attributes = struct {
            @"callconv": CallingConvention = .auto,
            varargs: bool = false,
        };
    };

    pub const Spirv = union(enum(u2)) {
        sampler,
        image,
        sampled_image: type,
        runtime_array: type,
    };

    pub const Opaque = struct {
        decl_names: []const [:0]const u8,
    };

    pub const Frame = struct {
        function: *const anyopaque,
    };

    pub const AnyFrame = struct {
        child: ?type,
    };

    pub const Vector = struct {
        len: comptime_int,
        child: type,
    };
};
`;

let lang: StructType | undefined;

/** `std.lang`, whose declarations the compiler analyzes from their source on first use. */
export function langNamespace(): StructType {
  if (lang) return lang;
  const file: SourceFile = parseZig(SOURCE);
  const namespace: Namespace = { name: 'lang', decls: new Map(), internal: true };
  addDecls(namespace, file.members);
  lang = { kind: 'struct', isTuple: false, namespace, layout: 'auto', fields: [] };
  return lang;
}
