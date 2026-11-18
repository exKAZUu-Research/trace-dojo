/**
 * The declarations of the standard library that this interpreter implements, in Rust's syntax. Functions without a
 * body run natively (`natives.ts`), keyed by the impl's self type or trait and the function's name. Builtin types are
 * declared as structs whose values the runtime represents in its own way.
 *
 * Pseudo-traits that rustc does not have stand for groups of types that the natives handle alike: `Integer`,
 * `SignedInteger`, `UnsignedInteger`, `Float`, `Pattern` (what `str::split` and its kin accept), `Borrow` (keys that
 * look up a map), `FromStrTarget`, `StringPart`, `RangeBounds`, `ExtendInto`, and `SliceIndex` (what `<[T]>::get`
 * accepts: a `usize` or a range of them, giving `Indexed<I, T>`, an element or a slice).
 */
export const STD_SOURCE = String.raw`
pub mod marker {
    pub trait Sized {}
    pub trait Copy: Clone {}
    pub trait Send {}
    pub trait Sync {}
}
pub mod clone {
    pub trait Clone { fn clone(&self) -> Self; }
}
pub mod default {
    pub trait Default { fn default() -> Self; }
}
pub mod ops {
    pub trait Add<Rhs> {}
    pub trait Sub<Rhs> {}
    pub trait Mul<Rhs> {}
    pub trait Div<Rhs> {}
    pub trait Rem<Rhs> {}
    pub trait Neg {}
    pub trait Not {}
    pub trait AddAssign<Rhs> {}
    pub trait SubAssign<Rhs> {}
    pub trait MulAssign<Rhs> {}
    pub trait DivAssign<Rhs> {}
    pub trait Index<Idx> {}
    pub trait IndexMut<Idx> {}
    pub trait Deref {}
    pub trait DerefMut {}
    pub trait Drop {}
    pub trait Fn {}
    pub trait FnMut {}
    pub trait FnOnce {}
    pub struct Range<Idx> { pub start: Idx, pub end: Idx }
    pub struct RangeInclusive<Idx>;
    pub struct RangeFrom<Idx> { pub start: Idx }
    pub struct RangeTo<Idx> { pub end: Idx }
    pub struct RangeToInclusive<Idx> { pub end: Idx }
    pub struct RangeFull;
    impl<Idx> RangeInclusive<Idx> {
        pub fn start(&self) -> &Idx;
        pub fn end(&self) -> &Idx;
    }
    impl<Idx> Range<Idx> {
        pub fn contains(&self, item: &Idx) -> bool where Idx: PartialOrd;
        pub fn is_empty(&self) -> bool where Idx: PartialOrd;
        pub fn len(&self) -> usize where Idx: Integer;
    }
    impl<Idx> RangeInclusive<Idx> {
        pub fn contains(&self, item: &Idx) -> bool where Idx: PartialOrd;
        pub fn is_empty(&self) -> bool where Idx: PartialOrd;
    }
}
pub mod cmp {
    pub trait PartialEq {
        fn eq(&self, other: &Self) -> bool;
        fn ne(&self, other: &Self) -> bool;
    }
    pub trait Eq: PartialEq {}
    pub trait PartialOrd: PartialEq {
        fn partial_cmp(&self, other: &Self) -> Option<Ordering>;
        fn lt(&self, other: &Self) -> bool;
        fn le(&self, other: &Self) -> bool;
        fn gt(&self, other: &Self) -> bool;
        fn ge(&self, other: &Self) -> bool;
    }
    pub trait Ord: Eq + PartialOrd {
        fn cmp(&self, other: &Self) -> Ordering;
        fn max(self, other: Self) -> Self;
        fn min(self, other: Self) -> Self;
        fn clamp(self, min: Self, max: Self) -> Self;
    }
    #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
    pub enum Ordering { Less = -1, Equal = 0, Greater = 1 }
    impl Ordering {
        pub fn reverse(self) -> Ordering;
        pub fn then(self, other: Ordering) -> Ordering;
        pub fn then_with<F: FnOnce() -> Ordering>(self, f: F) -> Ordering;
        pub fn is_eq(self) -> bool;
        pub fn is_ne(self) -> bool;
        pub fn is_lt(self) -> bool;
        pub fn is_gt(self) -> bool;
        pub fn is_le(self) -> bool;
        pub fn is_ge(self) -> bool;
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Default)]
    pub struct Reverse<T>(pub T);
    pub fn max<T: Ord>(v1: T, v2: T) -> T;
    pub fn min<T: Ord>(v1: T, v2: T) -> T;
    pub fn max_by_key<T, F: FnMut(&T) -> K, K: Ord>(v1: T, v2: T, f: F) -> T;
    pub fn min_by_key<T, F: FnMut(&T) -> K, K: Ord>(v1: T, v2: T, f: F) -> T;
}
pub mod hash {
    pub trait Hash {}
}
pub mod fmt {
    pub struct Formatter;
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub struct Error;
    pub type Result = core::result::Result<(), Error>;
    pub trait Display { fn fmt(&self, f: &mut Formatter) -> Result; }
    pub trait Debug { fn fmt(&self, f: &mut Formatter) -> Result; }
    pub trait Write {
        fn write_str(&mut self, s: &str) -> Result;
        fn write_char(&mut self, c: char) -> Result;
    }
    pub struct DebugStruct;
    pub struct DebugTuple;
    pub struct DebugList;
    pub struct DebugSet;
    pub struct DebugMap;
    impl DebugStruct {
        pub fn field(&mut self, name: &str, value: &dyn Debug) -> &mut DebugStruct;
        pub fn finish(&mut self) -> Result;
        pub fn finish_non_exhaustive(&mut self) -> Result;
    }
    impl DebugTuple {
        pub fn field(&mut self, value: &dyn Debug) -> &mut DebugTuple;
        pub fn finish(&mut self) -> Result;
    }
    impl DebugList {
        pub fn entry(&mut self, entry: &dyn Debug) -> &mut DebugList;
        pub fn finish(&mut self) -> Result;
    }
    impl DebugSet {
        pub fn entry(&mut self, entry: &dyn Debug) -> &mut DebugSet;
        pub fn finish(&mut self) -> Result;
    }
    impl DebugMap {
        pub fn entry(&mut self, key: &dyn Debug, value: &dyn Debug) -> &mut DebugMap;
        pub fn finish(&mut self) -> Result;
    }
    impl Formatter {
        pub fn debug_struct(&mut self, name: &str) -> DebugStruct;
        pub fn debug_tuple(&mut self, name: &str) -> DebugTuple;
        pub fn debug_list(&mut self) -> DebugList;
        pub fn debug_set(&mut self) -> DebugSet;
        pub fn debug_map(&mut self) -> DebugMap;
        pub fn write_str(&mut self, data: &str) -> Result;
        pub fn pad(&mut self, s: &str) -> Result;
        pub fn alternate(&self) -> bool;
        pub fn width(&self) -> Option<usize>;
        pub fn precision(&self) -> Option<usize>;
        pub fn fill(&self) -> char;
        pub fn sign_plus(&self) -> bool;
    }
}
pub mod string {
    pub struct String;
    pub trait ToString { fn to_string(&self) -> String; }
    impl String {
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn new() -> String;
        pub fn with_capacity(capacity: usize) -> String;
        pub fn from_utf8(vec: Vec<u8>) -> Result<String, Utf8Error>;
        pub fn push_str(&mut self, string: &str);
        pub fn push(&mut self, ch: char);
        pub fn pop(&mut self) -> Option<char>;
        pub fn insert(&mut self, idx: usize, ch: char);
        pub fn insert_str(&mut self, idx: usize, string: &str);
        pub fn remove(&mut self, idx: usize) -> char;
        pub fn truncate(&mut self, new_len: usize);
        pub fn clear(&mut self);
        pub fn capacity(&self) -> usize;
        pub fn reserve(&mut self, additional: usize);
        pub fn as_str(&self) -> &str;
        pub fn as_mut_str(&mut self) -> &mut str;
        pub fn into_bytes(self) -> Vec<u8>;
        pub fn retain<F: FnMut(char) -> bool>(&mut self, f: F);
        pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> Iter<char>;
        pub fn split_off(&mut self, at: usize) -> String;
        pub fn replace_range<R: RangeBounds<usize>>(&mut self, range: R, replace_with: &str);
        pub fn extend<I>(&mut self, iter: Iter<I>) where I: StringPart;
    }
}
pub mod vec {
    pub struct Vec<T>;
    impl<T> Vec<T> {
        pub fn new() -> Vec<T>;
        pub fn with_capacity(capacity: usize) -> Vec<T>;
        pub fn push(&mut self, value: T);
        pub fn pop(&mut self) -> Option<T>;
        pub fn insert(&mut self, index: usize, element: T);
        pub fn remove(&mut self, index: usize) -> T;
        pub fn swap_remove(&mut self, index: usize) -> T;
        pub fn truncate(&mut self, len: usize);
        pub fn clear(&mut self);
        pub fn capacity(&self) -> usize;
        pub fn reserve(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
        pub fn extend<A: ExtendInto<T>>(&mut self, iter: Iter<A>);
        pub fn extend_from_slice(&mut self, other: &[T]) where T: Clone;
        pub fn append(&mut self, other: &mut Vec<T>);
        pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> Iter<T>;
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn retain_mut<F: FnMut(&mut T) -> bool>(&mut self, f: F);
        pub fn dedup(&mut self) where T: PartialEq;
        pub fn dedup_by_key<K: PartialEq, F: FnMut(&mut T) -> K>(&mut self, key: F);
        pub fn resize(&mut self, new_len: usize, value: T) where T: Clone;
        pub fn split_off(&mut self, at: usize) -> Vec<T>;
        pub fn as_slice(&self) -> &[T];
        pub fn as_mut_slice(&mut self) -> &mut [T];
        pub fn into_boxed_slice(self) -> Vec<T>;
        pub fn is_empty(&self) -> bool;
        pub fn len(&self) -> usize;
    }
    impl<T> Vec<T> {
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> &Vec<T> {
        pub fn into_iter(self) -> Iter<&T>;
    }
    impl<T> &mut Vec<T> {
        pub fn into_iter(self) -> Iter<&mut T>;
    }
}
pub mod slice {
    impl<T> [T] {
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn first(&self) -> Option<&T>;
        pub fn last(&self) -> Option<&T>;
        pub fn first_mut(&mut self) -> Option<&mut T>;
        pub fn last_mut(&mut self) -> Option<&mut T>;
        pub fn get<I: SliceIndex>(&self, index: I) -> Option<&Indexed<I, T>>;
        pub fn get_mut<I: SliceIndex>(&mut self, index: I) -> Option<&mut Indexed<I, T>>;
        pub fn iter(&self) -> Iter<&T>;
        pub fn iter_mut(&mut self) -> Iter<&mut T>;
        pub fn contains(&self, x: &T) -> bool where T: PartialEq;
        pub fn starts_with(&self, needle: &[T]) -> bool where T: PartialEq;
        pub fn ends_with(&self, needle: &[T]) -> bool where T: PartialEq;
        pub fn sort(&mut self) where T: Ord;
        pub fn sort_unstable(&mut self) where T: Ord;
        pub fn sort_by<F: FnMut(&T, &T) -> Ordering>(&mut self, compare: F);
        pub fn sort_unstable_by<F: FnMut(&T, &T) -> Ordering>(&mut self, compare: F);
        pub fn sort_by_key<K: Ord, F: FnMut(&T) -> K>(&mut self, f: F);
        pub fn sort_unstable_by_key<K: Ord, F: FnMut(&T) -> K>(&mut self, f: F);
        pub fn sort_by_cached_key<K: Ord, F: FnMut(&T) -> K>(&mut self, f: F);
        pub fn is_sorted(&self) -> bool where T: PartialOrd;
        pub fn reverse(&mut self);
        pub fn binary_search(&self, x: &T) -> Result<usize, usize> where T: Ord;
        pub fn binary_search_by_key<B: Ord, F: FnMut(&T) -> B>(&self, b: &B, f: F) -> Result<usize, usize>;
        pub fn binary_search_by<F: FnMut(&T) -> Ordering>(&self, f: F) -> Result<usize, usize>;
        pub fn swap(&mut self, a: usize, b: usize);
        pub fn split_at(&self, mid: usize) -> (&[T], &[T]);
        pub fn split_at_mut(&mut self, mid: usize) -> (&mut [T], &mut [T]);
        pub fn split_first(&self) -> Option<(&T, &[T])>;
        pub fn split_last(&self) -> Option<(&T, &[T])>;
        pub fn windows(&self, size: usize) -> Iter<&[T]>;
        pub fn chunks(&self, chunk_size: usize) -> Iter<&[T]>;
        pub fn chunks_exact(&self, chunk_size: usize) -> Iter<&[T]>;
        pub fn fill(&mut self, value: T) where T: Clone;
        pub fn to_vec(&self) -> Vec<T> where T: Clone;
        pub fn into_vec(self) -> Vec<T>;
        pub fn rotate_left(&mut self, mid: usize);
        pub fn rotate_right(&mut self, mid: usize);
        pub fn copy_from_slice(&mut self, src: &[T]) where T: Copy;
        pub fn clone_from_slice(&mut self, src: &[T]) where T: Clone;
        pub fn repeat(&self, n: usize) -> Vec<T> where T: Copy;
    }
    impl<T> [T] {
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> &[T] {
        pub fn into_iter(self) -> Iter<&T>;
    }
    impl<T> &mut [T] {
        pub fn into_iter(self) -> Iter<&mut T>;
    }
    impl [String] {
        pub fn join(&self, sep: &str) -> String;
        pub fn concat(&self) -> String;
    }
    impl [&str] {
        pub fn join(&self, sep: &str) -> String;
        pub fn concat(&self) -> String;
    }
    impl<T> [Vec<T>] {
        pub fn concat(&self) -> Vec<T> where T: Clone;
        pub fn join(&self, sep: &T) -> Vec<T> where T: Clone;
    }
}
pub mod str {
    pub trait FromStr {}
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseBoolError;
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseCharError;
    impl str {
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn chars(&self) -> Iter<char>;
        pub fn bytes(&self) -> Iter<u8>;
        pub fn char_indices(&self) -> Iter<(usize, char)>;
        pub fn as_bytes(&self) -> &[u8];
        pub fn trim(&self) -> &str;
        pub fn trim_start(&self) -> &str;
        pub fn trim_end(&self) -> &str;
        pub fn trim_matches<P: Pattern>(&self, pat: P) -> &str;
        pub fn trim_start_matches<P: Pattern>(&self, pat: P) -> &str;
        pub fn trim_end_matches<P: Pattern>(&self, pat: P) -> &str;
        pub fn strip_prefix<P: Pattern>(&self, prefix: P) -> Option<&str>;
        pub fn strip_suffix<P: Pattern>(&self, suffix: P) -> Option<&str>;
        pub fn split_whitespace(&self) -> Iter<&str>;
        pub fn split_ascii_whitespace(&self) -> Iter<&str>;
        pub fn lines(&self) -> Iter<&str>;
        pub fn split<P: Pattern>(&self, pat: P) -> Iter<&str>;
        pub fn rsplit<P: Pattern>(&self, pat: P) -> Iter<&str>;
        pub fn split_terminator<P: Pattern>(&self, pat: P) -> Iter<&str>;
        pub fn splitn<P: Pattern>(&self, n: usize, pat: P) -> Iter<&str>;
        pub fn rsplitn<P: Pattern>(&self, n: usize, pat: P) -> Iter<&str>;
        pub fn split_once<P: Pattern>(&self, delimiter: P) -> Option<(&str, &str)>;
        pub fn rsplit_once<P: Pattern>(&self, delimiter: P) -> Option<(&str, &str)>;
        pub fn split_at(&self, mid: usize) -> (&str, &str);
        pub fn contains<P: Pattern>(&self, pat: P) -> bool;
        pub fn starts_with<P: Pattern>(&self, pat: P) -> bool;
        pub fn ends_with<P: Pattern>(&self, pat: P) -> bool;
        pub fn find<P: Pattern>(&self, pat: P) -> Option<usize>;
        pub fn rfind<P: Pattern>(&self, pat: P) -> Option<usize>;
        pub fn matches<P: Pattern>(&self, pat: P) -> Iter<&str>;
        pub fn match_indices<P: Pattern>(&self, pat: P) -> Iter<(usize, &str)>;
        pub fn replace<P: Pattern>(&self, from: P, to: &str) -> String;
        pub fn replacen<P: Pattern>(&self, pat: P, to: &str, count: usize) -> String;
        pub fn to_uppercase(&self) -> String;
        pub fn to_lowercase(&self) -> String;
        pub fn to_ascii_uppercase(&self) -> String;
        pub fn to_ascii_lowercase(&self) -> String;
        pub fn make_ascii_uppercase(&mut self);
        pub fn make_ascii_lowercase(&mut self);
        pub fn eq_ignore_ascii_case(&self, other: &str) -> bool;
        pub fn repeat(&self, n: usize) -> String;
        pub fn parse<F: FromStrTarget>(&self) -> Result<F, ParseError<F>>;
        pub fn to_owned(&self) -> String;
        pub fn is_char_boundary(&self, index: usize) -> bool;
        pub fn get<R: RangeBounds<usize>>(&self, range: R) -> Option<&str>;
        pub fn is_ascii(&self) -> bool;
        pub fn into_string(self) -> String;
    }
}
pub mod char {
    impl u8 {
        pub fn is_ascii(&self) -> bool;
        pub fn is_ascii_digit(&self) -> bool;
        pub fn is_ascii_hexdigit(&self) -> bool;
        pub fn is_ascii_alphabetic(&self) -> bool;
        pub fn is_ascii_alphanumeric(&self) -> bool;
        pub fn is_ascii_uppercase(&self) -> bool;
        pub fn is_ascii_lowercase(&self) -> bool;
        pub fn is_ascii_punctuation(&self) -> bool;
        pub fn is_ascii_whitespace(&self) -> bool;
        pub fn is_ascii_graphic(&self) -> bool;
        pub fn is_ascii_control(&self) -> bool;
        pub fn to_ascii_uppercase(&self) -> u8;
        pub fn to_ascii_lowercase(&self) -> u8;
        pub fn make_ascii_uppercase(&mut self);
        pub fn make_ascii_lowercase(&mut self);
        pub fn eq_ignore_ascii_case(&self, other: &u8) -> bool;
    }
    impl char {
        pub fn is_alphabetic(self) -> bool;
        pub fn is_numeric(self) -> bool;
        pub fn is_alphanumeric(self) -> bool;
        pub fn is_whitespace(self) -> bool;
        pub fn is_uppercase(self) -> bool;
        pub fn is_lowercase(self) -> bool;
        pub fn is_control(self) -> bool;
        pub fn is_digit(self, radix: u32) -> bool;
        pub fn is_ascii(&self) -> bool;
        pub fn is_ascii_digit(&self) -> bool;
        pub fn is_ascii_hexdigit(&self) -> bool;
        pub fn is_ascii_alphabetic(&self) -> bool;
        pub fn is_ascii_alphanumeric(&self) -> bool;
        pub fn is_ascii_uppercase(&self) -> bool;
        pub fn is_ascii_lowercase(&self) -> bool;
        pub fn is_ascii_punctuation(&self) -> bool;
        pub fn is_ascii_whitespace(&self) -> bool;
        pub fn is_ascii_graphic(&self) -> bool;
        pub fn is_ascii_control(&self) -> bool;
        pub fn to_ascii_uppercase(&self) -> char;
        pub fn to_ascii_lowercase(&self) -> char;
        pub fn make_ascii_uppercase(&mut self);
        pub fn make_ascii_lowercase(&mut self);
        pub fn eq_ignore_ascii_case(&self, other: &char) -> bool;
        pub fn to_uppercase(self) -> CaseIter;
        pub fn to_lowercase(self) -> CaseIter;
        pub fn to_digit(self, radix: u32) -> Option<u32>;
        pub fn len_utf8(self) -> usize;
        pub fn from_u32(i: u32) -> Option<char>;
        pub fn from_digit(num: u32, radix: u32) -> Option<char>;
    }
    pub fn from_u32(i: u32) -> Option<char>;
    pub fn from_digit(num: u32, radix: u32) -> Option<char>;
    pub struct CaseIter;
}
pub mod num {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseIntError;
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseFloatError;
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TryFromIntError;
    impl<N: SignedInteger> N {
        pub fn abs(self) -> N;
        pub fn checked_abs(self) -> Option<N>;
        pub fn wrapping_abs(self) -> N;
        pub fn signum(self) -> N;
        pub fn is_positive(self) -> bool;
        pub fn is_negative(self) -> bool;
        pub fn unsigned_abs(self) -> Unsigned<N>;
        pub fn saturating_neg(self) -> N;
        pub fn saturating_abs(self) -> N;
        pub fn overflowing_abs(self) -> (N, bool);
        pub fn checked_isqrt(self) -> Option<N>;
        pub fn cast_unsigned(self) -> Unsigned<N>;
    }
    impl<N: UnsignedInteger> N {
        pub fn is_power_of_two(self) -> bool;
        pub fn next_power_of_two(self) -> N;
        pub fn checked_next_power_of_two(self) -> Option<N>;
        pub fn div_ceil(self, rhs: N) -> N;
        pub fn is_multiple_of(self, rhs: N) -> bool;
        pub fn next_multiple_of(self, rhs: N) -> N;
        pub fn checked_next_multiple_of(self, rhs: N) -> Option<N>;
        pub fn checked_add_signed(self, rhs: Signed<N>) -> Option<N>;
        pub fn wrapping_add_signed(self, rhs: Signed<N>) -> N;
        pub fn saturating_add_signed(self, rhs: Signed<N>) -> N;
        pub fn cast_signed(self) -> Signed<N>;
    }
    impl<N: Integer> N {
        pub fn pow(self, exp: u32) -> N;
        pub fn checked_add(self, rhs: N) -> Option<N>;
        pub fn checked_sub(self, rhs: N) -> Option<N>;
        pub fn checked_mul(self, rhs: N) -> Option<N>;
        pub fn checked_div(self, rhs: N) -> Option<N>;
        pub fn checked_rem(self, rhs: N) -> Option<N>;
        pub fn checked_pow(self, exp: u32) -> Option<N>;
        pub fn checked_neg(self) -> Option<N>;
        pub fn wrapping_add(self, rhs: N) -> N;
        pub fn wrapping_sub(self, rhs: N) -> N;
        pub fn wrapping_mul(self, rhs: N) -> N;
        pub fn wrapping_div(self, rhs: N) -> N;
        pub fn wrapping_rem(self, rhs: N) -> N;
        pub fn wrapping_neg(self) -> N;
        pub fn wrapping_pow(self, exp: u32) -> N;
        pub fn saturating_add(self, rhs: N) -> N;
        pub fn saturating_sub(self, rhs: N) -> N;
        pub fn saturating_mul(self, rhs: N) -> N;
        pub fn saturating_pow(self, exp: u32) -> N;
        pub fn overflowing_add(self, rhs: N) -> (N, bool);
        pub fn overflowing_sub(self, rhs: N) -> (N, bool);
        pub fn overflowing_mul(self, rhs: N) -> (N, bool);
        pub fn overflowing_div(self, rhs: N) -> (N, bool);
        pub fn overflowing_rem(self, rhs: N) -> (N, bool);
        pub fn overflowing_neg(self) -> (N, bool);
        pub fn overflowing_pow(self, exp: u32) -> (N, bool);
        pub fn overflowing_shl(self, rhs: u32) -> (N, bool);
        pub fn overflowing_shr(self, rhs: u32) -> (N, bool);
        pub fn checked_shl(self, rhs: u32) -> Option<N>;
        pub fn checked_shr(self, rhs: u32) -> Option<N>;
        pub fn wrapping_shl(self, rhs: u32) -> N;
        pub fn wrapping_shr(self, rhs: u32) -> N;
        pub fn checked_div_euclid(self, rhs: N) -> Option<N>;
        pub fn checked_rem_euclid(self, rhs: N) -> Option<N>;
        pub fn wrapping_div_euclid(self, rhs: N) -> N;
        pub fn wrapping_rem_euclid(self, rhs: N) -> N;
        pub fn saturating_div(self, rhs: N) -> N;
        pub fn checked_ilog2(self) -> Option<u32>;
        pub fn checked_ilog10(self) -> Option<u32>;
        pub fn checked_ilog(self, base: N) -> Option<u32>;
        pub fn leading_ones(self) -> u32;
        pub fn trailing_ones(self) -> u32;
        pub fn rem_euclid(self, rhs: N) -> N;
        pub fn div_euclid(self, rhs: N) -> N;
        pub fn count_ones(self) -> u32;
        pub fn count_zeros(self) -> u32;
        pub fn leading_zeros(self) -> u32;
        pub fn trailing_zeros(self) -> u32;
        pub fn abs_diff(self, other: N) -> Unsigned<N>;
        pub fn isqrt(self) -> N;
        pub fn ilog2(self) -> u32;
        pub fn ilog10(self) -> u32;
        pub fn ilog(self, base: N) -> u32;
        pub fn from_str_radix(src: &str, radix: u32) -> Result<N, ParseIntError>;
        pub fn max_value() -> N;
        pub fn min_value() -> N;
        pub fn swap_bytes(self) -> N;
        pub fn reverse_bits(self) -> N;
        pub fn rotate_left(self, n: u32) -> N;
        pub fn rotate_right(self, n: u32) -> N;
        pub fn midpoint(self, rhs: N) -> N;
    }
    impl<F: Float> F {
        pub fn sqrt(self) -> F;
        pub fn cbrt(self) -> F;
        pub fn powi(self, n: i32) -> F;
        pub fn powf(self, n: F) -> F;
        pub fn abs(self) -> F;
        pub fn floor(self) -> F;
        pub fn ceil(self) -> F;
        pub fn round(self) -> F;
        pub fn round_ties_even(self) -> F;
        pub fn trunc(self) -> F;
        pub fn fract(self) -> F;
        pub fn sin(self) -> F;
        pub fn cos(self) -> F;
        pub fn tan(self) -> F;
        pub fn asin(self) -> F;
        pub fn acos(self) -> F;
        pub fn atan(self) -> F;
        pub fn atan2(self, other: F) -> F;
        pub fn sinh(self) -> F;
        pub fn cosh(self) -> F;
        pub fn tanh(self) -> F;
        pub fn exp(self) -> F;
        pub fn exp2(self) -> F;
        pub fn ln(self) -> F;
        pub fn log10(self) -> F;
        pub fn log2(self) -> F;
        pub fn log(self, base: F) -> F;
        pub fn hypot(self, other: F) -> F;
        pub fn min(self, other: F) -> F;
        pub fn max(self, other: F) -> F;
        pub fn clamp(self, min: F, max: F) -> F;
        pub fn is_nan(self) -> bool;
        pub fn is_infinite(self) -> bool;
        pub fn is_finite(self) -> bool;
        pub fn signum(self) -> F;
        pub fn is_sign_positive(self) -> bool;
        pub fn is_sign_negative(self) -> bool;
        pub fn to_degrees(self) -> F;
        pub fn to_radians(self) -> F;
        pub fn mul_add(self, a: F, b: F) -> F;
        pub fn recip(self) -> F;
        pub fn total_cmp(&self, other: &F) -> Ordering;
        pub fn rem_euclid(self, rhs: F) -> F;
        pub fn div_euclid(self, rhs: F) -> F;
        pub fn copysign(self, sign: F) -> F;
    }
    impl bool {
        pub fn then<T, F: FnOnce() -> T>(self, f: F) -> Option<T>;
        pub fn then_some<T>(self, t: T) -> Option<T>;
    }
}
pub mod option {
    #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
    pub enum Option<T> { None, Some(T) }
    impl Option<String> {
        pub fn as_deref(&self) -> Option<&str>;
        pub fn as_deref_mut(&mut self) -> Option<&mut str>;
    }
    impl<T> Option<Vec<T>> {
        pub fn as_deref(&self) -> Option<&[T]>;
    }
    impl<T> Option<Box<T>> {
        pub fn as_deref(&self) -> Option<&T>;
    }
    impl<T> Option<T> {
        pub fn is_some(&self) -> bool;
        pub fn is_none(&self) -> bool;
        pub fn is_some_and<F: FnOnce(T) -> bool>(self, f: F) -> bool;
        pub fn is_none_or<F: FnOnce(T) -> bool>(self, f: F) -> bool;
        pub fn unwrap(self) -> T;
        pub fn expect(self, msg: &str) -> T;
        pub fn unwrap_or(self, default: T) -> T;
        pub fn unwrap_or_else<F: FnOnce() -> T>(self, f: F) -> T;
        pub fn unwrap_or_default(self) -> T where T: Default;
        pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Option<U>;
        pub fn map_or<U, F: FnOnce(T) -> U>(self, default: U, f: F) -> U;
        pub fn map_or_else<U, D: FnOnce() -> U, F: FnOnce(T) -> U>(self, default: D, f: F) -> U;
        pub fn inspect<F: FnOnce(&T)>(self, f: F) -> Option<T>;
        pub fn and_then<U, F: FnOnce(T) -> Option<U>>(self, f: F) -> Option<U>;
        pub fn and<U>(self, optb: Option<U>) -> Option<U>;
        pub fn or(self, optb: Option<T>) -> Option<T>;
        pub fn or_else<F: FnOnce() -> Option<T>>(self, f: F) -> Option<T>;
        pub fn xor(self, optb: Option<T>) -> Option<T>;
        pub fn filter<P: FnOnce(&T) -> bool>(self, predicate: P) -> Option<T>;
        pub fn ok_or<E>(self, err: E) -> Result<T, E>;
        pub fn ok_or_else<E, F: FnOnce() -> E>(self, err: F) -> Result<T, E>;
        pub fn take(&mut self) -> Option<T>;
        pub fn replace(&mut self, value: T) -> Option<T>;
        pub fn insert(&mut self, value: T) -> &mut T;
        pub fn get_or_insert(&mut self, value: T) -> &mut T;
        pub fn get_or_insert_with<F: FnOnce() -> T>(&mut self, f: F) -> &mut T;
        pub fn as_ref(&self) -> Option<&T>;
        pub fn as_mut(&mut self) -> Option<&mut T>;
        pub fn iter(&self) -> Iter<&T>;
        pub fn zip<U>(self, other: Option<U>) -> Option<(T, U)>;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> Option<&T> {
        pub fn copied(self) -> Option<T> where T: Copy;
        pub fn cloned(self) -> Option<T> where T: Clone;
    }
    impl<T> Option<&mut T> {
        pub fn copied(self) -> Option<T> where T: Copy;
        pub fn cloned(self) -> Option<T> where T: Clone;
    }
    impl<T> Option<Option<T>> {
        pub fn flatten(self) -> Option<T>;
    }
    impl<T, E> Option<Result<T, E>> {
        pub fn transpose(self) -> Result<Option<T>, E>;
    }
}
pub mod result {
    #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
    pub enum Result<T, E> { Ok(T), Err(E) }
    impl<T, E> Result<T, E> {
        pub fn is_ok(&self) -> bool;
        pub fn is_err(&self) -> bool;
        pub fn is_ok_and<F: FnOnce(T) -> bool>(self, f: F) -> bool;
        pub fn is_err_and<F: FnOnce(E) -> bool>(self, f: F) -> bool;
        pub fn unwrap(self) -> T where E: Debug;
        pub fn expect(self, msg: &str) -> T where E: Debug;
        pub fn unwrap_err(self) -> E where T: Debug;
        pub fn expect_err(self, msg: &str) -> E where T: Debug;
        pub fn unwrap_or(self, default: T) -> T;
        pub fn unwrap_or_else<F: FnOnce(E) -> T>(self, op: F) -> T;
        pub fn unwrap_or_default(self) -> T where T: Default;
        pub fn map<U, F: FnOnce(T) -> U>(self, op: F) -> Result<U, E>;
        pub fn map_or<U, F: FnOnce(T) -> U>(self, default: U, f: F) -> U;
        pub fn map_err<F2, O: FnOnce(E) -> F2>(self, op: O) -> Result<T, F2>;
        pub fn inspect<F: FnOnce(&T)>(self, f: F) -> Result<T, E>;
        pub fn and_then<U, F: FnOnce(T) -> Result<U, E>>(self, op: F) -> Result<U, E>;
        pub fn and<U>(self, res: Result<U, E>) -> Result<U, E>;
        pub fn or<F2>(self, res: Result<T, F2>) -> Result<T, F2>;
        pub fn or_else<F2, O: FnOnce(E) -> Result<T, F2>>(self, op: O) -> Result<T, F2>;
        pub fn ok(self) -> Option<T>;
        pub fn err(self) -> Option<E>;
        pub fn as_ref(&self) -> Result<&T, &E>;
        pub fn as_mut(&mut self) -> Result<&mut T, &mut E>;
        pub fn iter(&self) -> Iter<&T>;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T, E> Result<&T, E> {
        pub fn copied(self) -> Result<T, E> where T: Copy;
        pub fn cloned(self) -> Result<T, E> where T: Clone;
    }
    impl<T, E> Result<Option<T>, E> {
        pub fn transpose(self) -> Option<Result<T, E>>;
    }
}
pub mod boxed {
    pub struct Box<T>;
    impl<T> Box<T> {
        pub fn new(x: T) -> Box<T>;
        pub fn as_ref(&self) -> &T;
        pub fn as_mut(&mut self) -> &mut T;
    }
}
pub mod convert {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Infallible {}
    pub trait From<T> { fn from(value: T) -> Self; }
    pub trait Into<T> { fn into(self) -> T; }
    pub trait TryFrom<T> { fn try_from(value: T) -> Result<Self, TryFromIntError>; }
    pub trait TryInto<T> { fn try_into(self) -> Result<T, TryFromIntError>; }
    pub trait AsRef<T> {}
    pub fn identity<T>(x: T) -> T;
}
pub mod error {
    pub trait Error: Debug + Display {}
}
pub mod iter {
    pub struct Iter<T>;
    pub trait Iterator {}
    pub trait IntoIterator {}
    pub trait FromIterator<A> {}
    pub trait Extend<A> {}
    pub trait Sum<A> {}
    pub trait Product<A> {}
    pub trait DoubleEndedIterator {}
    pub trait ExactSizeIterator {}
    impl<T> Iter<T> {
        pub fn next(&mut self) -> Option<T>;
        pub fn next_back(&mut self) -> Option<T>;
        pub fn map<B, F: FnMut(T) -> B>(self, f: F) -> Iter<B>;
        pub fn filter<P: FnMut(&T) -> bool>(self, predicate: P) -> Iter<T>;
        pub fn filter_map<B, F: FnMut(T) -> Option<B>>(self, f: F) -> Iter<B>;
        pub fn flat_map<U, F: FnMut(T) -> Iter<U>>(self, f: F) -> Iter<U>;
        pub fn map_while<B, P: FnMut(T) -> Option<B>>(self, predicate: P) -> Iter<B>;
        pub fn enumerate(self) -> Iter<(usize, T)>;
        pub fn zip<U>(self, other: Iter<U>) -> Iter<(T, U)>;
        pub fn chain(self, other: Iter<T>) -> Iter<T>;
        pub fn rev(self) -> Iter<T>;
        pub fn take(self, n: usize) -> Iter<T>;
        pub fn skip(self, n: usize) -> Iter<T>;
        pub fn take_while<P: FnMut(&T) -> bool>(self, predicate: P) -> Iter<T>;
        pub fn skip_while<P: FnMut(&T) -> bool>(self, predicate: P) -> Iter<T>;
        pub fn step_by(self, step: usize) -> Iter<T>;
        pub fn peekable(self) -> Iter<T>;
        pub fn peek(&mut self) -> Option<&T>;
        pub fn next_if<F: FnOnce(&T) -> bool>(&mut self, func: F) -> Option<T>;
        pub fn fuse(self) -> Iter<T>;
        pub fn inspect<F: FnMut(&T)>(self, f: F) -> Iter<T>;
        pub fn cycle(self) -> Iter<T> where T: Clone;
        pub fn scan<St, B, F: FnMut(&mut St, T) -> Option<B>>(self, initial_state: St, f: F) -> Iter<B>;
        pub fn by_ref(&mut self) -> Iter<T>;
        pub fn collect<B: FromIterator<T>>(self) -> B;
        pub fn sum<S: Sum<T>>(self) -> S;
        pub fn product<P: Product<T>>(self) -> P;
        pub fn count(self) -> usize;
        pub fn len(&self) -> usize;
        pub fn last(self) -> Option<T>;
        pub fn nth(&mut self, n: usize) -> Option<T>;
        pub fn fold<B, F: FnMut(B, T) -> B>(self, init: B, f: F) -> B;
        pub fn reduce<F: FnMut(T, T) -> T>(self, f: F) -> Option<T>;
        pub fn for_each<F: FnMut(T)>(self, f: F);
        pub fn any<F: FnMut(T) -> bool>(&mut self, f: F) -> bool;
        pub fn all<F: FnMut(T) -> bool>(&mut self, f: F) -> bool;
        pub fn find<P: FnMut(&T) -> bool>(&mut self, predicate: P) -> Option<T>;
        pub fn find_map<B, F: FnMut(T) -> Option<B>>(&mut self, f: F) -> Option<B>;
        pub fn position<P: FnMut(T) -> bool>(&mut self, predicate: P) -> Option<usize>;
        pub fn rposition<P: FnMut(T) -> bool>(&mut self, predicate: P) -> Option<usize>;
        pub fn max(self) -> Option<T> where T: Ord;
        pub fn min(self) -> Option<T> where T: Ord;
        pub fn max_by_key<B: Ord, F: FnMut(&T) -> B>(self, f: F) -> Option<T>;
        pub fn min_by_key<B: Ord, F: FnMut(&T) -> B>(self, f: F) -> Option<T>;
        pub fn max_by<F: FnMut(&T, &T) -> Ordering>(self, compare: F) -> Option<T>;
        pub fn min_by<F: FnMut(&T, &T) -> Ordering>(self, compare: F) -> Option<T>;
        pub fn partition<B: Extend<T>, F: FnMut(&T) -> bool>(self, f: F) -> (B, B);
        pub fn eq(self, other: Iter<T>) -> bool where T: PartialEq;
        pub fn is_sorted(self) -> bool where T: PartialOrd;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> Iter<&T> {
        pub fn copied(self) -> Iter<T> where T: Copy;
        pub fn cloned(self) -> Iter<T> where T: Clone;
    }
    impl<T> Iter<&mut T> {
        pub fn copied(self) -> Iter<T> where T: Copy;
        pub fn cloned(self) -> Iter<T> where T: Clone;
    }
    impl Iter<char> {
        pub fn as_str(&self) -> &str;
    }
    impl<A, B> Iter<(A, B)> {
        pub fn unzip<FromA: FromIterator<A>, FromB: FromIterator<B>>(self) -> (FromA, FromB);
    }
    impl<T> Iter<Iter<T>> {
        pub fn flatten(self) -> Iter<T>;
    }
    impl<T> Iter<Vec<T>> {
        pub fn flatten(self) -> Iter<T>;
    }
    impl<T> Iter<&Vec<T>> {
        pub fn flatten(self) -> Iter<&T>;
    }
    impl<T> Iter<&Option<T>> {
        pub fn flatten(self) -> Iter<&T>;
    }
    impl<T, E> Iter<&Result<T, E>> {
        pub fn flatten(self) -> Iter<&T>;
    }
    impl<T> Iter<Option<T>> {
        pub fn flatten(self) -> Iter<T>;
    }
    impl<T, E> Iter<Result<T, E>> {
        pub fn flatten(self) -> Iter<T>;
    }
    pub fn repeat<T: Clone>(elt: T) -> Iter<T>;
    pub fn repeat_n<T: Clone>(element: T, count: usize) -> Iter<T>;
    pub fn once<T>(value: T) -> Iter<T>;
    pub fn empty<T>() -> Iter<T>;
    pub fn from_fn<T, F: FnMut() -> Option<T>>(f: F) -> Iter<T>;
    pub fn successors<T, F: FnMut(&T) -> Option<T>>(first: Option<T>, succ: F) -> Iter<T>;
    pub fn zip<A, B>(a: Iter<A>, b: Iter<B>) -> Iter<(A, B)>;
}
pub mod collections {
    pub struct HashMap<K, V>;
    pub struct HashSet<T>;
    pub struct BTreeMap<K, V>;
    pub struct BTreeSet<T>;
    pub struct VecDeque<T>;
    pub struct BinaryHeap<T>;
    pub mod hash_map {
        pub struct Entry<K, V>;
        pub use super::HashMap;
    }
    pub mod btree_map {
        pub use super::hash_map::Entry;
        pub use super::BTreeMap;
    }
    impl<K, V> HashMap<K, V> {
        pub fn new() -> HashMap<K, V>;
        pub fn with_capacity(capacity: usize) -> HashMap<K, V>;
        pub fn insert(&mut self, k: K, v: V) -> Option<V> where K: Eq + Hash;
        pub fn get<Q>(&self, k: &Q) -> Option<&V> where K: Borrow<Q>;
        pub fn get_mut<Q>(&mut self, k: &Q) -> Option<&mut V> where K: Borrow<Q>;
        pub fn get_key_value<Q>(&self, k: &Q) -> Option<(&K, &V)> where K: Borrow<Q>;
        pub fn contains_key<Q>(&self, k: &Q) -> bool where K: Borrow<Q>;
        pub fn remove<Q>(&mut self, k: &Q) -> Option<V> where K: Borrow<Q>;
        pub fn remove_entry<Q>(&mut self, k: &Q) -> Option<(K, V)> where K: Borrow<Q>;
        pub fn entry(&mut self, key: K) -> Entry<K, V> where K: Eq + Hash;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> Iter<(&K, &V)>;
        pub fn iter_mut(&mut self) -> Iter<(&K, &mut V)>;
        pub fn keys(&self) -> Iter<&K>;
        pub fn values(&self) -> Iter<&V>;
        pub fn values_mut(&mut self) -> Iter<&mut V>;
        pub fn into_keys(self) -> Iter<K>;
        pub fn into_values(self) -> Iter<V>;
        pub fn drain(&mut self) -> Iter<(K, V)>;
        pub fn retain<F: FnMut(&K, &mut V) -> bool>(&mut self, f: F);
        pub fn extend(&mut self, iter: Iter<(K, V)>) where K: Eq + Hash;
        pub fn capacity(&self) -> usize;
        pub fn into_iter(self) -> Iter<(K, V)>;
    }
    impl<K, V> &HashMap<K, V> {
        pub fn into_iter(self) -> Iter<(&K, &V)>;
    }
    impl<K, V> &mut HashMap<K, V> {
        pub fn into_iter(self) -> Iter<(&K, &mut V)>;
    }
    impl<K, V> BTreeMap<K, V> {
        pub fn range<R: RangeBounds<K>>(&self, range: R) -> Iter<(&K, &V)>;
        pub fn new() -> BTreeMap<K, V>;
        pub fn insert(&mut self, k: K, v: V) -> Option<V> where K: Ord;
        pub fn get<Q>(&self, k: &Q) -> Option<&V> where K: Borrow<Q>;
        pub fn get_mut<Q>(&mut self, k: &Q) -> Option<&mut V> where K: Borrow<Q>;
        pub fn get_key_value<Q>(&self, k: &Q) -> Option<(&K, &V)> where K: Borrow<Q>;
        pub fn contains_key<Q>(&self, k: &Q) -> bool where K: Borrow<Q>;
        pub fn remove<Q>(&mut self, k: &Q) -> Option<V> where K: Borrow<Q>;
        pub fn entry(&mut self, key: K) -> Entry<K, V> where K: Ord;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> Iter<(&K, &V)>;
        pub fn iter_mut(&mut self) -> Iter<(&K, &mut V)>;
        pub fn keys(&self) -> Iter<&K>;
        pub fn values(&self) -> Iter<&V>;
        pub fn values_mut(&mut self) -> Iter<&mut V>;
        pub fn into_keys(self) -> Iter<K>;
        pub fn into_values(self) -> Iter<V>;
        pub fn first_key_value(&self) -> Option<(&K, &V)>;
        pub fn last_key_value(&self) -> Option<(&K, &V)>;
        pub fn pop_first(&mut self) -> Option<(K, V)>;
        pub fn pop_last(&mut self) -> Option<(K, V)>;
        pub fn retain<F: FnMut(&K, &mut V) -> bool>(&mut self, f: F);
        pub fn extend(&mut self, iter: Iter<(K, V)>) where K: Ord;
        pub fn into_iter(self) -> Iter<(K, V)>;
    }
    impl<K, V> &BTreeMap<K, V> {
        pub fn into_iter(self) -> Iter<(&K, &V)>;
    }
    impl<K, V> &mut BTreeMap<K, V> {
        pub fn into_iter(self) -> Iter<(&K, &mut V)>;
    }
    impl<K, V> Entry<K, V> {
        pub fn or_insert(self, default: V) -> &mut V;
        pub fn or_insert_with<F: FnOnce() -> V>(self, default: F) -> &mut V;
        pub fn or_insert_with_key<F: FnOnce(&K) -> V>(self, default: F) -> &mut V;
        pub fn or_default(self) -> &mut V where V: Default;
        pub fn and_modify<F: FnOnce(&mut V)>(self, f: F) -> Entry<K, V>;
        pub fn key(&self) -> &K;
    }
    impl<T> HashSet<T> {
        pub fn new() -> HashSet<T>;
        pub fn with_capacity(capacity: usize) -> HashSet<T>;
        pub fn insert(&mut self, value: T) -> bool where T: Eq + Hash;
        pub fn contains<Q>(&self, value: &Q) -> bool where T: Borrow<Q>;
        pub fn remove<Q>(&mut self, value: &Q) -> bool where T: Borrow<Q>;
        pub fn take<Q>(&mut self, value: &Q) -> Option<T> where T: Borrow<Q>;
        pub fn get<Q>(&self, value: &Q) -> Option<&T> where T: Borrow<Q>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> Iter<&T>;
        pub fn union<'a>(&'a self, other: &'a HashSet<T>) -> Iter<&'a T>;
        pub fn intersection<'a>(&'a self, other: &'a HashSet<T>) -> Iter<&'a T>;
        pub fn difference<'a>(&'a self, other: &'a HashSet<T>) -> Iter<&'a T>;
        pub fn symmetric_difference<'a>(&'a self, other: &'a HashSet<T>) -> Iter<&'a T>;
        pub fn is_subset(&self, other: &HashSet<T>) -> bool;
        pub fn is_superset(&self, other: &HashSet<T>) -> bool;
        pub fn is_disjoint(&self, other: &HashSet<T>) -> bool;
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn extend<A: ExtendInto<T>>(&mut self, iter: Iter<A>) where T: Eq + Hash;
        pub fn drain(&mut self) -> Iter<T>;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> &HashSet<T> {
        pub fn into_iter(self) -> Iter<&T>;
    }
    impl<T> BTreeSet<T> {
        pub fn range<R: RangeBounds<T>>(&self, range: R) -> Iter<&T>;
        pub fn new() -> BTreeSet<T>;
        pub fn insert(&mut self, value: T) -> bool where T: Ord;
        pub fn contains<Q>(&self, value: &Q) -> bool where T: Borrow<Q>;
        pub fn remove<Q>(&mut self, value: &Q) -> bool where T: Borrow<Q>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> Iter<&T>;
        pub fn first(&self) -> Option<&T>;
        pub fn last(&self) -> Option<&T>;
        pub fn pop_first(&mut self) -> Option<T>;
        pub fn pop_last(&mut self) -> Option<T>;
        pub fn union<'a>(&'a self, other: &'a BTreeSet<T>) -> Iter<&'a T>;
        pub fn intersection<'a>(&'a self, other: &'a BTreeSet<T>) -> Iter<&'a T>;
        pub fn difference<'a>(&'a self, other: &'a BTreeSet<T>) -> Iter<&'a T>;
        pub fn symmetric_difference<'a>(&'a self, other: &'a BTreeSet<T>) -> Iter<&'a T>;
        pub fn is_subset(&self, other: &BTreeSet<T>) -> bool;
        pub fn is_superset(&self, other: &BTreeSet<T>) -> bool;
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn extend<A: ExtendInto<T>>(&mut self, iter: Iter<A>) where T: Ord;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> &BTreeSet<T> {
        pub fn into_iter(self) -> Iter<&T>;
    }
    impl<T> VecDeque<T> {
        pub fn new() -> VecDeque<T>;
        pub fn with_capacity(capacity: usize) -> VecDeque<T>;
        pub fn push_back(&mut self, value: T);
        pub fn push_front(&mut self, value: T);
        pub fn pop_back(&mut self) -> Option<T>;
        pub fn pop_front(&mut self) -> Option<T>;
        pub fn front(&self) -> Option<&T>;
        pub fn back(&self) -> Option<&T>;
        pub fn front_mut(&mut self) -> Option<&mut T>;
        pub fn back_mut(&mut self) -> Option<&mut T>;
        pub fn get(&self, index: usize) -> Option<&T>;
        pub fn get_mut(&mut self, index: usize) -> Option<&mut T>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn contains(&self, x: &T) -> bool where T: PartialEq;
        pub fn iter(&self) -> Iter<&T>;
        pub fn iter_mut(&mut self) -> Iter<&mut T>;
        pub fn insert(&mut self, index: usize, value: T);
        pub fn remove(&mut self, index: usize) -> Option<T>;
        pub fn extend<A: ExtendInto<T>>(&mut self, iter: Iter<A>);
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn truncate(&mut self, len: usize);
        pub fn swap(&mut self, i: usize, j: usize);
        pub fn rotate_left(&mut self, n: usize);
        pub fn rotate_right(&mut self, n: usize);
        pub fn make_contiguous(&mut self) -> &mut [T];
        pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> Iter<T>;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> &VecDeque<T> {
        pub fn into_iter(self) -> Iter<&T>;
    }
    impl<T> &mut VecDeque<T> {
        pub fn into_iter(self) -> Iter<&mut T>;
    }
    impl<T> BinaryHeap<T> {
        pub fn new() -> BinaryHeap<T>;
        pub fn with_capacity(capacity: usize) -> BinaryHeap<T>;
        pub fn push(&mut self, item: T) where T: Ord;
        pub fn pop(&mut self) -> Option<T> where T: Ord;
        pub fn peek(&self) -> Option<&T>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> Iter<&T>;
        pub fn into_vec(self) -> Vec<T>;
        pub fn into_sorted_vec(self) -> Vec<T> where T: Ord;
        pub fn extend<A: ExtendInto<T>>(&mut self, iter: Iter<A>) where T: Ord;
        pub fn into_iter(self) -> Iter<T>;
    }
    impl<T> &BinaryHeap<T> {
        pub fn into_iter(self) -> Iter<&T>;
    }
}
pub mod mem {
    pub fn swap<T>(x: &mut T, y: &mut T);
    pub fn replace<T>(dest: &mut T, src: T) -> T;
    pub fn take<T: Default>(dest: &mut T) -> T;
    pub fn drop<T>(x: T);
}
pub mod io {
    #[derive(Debug)]
    pub struct Error;
    pub type Result<T> = core::result::Result<T, Error>;
    pub trait Write {}
    pub trait Read {}
    pub trait BufRead {}
}
pub mod process {
    pub fn exit(code: i32) -> !;
}
pub mod f64 {
    pub mod consts {
        pub const PI: f64;
        pub const E: f64;
        pub const TAU: f64;
        pub const SQRT_2: f64;
        pub const LN_2: f64;
        pub const LN_10: f64;
        pub const FRAC_PI_2: f64;
        pub const FRAC_PI_3: f64;
        pub const FRAC_PI_4: f64;
        pub const FRAC_PI_6: f64;
        pub const FRAC_PI_8: f64;
        pub const FRAC_1_PI: f64;
        pub const FRAC_2_PI: f64;
        pub const FRAC_2_SQRT_PI: f64;
        pub const LOG2_10: f64;
        pub const LOG10_2: f64;
        pub const FRAC_1_SQRT_2: f64;
        pub const LOG2_E: f64;
        pub const LOG10_E: f64;
    }
    pub const MAX: f64;
    pub const MIN: f64;
    pub const INFINITY: f64;
    pub const NEG_INFINITY: f64;
    pub const NAN: f64;
    pub const EPSILON: f64;
    pub const MIN_POSITIVE: f64;
}
pub mod f32 {
    pub mod consts {
        pub const PI: f32;
        pub const E: f32;
        pub const TAU: f32;
        pub const SQRT_2: f32;
        pub const LN_2: f32;
        pub const LN_10: f32;
        pub const FRAC_PI_2: f32;
        pub const FRAC_PI_3: f32;
        pub const FRAC_PI_4: f32;
        pub const FRAC_PI_6: f32;
        pub const FRAC_PI_8: f32;
        pub const FRAC_1_PI: f32;
        pub const FRAC_2_PI: f32;
        pub const FRAC_2_SQRT_PI: f32;
        pub const LOG2_10: f32;
        pub const LOG10_2: f32;
        pub const FRAC_1_SQRT_2: f32;
        pub const LOG2_E: f32;
        pub const LOG10_E: f32;
    }
    pub const MAX: f32;
    pub const MIN: f32;
    pub const INFINITY: f32;
    pub const NEG_INFINITY: f32;
    pub const NAN: f32;
    pub const EPSILON: f32;
    pub const MIN_POSITIVE: f32;
}
pub mod dojo {
    pub struct Turtle;
}
pub mod prelude {
    pub use super::option::Option;
    pub use super::option::Option::Some;
    pub use super::option::Option::None;
    pub use super::result::Result;
    pub use super::result::Result::Ok;
    pub use super::result::Result::Err;
    pub use super::vec::Vec;
    pub use super::string::String;
    pub use super::string::ToString;
    pub use super::boxed::Box;
    pub use super::clone::Clone;
    pub use super::marker::Copy;
    pub use super::marker::Send;
    pub use super::marker::Sync;
    pub use super::marker::Sized;
    pub use super::cmp::PartialEq;
    pub use super::cmp::Eq;
    pub use super::cmp::PartialOrd;
    pub use super::cmp::Ord;
    pub use super::default::Default;
    pub use super::iter::Iterator;
    pub use super::iter::IntoIterator;
    pub use super::iter::DoubleEndedIterator;
    pub use super::iter::ExactSizeIterator;
    pub use super::iter::FromIterator;
    pub use super::convert::From;
    pub use super::convert::Into;
    pub use super::convert::TryFrom;
    pub use super::convert::TryInto;
    pub use super::convert::AsRef;
    pub use super::ops::Fn;
    pub use super::ops::FnMut;
    pub use super::ops::FnOnce;
    pub use super::mem::drop;
    pub use super::ops::Drop;
    pub use super::dojo::Turtle;
}
pub mod pseudo {
    pub trait Integer {}
    pub trait SignedInteger {}
    pub trait UnsignedInteger {}
    pub trait SliceIndex {}
    pub trait Float {}
    pub trait Pattern {}
    pub trait Borrow<Q> {}
    pub trait FromStrTarget {}
    pub trait StringPart {}
    pub trait RangeBounds<T> {}
    pub trait ExtendInto<T> {}
    pub struct ParseError<F>;
    pub struct Unsigned<N>;
    pub struct Signed<N>;
    pub struct Indexed<I, T>;
    pub struct Utf8Error;
}
`;
