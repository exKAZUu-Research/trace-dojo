import { registerUnsupportedAttributes } from '../modules';

// The private names of CPython's modules that this grader's implementations do not have: helpers of CPython's own
// code, which programs reach only through its internals. They raise the unsupported error instead of AttributeError.
const INTERNAL_NAMES: Record<string, string> = {
  _codecs: '_unregister_error',
  _thread: '_ThreadHandle _get_main_thread_ident _get_name _make_thread_handle _shutdown',
  abc: '_abc_init _abc_instancecheck _abc_register _abc_subclasscheck _get_dump _reset_caches _reset_registry',
  annotationlib: '_ExtraNameFixer _build_closure _template_to_ast_constructor _template_to_ast_literal',
  array: '_array_reconstructor',
  'asyncio.graph': '_build_graph_for_future',
  base64:
    '_85encode _A85END _A85START _B32_DECODE_DOCSTRING _B32_DECODE_MAP01_DOCSTRING _B32_ENCODE_DOCSTRING _a85chars _a85chars2 _b32alphabet _b32decode _b32encode _b32hexalphabet _b32rev _b32tab2 _b85alphabet _b85chars _b85chars2 _b85dec _bytes_from_decode_data _input_type_check _urlsafe_decode_translation _urlsafe_encode_translation _z85_b85_decode_diff _z85_decode_translation _z85_encode_translation _z85alphabet',
  builtins: '_IncompleteInputError',
  collections:
    '_Link _OrderedDictItemsView _OrderedDictKeysView _OrderedDictValuesView _chain _count_elements _deque_iterator _eq _iskeyword _itemgetter _proxy _recursive_repr _repeat _starmap _tuplegetter',
  enum: '_auto_null _dataclass_repr _make_class_unpicklable _not_given _old_convert_ _proto_member _simple_enum _stdlib_enums _test_simple_enum',
  fractions:
    '_FLOAT_FORMAT_SPECIFICATION_MATCHER _GENERAL_FORMAT_SPECIFICATION_MATCHER _PyHASH_INF _PyHASH_MODULUS _RATIONAL_FORMAT _hash_algorithm _round_to_exponent _round_to_figures',
  hashlib: '__block_openssl_constructor __builtin_constructor_cache __get_builtin_constructor',
  heapq:
    '_heapify_max _heappop_max _heappush_max _heappushpop_max _heapreplace_max _siftdown _siftdown_max _siftup _siftup_max',
  importlib: '_RELOADING _pack_uint32 _unpack_uint32',
  inspect:
    '_NonUserDefinedCallables _ParameterKind _descriptor_get _findclass _finddoc _get_code_position _get_code_position_from_tb _has_code_flag _main _shadowed_dict_from_weakref_mro_tuple _signature_bound_method _signature_from_builtin _signature_from_callable _signature_from_function _signature_fromstr _signature_get_partial _signature_get_user_defined_method _signature_is_builtin _signature_is_functionlike _signature_strip_non_python_syntax _void',
  itertools: '_grouper _tee _tee_dataobject',
  logging:
    '_after_at_fork_child_reinit_locks _at_fork_reinit_lock_weakset _is_internal_frame _register_at_fork_reinit_lock _removeHandlerRef _srcfile _str_formatter',
  'logging.config': '_create_formatters _install_handlers _install_loggers _strip_spaces',
  operator: '_abs',
  os: '_Environ _check_methods _create_environ _execvpe _exists _fspath _fwalk _get_exports_list _spawnvef _walk_symlinks_as_files _wrap_close',
  'os.path': '_get_sep _varpattern _varsub _varsubb',
  posixpath: '_get_sep _varpattern _varsub _varsubb',
  random: '_parse_args _test _test_generator',
  re: '_MAXCACHE _MAXCACHE2 _ZeroSentinel _cache _cache2 _compile _compile_template _pickle _special_chars_map _zero_sentinel',
  statistics:
    '_SQRT2 _coerce _convert _decimal_sqrt_of_frac _exact_ratio _fail_neg _float_sqrt_of_frac _integer_sqrt_of_frac_rto _isfinite _mean_stdev _rank _sqrt_bit_width _sqrtprod _ss _sum',
  struct: '_clearcache',
  threading:
    '_DeleteDummyThreadOnDel _PyRLock _RLock _ThreadHandle _active_limbo_lock _after_fork _dangling _enumerate _get_main_thread_ident _make_invoke_excepthook _make_thread_handle _set_name _start_joinable_thread _thread_local_info _thread_shutdown',
  traceback:
    '_Anchors _CASE_COST _ExceptionPrintContext _MAX_CANDIDATE_ITEMS _MAX_STRING_SIZE _MOVE_COST _RECURSIVE_CUTOFF _Sentinel _WIDE_CHAR_SPECIFIERS _byte_offset_to_character_offset _cause_message _compute_suggestion_error _context_message _display_width _extract_caret_anchors_from_line_segment _format_final_exc_line _get_code_position _get_safe___dir__ _levenshtein_distance _parse_value_tb _print_exception_bltin _safe_string _substitution_cost _walk_tb_with_full_positions',
  types: '_GeneratorWrapper',
  typing:
    '_AnnotatedAlias _AnyMeta _BaseGenericAlias _CallableGenericAlias _CallableType _ConcatenateGenericAlias _DeprecatedGenericAlias _Final _Func _GenericAlias _IdentityCallable _LazyAnnotationLib _LiteralGenericAlias _NamedTuple _NotIterable _PROTO_ALLOWLIST _ProtocolMeta _SPECIAL_NAMES _Sentinel _SpecialForm _SpecialGenericAlias _TYPING_INTERNALS _TupleType _TypedCacheSpecialForm _TypedDict _TypedDictMeta _TypingEllipsis _UnionGenericAlias _UnionGenericAliasMeta _UnpackGenericAlias _abc_instancecheck _abc_subclasscheck _add_type_params_to_scope _alias _allow_reckless_class_checks _caches _caller _check_generic_specialization _cleanups _collect_type_parameters _deduplicate _deprecation_warning_for_no_type_params_passed _eval_type _flatten_literal_params _generic_class_getitem _generic_init_subclass _get_protocol_attrs _get_typeddict_qualifiers _idfunc _is_dunder _is_param_expr _is_typevar_like _is_unpacked_typevartuple _lazy_annotationlib _lazy_load_getattr_static _make_eager_annotate _make_forward_ref _make_nmtuple _namedtuple_mro_entries _no_init_or_replace_init _paramspec_prepare_subst _paramspec_subst _prohibited _proto_hook _sentinel _should_unflatten_callable_args _special _strip_annotations _tp_cache _type_check _type_check_issubclass_arg_1 _type_convert _type_repr _typevar_subst _typevartuple_prepare_subst _unpack_args _value_and_type_iter',
  unicodedata: '_ucnhash_CAPI',
  'unittest.mock': '_CODE_ATTRS',
  uuid: '_simple_enum',
  warnings:
    '_Lock _acquire_lock _filters_mutated_lock_held _get_context _get_filters _getaction _getcategory _is_filename_to_skip _is_internal_filename _is_internal_frame _lock _new_context _next_external_frame _processoptions _release_lock _set_context _set_module _setoption _use_context _warn_unawaited_coroutine _warnings_context',
  weakref: '_remove_dead_weakref',
};

for (const [module, names] of Object.entries(INTERNAL_NAMES)) {
  registerUnsupportedAttributes(
    module,
    Object.fromEntries(names.split(' ').map((name) => [name, `${module}.${name}（CPython の内部の名前）`]))
  );
}
