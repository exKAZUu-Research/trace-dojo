const BT = '`';

export const FIXED_WIDTH_TYPES: readonly { name: string; bits: number; signed: boolean }[] = [
  { name: 'Int8', bits: 8, signed: true },
  { name: 'Int16', bits: 16, signed: true },
  { name: 'Int32', bits: 32, signed: true },
  { name: 'Int64', bits: 64, signed: true },
  { name: 'Word8', bits: 8, signed: false },
  { name: 'Word16', bits: 16, signed: false },
  { name: 'Word32', bits: 32, signed: false },
  { name: 'Word64', bits: 64, signed: false },
];

/**
 * A fixed-width integer type, as GHC's base defines its behavior: arithmetic that wraps around within the type's
 * range, two's complement bits, and the messages of its Enum and its bounds.
 */
function fixedWidthSource(name: string, bits: number, signed: boolean): string {
  const lo = signed ? -(2n ** BigInt(bits - 1)) : 0n;
  const hi = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
  const range = 2n ** BigInt(bits);
  const con = `Mk${name}`;
  const wrap = `wrap${name}`;
  const normalize = signed ? `((x + ${-lo}) ${BT}mod${BT} ${range}) - ${-lo}` : `x ${BT}mod${BT} ${range}`;
  return String.raw`
newtype ${name} = ${con} Integer

${wrap} :: Integer -> ${name}
${wrap} x = ${con} (${normalize})

instance Eq ${name} where
  ${con} a == ${con} b = a == b

instance Ord ${name} where
  compare (${con} a) (${con} b) = compare a b
  ${con} a < ${con} b = a < b
  ${con} a <= ${con} b = a <= b
  ${con} a > ${con} b = a > b
  ${con} a >= ${con} b = a >= b

instance Show ${name} where
  showsPrec d (${con} x) = showsPrec d x

instance Read ${name} where
  readsPrec d s = [(fromInteger x, r) | (x, r) <- readsPrec d s]

instance Num ${name} where
  ${con} a + ${con} b = ${wrap} (a + b)
  ${con} a - ${con} b = ${wrap} (a - b)
  ${con} a * ${con} b = ${wrap} (a * b)
  negate (${con} a) = ${wrap} (negate a)
  abs (${con} a) = ${wrap} (abs a)
  signum (${con} a) = ${con} (signum a)
  fromInteger = ${wrap}

instance Real ${name} where
  toRational (${con} x) = toRational x

instance Bounded ${name} where
  minBound = ${con} (${lo})
  maxBound = ${con} ${hi}

instance Enum ${name} where
  succ x = if x == maxBound then errorWithoutStackTrace "Enum.succ{${name}}: tried to take ${BT}succ' of last tag in enumeration" else x + 1
  pred x = if x == minBound then errorWithoutStackTrace "Enum.pred{${name}}: tried to take ${BT}pred' of first tag in enumeration" else x - 1
  toEnum n = if toInteger n < (${lo}) || toInteger n > ${hi}
    then errorWithoutStackTrace ("Enum.toEnum{${name}}: tag (" ++ show n ++ ") is outside of enumeration's range (${lo},${hi})")
    else ${con} (toInteger n)
  fromEnum (${con} x) = if x > 9223372036854775807
    then errorWithoutStackTrace ("Enum.fromEnum{${name}}: value (" ++ show x ++ ") is outside of Int's bounds (-9223372036854775808,9223372036854775807)")
    else fromInteger x
  enumFrom x = enumFromTo x maxBound
  enumFromThen x y = enumFromThenTo x y (if y >= x then maxBound else minBound)
  enumFromTo (${con} a) (${con} b) = map ${con} (enumFromTo a b)
  enumFromThenTo (${con} a) (${con} b) (${con} c) = map ${con} (enumFromThenTo a b c)

instance Integral ${name} where
${signed ? signedDivision(con, lo) : unsignedDivision(con)}
  toInteger (${con} x) = x

instance Bits ${name} where
  ${con} a .&. ${con} b = ${con} (a .&. b)
  ${con} a .|. ${con} b = ${con} (a .|. b)
  xor (${con} a) (${con} b) = ${con} (xor a b)
  complement (${con} a) = ${wrap} (complement a)
  shift x n = if n >= 0 then shiftL x n else shiftR x (negate n)
  shiftL (${con} a) n = ${wrap} (shiftL a n)
  shiftR (${con} a) n = ${con} (shiftR a n)
  rotate x n =
    let k = n ${BT}mod${BT} ${bits}
        u = toInteger x ${BT}mod${BT} ${range}
    in if k == 0 then x else ${wrap} (shiftL u k .|. shiftR u (${bits} - k))
  testBit (${con} a) i = i >= 0 && i < ${bits} && testBit a i
  bit i = ${wrap} (bit i)
  popCount (${con} a) = popCount (a ${BT}mod${BT} ${range})
  zeroBits = ${con} 0
  bitSize _ = ${bits}
  bitSizeMaybe _ = Just ${bits}
  isSigned _ = ${signed ? 'True' : 'False'}

instance FiniteBits ${name} where
  finiteBitSize _ = ${bits}
`;
}

function signedDivision(con: string, lo: bigint): string {
  return String.raw`  quot (${con} a) (${con} b)
    | b == 0 = divZeroError
    | b == (-1) && a == (${lo}) = overflowError
    | otherwise = ${con} (quot a b)
  rem (${con} a) (${con} b)
    | b == 0 = divZeroError
    | b == (-1) = 0
    | otherwise = ${con} (rem a b)
  div (${con} a) (${con} b)
    | b == 0 = divZeroError
    | b == (-1) && a == (${lo}) = overflowError
    | otherwise = ${con} (div a b)
  mod (${con} a) (${con} b)
    | b == 0 = divZeroError
    | b == (-1) = 0
    | otherwise = ${con} (mod a b)
  quotRem (${con} a) (${con} b)
    | b == 0 = divZeroError
    | b == (-1) && a == (${lo}) = (overflowError, 0)
    | otherwise = (${con} (quot a b), ${con} (rem a b))
  divMod (${con} a) (${con} b)
    | b == 0 = divZeroError
    | b == (-1) && a == (${lo}) = (overflowError, 0)
    | otherwise = (${con} (div a b), ${con} (mod a b))`;
}

function unsignedDivision(con: string): string {
  return String.raw`  quot (${con} a) (${con} b)
    | b /= 0 = ${con} (quot a b)
    | otherwise = divZeroError
  rem (${con} a) (${con} b)
    | b /= 0 = ${con} (rem a b)
    | otherwise = divZeroError
  quotRem (${con} a) (${con} b)
    | b /= 0 = (${con} (quot a b), ${con} (rem a b))
    | otherwise = divZeroError
  div x y = quot x y
  mod x y = rem x y
  divMod x y = quotRem x y`;
}

export const FIXED_WIDTH_SOURCE = FIXED_WIDTH_TYPES.map(({ name, bits, signed }) =>
  fixedWidthSource(name, bits, signed)
).join('\n');

export const FIXED_WIDTH_PRINTF = FIXED_WIDTH_TYPES.map(
  ({ name, bits, signed }) => String.raw`
instance PrintfArg ${name} where
  formatArg x = UInteger (toInteger x) ${signed ? 2n ** BigInt(bits) : 0} '${signed ? 'd' : 'u'}'
`
).join('\n');

export const FIXED_WIDTH_LIFT = FIXED_WIDTH_TYPES.map(
  ({ name }) => String.raw`
instance Lift ${name} where
  lift x = return (LitE (IntegerL (toInteger x)))
`
).join('\n');
