import { BT } from './source';

export const NATURAL_SOURCE = String.raw`
underflowError :: a
underflowError = primitive "underflowError"

integerToNaturalThrow :: Integer -> Natural
integerToNaturalThrow = primitive "integerToNatural"

instance Eq Natural where
  (==) = primitive "integerEq"

instance Ord Natural where
  (<) = primitive "integerLt"
  (<=) = primitive "integerLe"
  (>) = primitive "integerGt"
  (>=) = primitive "integerGe"
  compare = primitive "integerCompare"

instance Num Natural where
  (+) = primitive "integerAdd"
  x - y = integerToNaturalThrow (toInteger x - toInteger y)
  (*) = primitive "integerMul"
  negate x = if x == 0 then 0 else underflowError
  fromInteger = integerToNaturalThrow
  abs x = x
  signum = primitive "integerSignum"

instance Real Natural where
  toRational n = toInteger n :% 1

instance Integral Natural where
  toInteger = primitive "naturalToInteger"
  quot = primitive "integerQuot"
  rem = primitive "integerRem"
  quotRem n d = let q = quot n d in q ${BT}seq${BT} (q, rem n d)
  div x y = quot x y
  mod x y = rem x y
  divMod x y = quotRem x y

instance Enum Natural where
  succ n = n + 1
  pred n = n - 1
  toEnum i = if i >= 0 then fromIntegral i else errorWithoutStackTrace "toEnum: unexpected negative Int"
  fromEnum n = if n <= 9223372036854775807 then fromIntegral n else errorWithoutStackTrace "fromEnum: out of Int range"
  enumFrom x = enumDeltaNatural x 1
  enumFromThen x y = if x <= y then enumDeltaNatural x (y - x) else enumNegDeltaToNatural x (x - y) 0
  enumFromTo x lim = enumDeltaToNatural x 1 lim
  enumFromThenTo x y lim = if x <= y then enumDeltaToNatural x (y - x) lim else enumNegDeltaToNatural x (x - y) lim

enumDeltaNatural :: Natural -> Natural -> [Natural]
enumDeltaNatural x d = x ${BT}seq${BT} (x : enumDeltaNatural (x + d) d)

enumDeltaToNatural :: Natural -> Natural -> Natural -> [Natural]
enumDeltaToNatural x0 delta lim = go x0
  where go x = if x > lim then [] else x : go (x + delta)

enumNegDeltaToNatural :: Natural -> Natural -> Natural -> [Natural]
enumNegDeltaToNatural x0 ndelta lim = go x0
  where go x = if x < lim then [] else if x >= ndelta then x : go (x - ndelta) else [x]

instance Show Natural where
  showsPrec p n = showsPrec p (toInteger n)

instance Read Natural where
  readsPrec d = map (\(n, s) -> (fromInteger n, s)) . filter ((>= 0) . (\(x, _) -> x)) . readsPrec d

instance Bits Natural where
  (.&.) = primitive "integerAnd"
  (.|.) = primitive "integerOr"
  xor = primitive "integerXor"
  complement _ = errorWithoutStackTrace "Bits.complement: Natural complement undefined"
  unsafeShiftR x i = primitive "integerShiftR" x (toInteger i)
  unsafeShiftL x i = primitive "integerShiftL" x (toInteger i)
  shiftR x i = if i >= 0 then unsafeShiftR x i else overflowError
  shiftL x i = if i >= 0 then unsafeShiftL x i else overflowError
  shift x i = if i >= 0 then primitive "integerShiftL" x (toInteger i) else primitive "integerShiftR" x (negate (toInteger i))
  testBit = primitive "integerTestBit"
  zeroBits = 0
  setBit = primitive "integerSetBit"
  clearBit = primitive "integerClearBit"
  complementBit = primitive "integerComplementBit"
  bit = primitive "integerBit"
  popCount x = fromInteger (primitive "integerPopCount" x)
  rotate x i = shift x i
  bitSizeMaybe _ = Nothing
  bitSize _ = errorWithoutStackTrace "GHC.Internal.Data.Bits.bitSize(Natural)"
  isSigned _ = False

minusNaturalMaybe :: Natural -> Natural -> Maybe Natural
minusNaturalMaybe x y = if x >= y then Just (primitive "integerSub" x y) else Nothing
`;

export const TYPE_NATS_SOURCE = String.raw`module GHC.TypeNats.Internal where

import Base hiding (natVal)

natVal :: KnownNat n => proxy n -> Natural
natVal = primitive "literalOf"
`;
