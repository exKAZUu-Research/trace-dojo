import { collectionKeyTraits } from './collectionBounds';

/**
 * The declarations of the standard library that this interpreter implements, in Rust's syntax. Functions without a
 * body run natively (`natives.ts`), keyed by the impl's self type or trait and the function's name. Builtin types are
 * declared as structs whose values the runtime represents in its own way.
 *
 * Pseudo-traits that rustc does not have stand for groups of types that the natives handle alike: `Integer`,
 * `SignedInteger`, `UnsignedInteger`, `Float`, `Pattern` (what `str::split` and its kin accept), `DoubleEndedPattern` (a `Pattern` but a string), `Borrow` (keys that
 * look up a map), `StringPart`, `RangeBounds`, `ExtendInto` (what a collection of `T` extends from: `T`, or a `&T` it copies), `MapExtendInto` (what a map of `(K, V)` extends from: those, or `(&K, &V)` it copies), `SliceOf` (what borrows as a slice), `JoinSeparator`, and `SliceIndex` (what `<[T]>::get`
 * accepts: a `usize` or a range of them, giving `Indexed<I, T>`, an element or a slice).
 *
 * Every iterator is an `IterImpl<T, S>` of items `T`, whose shape `S` (`CharsShape`, `RevShape<S>`, `MapShape<S, F>`,
 * ...) stands for the iterator type of std: it decides the traits the iterator implements (`DoubleEndedIterator`,
 * `ExactSizeIterator`), and the aliases with std's names (`std::str::Chars`, `std::iter::Peekable<I>`) name it.
 * `TryFromError<S, T>` is the error of `TryFrom<S>` for `T`. `IterItem<I>`, `IterShape<I>`, `IterTarget<I>`, `IntoItem<T>`, and `IntoShape<T>` are the item, the shape, the
 * referent of a reference item, and the item and the shape of the iterator `IntoIterator` makes.
 */
