import { BT } from './source';

/** The core of the library: the basic types, the standard classes, and the numeric instances. */
export const BASE_CORE = String.raw`module Base where

infixr 9 .
infixr 8 ^, ^^, **
infixl 7 *, /, ${BT}quot${BT}, ${BT}rem${BT}, ${BT}div${BT}, ${BT}mod${BT}, %
infixl 6 +, -
infixr 5 ++
infix 4 ==, /=, <, <=, >=, >
infixl 4 <$>, <$, $>, <*>, *>, <*
infixr 3 &&
infixr 2 ||
infixl 1 >>, >>=, &, <&>
infixr 1 =<<, >=>, <=<
infixr 0 $, $!
infixr 6 <>
infixl 9 !!
infixl 3 <|>

primitive :: [Char] -> a
primitive name = primitive name

data Bool = False | True
data Ordering = LT | EQ | GT
data Maybe a = Nothing | Just a
data Either a b = Left a | Right b
data Ratio a = a :% a
type String = [Char]
type Rational = Ratio Integer
type ShowS = String -> String
type ReadS a = String -> [(a, String)]
type FilePath = String

-- Functions

id :: a -> a
id x = x

const :: a -> b -> a
const x _ = x

(.) :: (b -> c) -> (a -> b) -> a -> c
(.) f g = \x -> f (g x)

flip :: (a -> b -> c) -> b -> a -> c
flip f x y = f y x

($) :: (a -> b) -> a -> b
f $ x = f x

seq :: a -> b -> b
seq = primitive "seq"

($!) :: (a -> b) -> a -> b
f $! x = x ${BT}seq${BT} f x

(&) :: a -> (a -> b) -> b
x & f = f x

on :: (b -> b -> c) -> (a -> b) -> a -> a -> c
on op f x y = f x ${BT}op${BT} f y

fix :: (a -> a) -> a
fix f = let x = f x in x

until :: (a -> Bool) -> (a -> a) -> a -> a
until p f x = if p x then x else until p f (f x)

asTypeOf :: a -> a -> a
asTypeOf x _ = x

error :: [Char] -> a
error = primitive "error"

errorWithoutStackTrace :: [Char] -> a
errorWithoutStackTrace = primitive "error"

undefined :: a
undefined = error "Prelude.undefined"

primConTag :: a -> Int
primConTag = primitive "primConTag"

errorEmptyList :: [Char] -> a
errorEmptyList = primitive "errorEmptyList"

-- Booleans

(&&) :: Bool -> Bool -> Bool
True && x = x
False && _ = False

(||) :: Bool -> Bool -> Bool
True || _ = True
False || x = x

not :: Bool -> Bool
not True = False
not False = True

otherwise :: Bool
otherwise = True

bool :: a -> a -> Bool -> a
bool f _ False = f
bool _ t True = t

-- Tuples

fst :: (a, b) -> a
fst (x, _) = x

snd :: (a, b) -> b
snd (_, y) = y

curry :: ((a, b) -> c) -> a -> b -> c
curry f x y = f (x, y)

uncurry :: (a -> b -> c) -> (a, b) -> c
uncurry f p = f (fst p) (snd p)

swap :: (a, b) -> (b, a)
swap (a, b) = (b, a)

-- Maybe and Either

maybe :: b -> (a -> b) -> Maybe a -> b
maybe n _ Nothing = n
maybe _ f (Just x) = f x

either :: (a -> c) -> (b -> c) -> Either a b -> c
either f _ (Left x) = f x
either _ g (Right y) = g y

-- Eq and Ord

class Eq a where
  (==), (/=) :: a -> a -> Bool
  x /= y = not (x == y)
  x == y = not (x /= y)

class Eq a => Ord a where
  compare :: a -> a -> Ordering
  (<), (<=), (>), (>=) :: a -> a -> Bool
  max, min :: a -> a -> a
  compare x y = if x == y then EQ else if x <= y then LT else GT
  x < y = case compare x y of
    LT -> True
    _ -> False
  x <= y = case compare x y of
    GT -> False
    _ -> True
  x > y = case compare x y of
    GT -> True
    _ -> False
  x >= y = case compare x y of
    LT -> False
    _ -> True
  max x y = if x <= y then y else x
  min x y = if x <= y then x else y

thenCmp :: Ordering -> Ordering -> Ordering
thenCmp EQ y = y
thenCmp x _ = x

comparing :: Ord a => (b -> a) -> b -> b -> Ordering
comparing p x y = compare (p x) (p y)

clamp :: Ord a => (a, a) -> a -> a
clamp (low, high) a = min high (max a low)

instance Eq Bool where
  True == True = True
  False == False = True
  _ == _ = False

instance Ord Bool where
  compare a b = compare (primConTag a) (primConTag b)

instance Eq Ordering where
  a == b = primConTag a == primConTag b

instance Ord Ordering where
  compare a b = compare (primConTag a) (primConTag b)

instance Eq () where
  _ == _ = True

instance Ord () where
  compare _ _ = EQ

instance Eq a => Eq (Maybe a) where
  Nothing == Nothing = True
  Just x == Just y = x == y
  _ == _ = False

instance Ord a => Ord (Maybe a) where
  compare Nothing Nothing = EQ
  compare Nothing (Just _) = LT
  compare (Just _) Nothing = GT
  compare (Just x) (Just y) = compare x y

instance (Eq a, Eq b) => Eq (Either a b) where
  Left x == Left y = x == y
  Right x == Right y = x == y
  _ == _ = False

instance (Ord a, Ord b) => Ord (Either a b) where
  compare (Left x) (Left y) = compare x y
  compare (Left _) (Right _) = LT
  compare (Right _) (Left _) = GT
  compare (Right x) (Right y) = compare x y

instance Eq a => Eq [a] where
  [] == [] = True
  (x:xs) == (y:ys) = x == y && xs == ys
  _ == _ = False

instance Ord a => Ord [a] where
  compare [] [] = EQ
  compare [] (_:_) = LT
  compare (_:_) [] = GT
  compare (x:xs) (y:ys) = case compare x y of
    EQ -> compare xs ys
    other -> other

instance Eq Char where
  (==) = primitive "charEq"

instance Ord Char where
  (<) = primitive "charLt"
  (<=) = primitive "charLe"
  x > y = y < x
  x >= y = y <= x
  compare x y = if x == y then EQ else if x < y then LT else GT

instance Eq Int where
  (==) = primitive "intEq"

instance Ord Int where
  (<) = primitive "intLt"
  (<=) = primitive "intLe"
  x > y = y < x
  x >= y = y <= x
  compare = primitive "intCompare"

instance Eq Integer where
  (==) = primitive "integerEq"

instance Ord Integer where
  (<) = primitive "integerLt"
  (<=) = primitive "integerLe"
  x > y = y < x
  x >= y = y <= x
  compare = primitive "integerCompare"

instance Eq Double where
  (==) = primitive "doubleEq"

instance Ord Double where
  (<) = primitive "doubleLt"
  (<=) = primitive "doubleLe"
  x > y = y < x
  x >= y = y <= x
  compare x y = if x < y then LT else if x == y then EQ else GT

instance Eq Float where
  (==) = primitive "floatEq"

instance Ord Float where
  (<) = primitive "floatLt"
  (<=) = primitive "floatLe"
  x > y = y < x
  x >= y = y <= x
  compare x y = if x < y then LT else if x == y then EQ else GT

-- Numbers

class Num a where
  (+), (-), (*) :: a -> a -> a
  negate, abs, signum :: a -> a
  fromInteger :: Integer -> a
  x - y = x + negate y
  negate x = fromInteger 0 - x

class (Num a, Ord a) => Real a where
  toRational :: a -> Rational

class (Real a, Enum a) => Integral a where
  quot, rem, div, mod :: a -> a -> a
  quotRem, divMod :: a -> a -> (a, a)
  toInteger :: a -> Integer
  n ${BT}quot${BT} d = fst (quotRem n d)
  n ${BT}rem${BT} d = snd (quotRem n d)
  n ${BT}div${BT} d = fst (divMod n d)
  n ${BT}mod${BT} d = snd (divMod n d)
  divMod n d = if signum r == negate (signum d) then (q - fromInteger 1, r + d) else qr
    where qr = quotRem n d
          q = fst qr
          r = snd qr
  quotRem n d = (quot n d, rem n d)

class Num a => Fractional a where
  (/) :: a -> a -> a
  recip :: a -> a
  fromRational :: Rational -> a
  recip x = fromInteger 1 / x
  x / y = x * recip y

class Fractional a => Floating a where
  pi :: a
  exp, log, sqrt :: a -> a
  (**), logBase :: a -> a -> a
  sin, cos, tan, asin, acos, atan :: a -> a
  sinh, cosh, tanh, asinh, acosh, atanh :: a -> a
  x ** y = exp (log x * y)
  logBase x y = log y / log x
  sqrt x = x ** fromRational (1 :% 2)
  tan x = sin x / cos x
  tanh x = sinh x / cosh x

class (Real a, Fractional a) => RealFrac a where
  properFraction :: Integral b => a -> (b, a)
  truncate, round :: Integral b => a -> b
  ceiling, floor :: Integral b => a -> b
  truncate x = fst (properFraction x)
  round x = let (n, r) = properFraction x
                m = if r < fromInteger 0 then n - fromInteger 1 else n + fromInteger 1
            in case signum (abs r - fromRational (1 :% 2)) of
                 -1 -> n
                 0 -> if even n then n else m
                 1 -> m
                 _ -> error "round default defn: Bad value"
  ceiling x = if r > fromInteger 0 then n + fromInteger 1 else n
    where (n, r) = properFraction x
  floor x = if r < fromInteger 0 then n - fromInteger 1 else n
    where (n, r) = properFraction x

class (RealFrac a, Floating a) => RealFloat a where
  floatRadix :: a -> Integer
  floatDigits :: a -> Int
  floatRange :: a -> (Int, Int)
  decodeFloat :: a -> (Integer, Int)
  encodeFloat :: Integer -> Int -> a
  exponent :: a -> Int
  significand :: a -> a
  scaleFloat :: Int -> a -> a
  isNaN, isInfinite, isDenormalized, isNegativeZero, isIEEE :: a -> Bool
  atan2 :: a -> a -> a
  exponent x = if m == 0 then 0 else n + floatDigits x
    where (m, n) = decodeFloat x
  significand x = encodeFloat m (negate (floatDigits x))
    where (m, _) = decodeFloat x
  scaleFloat k x = if k == 0 || x == fromInteger 0 || isNaN x || isInfinite x then x else encodeFloat m (n + k)
    where (m, n) = decodeFloat x

subtract :: Num a => a -> a -> a
subtract x y = y - x

even, odd :: Integral a => a -> Bool
even n = n ${BT}rem${BT} fromInteger 2 == fromInteger 0
odd n = not (even n)

gcd :: Integral a => a -> a -> a
gcd x y = gcd' (abs x) (abs y)
  where gcd' a b = if b == fromInteger 0 then a else gcd' b (a ${BT}rem${BT} b)

lcm :: Integral a => a -> a -> a
lcm x y = if x == fromInteger 0 || y == fromInteger 0 then fromInteger 0 else abs ((x ${BT}quot${BT} (gcd x y)) * y)

(^) :: (Num a, Integral b) => a -> b -> a
x0 ^ y0 = if y0 < fromInteger 0 then errorWithoutStackTrace "Negative exponent"
          else if y0 == fromInteger 0 then fromInteger 1
          else powImpl x0 y0

powImpl :: (Num a, Integral b) => a -> b -> a
powImpl x y = if even y then powImpl (x * x) (y ${BT}quot${BT} fromInteger 2)
              else if y == fromInteger 1 then x
              else powImplAcc (x * x) (y ${BT}quot${BT} fromInteger 2) x

powImplAcc :: (Num a, Integral b) => a -> b -> a -> a
powImplAcc x y z = if even y then powImplAcc (x * x) (y ${BT}quot${BT} fromInteger 2) z
                   else if y == fromInteger 1 then x * z
                   else powImplAcc (x * x) (y ${BT}quot${BT} fromInteger 2) (x * z)

(^^) :: (Fractional a, Integral b) => a -> b -> a
x ^^ n = if n >= fromInteger 0 then x ^ n else recip (x ^ negate n)

fromIntegral :: (Integral a, Num b) => a -> b
fromIntegral x = fromInteger (toInteger x)

realToFrac :: (Real a, Fractional b) => a -> b
realToFrac x = fromRational (toRational x)

instance Num Int where
  (+) = primitive "intAdd"
  (-) = primitive "intSub"
  (*) = primitive "intMul"
  negate = primitive "intNegate"
  abs = primitive "intAbs"
  signum = primitive "intSignum"
  fromInteger = primitive "integerToInt"

instance Real Int where
  toRational x = toInteger x :% 1

instance Integral Int where
  quot = primitive "intQuot"
  rem = primitive "intRem"
  div = primitive "intDiv"
  mod = primitive "intMod"
  quotRem x y = (quot x y, rem x y)
  divMod x y = (div x y, mod x y)
  toInteger = primitive "intToInteger"

instance Num Integer where
  (+) = primitive "integerAdd"
  (-) = primitive "integerSub"
  (*) = primitive "integerMul"
  negate = primitive "integerNegate"
  abs = primitive "integerAbs"
  signum = primitive "integerSignum"
  fromInteger x = x

instance Real Integer where
  toRational x = x :% 1

instance Integral Integer where
  quot = primitive "integerQuot"
  rem = primitive "integerRem"
  div = primitive "integerDiv"
  mod = primitive "integerMod"
  quotRem x y = (quot x y, rem x y)
  divMod x y = (div x y, mod x y)
  toInteger x = x

instance Num Double where
  (+) = primitive "doubleAdd"
  (-) = primitive "doubleSub"
  (*) = primitive "doubleMul"
  negate = primitive "doubleNegate"
  abs = primitive "doubleAbs"
  signum = primitive "doubleSignum"
  fromInteger = primitive "doubleFromInteger"

instance Real Double where
  toRational x = floatToRational x

instance Fractional Double where
  (/) = primitive "doubleDiv"
  recip x = 1.0 / x
  fromRational (n :% d) = primDoubleFromRational n d

primDoubleFromRational :: Integer -> Integer -> Double
primDoubleFromRational = primitive "doubleFromRational"

instance Floating Double where
  pi = 3.141592653589793
  exp = primitive "doubleExp"
  log = primitive "doubleLog"
  sqrt = primitive "doubleSqrt"
  (**) = primitive "doublePow"
  logBase = primitive "doubleLogBase"
  sin = primitive "doubleSin"
  cos = primitive "doubleCos"
  tan = primitive "doubleTan"
  asin = primitive "doubleAsin"
  acos = primitive "doubleAcos"
  atan = primitive "doubleAtan"
  sinh = primitive "doubleSinh"
  cosh = primitive "doubleCosh"
  tanh = primitive "doubleTanh"
  asinh = primitive "doubleAsinh"
  acosh = primitive "doubleAcosh"
  atanh = primitive "doubleAtanh"

instance RealFrac Double where
  properFraction x = let n = primDoubleTruncate x in (fromInteger n, x - primDoubleFromInteger n)
  truncate x = fromInteger (primDoubleTruncate x)
  round x = fromInteger (roundDouble x)
  ceiling x = fromInteger (ceilingDouble x)
  floor x = fromInteger (floorDouble x)

primDoubleTruncate :: Double -> Integer
primDoubleTruncate = primitive "doubleTruncate"

primDoubleFromInteger :: Integer -> Double
primDoubleFromInteger = primitive "doubleFromInteger"

roundDouble :: Double -> Integer
roundDouble x = let n = primDoubleTruncate x
                    r = x - primDoubleFromInteger n
                    m = if r < 0.0 then n - 1 else n + 1
                    half = abs r - 0.5
                in if half < 0.0 then n else if half == 0.0 then (if even n then n else m) else m

ceilingDouble :: Double -> Integer
ceilingDouble x = let n = primDoubleTruncate x in if x - primDoubleFromInteger n > 0.0 then n + 1 else n

floorDouble :: Double -> Integer
floorDouble x = let n = primDoubleTruncate x in if x - primDoubleFromInteger n < 0.0 then n - 1 else n

instance RealFloat Double where
  floatRadix _ = 2
  floatDigits _ = 53
  floatRange _ = (-1021, 1024)
  decodeFloat = primitive "doubleDecode"
  encodeFloat = primitive "doubleEncode"
  isNaN = primitive "doubleIsNaN"
  isInfinite = primitive "doubleIsInfinite"
  isDenormalized x = x /= 0.0 && abs x < 2.2250738585072014e-308
  isNegativeZero = primitive "doubleIsNegativeZero"
  isIEEE _ = True
  atan2 = primitive "doubleAtan2"

instance Num Float where
  (+) = primitive "floatAdd"
  (-) = primitive "floatSub"
  (*) = primitive "floatMul"
  negate = primitive "floatNegate"
  abs = primitive "floatAbs"
  signum = primitive "floatSignum"
  fromInteger = primitive "floatFromInteger"

instance Real Float where
  toRational x = floatToRational x

instance Fractional Float where
  (/) = primitive "floatDiv"
  recip x = 1.0 / x
  fromRational (n :% d) = primFloatFromRational n d

primFloatFromRational :: Integer -> Integer -> Float
primFloatFromRational = primitive "floatFromRational"

instance Floating Float where
  pi = 3.1415927
  exp = primitive "floatExp"
  log = primitive "floatLog"
  sqrt = primitive "floatSqrt"
  (**) = primitive "floatPow"
  logBase = primitive "floatLogBase"
  sin = primitive "floatSin"
  cos = primitive "floatCos"
  tan = primitive "floatTan"
  asin = primitive "floatAsin"
  acos = primitive "floatAcos"
  atan = primitive "floatAtan"
  sinh = primitive "floatSinh"
  cosh = primitive "floatCosh"
  tanh = primitive "floatTanh"
  asinh = primitive "floatAsinh"
  acosh = primitive "floatAcosh"
  atanh = primitive "floatAtanh"

instance RealFrac Float where
  properFraction x = let n = primFloatTruncate x in (fromInteger n, x - primFloatFromInteger n)
  truncate x = fromInteger (primFloatTruncate x)
  round x = fromInteger (roundFloat x)
  ceiling x = fromInteger (let n = primFloatTruncate x in if x - primFloatFromInteger n > 0.0 then n + 1 else n)
  floor x = fromInteger (let n = primFloatTruncate x in if x - primFloatFromInteger n < 0.0 then n - 1 else n)

primFloatTruncate :: Float -> Integer
primFloatTruncate = primitive "floatTruncate"

primFloatFromInteger :: Integer -> Float
primFloatFromInteger = primitive "floatFromInteger"

roundFloat :: Float -> Integer
roundFloat x = let n = primFloatTruncate x
                   r = x - primFloatFromInteger n
                   m = if r < 0.0 then n - 1 else n + 1
                   half = abs r - 0.5
               in if half < 0.0 then n else if half == 0.0 then (if even n then n else m) else m

instance RealFloat Float where
  floatRadix _ = 2
  floatDigits _ = 24
  floatRange _ = (-125, 128)
  decodeFloat = primitive "floatDecode"
  encodeFloat = primitive "floatEncode"
  isNaN = primitive "floatIsNaN"
  isInfinite = primitive "floatIsInfinite"
  isDenormalized x = x /= 0.0 && abs x < 1.17549435e-38
  isNegativeZero = primitive "floatIsNegativeZero"
  isIEEE _ = True
  atan2 = primitive "floatAtan2"

floatToRational :: RealFloat a => a -> Rational
floatToRational x = let (m, e) = decodeFloat x
                    in if e >= 0 then (m * 2 ^ e) :% 1 else reduce m (2 ^ negate e)

-- Rationals

reduce :: Integral a => a -> a -> Ratio a
reduce x y = if y == fromInteger 0 then errorWithoutStackTrace "Ratio has zero denominator"
             else let d = gcd x y in (x ${BT}quot${BT} d) :% (y ${BT}quot${BT} d)

(%) :: Integral a => a -> a -> Ratio a
x % y = reduce (x * signum y) (abs y)

numerator :: Ratio a -> a
numerator (x :% _) = x

denominator :: Ratio a -> a
denominator (_ :% y) = y

instance Eq a => Eq (Ratio a) where
  (x :% y) == (x' :% y') = x == x' && y == y'

instance Integral a => Ord (Ratio a) where
  compare (x :% y) (x' :% y') = compare (x * y') (x' * y)

instance Integral a => Num (Ratio a) where
  (x :% y) + (x' :% y') = reduce (x * y' + x' * y) (y * y')
  (x :% y) - (x' :% y') = reduce (x * y' - x' * y) (y * y')
  (x :% y) * (x' :% y') = reduce (x * x') (y * y')
  negate (x :% y) = negate x :% y
  abs (x :% y) = abs x :% y
  signum (x :% _) = signum x :% fromInteger 1
  fromInteger x = fromInteger x :% fromInteger 1

instance Integral a => Fractional (Ratio a) where
  (x :% y) / (x' :% y') = (x * y') % (y * x')
  recip (x :% y) = if x == fromInteger 0 then errorWithoutStackTrace "Ratio has zero denominator"
                   else if x < fromInteger 0 then negate y :% negate x else y :% x
  fromRational (x :% y) = fromInteger x % fromInteger y

instance Integral a => Real (Ratio a) where
  toRational (x :% y) = toInteger x :% toInteger y

instance Integral a => RealFrac (Ratio a) where
  properFraction (x :% y) = let (q, r) = quotRem x y in (fromInteger (toInteger q), r :% y)

-- Enum and Bounded

class Enum a where
  succ, pred :: a -> a
  toEnum :: Int -> a
  fromEnum :: a -> Int
  enumFrom :: a -> [a]
  enumFromThen :: a -> a -> [a]
  enumFromTo :: a -> a -> [a]
  enumFromThenTo :: a -> a -> a -> [a]
  succ = toEnum . (\x -> x + 1) . fromEnum
  pred = toEnum . (\x -> x - 1) . fromEnum
  enumFrom x = map toEnum [fromEnum x ..]
  enumFromThen x y = map toEnum [fromEnum x, fromEnum y ..]
  enumFromTo x y = map toEnum [fromEnum x .. fromEnum y]
  enumFromThenTo x1 x2 y = map toEnum [fromEnum x1, fromEnum x2 .. fromEnum y]

class Bounded a where
  minBound, maxBound :: a

boundedEnumFrom :: (Enum a, Bounded a) => a -> [a]
boundedEnumFrom n = enumFromTo n maxBound

boundedEnumFromThen :: (Enum a, Bounded a) => a -> a -> [a]
boundedEnumFromThen n1 n2 = if fromEnum n2 >= fromEnum n1 then enumFromThenTo n1 n2 maxBound
                            else enumFromThenTo n1 n2 minBound

derivedToEnum :: [Char] -> [a] -> Int -> a
derivedToEnum name cons n =
  if n >= 0 && n < length cons then cons !! n
  else errorWithoutStackTrace ("Enum.toEnum{" ++ name ++ "}: tag (" ++ show n ++ ") is outside of enumeration's range (0," ++ show (length cons - 1) ++ ")")

derivedSucc :: [Char] -> [a] -> Int -> a
derivedSucc name cons n =
  if n + 1 >= length cons then errorWithoutStackTrace ("Enum.succ{" ++ name ++ "}: tried to take ${BT}succ' of last tag in enumeration")
  else cons !! (n + 1)

derivedPred :: [Char] -> [a] -> Int -> a
derivedPred name cons n =
  if n == 0 then errorWithoutStackTrace ("Enum.pred{" ++ name ++ "}: tried to take ${BT}pred' of first tag in enumeration")
  else cons !! (n - 1)

derivedEnumFrom :: [a] -> Int -> [a]
derivedEnumFrom cons n = drop n cons

derivedEnumFromThen :: [a] -> Int -> Int -> [a]
derivedEnumFromThen cons a b =
  let limit = if b >= a then length cons - 1 else 0
  in map (cons !!) (enumFromThenTo a b limit)

instance Enum Bool where
  succ False = True
  succ True = errorWithoutStackTrace "Prelude.Enum.Bool.succ: bad argument"
  pred True = False
  pred False = errorWithoutStackTrace "Prelude.Enum.Bool.pred: bad argument"
  toEnum n = if n == 0 then False else if n == 1 then True else errorWithoutStackTrace "Prelude.Enum.Bool.toEnum: bad argument"
  fromEnum False = 0
  fromEnum True = 1
  enumFrom = boundedEnumFrom
  enumFromThen = boundedEnumFromThen

instance Bounded Bool where
  minBound = False
  maxBound = True

instance Enum Ordering where
  succ LT = EQ
  succ EQ = GT
  succ GT = errorWithoutStackTrace "Prelude.Enum.Ordering.succ: bad argument"
  pred GT = EQ
  pred EQ = LT
  pred LT = errorWithoutStackTrace "Prelude.Enum.Ordering.pred: bad argument"
  toEnum n = if n == 0 then LT else if n == 1 then EQ else if n == 2 then GT else errorWithoutStackTrace "Prelude.Enum.Ordering.toEnum: bad argument"
  fromEnum x = primConTag x
  enumFrom = boundedEnumFrom
  enumFromThen = boundedEnumFromThen

instance Bounded Ordering where
  minBound = LT
  maxBound = GT

instance Enum () where
  succ _ = errorWithoutStackTrace "Prelude.Enum.().succ: bad argument"
  pred _ = errorWithoutStackTrace "Prelude.Enum.().pred: bad argument"
  toEnum n = if n == 0 then () else errorWithoutStackTrace "Prelude.Enum.().toEnum: bad argument"
  fromEnum () = 0
  enumFrom () = [()]
  enumFromThen () () = repeat ()
  enumFromTo () () = [()]
  enumFromThenTo () () () = repeat ()

instance Bounded () where
  minBound = ()
  maxBound = ()

instance Bounded Int where
  minBound = -9223372036854775808
  maxBound = 9223372036854775807

instance Enum Int where
  succ x = if x == maxBound then errorWithoutStackTrace "Enum.succ{Int}: tried to take ${BT}succ' of last tag in enumeration" else x + 1
  pred x = if x == minBound then errorWithoutStackTrace "Enum.pred{Int}: tried to take ${BT}pred' of first tag in enumeration" else x - 1
  toEnum x = x
  fromEnum x = x
  enumFrom x = enumFromTo x maxBound
  enumFromTo x y = if x > y then [] else intUpTo x y
  enumFromThen x y = enumFromThenTo x y (if y >= x then maxBound else minBound)
  enumFromThenTo x1 x2 y = intFromThenTo x1 x2 y

intUpTo :: Int -> Int -> [Int]
intUpTo x y = x : (if x == y then [] else intUpTo (x + 1) y)

intFromThenTo :: Int -> Int -> Int -> [Int]
intFromThenTo x1 x2 y =
  if x2 >= x1
    then (if x1 > y then [] else upFrom x1)
    else (if x1 < y then [] else downFrom x1)
  where
    delta = toInteger x2 - toInteger x1
    upFrom x = x : (let next = toInteger x + delta in if next > toInteger y then [] else upFrom (fromInteger next))
    downFrom x = x : (let next = toInteger x + delta in if next < toInteger y then [] else downFrom (fromInteger next))

instance Enum Integer where
  succ x = x + 1
  pred x = x - 1
  toEnum x = toInteger x
  fromEnum x = fromInteger x
  enumFrom x = x : enumFrom (x + 1)
  enumFromTo x y = if x > y then [] else x : enumFromTo (x + 1) y
  enumFromThen x y = x : enumFromThen y (y + y - x)
  enumFromThenTo x1 x2 y =
    if x2 >= x1
      then (if x1 > y then [] else x1 : enumFromThenTo x2 (x2 + x2 - x1) y)
      else (if x1 < y then [] else x1 : enumFromThenTo x2 (x2 + x2 - x1) y)

instance Bounded Char where
  minBound = '\0'
  maxBound = '\1114111'

instance Enum Char where
  succ c = if c == maxBound then errorWithoutStackTrace "Prelude.Enum.Char.succ: bad argument" else chr (ord c + 1)
  pred c = if c == minBound then errorWithoutStackTrace "Prelude.Enum.Char.pred: bad argument" else chr (ord c - 1)
  toEnum = chr
  fromEnum = ord
  enumFrom c = map chr (enumFromTo (ord c) 1114111)
  enumFromTo a b = map chr (enumFromTo (ord a) (ord b))
  enumFromThen a b = map chr (enumFromThenTo (ord a) (ord b) (if b >= a then 1114111 else 0))
  enumFromThenTo a b c = map chr (enumFromThenTo (ord a) (ord b) (ord c))

ord :: Char -> Int
ord = primitive "ord"

chr :: Int -> Char
chr = primitive "chr"

numericEnumFrom :: Fractional a => a -> [a]
numericEnumFrom n = go 0
  where go k = (n + fromInteger k) : go (k + 1)

numericEnumFromThen :: Fractional a => a -> a -> [a]
numericEnumFromThen n m = go 0
  where step = m - n
        go k = (n + fromInteger k * step) : go (k + 1)

numericEnumFromTo :: (Ord a, Fractional a) => a -> a -> [a]
numericEnumFromTo n m = takeWhile (<= m + fromRational (1 :% 2)) (numericEnumFrom n)

numericEnumFromThenTo :: (Ord a, Fractional a) => a -> a -> a -> [a]
numericEnumFromThenTo e1 e2 e3 = takeWhile predicate (numericEnumFromThen e1 e2)
  where mid = (e2 - e1) / fromInteger 2
        predicate x = if e2 >= e1 then x <= e3 + mid else x >= e3 + mid

instance Enum Double where
  succ x = x + 1.0
  pred x = x - 1.0
  toEnum = fromIntegral
  fromEnum x = fromInteger (primDoubleTruncate x)
  enumFrom = numericEnumFrom
  enumFromTo = numericEnumFromTo
  enumFromThen = numericEnumFromThen
  enumFromThenTo = numericEnumFromThenTo

instance Enum Float where
  succ x = x + 1.0
  pred x = x - 1.0
  toEnum = fromIntegral
  fromEnum x = fromInteger (primFloatTruncate x)
  enumFrom = numericEnumFrom
  enumFromTo = numericEnumFromTo
  enumFromThen = numericEnumFromThen
  enumFromThenTo = numericEnumFromThenTo

instance Integral a => Enum (Ratio a) where
  succ x = x + fromInteger 1
  pred x = x - fromInteger 1
  toEnum n = fromInteger (toInteger n) :% fromInteger 1
  fromEnum x = fromInteger (truncate x)
  enumFrom = numericEnumFrom
  enumFromTo = numericEnumFromTo
  enumFromThen = numericEnumFromThen
  enumFromThenTo = numericEnumFromThenTo
`;