export const STD_SOURCE = String.raw`
pub mod marker {
    pub trait Sized {}
    pub trait Copy: Clone {}
    pub trait Send {}
    pub trait Sync {}
    pub trait Unpin {}
}
pub mod clone {
    pub trait Clone: Sized {
        fn clone(&self) -> Self;
        fn clone_from(&mut self, source: &Self);
    }
}
pub mod borrow {
    pub trait ToOwned { fn to_owned(&self) -> Self; }
}
pub mod default {
    pub trait Default: Sized { fn default() -> Self; }
}
pub mod ops {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub enum Bound<T> { Included(T), Excluded(T), Unbounded }
    pub trait Add<Rhs = Self> { type Output; fn add(self, rhs: Rhs) -> Self::Output; }
    pub trait Sub<Rhs = Self> { type Output; fn sub(self, rhs: Rhs) -> Self::Output; }
    pub trait Mul<Rhs = Self> { type Output; fn mul(self, rhs: Rhs) -> Self::Output; }
    pub trait Div<Rhs = Self> { type Output; fn div(self, rhs: Rhs) -> Self::Output; }
    pub trait Rem<Rhs = Self> { type Output; fn rem(self, rhs: Rhs) -> Self::Output; }
    pub trait BitAnd<Rhs = Self> { type Output; fn bitand(self, rhs: Rhs) -> Self::Output; }
    pub trait BitOr<Rhs = Self> { type Output; fn bitor(self, rhs: Rhs) -> Self::Output; }
    pub trait BitXor<Rhs = Self> { type Output; fn bitxor(self, rhs: Rhs) -> Self::Output; }
    pub trait Shl<Rhs = Self> { type Output; fn shl(self, rhs: Rhs) -> Self::Output; }
    pub trait Shr<Rhs = Self> { type Output; fn shr(self, rhs: Rhs) -> Self::Output; }
    pub trait Neg { type Output; fn neg(self) -> Self::Output; }
    pub trait Not { type Output; fn not(self) -> Self::Output; }
    pub trait AddAssign<Rhs = Self> { fn add_assign(&mut self, rhs: Rhs); }
    pub trait SubAssign<Rhs = Self> { fn sub_assign(&mut self, rhs: Rhs); }
    pub trait MulAssign<Rhs = Self> { fn mul_assign(&mut self, rhs: Rhs); }
    pub trait DivAssign<Rhs = Self> { fn div_assign(&mut self, rhs: Rhs); }
    pub trait RemAssign<Rhs = Self> { fn rem_assign(&mut self, rhs: Rhs); }
    pub trait BitAndAssign<Rhs = Self> { fn bitand_assign(&mut self, rhs: Rhs); }
    pub trait BitOrAssign<Rhs = Self> { fn bitor_assign(&mut self, rhs: Rhs); }
    pub trait BitXorAssign<Rhs = Self> { fn bitxor_assign(&mut self, rhs: Rhs); }
    pub trait ShlAssign<Rhs = Self> { fn shl_assign(&mut self, rhs: Rhs); }
    pub trait ShrAssign<Rhs = Self> { fn shr_assign(&mut self, rhs: Rhs); }
    pub trait Index<Idx> { type Output; fn index(&self, index: Idx) -> &Self::Output; }
    pub trait IndexMut<Idx>: Index<Idx> { fn index_mut(&mut self, index: Idx) -> &mut Self::Output; }
    pub trait Deref { type Target; fn deref(&self) -> &Self::Target; }
    pub trait DerefMut: Deref { fn deref_mut(&mut self) -> &mut Self::Target; }
    pub trait Drop { fn drop(&mut self); }
    pub trait Fn {}
    pub trait FnMut {}
    pub trait FnOnce {}
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ControlFlow<B, C = ()> { Continue(C), Break(B) }
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
    }
    impl<Idx> RangeInclusive<Idx> {
        pub fn contains(&self, item: &Idx) -> bool where Idx: PartialOrd;
        pub fn is_empty(&self) -> bool where Idx: PartialOrd;
    }
}
pub mod cmp {
    pub trait PartialEq<Rhs = Self> {
        fn eq(&self, other: &Rhs) -> bool;
        fn ne(&self, other: &Rhs) -> bool;
    }
    pub trait Eq: PartialEq {}
    pub trait PartialOrd<Rhs = Self>: PartialEq<Rhs> {
        fn partial_cmp(&self, other: &Rhs) -> Option<Ordering>;
        fn lt(&self, other: &Rhs) -> bool;
        fn le(&self, other: &Rhs) -> bool;
        fn gt(&self, other: &Rhs) -> bool;
        fn ge(&self, other: &Rhs) -> bool;
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
    pub fn max_by<T, F: FnMut(&T, &T) -> Ordering>(v1: T, v2: T, compare: F) -> T;
    pub fn min_by<T, F: FnMut(&T, &T) -> Ordering>(v1: T, v2: T, compare: F) -> T;
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
    impl Write for String {}
    pub struct DebugStruct<'a>;
    pub struct DebugTuple<'a>;
    pub struct DebugList<'a>;
    pub struct DebugSet<'a>;
    pub struct DebugMap<'a>;
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
        pub fn entries<T: Debug, S>(&mut self, entries: IterImpl<T, S>) -> &mut DebugList;
        pub fn finish(&mut self) -> Result;
    }
    impl DebugSet {
        pub fn entry(&mut self, entry: &dyn Debug) -> &mut DebugSet;
        pub fn entries<T: Debug, S>(&mut self, entries: IterImpl<T, S>) -> &mut DebugSet;
        pub fn finish(&mut self) -> Result;
    }
    impl DebugMap {
        pub fn entry(&mut self, key: &dyn Debug, value: &dyn Debug) -> &mut DebugMap;
        pub fn entries<K: Debug, V: Debug, S>(&mut self, entries: IterImpl<(K, V), S>) -> &mut DebugMap;
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
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct FromUtf8Error { bytes: Vec<u8>, error: Utf8Error }
    impl FromUtf8Error {
        pub fn as_bytes(&self) -> &[u8];
        pub fn into_bytes(self) -> Vec<u8>;
        pub fn into_utf8_lossy(self) -> String;
        pub fn utf8_error(&self) -> Utf8Error;
    }
    pub trait ToString { fn to_string(&self) -> String; }
    impl String {
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub const fn new() -> String;
        pub fn with_capacity(capacity: usize) -> String;
        pub fn from_utf8(vec: Vec<u8>) -> Result<String, FromUtf8Error>;
        pub fn from_iter<P: StringPart, S>(iter: IterImpl<P, S>) -> String;
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
        pub fn reserve_exact(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
        pub fn shrink_to(&mut self, min_capacity: usize);
        pub fn as_str(&self) -> &str;
        pub fn as_mut_str(&mut self) -> &mut str;
        pub fn into_bytes(self) -> Vec<u8>;
        pub fn into_boxed_str(self) -> Box<str>;
        pub fn retain<F: FnMut(char) -> bool>(&mut self, f: F);
        pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> IterImpl<char, StringDrainShape>;
        pub fn split_off(&mut self, at: usize) -> String;
        pub fn replace_range<R: RangeBounds<usize>>(&mut self, range: R, replace_with: &str);
        pub fn extend<I, S>(&mut self, iter: IterImpl<I, S>) where I: StringPart;
    }
}
pub mod vec {
    pub type IntoIter<T> = IterImpl<T, VecIntoIterShape<T>>;
    pub type Drain<'a, T> = IterImpl<'a, T, VecDrainShape>;
    pub struct Vec<T>;
    impl<T> Vec<T> {
        pub fn from_iter<S>(iter: IterImpl<T, S>) -> Vec<T>;
        pub const fn new() -> Vec<T>;
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
        pub fn reserve_exact(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
        pub fn shrink_to(&mut self, min_capacity: usize);
        pub fn extend<A: ExtendInto<T>, S>(&mut self, iter: IterImpl<A, S>);
        pub fn extend_from_slice(&mut self, other: &[T]) where T: Clone;
        pub fn append(&mut self, other: &mut Vec<T>);
        pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> IterImpl<T, VecDrainShape>;
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn retain_mut<F: FnMut(&mut T) -> bool>(&mut self, f: F);
        pub fn dedup(&mut self) where T: PartialEq;
        pub fn dedup_by_key<K: PartialEq, F: FnMut(&mut T) -> K>(&mut self, key: F);
        pub fn dedup_by<F: FnMut(&mut T, &mut T) -> bool>(&mut self, same_bucket: F);
        pub fn resize(&mut self, new_len: usize, value: T) where T: Clone;
        pub fn resize_with<F: FnMut() -> T>(&mut self, new_len: usize, f: F);
        pub fn split_off(&mut self, at: usize) -> Vec<T>;
        pub fn as_slice(&self) -> &[T];
        pub fn as_mut_slice(&mut self) -> &mut [T];
        pub fn into_boxed_slice(self) -> Box<[T]>;
        pub fn is_empty(&self) -> bool;
        pub fn len(&self) -> usize;
    }
    impl<T> Vec<T> {
        pub fn into_iter(self) -> IterImpl<T, VecIntoIterShape<T>>;
    }
    impl<T> &Vec<T> {
        pub fn into_iter(self) -> IterImpl<&T, SliceIterShape>;
    }
    impl<T> &mut Vec<T> {
        pub fn into_iter(self) -> IterImpl<&mut T, SliceIterMutShape>;
    }
}
pub mod slice {
    pub type Iter<'a, T> = IterImpl<'a, &'a T, SliceIterShape>;
    pub type IterMut<'a, T> = IterImpl<'a, &'a mut T, SliceIterMutShape>;
    pub type Windows<'a, T> = IterImpl<'a, &'a [T], WindowsShape>;
    pub type Chunks<'a, T> = IterImpl<'a, &'a [T], ChunksShape>;
    impl<T> [T] {
        pub fn as_ptr(&self) -> super::ptr::ConstPtr<T>;
        pub fn as_mut_ptr(&mut self) -> super::ptr::MutPtr<T>;
        pub const fn len(&self) -> usize;
        pub const fn is_empty(&self) -> bool;
        pub fn first(&self) -> Option<&T>;
        pub fn last(&self) -> Option<&T>;
        pub fn first_mut(&mut self) -> Option<&mut T>;
        pub fn last_mut(&mut self) -> Option<&mut T>;
        pub fn get<I: SliceIndex>(&self, index: I) -> Option<&Indexed<I, T>>;
        pub fn get_mut<I: SliceIndex>(&mut self, index: I) -> Option<&mut Indexed<I, T>>;
        pub fn iter(&self) -> IterImpl<&T, SliceIterShape>;
        pub fn iter_mut(&mut self) -> IterImpl<&mut T, SliceIterMutShape>;
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
        pub fn partition_point<F: FnMut(&T) -> bool>(&self, predicate: F) -> usize;
        pub fn swap(&mut self, a: usize, b: usize);
        pub fn split_at(&self, mid: usize) -> (&[T], &[T]);
        pub fn split_at_mut(&mut self, mid: usize) -> (&mut [T], &mut [T]);
        pub fn split_first(&self) -> Option<(&T, &[T])>;
        pub fn split_last(&self) -> Option<(&T, &[T])>;
        pub fn split_first_mut(&mut self) -> Option<(&mut T, &mut [T])>;
        pub fn split_last_mut(&mut self) -> Option<(&mut T, &mut [T])>;
        pub fn windows(&self, size: usize) -> IterImpl<&[T], WindowsShape>;
        pub fn split<F: FnMut(&T) -> bool>(&self, predicate: F) -> IterImpl<&[T], SliceSplitShape<F>>;
        pub fn splitn<F: FnMut(&T) -> bool>(&self, n: usize, predicate: F) -> IterImpl<&[T], SliceSplitNShape<F>>;
        pub fn rsplitn<F: FnMut(&T) -> bool>(&self, n: usize, predicate: F) -> IterImpl<&[T], SliceSplitNShape<F>>;
        pub fn chunk_by<F: FnMut(&T, &T) -> bool>(&self, predicate: F) -> IterImpl<&[T], ChunkByShape<F>>;
        pub fn chunks(&self, chunk_size: usize) -> IterImpl<&[T], ChunksShape>;
        pub fn rchunks(&self, chunk_size: usize) -> IterImpl<&[T], RChunksShape>;
        pub fn chunks_exact(&self, chunk_size: usize) -> IterImpl<&[T], ChunksExactShape>;
        pub fn rchunks_exact(&self, chunk_size: usize) -> IterImpl<&[T], RChunksExactShape>;
        pub fn chunks_mut(&mut self, chunk_size: usize) -> IterImpl<&mut [T], ChunksMutShape>;
        pub fn chunks_exact_mut(&mut self, chunk_size: usize) -> IterImpl<&mut [T], ChunksExactMutShape>;
        pub fn rchunks_mut(&mut self, chunk_size: usize) -> IterImpl<&mut [T], RChunksMutShape>;
        pub fn rchunks_exact_mut(&mut self, chunk_size: usize) -> IterImpl<&mut [T], RChunksExactMutShape>;
        pub fn copy_within<R: RangeBounds<usize>>(&mut self, src: R, dest: usize) where T: Copy;
        pub fn fill(&mut self, value: T) where T: Clone;
        pub fn to_vec(&self) -> Vec<T> where T: Clone;
        pub fn to_owned(&self) -> Vec<T> where T: Clone;
        pub fn into_vec(self) -> Vec<T>;
        pub fn rotate_left(&mut self, mid: usize);
        pub fn rotate_right(&mut self, mid: usize);
        pub fn copy_from_slice(&mut self, src: &[T]) where T: Copy;
        pub fn clone_from_slice(&mut self, src: &[T]) where T: Clone;
        pub fn repeat(&self, n: usize) -> Vec<T> where T: Copy;
    }
    impl<T> [T] {
        pub fn into_iter(self) -> IterImpl<T, ArrayIntoIterShape<T>>;
        pub fn map<U, F: FnMut(T) -> U>(self, f: F) -> [U];
    }
    impl<T> &[T] {
        pub fn into_iter(self) -> IterImpl<&T, SliceIterShape>;
    }
    impl<T> &mut [T] {
        pub fn into_iter(self) -> IterImpl<&mut T, SliceIterMutShape>;
    }
    impl [String] {
        pub fn join(&self, sep: &str) -> String;
        pub fn concat(&self) -> String;
    }
    impl [&str] {
        pub fn join(&self, sep: &str) -> String;
        pub fn concat(&self) -> String;
    }
    impl<T, V: SliceOf<T>> [V] {
        pub fn concat(&self) -> Vec<T> where T: Clone;
        pub fn join<P: JoinSeparator<T>>(&self, sep: P) -> Vec<T> where T: Clone;
    }
}
pub mod str {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Utf8Error { valid_up_to: usize, error_len: Option<u8> }
    impl Utf8Error {
        pub const fn valid_up_to(&self) -> usize;
        pub const fn error_len(&self) -> Option<usize>;
    }
    pub fn from_utf8(v: &[u8]) -> Result<&str, Utf8Error>;
    pub type Chars<'a> = IterImpl<'a, char, CharsShape>;
    pub type CharIndices<'a> = IterImpl<'a, (usize, char), CharIndicesShape>;
    pub type Bytes<'a> = IterImpl<'a, u8, BytesShape>;
    pub type SplitWhitespace<'a> = IterImpl<'a, &'a str, SplitWhitespaceShape>;
    pub type Lines<'a> = IterImpl<'a, &'a str, LinesShape>;
    pub type Split<'a, P> = IterImpl<'a, &'a str, SplitShape<P>>;
    pub trait FromStr: Sized { fn from_str(s: &str) -> Result<Self, ParseError<Self>>; }
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseBoolError;
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseCharError;
    impl str {
        pub const fn len(&self) -> usize;
        pub const fn is_empty(&self) -> bool;
        pub fn chars(&self) -> IterImpl<char, CharsShape>;
        pub fn bytes(&self) -> IterImpl<u8, BytesShape>;
        pub fn char_indices(&self) -> IterImpl<(usize, char), CharIndicesShape>;
        pub fn as_bytes(&self) -> &[u8];
        pub fn trim(&self) -> &str;
        pub fn trim_start(&self) -> &str;
        pub fn trim_end(&self) -> &str;
        pub fn trim_matches<P: DoubleEndedPattern>(&self, pat: P) -> &str;
        pub fn trim_start_matches<P: Pattern>(&self, pat: P) -> &str;
        pub fn trim_end_matches<P: Pattern>(&self, pat: P) -> &str;
        pub fn strip_prefix<P: Pattern>(&self, prefix: P) -> Option<&str>;
        pub fn strip_suffix<P: Pattern>(&self, suffix: P) -> Option<&str>;
        pub fn split_whitespace(&self) -> IterImpl<&str, SplitWhitespaceShape>;
        pub fn split_ascii_whitespace(&self) -> IterImpl<&str, SplitWhitespaceShape>;
        pub fn lines(&self) -> IterImpl<&str, LinesShape>;
        pub fn split<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn rsplit<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn split_terminator<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn rsplit_terminator<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn split_inclusive<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn splitn<P: Pattern>(&self, n: usize, pat: P) -> IterImpl<&str, SplitNShape<P>>;
        pub fn rsplitn<P: Pattern>(&self, n: usize, pat: P) -> IterImpl<&str, SplitNShape<P>>;
        pub fn split_once<P: Pattern>(&self, delimiter: P) -> Option<(&str, &str)>;
        pub fn rsplit_once<P: Pattern>(&self, delimiter: P) -> Option<(&str, &str)>;
        pub fn split_at(&self, mid: usize) -> (&str, &str);
        pub fn contains<P: Pattern>(&self, pat: P) -> bool;
        pub fn starts_with<P: Pattern>(&self, pat: P) -> bool;
        pub fn ends_with<P: Pattern>(&self, pat: P) -> bool;
        pub fn find<P: Pattern>(&self, pat: P) -> Option<usize>;
        pub fn rfind<P: Pattern>(&self, pat: P) -> Option<usize>;
        pub fn matches<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn rmatches<P: Pattern>(&self, pat: P) -> IterImpl<&str, SplitShape<P>>;
        pub fn match_indices<P: Pattern>(&self, pat: P) -> IterImpl<(usize, &str), SplitShape<P>>;
        pub fn rmatch_indices<P: Pattern>(&self, pat: P) -> IterImpl<(usize, &str), SplitShape<P>>;
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
        pub fn parse<F: FromStr>(&self) -> Result<F, ParseError<F>>;
        pub fn to_owned(&self) -> String;
        pub fn is_char_boundary(&self, index: usize) -> bool;
        pub fn get<R: RangeBounds<usize>>(&self, range: R) -> Option<&str>;
        pub fn is_ascii(&self) -> bool;
        pub fn into_string(self) -> String;
    }
}
pub mod char {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct CharTryFromError;
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TryFromCharError;
    impl u8 {
        pub const fn is_ascii(&self) -> bool;
        pub const fn is_ascii_digit(&self) -> bool;
        pub const fn is_ascii_hexdigit(&self) -> bool;
        pub const fn is_ascii_alphabetic(&self) -> bool;
        pub const fn is_ascii_alphanumeric(&self) -> bool;
        pub const fn is_ascii_uppercase(&self) -> bool;
        pub const fn is_ascii_lowercase(&self) -> bool;
        pub const fn is_ascii_punctuation(&self) -> bool;
        pub const fn is_ascii_whitespace(&self) -> bool;
        pub const fn is_ascii_graphic(&self) -> bool;
        pub const fn is_ascii_control(&self) -> bool;
        pub const fn to_ascii_uppercase(&self) -> u8;
        pub const fn to_ascii_lowercase(&self) -> u8;
        pub fn make_ascii_uppercase(&mut self);
        pub fn make_ascii_lowercase(&mut self);
        pub const fn eq_ignore_ascii_case(&self, other: &u8) -> bool;
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
        pub const fn is_ascii(&self) -> bool;
        pub const fn is_ascii_digit(&self) -> bool;
        pub const fn is_ascii_hexdigit(&self) -> bool;
        pub const fn is_ascii_alphabetic(&self) -> bool;
        pub const fn is_ascii_alphanumeric(&self) -> bool;
        pub const fn is_ascii_uppercase(&self) -> bool;
        pub const fn is_ascii_lowercase(&self) -> bool;
        pub const fn is_ascii_punctuation(&self) -> bool;
        pub const fn is_ascii_whitespace(&self) -> bool;
        pub const fn is_ascii_graphic(&self) -> bool;
        pub const fn is_ascii_control(&self) -> bool;
        pub const fn to_ascii_uppercase(&self) -> char;
        pub const fn to_ascii_lowercase(&self) -> char;
        pub fn make_ascii_uppercase(&mut self);
        pub fn make_ascii_lowercase(&mut self);
        pub const fn eq_ignore_ascii_case(&self, other: &char) -> bool;
        pub fn to_uppercase(self) -> CaseIter;
        pub fn to_lowercase(self) -> CaseIter;
        pub fn escape_default(self) -> EscapeDefault;
        pub fn escape_unicode(self) -> EscapeUnicode;
        pub fn to_digit(self, radix: u32) -> Option<u32>;
        pub fn len_utf8(self) -> usize;
        pub fn len_utf16(self) -> usize;
        pub fn from_u32(i: u32) -> Option<char>;
        pub fn from_digit(num: u32, radix: u32) -> Option<char>;
    }
    pub fn from_u32(i: u32) -> Option<char>;
    pub fn from_digit(num: u32, radix: u32) -> Option<char>;
    pub struct CaseIter;
    pub struct EscapeDefault;
    pub struct EscapeUnicode;
}
pub mod array {
    pub struct TryFromSliceError;
}

pub mod num {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseIntError;
    impl ParseIntError {
        pub fn kind(&self) -> &IntErrorKind;
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum IntErrorKind {
        Empty,
        InvalidDigit,
        PosOverflow,
        NegOverflow,
        Zero,
    }
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ParseFloatError;
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TryFromIntError;
    impl i8 {
        pub const fn to_be_bytes(self) -> [u8; 1];
        pub const fn to_le_bytes(self) -> [u8; 1];
        pub const fn to_ne_bytes(self) -> [u8; 1];
        pub const fn from_be_bytes(bytes: [u8; 1]) -> i8;
        pub const fn from_le_bytes(bytes: [u8; 1]) -> i8;
        pub const fn from_ne_bytes(bytes: [u8; 1]) -> i8;
    }
    impl i16 {
        pub const fn to_be_bytes(self) -> [u8; 2];
        pub const fn to_le_bytes(self) -> [u8; 2];
        pub const fn to_ne_bytes(self) -> [u8; 2];
        pub const fn from_be_bytes(bytes: [u8; 2]) -> i16;
        pub const fn from_le_bytes(bytes: [u8; 2]) -> i16;
        pub const fn from_ne_bytes(bytes: [u8; 2]) -> i16;
    }
    impl i32 {
        pub const fn to_be_bytes(self) -> [u8; 4];
        pub const fn to_le_bytes(self) -> [u8; 4];
        pub const fn to_ne_bytes(self) -> [u8; 4];
        pub const fn from_be_bytes(bytes: [u8; 4]) -> i32;
        pub const fn from_le_bytes(bytes: [u8; 4]) -> i32;
        pub const fn from_ne_bytes(bytes: [u8; 4]) -> i32;
    }
    impl i64 {
        pub const fn to_be_bytes(self) -> [u8; 8];
        pub const fn to_le_bytes(self) -> [u8; 8];
        pub const fn to_ne_bytes(self) -> [u8; 8];
        pub const fn from_be_bytes(bytes: [u8; 8]) -> i64;
        pub const fn from_le_bytes(bytes: [u8; 8]) -> i64;
        pub const fn from_ne_bytes(bytes: [u8; 8]) -> i64;
    }
    impl i128 {
        pub const fn to_be_bytes(self) -> [u8; 16];
        pub const fn to_le_bytes(self) -> [u8; 16];
        pub const fn to_ne_bytes(self) -> [u8; 16];
        pub const fn from_be_bytes(bytes: [u8; 16]) -> i128;
        pub const fn from_le_bytes(bytes: [u8; 16]) -> i128;
        pub const fn from_ne_bytes(bytes: [u8; 16]) -> i128;
    }
    impl isize {
        pub const fn to_be_bytes(self) -> [u8; 8];
        pub const fn to_le_bytes(self) -> [u8; 8];
        pub const fn to_ne_bytes(self) -> [u8; 8];
        pub const fn from_be_bytes(bytes: [u8; 8]) -> isize;
        pub const fn from_le_bytes(bytes: [u8; 8]) -> isize;
        pub const fn from_ne_bytes(bytes: [u8; 8]) -> isize;
    }
    impl u8 {
        pub const fn to_be_bytes(self) -> [u8; 1];
        pub const fn to_le_bytes(self) -> [u8; 1];
        pub const fn to_ne_bytes(self) -> [u8; 1];
        pub const fn from_be_bytes(bytes: [u8; 1]) -> u8;
        pub const fn from_le_bytes(bytes: [u8; 1]) -> u8;
        pub const fn from_ne_bytes(bytes: [u8; 1]) -> u8;
    }
    impl u16 {
        pub const fn to_be_bytes(self) -> [u8; 2];
        pub const fn to_le_bytes(self) -> [u8; 2];
        pub const fn to_ne_bytes(self) -> [u8; 2];
        pub const fn from_be_bytes(bytes: [u8; 2]) -> u16;
        pub const fn from_le_bytes(bytes: [u8; 2]) -> u16;
        pub const fn from_ne_bytes(bytes: [u8; 2]) -> u16;
    }
    impl u32 {
        pub const fn to_be_bytes(self) -> [u8; 4];
        pub const fn to_le_bytes(self) -> [u8; 4];
        pub const fn to_ne_bytes(self) -> [u8; 4];
        pub const fn from_be_bytes(bytes: [u8; 4]) -> u32;
        pub const fn from_le_bytes(bytes: [u8; 4]) -> u32;
        pub const fn from_ne_bytes(bytes: [u8; 4]) -> u32;
    }
    impl u64 {
        pub const fn to_be_bytes(self) -> [u8; 8];
        pub const fn to_le_bytes(self) -> [u8; 8];
        pub const fn to_ne_bytes(self) -> [u8; 8];
        pub const fn from_be_bytes(bytes: [u8; 8]) -> u64;
        pub const fn from_le_bytes(bytes: [u8; 8]) -> u64;
        pub const fn from_ne_bytes(bytes: [u8; 8]) -> u64;
    }
    impl u128 {
        pub const fn to_be_bytes(self) -> [u8; 16];
        pub const fn to_le_bytes(self) -> [u8; 16];
        pub const fn to_ne_bytes(self) -> [u8; 16];
        pub const fn from_be_bytes(bytes: [u8; 16]) -> u128;
        pub const fn from_le_bytes(bytes: [u8; 16]) -> u128;
        pub const fn from_ne_bytes(bytes: [u8; 16]) -> u128;
    }
    impl usize {
        pub const fn to_be_bytes(self) -> [u8; 8];
        pub const fn to_le_bytes(self) -> [u8; 8];
        pub const fn to_ne_bytes(self) -> [u8; 8];
        pub const fn from_be_bytes(bytes: [u8; 8]) -> usize;
        pub const fn from_le_bytes(bytes: [u8; 8]) -> usize;
        pub const fn from_ne_bytes(bytes: [u8; 8]) -> usize;
    }
    impl<N: SignedInteger> N {
        pub const fn abs(self) -> N;
        pub const fn checked_abs(self) -> Option<N>;
        pub const fn wrapping_abs(self) -> N;
        pub const fn signum(self) -> N;
        pub const fn is_positive(self) -> bool;
        pub const fn is_negative(self) -> bool;
        pub const fn unsigned_abs(self) -> Unsigned<N>;
        pub const fn saturating_neg(self) -> N;
        pub const fn saturating_abs(self) -> N;
        pub const fn overflowing_abs(self) -> (N, bool);
        pub const fn checked_isqrt(self) -> Option<N>;
        pub const fn cast_unsigned(self) -> Unsigned<N>;
    }
    impl<N: UnsignedInteger> N {
        pub const fn is_power_of_two(self) -> bool;
        pub const fn next_power_of_two(self) -> N;
        pub const fn checked_next_power_of_two(self) -> Option<N>;
        pub const fn div_ceil(self, rhs: N) -> N;
        pub const fn is_multiple_of(self, rhs: N) -> bool;
        pub const fn next_multiple_of(self, rhs: N) -> N;
        pub const fn checked_next_multiple_of(self, rhs: N) -> Option<N>;
        pub const fn checked_add_signed(self, rhs: Signed<N>) -> Option<N>;
        pub const fn wrapping_add_signed(self, rhs: Signed<N>) -> N;
        pub const fn saturating_add_signed(self, rhs: Signed<N>) -> N;
        pub const fn cast_signed(self) -> Signed<N>;
    }
    impl<N: Integer> N {
        pub const fn pow(self, exp: u32) -> N;
        pub const fn checked_add(self, rhs: N) -> Option<N>;
        pub const fn checked_sub(self, rhs: N) -> Option<N>;
        pub const fn checked_mul(self, rhs: N) -> Option<N>;
        pub const fn checked_div(self, rhs: N) -> Option<N>;
        pub const fn checked_rem(self, rhs: N) -> Option<N>;
        pub const fn checked_pow(self, exp: u32) -> Option<N>;
        pub const fn checked_neg(self) -> Option<N>;
        pub const fn wrapping_add(self, rhs: N) -> N;
        pub const fn wrapping_sub(self, rhs: N) -> N;
        pub const fn wrapping_mul(self, rhs: N) -> N;
        pub const fn wrapping_div(self, rhs: N) -> N;
        pub const fn wrapping_rem(self, rhs: N) -> N;
        pub const fn wrapping_neg(self) -> N;
        pub const fn wrapping_pow(self, exp: u32) -> N;
        pub const fn saturating_add(self, rhs: N) -> N;
        pub const fn saturating_sub(self, rhs: N) -> N;
        pub const fn saturating_mul(self, rhs: N) -> N;
        pub const fn saturating_pow(self, exp: u32) -> N;
        pub const fn overflowing_add(self, rhs: N) -> (N, bool);
        pub const fn overflowing_sub(self, rhs: N) -> (N, bool);
        pub const fn overflowing_mul(self, rhs: N) -> (N, bool);
        pub const fn overflowing_div(self, rhs: N) -> (N, bool);
        pub const fn overflowing_rem(self, rhs: N) -> (N, bool);
        pub const fn overflowing_neg(self) -> (N, bool);
        pub const fn overflowing_pow(self, exp: u32) -> (N, bool);
        pub const fn overflowing_shl(self, rhs: u32) -> (N, bool);
        pub const fn overflowing_shr(self, rhs: u32) -> (N, bool);
        pub const fn checked_shl(self, rhs: u32) -> Option<N>;
        pub const fn checked_shr(self, rhs: u32) -> Option<N>;
        pub const fn wrapping_shl(self, rhs: u32) -> N;
        pub const fn wrapping_shr(self, rhs: u32) -> N;
        pub const fn checked_div_euclid(self, rhs: N) -> Option<N>;
        pub const fn checked_rem_euclid(self, rhs: N) -> Option<N>;
        pub const fn wrapping_div_euclid(self, rhs: N) -> N;
        pub const fn wrapping_rem_euclid(self, rhs: N) -> N;
        pub const fn saturating_div(self, rhs: N) -> N;
        pub const fn checked_ilog2(self) -> Option<u32>;
        pub const fn checked_ilog10(self) -> Option<u32>;
        pub const fn checked_ilog(self, base: N) -> Option<u32>;
        pub const fn leading_ones(self) -> u32;
        pub const fn trailing_ones(self) -> u32;
        pub const fn rem_euclid(self, rhs: N) -> N;
        pub const fn div_euclid(self, rhs: N) -> N;
        pub const fn count_ones(self) -> u32;
        pub const fn count_zeros(self) -> u32;
        pub const fn leading_zeros(self) -> u32;
        pub const fn trailing_zeros(self) -> u32;
        pub const fn abs_diff(self, other: N) -> Unsigned<N>;
        pub const fn isqrt(self) -> N;
        pub const fn ilog2(self) -> u32;
        pub const fn ilog10(self) -> u32;
        pub const fn ilog(self, base: N) -> u32;
        pub const fn from_str_radix(src: &str, radix: u32) -> Result<N, ParseIntError>;
        pub const fn max_value() -> N;
        pub const fn min_value() -> N;
        pub const fn swap_bytes(self) -> N;
        pub const fn reverse_bits(self) -> N;
        pub const fn rotate_left(self, n: u32) -> N;
        pub const fn rotate_right(self, n: u32) -> N;
        pub const fn midpoint(self, rhs: N) -> N;
    }
    impl<F: Float> F {
        pub fn sqrt(self) -> F;
        pub fn cbrt(self) -> F;
        pub fn powi(self, n: i32) -> F;
        pub fn powf(self, n: F) -> F;
        pub const fn abs(self) -> F;
        pub const fn floor(self) -> F;
        pub const fn ceil(self) -> F;
        pub const fn round(self) -> F;
        pub const fn round_ties_even(self) -> F;
        pub const fn trunc(self) -> F;
        pub const fn fract(self) -> F;
        pub fn sin(self) -> F;
        pub fn cos(self) -> F;
        pub fn sin_cos(self) -> (F, F);
        pub const fn to_bits(self) -> Unsigned<F>;
        pub const fn from_bits(bits: Unsigned<F>) -> F;
        pub fn tan(self) -> F;
        pub fn asin(self) -> F;
        pub fn acos(self) -> F;
        pub fn atan(self) -> F;
        pub fn atan2(self, other: F) -> F;
        pub fn sinh(self) -> F;
        pub fn cosh(self) -> F;
        pub fn tanh(self) -> F;
        pub fn asinh(self) -> F;
        pub fn acosh(self) -> F;
        pub fn atanh(self) -> F;
        pub fn exp_m1(self) -> F;
        pub fn ln_1p(self) -> F;
        pub fn exp(self) -> F;
        pub fn exp2(self) -> F;
        pub fn ln(self) -> F;
        pub fn log10(self) -> F;
        pub fn log2(self) -> F;
        pub fn log(self, base: F) -> F;
        pub fn hypot(self, other: F) -> F;
        pub const fn min(self, other: F) -> F;
        pub const fn max(self, other: F) -> F;
        pub const fn clamp(self, min: F, max: F) -> F;
        pub const fn is_nan(self) -> bool;
        pub const fn is_infinite(self) -> bool;
        pub const fn is_finite(self) -> bool;
        pub const fn signum(self) -> F;
        pub const fn is_sign_positive(self) -> bool;
        pub const fn is_sign_negative(self) -> bool;
        pub const fn to_degrees(self) -> F;
        pub const fn to_radians(self) -> F;
        pub const fn mul_add(self, a: F, b: F) -> F;
        pub const fn recip(self) -> F;
        pub fn total_cmp(&self, other: &F) -> Ordering;
        pub fn rem_euclid(self, rhs: F) -> F;
        pub fn div_euclid(self, rhs: F) -> F;
        pub const fn copysign(self, sign: F) -> F;
        pub const fn midpoint(self, other: F) -> F;
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
        pub fn as_deref_mut(&mut self) -> Option<&mut [T]>;
    }
    impl<T> Option<Box<T>> {
        pub fn as_deref(&self) -> Option<&T>;
        pub fn as_deref_mut(&mut self) -> Option<&mut T>;
    }
    impl<T, U> Option<(T, U)> {
        pub fn unzip(self) -> (Option<T>, Option<U>);
    }
    impl<T> Option<T> {
        pub const fn is_some(&self) -> bool;
        pub const fn is_none(&self) -> bool;
        pub fn is_some_and<F: FnOnce(T) -> bool>(self, f: F) -> bool;
        pub fn is_none_or<F: FnOnce(T) -> bool>(self, f: F) -> bool;
        pub const fn unwrap(self) -> T;
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
        pub fn take_if<P: FnOnce(&mut T) -> bool>(&mut self, predicate: P) -> Option<T>;
        pub fn replace(&mut self, value: T) -> Option<T>;
        pub fn insert(&mut self, value: T) -> &mut T;
        pub fn get_or_insert(&mut self, value: T) -> &mut T;
        pub fn get_or_insert_with<F: FnOnce() -> T>(&mut self, f: F) -> &mut T;
        pub const fn as_ref(&self) -> Option<&T>;
        pub const fn as_mut(&mut self) -> Option<&mut T>;
        pub fn iter(&self) -> IterImpl<&T, OptionIterShape<&T>>;
        pub fn iter_mut(&mut self) -> IterImpl<&mut T, OptionIterShape<&mut T>>;
        pub fn zip<U>(self, other: Option<U>) -> Option<(T, U)>;
        pub fn into_iter(self) -> IterImpl<T, OptionIterShape<T>>;
    }
    impl<'a, T> &'a Option<T> {
        pub fn into_iter(self) -> IterImpl<&'a T, OptionIterShape<&'a T>>;
    }
    impl<'a, T> &'a mut Option<T> {
        pub fn into_iter(self) -> IterImpl<&'a mut T, OptionIterShape<&'a mut T>>;
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
        pub const fn is_ok(&self) -> bool;
        pub const fn is_err(&self) -> bool;
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
        pub fn map_or_else<U, D: FnOnce(E) -> U, F: FnOnce(T) -> U>(self, default: D, f: F) -> U;
        pub fn map_err<F2, O: FnOnce(E) -> F2>(self, op: O) -> Result<T, F2>;
        pub fn inspect<F: FnOnce(&T)>(self, f: F) -> Result<T, E>;
        pub fn inspect_err<F: FnOnce(&E)>(self, f: F) -> Result<T, E>;
        pub fn and_then<U, F: FnOnce(T) -> Result<U, E>>(self, op: F) -> Result<U, E>;
        pub fn and<U>(self, res: Result<U, E>) -> Result<U, E>;
        pub fn or<F2>(self, res: Result<T, F2>) -> Result<T, F2>;
        pub fn or_else<F2, O: FnOnce(E) -> Result<T, F2>>(self, op: O) -> Result<T, F2>;
        pub fn ok(self) -> Option<T>;
        pub fn err(self) -> Option<E>;
        pub const fn as_ref(&self) -> Result<&T, &E>;
        pub const fn as_mut(&mut self) -> Result<&mut T, &mut E>;
        pub fn iter(&self) -> IterImpl<&T, OptionIterShape<&T>>;
        pub fn iter_mut(&mut self) -> IterImpl<&mut T, OptionIterShape<&mut T>>;
        pub fn into_iter(self) -> IterImpl<T, OptionIterShape<T>>;
    }
    impl<'a, T, E> &'a Result<T, E> {
        pub fn into_iter(self) -> IterImpl<&'a T, OptionIterShape<&'a T>>;
    }
    impl<'a, T, E> &'a mut Result<T, E> {
        pub fn into_iter(self) -> IterImpl<&'a mut T, OptionIterShape<&'a mut T>>;
    }
    impl<T, E> Result<&T, E> {
        pub fn copied(self) -> Result<T, E> where T: Copy;
        pub fn cloned(self) -> Result<T, E> where T: Clone;
    }
    impl<T, E> Result<Option<T>, E> {
        pub fn transpose(self) -> Option<Result<T, E>>;
    }
}
pub mod ptr {
    pub struct ConstPtr<T>;
    pub struct MutPtr<T>;
    pub fn null<T>() -> ConstPtr<T>;
    pub fn null_mut<T>() -> MutPtr<T>;
    impl<T> ConstPtr<T> {
        pub unsafe fn add(self, count: usize) -> ConstPtr<T>;
        pub unsafe fn sub(self, count: usize) -> ConstPtr<T>;
        pub unsafe fn offset(self, count: isize) -> ConstPtr<T>;
        pub fn is_null(self) -> bool;
        pub unsafe fn read(self) -> T;
        pub unsafe fn as_ref(self) -> Option<&T>;
    }
    impl<T> MutPtr<T> {
        pub unsafe fn add(self, count: usize) -> MutPtr<T>;
        pub unsafe fn sub(self, count: usize) -> MutPtr<T>;
        pub unsafe fn offset(self, count: isize) -> MutPtr<T>;
        pub fn is_null(self) -> bool;
        pub unsafe fn read(self) -> T;
        pub unsafe fn write(self, value: T);
        pub unsafe fn as_ref(self) -> Option<&T>;
        pub unsafe fn as_mut(self) -> Option<&mut T>;
    }
    impl<T> ConstPtr<[T]> { pub fn len(self) -> usize; pub fn is_empty(self) -> bool; }
    impl<T> MutPtr<[T]> { pub fn len(self) -> usize; pub fn is_empty(self) -> bool; }
}
pub mod rc {
    pub struct Rc<T>;
    impl<T> Rc<T> {
        pub fn new(value: T) -> Rc<T>;
        pub fn strong_count(this: &Rc<T>) -> usize;
        pub fn weak_count(this: &Rc<T>) -> usize;
        pub fn downgrade(this: &Rc<T>) -> Weak<T>;
        pub fn ptr_eq(this: &Rc<T>, other: &Rc<T>) -> bool;
        pub fn try_unwrap(this: Rc<T>) -> Result<T, Rc<T>>;
        pub fn into_inner(this: Rc<T>) -> Option<T>;
        pub fn get_mut(this: &mut Rc<T>) -> Option<&mut T>;
        pub fn make_mut(this: &mut Rc<T>) -> &mut T where T: Clone;
        pub fn unwrap_or_clone(this: Rc<T>) -> T where T: Clone;
        pub fn as_ref(&self) -> &T;
    }
    impl<'a> From<&'a str> for Rc<str> { fn from(text: &str) -> Rc<str>; }
    impl From<String> for Rc<str> { fn from(text: String) -> Rc<str>; }
    impl<T> From<Vec<T>> for Rc<[T]> { fn from(items: Vec<T>) -> Rc<[T]>; }
    pub struct Weak<T>;
    impl<T> Weak<T> {
        pub fn new() -> Weak<T>;
        pub fn upgrade(&self) -> Option<Rc<T>>;
        pub fn strong_count(&self) -> usize;
        pub fn weak_count(&self) -> usize;
        pub fn ptr_eq(&self, other: &Weak<T>) -> bool;
    }
}
pub mod cell {
    pub struct RefCell<T>;
    impl<T> RefCell<T> {
        pub fn new(value: T) -> RefCell<T>;
        pub fn borrow(&self) -> Ref<T>;
        pub fn borrow_mut(&self) -> RefMut<T>;
        pub fn replace(&self, t: T) -> T;
        pub fn replace_with<F: FnOnce(&mut T) -> T>(&self, f: F) -> T;
        pub fn take(&self) -> T where T: Default;
        pub fn into_inner(self) -> T;
        pub fn get_mut(&mut self) -> &mut T;
        pub fn swap(&self, other: &RefCell<T>);
    }
    pub struct Ref<T>;
    impl<T> Ref<T> {
        pub fn clone(orig: &Ref<T>) -> Ref<T>;
    }
    pub struct RefMut<T>;
    pub struct Cell<T>;
    impl<T> Cell<T> {
        pub fn new(value: T) -> Cell<T>;
        pub fn get(&self) -> T where T: Copy;
        pub fn set(&self, val: T);
        pub fn replace(&self, val: T) -> T;
        pub fn take(&self) -> T where T: Default;
        pub fn into_inner(self) -> T;
        pub fn get_mut(&mut self) -> &mut T;
        pub fn swap(&self, other: &Cell<T>);
        pub fn update<F: FnOnce(T) -> T>(&self, f: F) where T: Copy;
    }
}
pub mod boxed {
    pub struct Box<T>;
    impl<T> Box<T> {
        pub fn new(x: T) -> Box<T>;
        pub fn pin(x: T) -> super::pin::Pin<Box<T>>;
        pub fn into_pin(boxed: Box<T>) -> super::pin::Pin<Box<T>>;
        pub fn as_ref(&self) -> &T;
        pub fn as_mut(&mut self) -> &mut T;
    }
    impl<T> Box<[T]> {
        pub fn into_vec(self) -> Vec<T>;
    }
    impl Box<str> {
        pub fn into_string(self) -> String;
    }
}
pub mod convert {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Infallible {}
    pub trait From<T>: Sized { fn from(value: T) -> Self; }
    pub trait Into<T>: Sized { fn into(self) -> T; }
    pub trait TryFrom<T>: Sized { fn try_from(value: T) -> Result<Self, TryFromError<T, Self>>; }
    pub trait TryInto<T>: Sized { fn try_into(self) -> Result<T, TryFromError<Self, T>>; }
    pub trait AsRef<T> { fn as_ref(&self) -> &T; }
    pub fn identity<T>(x: T) -> T;
}
pub mod error {
    pub trait Error: Debug + Display {}
}
pub mod iter {
    pub struct IterImpl<'a, T, S>;
    pub trait Iterator {
        type Item;
        fn next(&mut self) -> Option<Self::Item>;
        fn size_hint(&self) -> (usize, Option<usize>);
    }
    pub trait IntoIterator {}
    pub trait FromIterator<A>: Sized { fn from_iter<I: IntoIterator<Item = A>>(iter: I) -> Self; }
    pub trait Extend<A> {}
    pub trait Sum<A>: Sized {}
    pub trait Product<A>: Sized {}
    pub trait DoubleEndedIterator: Iterator {}
    pub trait ExactSizeIterator: Iterator {}
    pub trait DoubleEndedSearcher {}
    pub mod shape {
        pub struct SliceIterShape;
        pub struct SliceIterMutShape;
        pub struct VecIntoIterShape<T>;
        pub struct ArrayIntoIterShape<T>;
        pub struct VecDrainShape;
        pub struct StringDrainShape;
        pub struct WindowsShape;
        pub struct SliceSplitShape<F>;
        pub struct SliceSplitNShape<F>;
        pub struct ChunkByShape<F>;
        pub struct ChunksShape;
        pub struct RChunksShape;
        pub struct ChunksExactShape;
        pub struct RChunksExactShape;
        pub struct ChunksMutShape;
        pub struct ChunksExactMutShape;
        pub struct RChunksMutShape;
        pub struct RChunksExactMutShape;
        pub struct CharsShape;
        pub struct BytesShape;
        pub struct DynIteratorShape<D>;
        pub struct IoLinesShape;
        pub struct ReceiverShape;
        pub struct UserIterShape<I>;
        pub struct CharIndicesShape;
        pub struct SplitWhitespaceShape;
        pub struct LinesShape;
        pub struct SplitShape<P>;
        pub struct SplitNShape<P>;
        pub struct OptionIterShape<T>;
        pub struct HashMapIterShape;
        pub struct HashMapIterMutShape;
        pub struct HashMapKeysShape;
        pub struct HashMapValuesShape;
        pub struct HashMapValuesMutShape;
        pub struct HashMapIntoKeysShape;
        pub struct HashMapIntoValuesShape;
        pub struct HashMapDrainShape;
        pub struct HashMapIntoIterShape;
        pub struct HashSetIterShape;
        pub struct HashSetDrainShape;
        pub struct HashSetIntoIterShape;
        pub struct BTreeMapIterShape;
        pub struct BTreeMapIterMutShape;
        pub struct BTreeMapKeysShape;
        pub struct BTreeMapValuesShape;
        pub struct BTreeMapValuesMutShape;
        pub struct BTreeMapIntoKeysShape;
        pub struct BTreeMapIntoValuesShape;
        pub struct BTreeMapIntoIterShape;
        pub struct BTreeMapRangeShape;
        pub struct BTreeSetIterShape;
        pub struct BTreeSetIntoIterShape;
        pub struct BTreeSetRangeShape;
        pub struct SetOpShape;
        pub struct VecDequeIterShape;
        pub struct VecDequeIterMutShape;
        pub struct VecDequeIntoIterShape<T>;
        pub struct VecDequeDrainShape;
        pub struct BinaryHeapIterShape;
        pub struct BinaryHeapIntoIterShape<T>;
        pub struct BinaryHeapDrainShape;
        pub struct RangeShape<Idx>;
        pub struct RangeInclusiveShape<Idx>;
        pub struct RangeFromShape<Idx>;
        pub struct CaseMappingShape;
        pub struct EscapeDefaultShape;
        pub struct RepeatShape<T>;
        pub struct RepeatWithShape<F>;
        pub struct RepeatNShape<T>;
        pub struct OnceShape<T>;
        pub struct EmptyShape;
        pub struct FromFnShape<F>;
        pub struct SuccessorsShape<T, F>;
        pub struct MapShape<S, F>;
        pub struct FilterShape<S, P>;
        pub struct FilterMapShape<S, F>;
        pub struct FlatMapShape<S, U, F>;
        pub struct FlattenShape<S, U>;
        pub struct MapWhileShape<S, P>;
        pub struct EnumerateShape<S>;
        pub struct ZipShape<S, U>;
        pub struct ChainShape<S, U>;
        pub struct RevShape<S>;
        pub struct TakeShape<S>;
        pub struct SkipShape<S>;
        pub struct TakeWhileShape<S, P>;
        pub struct SkipWhileShape<S, P>;
        pub struct StepByShape<S>;
        pub struct PeekableShape<S, T>;
        pub struct FuseShape<S>;
        pub struct InspectShape<S, F>;
        pub struct CycleShape<S>;
        pub struct GenericShuntShape<S>;
        pub struct ScanShape<S, St, F>;
        pub struct ByRefShape<S>;
        pub struct CopiedShape<S>;
        pub struct ClonedShape<S>;
    }
    pub type Rev<I> = IterImpl<IterItem<I>, RevShape<IterShape<I>>>;
    pub type Take<I> = IterImpl<IterItem<I>, TakeShape<IterShape<I>>>;
    pub type Skip<I> = IterImpl<IterItem<I>, SkipShape<IterShape<I>>>;
    pub type StepBy<I> = IterImpl<IterItem<I>, StepByShape<IterShape<I>>>;
    pub type Peekable<I> = IterImpl<IterItem<I>, PeekableShape<IterShape<I>, IterItem<I>>>;
    pub type Fuse<I> = IterImpl<IterItem<I>, FuseShape<IterShape<I>>>;
    pub type Cycle<I> = IterImpl<IterItem<I>, CycleShape<IterShape<I>>>;
    pub type Enumerate<I> = IterImpl<(usize, IterItem<I>), EnumerateShape<IterShape<I>>>;
    pub type Copied<I> = IterImpl<IterTarget<I>, CopiedShape<IterShape<I>>>;
    pub type Cloned<I> = IterImpl<IterTarget<I>, ClonedShape<IterShape<I>>>;
    pub type Zip<A, B> = IterImpl<(IterItem<A>, IterItem<B>), ZipShape<IterShape<A>, IterShape<B>>>;
    pub type Chain<A, B> = IterImpl<IterItem<A>, ChainShape<IterShape<A>, IterShape<B>>>;
    pub type Repeat<A> = IterImpl<A, RepeatShape<A>>;
    pub type RepeatN<A> = IterImpl<A, RepeatNShape<A>>;
    pub type Once<A> = IterImpl<A, OnceShape<A>>;
    pub type Empty<A> = IterImpl<A, EmptyShape>;
    impl<T, S> IterImpl<T, S> {
        pub fn next(&mut self) -> Option<T>;
        pub fn next_back(&mut self) -> Option<T> where S: DoubleEndedIterator;
        pub fn map<B, F: FnMut(T) -> B>(self, f: F) -> IterImpl<B, MapShape<S, F>>;
        pub fn filter<P: FnMut(&T) -> bool>(self, predicate: P) -> IterImpl<T, FilterShape<S, P>>;
        pub fn filter_map<B, F: FnMut(T) -> Option<B>>(self, f: F) -> IterImpl<B, FilterMapShape<S, F>>;
        pub fn flat_map<U: IntoIterator, F: FnMut(T) -> U>(self, f: F) -> IterImpl<IntoItem<U>, FlatMapShape<S, IntoShape<U>, F>>;
        pub fn flatten(self) -> IterImpl<IntoItem<T>, FlattenShape<S, IntoShape<T>>> where T: IntoIterator;
        pub fn map_while<B, P: FnMut(T) -> Option<B>>(self, predicate: P) -> IterImpl<B, MapWhileShape<S, P>>;
        pub fn enumerate(self) -> IterImpl<(usize, T), EnumerateShape<S>>;
        pub fn zip<U, S2>(self, other: IterImpl<U, S2>) -> IterImpl<(T, U), ZipShape<S, S2>>;
        pub fn chain<S2>(self, other: IterImpl<T, S2>) -> IterImpl<T, ChainShape<S, S2>>;
        pub fn rev(self) -> IterImpl<T, RevShape<S>> where S: DoubleEndedIterator;
        pub fn take(self, n: usize) -> IterImpl<T, TakeShape<S>>;
        pub fn skip(self, n: usize) -> IterImpl<T, SkipShape<S>>;
        pub fn take_while<P: FnMut(&T) -> bool>(self, predicate: P) -> IterImpl<T, TakeWhileShape<S, P>>;
        pub fn skip_while<P: FnMut(&T) -> bool>(self, predicate: P) -> IterImpl<T, SkipWhileShape<S, P>>;
        pub fn step_by(self, step: usize) -> IterImpl<T, StepByShape<S>>;
        pub fn peekable(self) -> IterImpl<T, PeekableShape<S, T>>;
        pub fn fuse(self) -> IterImpl<T, FuseShape<S>>;
        pub fn inspect<F: FnMut(&T)>(self, f: F) -> IterImpl<T, InspectShape<S, F>>;
        pub fn cycle(self) -> IterImpl<T, CycleShape<S>> where S: Clone;
        pub fn scan<St, B, F: FnMut(&mut St, T) -> Option<B>>(self, initial_state: St, f: F) -> IterImpl<B, ScanShape<S, St, F>>;
        pub fn by_ref(&mut self) -> IterImpl<T, ByRefShape<S>>;
        pub fn collect<B: FromIterator<T>>(self) -> B;
        pub fn sum<Out: Sum<T>>(self) -> Out;
        pub fn product<Out: Product<T>>(self) -> Out;
        pub fn count(self) -> usize;
        pub fn len(&self) -> usize where S: ExactSizeIterator;
        pub fn last(self) -> Option<T>;
        pub fn nth(&mut self, n: usize) -> Option<T>;
        pub fn nth_back(&mut self, n: usize) -> Option<T> where S: DoubleEndedIterator;
        pub fn fold<B, F: FnMut(B, T) -> B>(self, init: B, f: F) -> B;
        pub fn try_fold<B, R: TryFoldResult<B>, F: FnMut(B, T) -> R>(&mut self, init: B, f: F) -> R;
        pub fn rfold<B, F: FnMut(B, T) -> B>(self, init: B, f: F) -> B where S: DoubleEndedIterator;
        pub fn reduce<F: FnMut(T, T) -> T>(self, f: F) -> Option<T>;
        pub fn for_each<F: FnMut(T)>(self, f: F);
        pub fn any<F: FnMut(T) -> bool>(&mut self, f: F) -> bool;
        pub fn all<F: FnMut(T) -> bool>(&mut self, f: F) -> bool;
        pub fn find<P: FnMut(&T) -> bool>(&mut self, predicate: P) -> Option<T>;
        pub fn rfind<P: FnMut(&T) -> bool>(&mut self, predicate: P) -> Option<T> where S: DoubleEndedIterator;
        pub fn find_map<B, F: FnMut(T) -> Option<B>>(&mut self, f: F) -> Option<B>;
        pub fn position<P: FnMut(T) -> bool>(&mut self, predicate: P) -> Option<usize>;
        pub fn rposition<P: FnMut(T) -> bool>(&mut self, predicate: P) -> Option<usize> where S: DoubleEndedIterator + ExactSizeIterator;
        pub fn max(self) -> Option<T> where T: Ord;
        pub fn min(self) -> Option<T> where T: Ord;
        pub fn max_by_key<B: Ord, F: FnMut(&T) -> B>(self, f: F) -> Option<T>;
        pub fn min_by_key<B: Ord, F: FnMut(&T) -> B>(self, f: F) -> Option<T>;
        pub fn max_by<F: FnMut(&T, &T) -> Ordering>(self, compare: F) -> Option<T>;
        pub fn min_by<F: FnMut(&T, &T) -> Ordering>(self, compare: F) -> Option<T>;
        pub fn partition<B: Extend<T>, F: FnMut(&T) -> bool>(self, f: F) -> (B, B);
        pub fn unzip<A, B, FromA: Default + Extend<A>, FromB: Default + Extend<B>>(self) -> (FromA, FromB) where T: PairOf<A, B>;
        pub fn eq<I: IntoIterator>(self, other: I) -> bool where T: PartialEq<IntoItem<I>>;
        pub fn ne<I: IntoIterator>(self, other: I) -> bool where T: PartialEq<IntoItem<I>>;
        pub fn cmp<S2>(self, other: IterImpl<T, S2>) -> Ordering where T: Ord;
        pub fn partial_cmp<U, S2>(self, other: IterImpl<U, S2>) -> Option<Ordering> where T: PartialOrd<U>;
        pub fn lt<U, S2>(self, other: IterImpl<U, S2>) -> bool where T: PartialOrd<U>;
        pub fn le<U, S2>(self, other: IterImpl<U, S2>) -> bool where T: PartialOrd<U>;
        pub fn gt<U, S2>(self, other: IterImpl<U, S2>) -> bool where T: PartialOrd<U>;
        pub fn ge<U, S2>(self, other: IterImpl<U, S2>) -> bool where T: PartialOrd<U>;
        pub fn is_sorted(self) -> bool where T: PartialOrd;
        pub fn into_iter(self) -> IterImpl<T, S>;
    }
    impl<T, S> IterImpl<T, PeekableShape<S, T>> {
        pub fn peek(&mut self) -> Option<&T>;
        pub fn next_if<F: FnOnce(&T) -> bool>(&mut self, func: F) -> Option<T>;
    }
    impl<T, S> IterImpl<&T, S> {
        pub fn copied(self) -> IterImpl<T, CopiedShape<S>> where T: Copy;
        pub fn cloned(self) -> IterImpl<T, ClonedShape<S>> where T: Clone;
    }
    impl<T, S> IterImpl<&mut T, S> {
        pub fn copied(self) -> IterImpl<T, CopiedShape<S>> where T: Copy;
        pub fn cloned(self) -> IterImpl<T, ClonedShape<S>> where T: Clone;
    }
    impl IterImpl<char, CharsShape> {
        pub fn as_str(&self) -> &str;
    }
    pub fn repeat<T: Clone>(elt: T) -> IterImpl<T, RepeatShape<T>>;
    pub fn repeat_with<T, F: FnMut() -> T>(f: F) -> IterImpl<T, RepeatWithShape<F>>;
    pub fn repeat_n<T: Clone>(element: T, count: usize) -> IterImpl<T, RepeatNShape<T>>;
    pub fn once<T>(value: T) -> IterImpl<T, OnceShape<T>>;
    pub fn empty<T>() -> IterImpl<T, EmptyShape>;
    pub fn from_fn<T, F: FnMut() -> Option<T>>(f: F) -> IterImpl<T, FromFnShape<F>>;
    pub fn successors<T, F: FnMut(&T) -> Option<T>>(first: Option<T>, succ: F) -> IterImpl<T, SuccessorsShape<T, F>>;
    pub fn zip<A, B, SA, SB>(a: IterImpl<A, SA>, b: IterImpl<B, SB>) -> IterImpl<(A, B), ZipShape<SA, SB>>;
}
pub mod collections {
    pub struct HashMap<K, V>;
    pub struct HashSet<T>;
    pub struct BTreeMap<K, V>;
    pub struct BTreeSet<T>;
    pub struct VecDeque<T>;
    pub struct BinaryHeap<T>;
    pub mod hash_map {
        pub type Iter<'a, K, V> = IterImpl<'a, (&'a K, &'a V), HashMapIterShape>;
        pub type IterMut<'a, K, V> = IterImpl<'a, (&'a K, &'a mut V), HashMapIterMutShape>;
        pub type Keys<'a, K, V> = IterImpl<'a, &'a K, HashMapKeysShape>;
        pub type Values<'a, K, V> = IterImpl<'a, &'a V, HashMapValuesShape>;
        pub type IntoIter<K, V> = IterImpl<(K, V), HashMapIntoIterShape>;
        pub struct Entry<'a, K, V> { map: &'a mut HashMap<K, V> }
        pub use super::HashMap;
    }
    pub mod btree_map {
        pub type Iter<'a, K, V> = IterImpl<'a, (&'a K, &'a V), BTreeMapIterShape>;
        pub type IterMut<'a, K, V> = IterImpl<'a, (&'a K, &'a mut V), BTreeMapIterMutShape>;
        pub type Keys<'a, K, V> = IterImpl<'a, &'a K, BTreeMapKeysShape>;
        pub type Values<'a, K, V> = IterImpl<'a, &'a V, BTreeMapValuesShape>;
        pub type IntoIter<K, V> = IterImpl<(K, V), BTreeMapIntoIterShape>;
        pub struct OccupiedEntry<'a, K, V> { map: &'a mut BTreeMap<K, V> }
        pub use super::hash_map::Entry;
        pub use super::BTreeMap;
    }
    use btree_map::OccupiedEntry;

    impl<K, V> HashMap<K, V> {
        pub fn new() -> HashMap<K, V>;
        pub fn with_capacity(capacity: usize) -> HashMap<K, V>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> IterImpl<(&K, &V), HashMapIterShape>;
        pub fn iter_mut(&mut self) -> IterImpl<(&K, &mut V), HashMapIterMutShape>;
        pub fn keys(&self) -> IterImpl<&K, HashMapKeysShape>;
        pub fn values(&self) -> IterImpl<&V, HashMapValuesShape>;
        pub fn values_mut(&mut self) -> IterImpl<&mut V, HashMapValuesMutShape>;
        pub fn into_keys(self) -> IterImpl<K, HashMapIntoKeysShape>;
        pub fn into_values(self) -> IterImpl<V, HashMapIntoValuesShape>;
        pub fn drain(&mut self) -> IterImpl<(K, V), HashMapDrainShape>;
        pub fn retain<F: FnMut(&K, &mut V) -> bool>(&mut self, f: F);
        pub fn capacity(&self) -> usize;
        pub fn into_iter(self) -> IterImpl<(K, V), HashMapIntoIterShape>;
    }
    impl<K: ${collectionKeyTraits('HashMap').join(' + ')}, V> HashMap<K, V> {
        pub fn reserve(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
        pub fn shrink_to(&mut self, min_capacity: usize);
        pub fn insert(&mut self, k: K, v: V) -> Option<V> ;
        pub fn get<Q>(&self, k: &Q) -> Option<&V> where K: Borrow<Q>, Q: Eq + Hash;
        pub fn get_mut<Q>(&mut self, k: &Q) -> Option<&mut V> where K: Borrow<Q>, Q: Eq + Hash;
        pub fn get_key_value<Q>(&self, k: &Q) -> Option<(&K, &V)> where K: Borrow<Q>, Q: Eq + Hash;
        pub fn contains_key<Q>(&self, k: &Q) -> bool where K: Borrow<Q>, Q: Eq + Hash;
        pub fn remove<Q>(&mut self, k: &Q) -> Option<V> where K: Borrow<Q>, Q: Eq + Hash;
        pub fn remove_entry<Q>(&mut self, k: &Q) -> Option<(K, V)> where K: Borrow<Q>, Q: Eq + Hash;
        pub fn entry(&mut self, key: K) -> Entry<K, V> ;
        pub fn extend<A: MapExtendInto<(K, V)>, S>(&mut self, iter: IterImpl<A, S>);
    }
    impl<K, V> &HashMap<K, V> {
        pub fn into_iter(self) -> IterImpl<(&K, &V), HashMapIterShape>;
    }
    impl<K, V> &mut HashMap<K, V> {
        pub fn into_iter(self) -> IterImpl<(&K, &mut V), HashMapIterMutShape>;
    }
    impl<K, V> BTreeMap<K, V> {
        pub const fn new() -> BTreeMap<K, V>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> IterImpl<(&K, &V), BTreeMapIterShape>;
        pub fn iter_mut(&mut self) -> IterImpl<(&K, &mut V), BTreeMapIterMutShape>;
        pub fn keys(&self) -> IterImpl<&K, BTreeMapKeysShape>;
        pub fn values(&self) -> IterImpl<&V, BTreeMapValuesShape>;
        pub fn values_mut(&mut self) -> IterImpl<&mut V, BTreeMapValuesMutShape>;
        pub fn into_keys(self) -> IterImpl<K, BTreeMapIntoKeysShape>;
        pub fn into_values(self) -> IterImpl<V, BTreeMapIntoValuesShape>;
        pub fn into_iter(self) -> IterImpl<(K, V), BTreeMapIntoIterShape>;
    }
    impl<K: ${collectionKeyTraits('BTreeMap').join(' + ')}, V> BTreeMap<K, V> {
        pub fn range<R: RangeBounds<K>>(&self, range: R) -> IterImpl<(&K, &V), BTreeMapRangeShape>;
        pub fn insert(&mut self, k: K, v: V) -> Option<V> ;
        pub fn get<Q>(&self, k: &Q) -> Option<&V> where K: Borrow<Q>, Q: Ord;
        pub fn get_mut<Q>(&mut self, k: &Q) -> Option<&mut V> where K: Borrow<Q>, Q: Ord;
        pub fn get_key_value<Q>(&self, k: &Q) -> Option<(&K, &V)> where K: Borrow<Q>, Q: Ord;
        pub fn contains_key<Q>(&self, k: &Q) -> bool where K: Borrow<Q>, Q: Ord;
        pub fn remove<Q>(&mut self, k: &Q) -> Option<V> where K: Borrow<Q>, Q: Ord;
        pub fn entry(&mut self, key: K) -> Entry<K, V> ;
        pub fn first_key_value(&self) -> Option<(&K, &V)>;
        pub fn last_key_value(&self) -> Option<(&K, &V)>;
        pub fn first_entry(&mut self) -> Option<OccupiedEntry<K, V>>;
        pub fn last_entry(&mut self) -> Option<OccupiedEntry<K, V>>;
        pub fn pop_first(&mut self) -> Option<(K, V)>;
        pub fn pop_last(&mut self) -> Option<(K, V)>;
        pub fn retain<F: FnMut(&K, &mut V) -> bool>(&mut self, f: F);
        pub fn extend<A: MapExtendInto<(K, V)>, S>(&mut self, iter: IterImpl<A, S>);
    }
    impl<K, V> &BTreeMap<K, V> {
        pub fn into_iter(self) -> IterImpl<(&K, &V), BTreeMapIterShape>;
    }
    impl<K, V> &mut BTreeMap<K, V> {
        pub fn into_iter(self) -> IterImpl<(&K, &mut V), BTreeMapIterMutShape>;
    }
    impl<K, V> Entry<K, V> {
        pub fn or_insert(self, default: V) -> &mut V;
        pub fn or_insert_with<F: FnOnce() -> V>(self, default: F) -> &mut V;
        pub fn or_insert_with_key<F: FnOnce(&K) -> V>(self, default: F) -> &mut V;
        pub fn or_default(self) -> &mut V where V: Default;
        pub fn and_modify<F: FnOnce(&mut V)>(self, f: F) -> Entry<K, V>;
        pub fn key(&self) -> &K;
    }
    impl<'a, K, V> OccupiedEntry<'a, K, V> {
        pub fn key(&self) -> &K;
        pub fn get(&self) -> &V;
        pub fn get_mut(&mut self) -> &mut V;
        pub fn into_mut(self) -> &'a mut V;
        pub fn insert(&mut self, value: V) -> V;
        pub fn remove(self) -> V;
        pub fn remove_entry(self) -> (K, V);
    }
    impl<T> HashSet<T> {
        pub fn new() -> HashSet<T>;
        pub fn with_capacity(capacity: usize) -> HashSet<T>;
        pub fn capacity(&self) -> usize;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> IterImpl<&T, HashSetIterShape>;
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn drain(&mut self) -> IterImpl<T, HashSetDrainShape>;
        pub fn into_iter(self) -> IterImpl<T, HashSetIntoIterShape>;
    }
    impl<T: ${collectionKeyTraits('HashSet').join(' + ')}> HashSet<T> {
        pub fn reserve(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
        pub fn shrink_to(&mut self, min_capacity: usize);
        pub fn insert(&mut self, value: T) -> bool ;
        pub fn replace(&mut self, value: T) -> Option<T>;
        pub fn contains<Q>(&self, value: &Q) -> bool where T: Borrow<Q>, Q: Eq + Hash;
        pub fn remove<Q>(&mut self, value: &Q) -> bool where T: Borrow<Q>, Q: Eq + Hash;
        pub fn take<Q>(&mut self, value: &Q) -> Option<T> where T: Borrow<Q>, Q: Eq + Hash;
        pub fn get<Q>(&self, value: &Q) -> Option<&T> where T: Borrow<Q>, Q: Eq + Hash;
        pub fn union<'a>(&'a self, other: &'a HashSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn intersection<'a>(&'a self, other: &'a HashSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn difference<'a>(&'a self, other: &'a HashSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn symmetric_difference<'a>(&'a self, other: &'a HashSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn is_subset(&self, other: &HashSet<T>) -> bool;
        pub fn is_superset(&self, other: &HashSet<T>) -> bool;
        pub fn is_disjoint(&self, other: &HashSet<T>) -> bool;
        pub fn extend<A: ExtendInto<T>, S>(&mut self, iter: IterImpl<A, S>) ;
    }
    impl<T> &HashSet<T> {
        pub fn into_iter(self) -> IterImpl<&T, HashSetIterShape>;
    }
    impl<T> BTreeSet<T> {
        pub const fn new() -> BTreeSet<T>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> IterImpl<&T, BTreeSetIterShape>;
        pub fn into_iter(self) -> IterImpl<T, BTreeSetIntoIterShape>;
    }
    impl<T: ${collectionKeyTraits('BTreeSet').join(' + ')}> BTreeSet<T> {
        pub fn range<R: RangeBounds<T>>(&self, range: R) -> IterImpl<&T, BTreeSetRangeShape>;
        pub fn insert(&mut self, value: T) -> bool ;
        pub fn contains<Q>(&self, value: &Q) -> bool where T: Borrow<Q>, Q: Ord;
        pub fn remove<Q>(&mut self, value: &Q) -> bool where T: Borrow<Q>, Q: Ord;
        pub fn first(&self) -> Option<&T>;
        pub fn last(&self) -> Option<&T>;
        pub fn pop_first(&mut self) -> Option<T>;
        pub fn pop_last(&mut self) -> Option<T>;
        pub fn union<'a>(&'a self, other: &'a BTreeSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn intersection<'a>(&'a self, other: &'a BTreeSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn difference<'a>(&'a self, other: &'a BTreeSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn symmetric_difference<'a>(&'a self, other: &'a BTreeSet<T>) -> IterImpl<&'a T, SetOpShape>;
        pub fn is_subset(&self, other: &BTreeSet<T>) -> bool;
        pub fn is_disjoint(&self, other: &BTreeSet<T>) -> bool;
        pub fn is_superset(&self, other: &BTreeSet<T>) -> bool;
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn extend<A: ExtendInto<T>, S>(&mut self, iter: IterImpl<A, S>) ;
    }
    impl<T> &BTreeSet<T> {
        pub fn into_iter(self) -> IterImpl<&T, BTreeSetIterShape>;
    }
    impl<T> VecDeque<T> {
        pub const fn new() -> VecDeque<T>;
        pub fn with_capacity(capacity: usize) -> VecDeque<T>;
        pub fn capacity(&self) -> usize;
        pub fn reserve(&mut self, additional: usize);
        pub fn reserve_exact(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
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
        pub fn iter(&self) -> IterImpl<&T, VecDequeIterShape>;
        pub fn range<R: RangeBounds<usize>>(&self, range: R) -> IterImpl<&T, VecDequeIterShape>;
        pub fn iter_mut(&mut self) -> IterImpl<&mut T, VecDequeIterMutShape>;
        pub fn as_slices(&self) -> (&[T], &[T]);
        pub fn insert(&mut self, index: usize, value: T);
        pub fn remove(&mut self, index: usize) -> Option<T>;
        pub fn extend<A: ExtendInto<T>, S>(&mut self, iter: IterImpl<A, S>);
        pub fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
        pub fn retain_mut<F: FnMut(&mut T) -> bool>(&mut self, f: F);
        pub fn truncate(&mut self, len: usize);
        pub fn swap(&mut self, i: usize, j: usize);
        pub fn rotate_left(&mut self, n: usize);
        pub fn rotate_right(&mut self, n: usize);
        pub fn make_contiguous(&mut self) -> &mut [T];
        pub fn split_off(&mut self, at: usize) -> VecDeque<T>;
        pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> IterImpl<T, VecDequeDrainShape>;
        pub fn into_iter(self) -> IterImpl<T, VecDequeIntoIterShape<T>>;
    }
    impl<T> &VecDeque<T> {
        pub fn into_iter(self) -> IterImpl<&T, VecDequeIterShape>;
    }
    impl<T> &mut VecDeque<T> {
        pub fn into_iter(self) -> IterImpl<&mut T, VecDequeIterMutShape>;
    }
    impl<T> BinaryHeap<T> {
        pub const fn new() -> BinaryHeap<T>;
        pub fn with_capacity(capacity: usize) -> BinaryHeap<T>;
        pub fn capacity(&self) -> usize;
        pub fn reserve(&mut self, additional: usize);
        pub fn shrink_to_fit(&mut self);
        pub fn push(&mut self, item: T) where T: Ord;
        pub fn pop(&mut self) -> Option<T> where T: Ord;
        pub fn append(&mut self, other: &mut BinaryHeap<T>) where T: Ord;
        pub fn peek(&self) -> Option<&T>;
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
        pub fn clear(&mut self);
        pub fn iter(&self) -> IterImpl<&T, BinaryHeapIterShape>;
        pub fn into_vec(self) -> Vec<T>;
        pub fn into_sorted_vec(self) -> Vec<T> where T: Ord;
        pub fn extend<A: ExtendInto<T>, S>(&mut self, iter: IterImpl<A, S>) where T: Ord;
        pub fn into_iter(self) -> IterImpl<T, BinaryHeapIntoIterShape<T>>;
        pub fn drain(&mut self) -> IterImpl<T, BinaryHeapDrainShape>;
    }
    impl<T> &BinaryHeap<T> {
        pub fn into_iter(self) -> IterImpl<&T, BinaryHeapIterShape>;
    }
}
pub mod mem {
    pub const fn size_of<T>() -> usize;
    pub const fn swap<T>(x: &mut T, y: &mut T);
    pub const fn replace<T>(dest: &mut T, src: T) -> T;
    pub fn take<T: Default>(dest: &mut T) -> T;
    pub fn drop<T>(x: T);
}
pub mod io {
    #[derive(Debug)]
    pub struct Error { inner: () }
    pub type Result<T> = core::result::Result<T, Error>;
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
    pub enum ErrorKind {
        NotFound, PermissionDenied, ConnectionRefused, ConnectionReset, HostUnreachable, NetworkUnreachable,
        ConnectionAborted, NotConnected, AddrInUse, AddrNotAvailable, NetworkDown, BrokenPipe, AlreadyExists,
        WouldBlock, NotADirectory, IsADirectory, DirectoryNotEmpty, ReadOnlyFilesystem, StaleNetworkFileHandle,
        InvalidInput, InvalidData, TimedOut, WriteZero, StorageFull, NotSeekable, QuotaExceeded, FileTooLarge,
        ResourceBusy, ExecutableFileBusy, Deadlock, CrossesDevices, TooManyLinks, InvalidFilename,
        ArgumentListTooLong, Interrupted, Unsupported, UnexpectedEof, OutOfMemory, Other,
    }
    impl Error {
        pub fn new<E: super::fmt::Display>(kind: ErrorKind, error: E) -> Error;
        pub fn other<E: super::fmt::Display>(error: E) -> Error;
        pub fn kind(&self) -> ErrorKind;
    }
    impl From<ErrorKind> for Error { fn from(kind: ErrorKind) -> Error; }
    pub trait Read {
        fn read(&mut self, buf: &mut [u8]) -> Result<usize>;
        fn read_to_string(&mut self, buf: &mut String) -> Result<usize>;
        fn read_to_end(&mut self, buf: &mut Vec<u8>) -> Result<usize>;
    }
    pub trait BufRead: Read {
        fn read_line(&mut self, buf: &mut String) -> Result<usize>;
        fn lines(self) -> IterImpl<Result<String>, super::iter::shape::IoLinesShape> where Self: Sized;
    }
    pub struct Stdin { inner: () }
    pub struct StdinLock { inner: () }
    pub fn stdin() -> Stdin;
    impl Stdin {
        pub fn lock(&self) -> StdinLock;
        pub fn read_line(&self, buf: &mut String) -> Result<usize>;
        pub fn lines(self) -> IterImpl<Result<String>, super::iter::shape::IoLinesShape>;
    }
    impl Read for Stdin {}
    impl Read for StdinLock {}
    impl BufRead for StdinLock {}
    pub fn read_to_string<R: Read>(reader: R) -> Result<String>;
    pub struct BufReader<R> { inner: R }
    impl<R: Read> BufReader<R> { pub fn new(inner: R) -> BufReader<R>; }
    impl<R: Read> Read for BufReader<R> {}
    impl<R: Read> BufRead for BufReader<R> {}
    pub struct BufWriter<W: Write> { inner: W }
    impl<W: Write> BufWriter<W> { pub fn new(inner: W) -> BufWriter<W>; }
    impl<W: Write> Write for BufWriter<W> {}
    pub trait Write {
        fn write(&mut self, buf: &[u8]) -> Result<usize>;
        fn write_all(&mut self, buf: &[u8]) -> Result<()>;
        fn flush(&mut self) -> Result<()>;
    }
    pub struct Stdout { inner: () }
    pub struct StdoutLock { inner: () }
    pub struct Stderr { inner: () }
    pub struct StderrLock { inner: () }
    pub fn stdout() -> Stdout;
    pub fn stderr() -> Stderr;
    impl Stdout { pub fn lock(&self) -> StdoutLock; }
    impl Stderr { pub fn lock(&self) -> StderrLock; }
    impl Write for Stdout {}
    impl Write for StdoutLock {}
    impl Write for Stderr {}
    impl Write for StderrLock {}
}
pub mod ffi {
    /** A C string: its bytes without the terminating NUL, which no byte inside is. */
    pub struct CStr;
    impl CStr {
        pub fn to_bytes(&self) -> &[u8];
        pub fn to_bytes_with_nul(&self) -> &[u8];
        pub fn to_str(&self) -> Result<&str, super::str::Utf8Error>;
        pub fn count_bytes(&self) -> usize;
        pub fn is_empty(&self) -> bool;
    }
    pub fn c_str_literal(bytes: &'static [u8]) -> &'static CStr;
}
pub mod future {
    use super::pin::Pin;
    use super::task::{Context, Poll};
    pub trait Future {
        type Output;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Self::Output>;
    }
    /** The future of an \`async\` block or function. */
    pub struct AsyncFuture<T>;
    impl<T> Future for AsyncFuture<T> {
        type Output = T;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<T>;
    }
    impl<F: Future + Unpin + ?Sized> Future for Box<F> {
        type Output = F::Output;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<F::Output>;
    }
    impl<'a, F: Future + Unpin + ?Sized> Future for &'a mut F {
        type Output = F::Output;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<F::Output>;
    }
    impl<F: Future + ?Sized> Future for Pin<Box<F>> {
        type Output = F::Output;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<F::Output>;
    }
    impl<'a, F: Future + ?Sized> Future for Pin<&'a mut F> {
        type Output = F::Output;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<F::Output>;
    }
    pub trait IntoFuture {
        type Output;
        type IntoFuture: Future<Output = Self::Output>;
        fn into_future(self) -> Self::IntoFuture;
    }
    impl<F: Future> IntoFuture for F {
        type Output = F::Output;
        type IntoFuture = F;
        fn into_future(self) -> F;
    }
    pub struct Ready<T>;
    impl<T> Future for Ready<T> {
        type Output = T;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<T>;
    }
    pub struct Pending<T>;
    impl<T> Future for Pending<T> {
        type Output = T;
        fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<T>;
    }
    pub fn ready<T>(t: T) -> Ready<T>;
    pub fn pending<T>() -> Pending<T>;
}
pub mod task {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub enum Poll<T> { Ready(T), Pending }
    impl<T> Poll<T> {
        pub fn is_ready(&self) -> bool;
        pub fn is_pending(&self) -> bool;
        pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Poll<U>;
    }
    pub struct Context { inner: () }
    impl Context {
        pub fn from_waker(waker: &Waker) -> Context;
        pub fn waker(&self) -> &Waker;
    }
    #[derive(Debug)]
    pub struct Waker { inner: () }
    impl Waker {
        pub fn noop() -> &'static Waker;
        pub fn wake(self);
        pub fn wake_by_ref(&self);
        pub fn will_wake(&self, other: &Waker) -> bool;
    }
    impl Clone for Waker { fn clone(&self) -> Waker; }
}
pub mod pin {
    pub struct Pin<P>;
    impl<'a, T: ?Sized + super::marker::Unpin> Pin<&'a mut T> {
        pub fn new(pointer: &'a mut T) -> Pin<&'a mut T>;
    }
    impl<P> Pin<P> {
        pub unsafe fn new_unchecked(pointer: P) -> Pin<P>;
        pub fn into_inner(pin: Pin<P>) -> P;
    }
    impl<'a, T> Pin<&'a mut T> {
        pub fn as_mut(&mut self) -> Pin<&mut T>;
        pub fn get_mut(self) -> &'a mut T;
        pub fn set(&mut self, value: T);
    }
    impl<T> Pin<Box<T>> {
        pub fn as_mut(&mut self) -> Pin<&mut T>;
    }
    pub fn pin_value<T>(value: T) -> Pin<&'static mut T>;
}
pub mod time {
    pub struct Duration { inner: () }
    impl Duration {
        pub const ZERO: Duration;
        pub const MAX: Duration;
        pub const fn new(secs: u64, nanos: u32) -> Duration;
        pub const fn from_secs(secs: u64) -> Duration;
        pub const fn from_millis(millis: u64) -> Duration;
        pub const fn from_micros(micros: u64) -> Duration;
        pub const fn from_nanos(nanos: u64) -> Duration;
        pub fn from_secs_f64(secs: f64) -> Duration;
        pub const fn as_secs(&self) -> u64;
        pub const fn as_millis(&self) -> u128;
        pub const fn as_micros(&self) -> u128;
        pub const fn as_nanos(&self) -> u128;
        pub fn as_secs_f64(&self) -> f64;
        pub const fn subsec_millis(&self) -> u32;
        pub const fn subsec_nanos(&self) -> u32;
        pub fn abs_diff(self, other: Duration) -> Duration;
        pub fn mul_f64(self, rhs: f64) -> Duration;
    }
    impl super::ops::Add for Duration { type Output = Duration; fn add(self, rhs: Duration) -> Duration; }
    impl super::ops::Sub for Duration { type Output = Duration; fn sub(self, rhs: Duration) -> Duration; }
    impl super::ops::Mul<u32> for Duration { type Output = Duration; fn mul(self, rhs: u32) -> Duration; }
    impl super::ops::Mul<Duration> for u32 { type Output = Duration; fn mul(self, rhs: Duration) -> Duration; }
    impl super::ops::Div<u32> for Duration { type Output = Duration; fn div(self, rhs: u32) -> Duration; }
    impl super::ops::AddAssign for Duration { fn add_assign(&mut self, rhs: Duration); }
    impl super::ops::SubAssign for Duration { fn sub_assign(&mut self, rhs: Duration); }
    impl super::ops::MulAssign<u32> for Duration { fn mul_assign(&mut self, rhs: u32); }
    impl super::ops::DivAssign<u32> for Duration { fn div_assign(&mut self, rhs: u32); }
}
pub mod thread {
    use super::pseudo::Any;
    pub struct JoinHandle<T> { inner: () }
    impl<T> JoinHandle<T> {
        pub fn join(self) -> Result<T, Box<dyn Any + Send>>;
        pub fn is_finished(&self) -> bool;
        pub fn thread(&self) -> &Thread;
    }
    pub fn spawn<F: FnOnce() -> T + Send + 'static, T: Send + 'static>(f: F) -> JoinHandle<T>;
    pub fn sleep(dur: super::time::Duration);
    pub fn yield_now();
    pub fn current() -> Thread;
    pub fn scope<F: FnOnce(&Scope) -> T, T>(f: F) -> T;
    pub struct Scope { inner: () }
    impl Scope {
        pub fn spawn<F: FnOnce() -> T + Send, T: Send>(&self, f: F) -> ScopedJoinHandle<T>;
    }
    pub struct ScopedJoinHandle<T> { inner: () }
    impl<T> ScopedJoinHandle<T> {
        pub fn join(self) -> Result<T, Box<dyn Any + Send>>;
        pub fn is_finished(&self) -> bool;
    }
    pub struct Thread { inner: () }
    impl Thread {
        pub fn id(&self) -> ThreadId;
        pub fn name(&self) -> Option<&str>;
    }
    #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
    pub struct ThreadId(u64);
}
pub mod sync {
    pub struct Arc<T>;
    impl<T> Arc<T> {
        pub fn new(value: T) -> Arc<T>;
        pub fn strong_count(this: &Arc<T>) -> usize;
        pub fn ptr_eq(this: &Arc<T>, other: &Arc<T>) -> bool;
        pub fn try_unwrap(this: Arc<T>) -> Result<T, Arc<T>>;
        pub fn into_inner(this: Arc<T>) -> Option<T>;
        pub fn as_ref(&self) -> &T;
    }
    impl<'a> From<&'a str> for Arc<str> { fn from(text: &str) -> Arc<str>; }
    impl From<String> for Arc<str> { fn from(text: String) -> Arc<str>; }
    impl<T> From<Vec<T>> for Arc<[T]> { fn from(items: Vec<T>) -> Arc<[T]>; }
    pub struct Mutex<T>;
    impl<T> Mutex<T> {
        pub fn new(value: T) -> Mutex<T>;
        pub fn lock(&self) -> LockResult<MutexGuard<T>>;
        pub fn try_lock(&self) -> Result<MutexGuard<T>, TryLockError<MutexGuard<T>>>;
        pub fn into_inner(self) -> LockResult<T>;
        pub fn get_mut(&mut self) -> LockResult<&mut T>;
        pub fn is_poisoned(&self) -> bool;
        pub fn clear_poison(&self);
    }
    pub struct MutexGuard<T>;
    pub struct Condvar { inner: () }
    impl Condvar {
        pub fn new() -> Condvar;
        pub fn wait<T>(&self, guard: MutexGuard<T>) -> LockResult<MutexGuard<T>>;
        pub fn wait_while<T, F: FnMut(&mut T) -> bool>(&self, guard: MutexGuard<T>, condition: F) -> LockResult<MutexGuard<T>>;
        pub fn notify_one(&self);
        pub fn notify_all(&self);
    }
    pub struct RwLock<T>;
    impl<T> RwLock<T> {
        pub fn new(value: T) -> RwLock<T>;
        pub fn read(&self) -> LockResult<RwLockReadGuard<T>>;
        pub fn write(&self) -> LockResult<RwLockWriteGuard<T>>;
        pub fn into_inner(self) -> LockResult<T>;
        pub fn get_mut(&mut self) -> LockResult<&mut T>;
        pub fn is_poisoned(&self) -> bool;
        pub fn clear_poison(&self);
    }
    pub struct RwLockReadGuard<T>;
    pub struct RwLockWriteGuard<T>;
    pub type LockResult<G> = Result<G, PoisonError<G>>;
    pub struct PoisonError<T> { guard: T }
    impl<T> PoisonError<T> {
        pub fn into_inner(self) -> T;
        pub fn get_ref(&self) -> &T;
        pub fn get_mut(&mut self) -> &mut T;
    }
    pub enum TryLockError<T> { Poisoned(PoisonError<T>), WouldBlock }
    pub mod mpsc {
        pub struct Sender<T>;
        impl<T> Sender<T> { pub fn send(&self, t: T) -> Result<(), SendError<T>>; }
        pub struct Receiver<T>;
        impl<T> Receiver<T> {
            pub fn recv(&self) -> Result<T, RecvError>;
            pub fn try_recv(&self) -> Result<T, TryRecvError>;
            pub fn iter(&self) -> IterImpl<T, super::super::iter::shape::ReceiverShape>;
            pub fn try_iter(&self) -> IterImpl<T, super::super::iter::shape::ReceiverShape>;
        }
        pub fn channel<T>() -> (Sender<T>, Receiver<T>);
        #[derive(Clone, Copy, PartialEq, Eq)]
        pub struct SendError<T>(pub T);
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct RecvError;
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum TryRecvError { Empty, Disconnected }
    }
}
pub mod fs {
    use super::io::Result;
    use super::pseudo::{AsPath, AsBytes};
    pub struct File { inner: () }
    impl File {
        pub fn open<P: AsPath>(path: P) -> Result<File>;
        pub fn create<P: AsPath>(path: P) -> Result<File>;
        pub fn create_new<P: AsPath>(path: P) -> Result<File>;
        pub fn options() -> OpenOptions;
    }
    impl super::io::Read for File {}
    impl super::io::Write for File {}
    pub struct OpenOptions { inner: () }
    impl OpenOptions {
        pub fn new() -> OpenOptions;
        pub fn read(&mut self, read: bool) -> &mut OpenOptions;
        pub fn write(&mut self, write: bool) -> &mut OpenOptions;
        pub fn append(&mut self, append: bool) -> &mut OpenOptions;
        pub fn truncate(&mut self, truncate: bool) -> &mut OpenOptions;
        pub fn create(&mut self, create: bool) -> &mut OpenOptions;
        pub fn create_new(&mut self, create_new: bool) -> &mut OpenOptions;
        pub fn open<P: AsPath>(&self, path: P) -> Result<File>;
    }
    pub fn read_to_string<P: AsPath>(path: P) -> Result<String>;
    pub fn read<P: AsPath>(path: P) -> Result<Vec<u8>>;
    pub fn write<P: AsPath, C: AsBytes>(path: P, contents: C) -> Result<()>;
    pub fn remove_file<P: AsPath>(path: P) -> Result<()>;
    pub fn create_dir<P: AsPath>(path: P) -> Result<()>;
    pub fn create_dir_all<P: AsPath>(path: P) -> Result<()>;
    pub fn remove_dir<P: AsPath>(path: P) -> Result<()>;
    pub fn rename<P: AsPath, Q: AsPath>(from: P, to: Q) -> Result<()>;
    pub fn copy<P: AsPath, Q: AsPath>(from: P, to: Q) -> Result<u64>;
    pub fn exists<P: AsPath>(path: P) -> Result<bool>;
}
pub mod path {
    use super::pseudo::AsPath;
    pub struct Path { inner: () }
    pub struct PathBuf { inner: () }
    pub struct Display<'a>;
    impl Path {
        pub fn new<S: AsPath>(s: &S) -> &Path;
        pub fn exists(&self) -> bool;
        pub fn is_file(&self) -> bool;
        pub fn is_dir(&self) -> bool;
        pub fn to_str(&self) -> Option<&str>;
        pub fn display(&self) -> Display<'_>;
        pub fn join<P: AsPath>(&self, path: P) -> PathBuf;
        pub fn to_path_buf(&self) -> PathBuf;
    }
    impl PathBuf {
        pub fn new() -> PathBuf;
        pub fn from<S: AsPath>(s: S) -> PathBuf;
        pub fn push<P: AsPath>(&mut self, path: P);
        pub fn as_path(&self) -> &Path;
        pub fn exists(&self) -> bool;
        pub fn to_str(&self) -> Option<&str>;
        pub fn display(&self) -> Display<'_>;
        pub fn join<P: AsPath>(&self, path: P) -> PathBuf;
    }
}
pub mod process {
    pub fn exit(code: i32) -> !;
}
pub mod i8 {
    pub const MAX: i8;
    pub const MIN: i8;
}
pub mod i16 {
    pub const MAX: i16;
    pub const MIN: i16;
}
pub mod i32 {
    pub const MAX: i32;
    pub const MIN: i32;
}
pub mod i64 {
    pub const MAX: i64;
    pub const MIN: i64;
}
pub mod i128 {
    pub const MAX: i128;
    pub const MIN: i128;
}
pub mod isize {
    pub const MAX: isize;
    pub const MIN: isize;
}
pub mod u8 {
    pub const MAX: u8;
    pub const MIN: u8;
}
pub mod u16 {
    pub const MAX: u16;
    pub const MIN: u16;
}
pub mod u32 {
    pub const MAX: u32;
    pub const MIN: u32;
}
pub mod u64 {
    pub const MAX: u64;
    pub const MIN: u64;
}
pub mod u128 {
    pub const MAX: u128;
    pub const MIN: u128;
}
pub mod usize {
    pub const MAX: usize;
    pub const MIN: usize;
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
    pub use super::borrow::ToOwned;
    pub use super::marker::Copy;
    pub use super::marker::Send;
    pub use super::marker::Sync;
    pub use super::marker::Unpin;
    pub use super::marker::Sized;
    pub use super::cmp::PartialEq;
    pub use super::cmp::Eq;
    pub use super::cmp::PartialOrd;
    pub use super::cmp::Ord;
    pub use super::default::Default;
    pub use super::iter::Iterator;
    pub use super::iter::IntoIterator;
    pub use super::iter::DoubleEndedIterator;
    pub use super::future::Future;
    pub use super::future::IntoFuture;
    pub use super::iter::ExactSizeIterator;
    pub use super::iter::FromIterator;
    pub use super::iter::Extend;
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
    pub trait Any: super::fmt::Debug {}
    pub trait AsPath {}
    pub trait AsBytes {}
    pub trait Integer {}
    pub trait SignedInteger {}
    pub trait UnsignedInteger {}
    pub trait SliceIndex {}
    pub trait Float {}
    pub trait Pattern {}
    pub trait DoubleEndedPattern {}
    pub trait Borrow<Q> {}
    pub trait StringPart {}
    pub trait RangeBounds<T> {}
    pub trait ExtendInto<T> {}
    pub trait MapExtendInto<T> {}
    pub trait PairOf<A, B> {}
    pub trait TryFoldResult<T> {}
    pub trait SliceOf<T> {}
    pub trait JoinSeparator<T> {}
    pub struct ParseError<F>;
    pub struct Unsigned<N>;
    pub struct Signed<N>;
    pub struct Indexed<I, T>;
    pub struct TryFromError<S, T>;
    pub struct IterItem<I>;
    pub struct IterShape<I>;
    pub struct IterTarget<I>;
    pub struct IntoItem<T>;
    pub struct IntoShape<T>;
}
`;
