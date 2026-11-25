import { BT } from './source';

export const BASE_MISC = String.raw`
-- IO

instance Functor IO where
  fmap f m = m >>= \x -> return (f x)

instance Applicative IO where
  pure = primitive "ioReturn"
  m <*> n = m >>= \f -> n >>= \x -> return (f x)
  liftA2 f m n = m >>= \x -> n >>= \y -> return (f x y)
  (*>) = primitive "ioThen"
  m <* n = m >>= \x -> n >> return x

instance Monad IO where
  (>>=) = primitive "ioBind"
  (>>) = primitive "ioThen"
  return = primitive "ioReturn"

instance MonadFail IO where
  fail = primitive "failIO"

instance Semigroup a => Semigroup (IO a) where
  a <> b = liftA2 (<>) a b

instance Monoid a => Monoid (IO a) where
  mempty = pure mempty

returnIO :: a -> IO a
returnIO = primitive "ioReturn"

putStr :: String -> IO ()
putStr = primitive "putStr"

putStrLn :: String -> IO ()
putStrLn = primitive "putStrLn"

putChar :: Char -> IO ()
putChar c = putStr [c]

-- Turtles

newTurtle :: IO Turtle
newTurtle = primitive "newTurtle"

newTurtleAt :: Int -> Int -> IO Turtle
newTurtleAt = primitive "newTurtleAt"

newTurtleWithColor :: Int -> Int -> String -> IO Turtle
newTurtleWithColor = primitive "newTurtleWithColor"

forward :: Turtle -> IO ()
forward = primitive "turtle:forward"

${'前に進む'} :: Turtle -> IO ()
${'前に進む'} = primitive "turtle:${'前に進む'}"

backward :: Turtle -> IO ()
backward = primitive "turtle:backward"

${'後に戻る'} :: Turtle -> IO ()
${'後に戻る'} = primitive "turtle:${'後に戻る'}"

turnRight :: Turtle -> IO ()
turnRight = primitive "turtle:turnRight"

${'右を向く'} :: Turtle -> IO ()
${'右を向く'} = primitive "turtle:${'右を向く'}"

turnLeft :: Turtle -> IO ()
turnLeft = primitive "turtle:turnLeft"

${'左を向く'} :: Turtle -> IO ()
${'左を向く'} = primitive "turtle:${'左を向く'}"

canMoveForward :: Turtle -> IO Bool
canMoveForward = primitive "turtle:canMoveForward"

${'前に進めるか'} :: Turtle -> IO Bool
${'前に進めるか'} = primitive "turtle:${'前に進めるか'}"

${'前のマスが塗られているか'} :: Turtle -> IO Bool
${'前のマスが塗られているか'} = primitive "turtle:${'前のマスが塗られているか'}"

remove :: Turtle -> IO ()
remove = primitive "turtle:remove"

-- Data.Char

data GeneralCategory
  = UppercaseLetter | LowercaseLetter | TitlecaseLetter | ModifierLetter | OtherLetter
  | NonSpacingMark | SpacingCombiningMark | EnclosingMark
  | DecimalNumber | LetterNumber | OtherNumber
  | ConnectorPunctuation | DashPunctuation | OpenPunctuation | ClosePunctuation
  | InitialQuote | FinalQuote | OtherPunctuation
  | MathSymbol | CurrencySymbol | ModifierSymbol | OtherSymbol
  | Space | LineSeparator | ParagraphSeparator
  | Control | Format | Surrogate | PrivateUse | NotAssigned
  deriving (Show, Eq, Ord, Enum, Bounded)

generalCategory :: Char -> GeneralCategory
generalCategory c = toEnum (primitive "generalCategory" c)

isAscii :: Char -> Bool
isAscii c = c < '\x80'

isLatin1 :: Char -> Bool
isLatin1 c = c <= '\xff'

isControl :: Char -> Bool
isControl c = generalCategory c == Control

isAsciiUpper :: Char -> Bool
isAsciiUpper c = c >= 'A' && c <= 'Z'

isAsciiLower :: Char -> Bool
isAsciiLower c = c >= 'a' && c <= 'z'

isPrint :: Char -> Bool
isPrint c = case generalCategory c of
  LineSeparator -> False
  ParagraphSeparator -> False
  Control -> False
  Format -> False
  Surrogate -> False
  PrivateUse -> False
  NotAssigned -> False
  _ -> True

isSpace :: Char -> Bool
isSpace = primitive "isSpace"

isUpper :: Char -> Bool
isUpper c = case generalCategory c of
  UppercaseLetter -> True
  TitlecaseLetter -> True
  _ -> False

isUpperCase :: Char -> Bool
isUpperCase c = generalCategory c == UppercaseLetter || (c >= '\x2160' && c <= '\x216f') || (c >= '\x24b6' && c <= '\x24cf') || (c >= '\x1f130' && c <= '\x1f149') || (c >= '\x1f150' && c <= '\x1f169') || (c >= '\x1f170' && c <= '\x1f189')

isLower :: Char -> Bool
isLower c = generalCategory c == LowercaseLetter

isLowerCase :: Char -> Bool
isLowerCase c = generalCategory c == LowercaseLetter || c == '\xaa' || c == '\xba' || (c >= '\x2b0' && c <= '\x2b8') || (c >= '\x2c0' && c <= '\x2c1') || (c >= '\x2e0' && c <= '\x2e4') || c == '\x345' || c == '\x37a' || c == '\x10fc' || (c >= '\x1d2c' && c <= '\x1d6a') || c == '\x1d78' || (c >= '\x1d9b' && c <= '\x1dbf') || c == '\x2071' || c == '\x207f' || (c >= '\x2090' && c <= '\x209c') || (c >= '\x2170' && c <= '\x217f') || (c >= '\x24d0' && c <= '\x24e9') || (c >= '\x2c7c' && c <= '\x2c7d') || (c >= '\xa69c' && c <= '\xa69d') || c == '\xa770' || (c >= '\xa7f1' && c <= '\xa7f4') || (c >= '\xa7f8' && c <= '\xa7f9') || (c >= '\xab5c' && c <= '\xab5f') || c == '\xab69' || c == '\x10780' || (c >= '\x10783' && c <= '\x10785') || (c >= '\x10787' && c <= '\x107b0') || (c >= '\x107b2' && c <= '\x107ba') || (c >= '\x1e030' && c <= '\x1e06d')

isAlpha :: Char -> Bool
isAlpha c = case generalCategory c of
  UppercaseLetter -> True
  LowercaseLetter -> True
  TitlecaseLetter -> True
  ModifierLetter -> True
  OtherLetter -> True
  _ -> False

isLetter :: Char -> Bool
isLetter = isAlpha

isDigit :: Char -> Bool
isDigit c = c >= '0' && c <= '9'

isOctDigit :: Char -> Bool
isOctDigit c = c >= '0' && c <= '7'

isHexDigit :: Char -> Bool
isHexDigit c = isDigit c || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')

isAlphaNum :: Char -> Bool
isAlphaNum c = case generalCategory c of
  UppercaseLetter -> True
  LowercaseLetter -> True
  TitlecaseLetter -> True
  ModifierLetter -> True
  OtherLetter -> True
  DecimalNumber -> True
  LetterNumber -> True
  OtherNumber -> True
  _ -> False

isNumber :: Char -> Bool
isNumber c = case generalCategory c of
  DecimalNumber -> True
  LetterNumber -> True
  OtherNumber -> True
  _ -> False

isMark :: Char -> Bool
isMark c = case generalCategory c of
  NonSpacingMark -> True
  SpacingCombiningMark -> True
  EnclosingMark -> True
  _ -> False

isPunctuation :: Char -> Bool
isPunctuation c = case generalCategory c of
  ConnectorPunctuation -> True
  DashPunctuation -> True
  OpenPunctuation -> True
  ClosePunctuation -> True
  InitialQuote -> True
  FinalQuote -> True
  OtherPunctuation -> True
  _ -> False

isSymbol :: Char -> Bool
isSymbol c = case generalCategory c of
  MathSymbol -> True
  CurrencySymbol -> True
  ModifierSymbol -> True
  OtherSymbol -> True
  _ -> False

isSeparator :: Char -> Bool
isSeparator c = case generalCategory c of
  Space -> True
  LineSeparator -> True
  ParagraphSeparator -> True
  _ -> False

toUpper :: Char -> Char
toUpper = primitive "toUpper"

toLower :: Char -> Char
toLower = primitive "toLower"

toTitle :: Char -> Char
toTitle = primitive "toTitle"

-- Data.List

foldl1' :: (a -> a -> a) -> [a] -> a
foldl1' f (x:xs) = listFoldl' f x xs
foldl1' _ [] = errorEmptyList "foldl1'"

sort :: Ord a => [a] -> [a]
sort = actualSort (>)

sortOn :: Ord b => (a -> b) -> [a] -> [a]
sortOn f = map snd . sortBy (comparing fst) . map (\x -> let y = f x in y ${BT}seq${BT} (y, x))

sortBy :: (a -> a -> Ordering) -> [a] -> [a]
sortBy cmp = actualSort (\x y -> cmp x y == GT)

-- GHC's merge sort, which takes whether one element is greater than another.
actualSort :: (a -> a -> Bool) -> [a] -> [a]
actualSort gt = mergeAll . sequences
  where
    sequences (a:b:xs) = if a ${BT}gt${BT} b then descending b [a] xs else ascending b (\ys -> a : ys) xs
    sequences xs = [xs]
    descending a as' (b:bs) = if a ${BT}gt${BT} b then descending b (a : as') bs else (a : as') : sequences (b : bs)
    descending a as' bs = (a : as') : sequences bs
    ascending a as' (b:bs) = if not (a ${BT}gt${BT} b) then ascending b (\ys -> as' (a : ys)) bs else let x = as' [a] in x ${BT}seq${BT} (x : sequences (b : bs))
    ascending a as' bs = let x = as' [a] in x ${BT}seq${BT} (x : sequences bs)
    mergeAll [x] = x
    mergeAll xs = mergeAll (mergePairs xs)
    mergePairs (a:b:xs) = let x = merge a b in x ${BT}seq${BT} (x : mergePairs xs)
    mergePairs xs = xs
    merge as'@(a:as2) bs'@(b:bs2) = if a ${BT}gt${BT} b then b : merge as' bs2 else a : merge as2 bs'
    merge [] bs' = bs'
    merge as' [] = as'

insert :: Ord a => a -> [a] -> [a]
insert e ls = insertBy compare e ls

insertBy :: (a -> a -> Ordering) -> a -> [a] -> [a]
insertBy _ x [] = [x]
insertBy cmp x ys@(y:ys') = case cmp x y of
  GT -> y : insertBy cmp x ys'
  _ -> x : ys

nub :: Eq a => [a] -> [a]
nub = nubBy (==)

nubBy :: (a -> a -> Bool) -> [a] -> [a]
nubBy eq l = nubBy' l []
  where nubBy' [] _ = []
        nubBy' (y:ys) xs = if elemBy eq y xs then nubBy' ys xs else y : nubBy' ys (y : xs)
        elemBy _ _ [] = False
        elemBy e y (x:xs) = e x y || elemBy e y xs

delete :: Eq a => a -> [a] -> [a]
delete = deleteBy (==)

deleteBy :: (a -> a -> Bool) -> a -> [a] -> [a]
deleteBy _ _ [] = []
deleteBy eq x (y:ys) = if x ${BT}eq${BT} y then ys else y : deleteBy eq x ys

(\\) :: Eq a => [a] -> [a] -> [a]
(\\) = foldl (flip delete)

union :: Eq a => [a] -> [a] -> [a]
union = unionBy (==)

unionBy :: (a -> a -> Bool) -> [a] -> [a] -> [a]
unionBy eq xs ys = xs ++ foldl (flip (deleteBy eq)) (nubBy eq ys) xs

intersect :: Eq a => [a] -> [a] -> [a]
intersect = intersectBy (==)

intersectBy :: (a -> a -> Bool) -> [a] -> [a] -> [a]
intersectBy _ [] _ = []
intersectBy _ _ [] = []
intersectBy eq xs ys = [x | x <- xs, any (eq x) ys]

group :: Eq a => [a] -> [[a]]
group = groupBy (==)

groupBy :: (a -> a -> Bool) -> [a] -> [[a]]
groupBy _ [] = []
groupBy eq (x:xs) = let (ys, zs) = span (eq x) xs in (x : ys) : groupBy eq zs

partition :: (a -> Bool) -> [a] -> ([a], [a])
partition _ [] = ([],[])
partition p (x:xs) = let (yes,no) = partition p xs
                     in if p x then (x:yes,no) else (yes,x:no)

intersperse :: a -> [a] -> [a]
intersperse _ [] = []
intersperse sep (x:xs) = x : prependToAll sep xs

prependToAll :: a -> [a] -> [a]
prependToAll _ [] = []
prependToAll sep (x:xs) = sep : x : prependToAll sep xs

intercalate :: [a] -> [[a]] -> [a]
intercalate xs xss = concat (intersperse xs xss)

transpose :: [[a]] -> [[a]]
transpose [] = []
transpose ([] : xss) = transpose xss
transpose ((x:xs) : xss) = (x : [h | (h:_) <- xss]) : transpose (xs : [t | (_:t) <- xss])

subsequences :: [a] -> [[a]]
subsequences xs = [] : nonEmptySubsequences xs

nonEmptySubsequences :: [a] -> [[a]]
nonEmptySubsequences [] = []
nonEmptySubsequences (x:xs) = [x] : foldr f [] (nonEmptySubsequences xs)
  where f ys r = ys : (x : ys) : r

permutations :: [a] -> [[a]]
permutations xs0 = xs0 : perms xs0 []
  where
    perms [] _ = []
    perms (t:ts) is' = foldr interleave (perms ts (t : is')) (permutations is')
      where interleave xs r = let (_, zs) = interleave' id xs r in zs
            interleave' _ [] r = (ts, r)
            interleave' f (y:ys) r = let (us, zs) = interleave' (f . (y:)) ys r
                                     in (y : us, f (t : y : us) : zs)

isPrefixOf :: Eq a => [a] -> [a] -> Bool
isPrefixOf [] _ = True
isPrefixOf _ [] = False
isPrefixOf (x:xs) (y:ys) = x == y && isPrefixOf xs ys

isSuffixOf :: Eq a => [a] -> [a] -> Bool
isSuffixOf ns hs = case dropNeedle ns hs of
  Nothing -> False
  Just delta -> ns == dropDelta delta hs
  where dropNeedle [] ys = Just ys
        dropNeedle _ [] = Nothing
        dropNeedle (_:xs) (_:ys) = dropNeedle xs ys
        dropDelta [] ys = ys
        dropDelta _ [] = []
        dropDelta (_:xs) (_:ys) = dropDelta xs ys

isInfixOf :: Eq a => [a] -> [a] -> Bool
isInfixOf needle haystack = any (isPrefixOf needle) (tails haystack)

isSubsequenceOf :: Eq a => [a] -> [a] -> Bool
isSubsequenceOf [] _ = True
isSubsequenceOf _ [] = False
isSubsequenceOf a@(x:a') (y:b) = if x == y then isSubsequenceOf a' b else isSubsequenceOf a b

findIndex :: (a -> Bool) -> [a] -> Maybe Int
findIndex p = listToMaybe . findIndices p

findIndices :: (a -> Bool) -> [a] -> [Int]
findIndices p xs = [i | (x, i) <- zip xs [0..], p x]

elemIndex :: Eq a => a -> [a] -> Maybe Int
elemIndex x = findIndex (x ==)

elemIndices :: Eq a => a -> [a] -> [Int]
elemIndices x = findIndices (x ==)

inits :: [a] -> [[a]]
inits xs = [] : case xs of
  [] -> []
  (y:ys) -> map (y :) (inits ys)

tails :: [a] -> [[a]]
tails xs = xs : case xs of
  [] -> []
  (_:ys) -> tails ys

genericLength :: Num i => [a] -> i
genericLength [] = fromInteger 0
genericLength (_:l) = fromInteger 1 + genericLength l

genericTake :: Integral i => i -> [a] -> [a]
genericTake n _ | n <= fromInteger 0 = []
genericTake _ [] = []
genericTake n (x:xs) = x : genericTake (n - fromInteger 1) xs

genericDrop :: Integral i => i -> [a] -> [a]
genericDrop n xs | n <= fromInteger 0 = xs
genericDrop _ [] = []
genericDrop n (_:xs) = genericDrop (n - fromInteger 1) xs

genericSplitAt :: Integral i => i -> [a] -> ([a], [a])
genericSplitAt n xs | n <= 0 = ([],xs)
genericSplitAt _ [] = ([],[])
genericSplitAt n (x:xs) = let (a,b) = genericSplitAt (n-1) xs in (x:a,b)

genericIndex :: Integral i => [a] -> i -> a
genericIndex (x:_) n | n == fromInteger 0 = x
genericIndex (_:xs) n | n > fromInteger 0 = genericIndex xs (n - fromInteger 1)
                      | otherwise = errorWithoutStackTrace "List.genericIndex: negative argument."
genericIndex _ _ = errorWithoutStackTrace "List.genericIndex: index too large."

genericReplicate :: Integral i => i -> a -> [a]
genericReplicate n x = genericTake n (repeat x)

unfoldr :: (b -> Maybe (a, b)) -> b -> [a]
unfoldr f b0 = case f b0 of
  Just (a, b) -> a : unfoldr f b
  Nothing -> []

data Accum s a = Accum !(s -> (s,a))

runAccum :: Accum s a -> s -> (s,a)
runAccum (Accum f) = f

instance Functor (Accum s) where
  fmap f (Accum g) = Accum (\s -> let (next,x) = g s in (next,f x))

instance Applicative (Accum s) where
  pure x = Accum (\s -> (s,x))
  Accum f <*> Accum g = Accum (\s -> let (s1,h) = f s; (s2,x) = g s1 in (s2,h x))

data AccumR s a = AccumR !(s -> (s,a))

runAccumR :: AccumR s a -> s -> (s,a)
runAccumR (AccumR f) = f

instance Functor (AccumR s) where
  fmap f (AccumR g) = AccumR (\s -> let (next,x) = g s in (next,f x))

instance Applicative (AccumR s) where
  pure x = AccumR (\s -> (s,x))
  AccumR f <*> AccumR g = AccumR (\s -> let (s1,x) = g s; (s2,h) = f s1 in (s2,h x))

mapAccumL :: Traversable t => (s -> a -> (s,b)) -> s -> t a -> (s,t b)
mapAccumL f s xs = runAccum (traverse (\x -> Accum (\acc -> f acc x)) xs) s

mapAccumR :: Traversable t => (s -> a -> (s,b)) -> s -> t a -> (s,t b)
mapAccumR f s xs = runAccumR (traverse (\x -> AccumR (\acc -> f acc x)) xs) s

zip4 :: [a] -> [b] -> [c] -> [d] -> [(a, b, c, d)]
zip4 = zipWith4 (\a b c d -> (a, b, c, d))

zipWith4 :: (a -> b -> c -> d -> e) -> [a] -> [b] -> [c] -> [d] -> [e]
zipWith4 z (a:as') (b:bs) (c:cs) (d:ds) = z a b c d : zipWith4 z as' bs cs ds
zipWith4 _ _ _ _ _ = []

zip5 :: [a] -> [b] -> [c] -> [d] -> [e] -> [(a, b, c, d, e)]
zip5 = zipWith5 (\a b c d e -> (a, b, c, d, e))

zipWith5 :: (a -> b -> c -> d -> e -> f) -> [a] -> [b] -> [c] -> [d] -> [e] -> [f]
zipWith5 z (a:as') (b:bs) (c:cs) (d:ds) (e:es) = z a b c d e : zipWith5 z as' bs cs ds es
zipWith5 _ _ _ _ _ _ = []

zip6 :: [a] -> [b] -> [c] -> [d] -> [e] -> [f] -> [(a, b, c, d, e, f)]
zip6 = zipWith6 (\a b c d e f -> (a, b, c, d, e, f))

zipWith6 :: (a -> b -> c -> d -> e -> f -> g) -> [a] -> [b] -> [c] -> [d] -> [e] -> [f] -> [g]
zipWith6 z (a:as') (b:bs) (c:cs) (d:ds) (e:es) (f:fs) = z a b c d e f : zipWith6 z as' bs cs ds es fs
zipWith6 _ _ _ _ _ _ _ = []

zip7 :: [a] -> [b] -> [c] -> [d] -> [e] -> [f] -> [g] -> [(a, b, c, d, e, f, g)]
zip7 = zipWith7 (\a b c d e f g -> (a, b, c, d, e, f, g))

zipWith7 :: (a -> b -> c -> d -> e -> f -> g -> h) -> [a] -> [b] -> [c] -> [d] -> [e] -> [f] -> [g] -> [h]
zipWith7 z (a:as') (b:bs) (c:cs) (d:ds) (e:es) (f:fs) (g:gs) = z a b c d e f g : zipWith7 z as' bs cs ds es fs gs
zipWith7 _ _ _ _ _ _ _ _ = []

unzip4 :: [(a, b, c, d)] -> ([a], [b], [c], [d])
unzip4 [] = ([],[],[],[])
unzip4 ((a,b,c,d):xs) = let (as,bs,cs,ds) = unzip4 xs in (a:as,b:bs,c:cs,d:ds)

unzip5 :: [(a, b, c, d, e)] -> ([a], [b], [c], [d], [e])
unzip5 [] = ([],[],[],[],[])
unzip5 ((a,b,c,d,e):xs) = let (as,bs,cs,ds,es) = unzip5 xs in (a:as,b:bs,c:cs,d:ds,e:es)

unzip6 :: [(a, b, c, d, e, f)] -> ([a], [b], [c], [d], [e], [f])
unzip6 [] = ([],[],[],[],[],[])
unzip6 ((a,b,c,d,e,f):xs) = let (as,bs,cs,ds,es,fs) = unzip6 xs in (a:as,b:bs,c:cs,d:ds,e:es,f:fs)

unzip7 :: [(a, b, c, d, e, f, g)] -> ([a], [b], [c], [d], [e], [f], [g])
unzip7 [] = ([],[],[],[],[],[],[])
unzip7 ((a,b,c,d,e,f,g):xs) = let (as,bs,cs,ds,es,fs,gs) = unzip7 xs in (a:as,b:bs,c:cs,d:ds,e:es,f:fs,g:gs)

-- Data.Bits

class Eq a => Bits a where
  (.&.), (.|.), xor :: a -> a -> a
  complement :: a -> a
  shift :: a -> Int -> a
  shiftL, shiftR :: a -> Int -> a
  testBit :: a -> Int -> Bool
  setBit, clearBit, complementBit :: a -> Int -> a
  popCount :: a -> Int
  bit :: Int -> a
  zeroBits :: a
  rotate, rotateL, rotateR :: a -> Int -> a
  bitSize :: a -> Int
  bitSizeMaybe :: a -> Maybe Int
  isSigned :: a -> Bool
  unsafeShiftL, unsafeShiftR :: a -> Int -> a
  zeroBits = clearBit (bit 0) 0
  setBit x i = x .|. bit i
  clearBit x i = x .&. complement (bit i)
  complementBit x i = x ${BT}xor${BT} bit i
  bitSize x = fromMaybe (error "bitSize is undefined") (bitSizeMaybe x)
  shiftL = shift
  shiftR x n = shift x (negate n)
  rotateL = rotate
  rotateR x n = rotate x (negate n)
  unsafeShiftL = shiftL
  unsafeShiftR = shiftR
  shift x n = if n < 0 then shiftR x (negate n) else if n > 0 then shiftL x n else x
  rotate x n = if n < 0 then rotateR x (negate n) else if n > 0 then rotateL x n else x

builtinShift :: Bits a => a -> Int -> a
builtinShift x n = if n >= 0 then shiftL x n else if negate n < 0 then x else shiftR x (negate n)

instance Bits Int where
  shift x n = x ${BT}seq${BT} builtinShift x n
  rotate = primitive "intRotate"
  bitSize _ = 64
  bitSizeMaybe _ = Just 64
  isSigned _ = True
  (.&.) = primitive "intAnd"
  (.|.) = primitive "intOr"
  xor = primitive "intXor"
  complement = primitive "intComplement"
  shiftL = primitive "intShiftL"
  shiftR = primitive "intShiftR"
  testBit x i = (x .&. shiftL 1 i) /= 0
  setBit x i = x .|. shiftL 1 i
  clearBit x i = x .&. complement (shiftL 1 i)
  complementBit x i = x ${BT}xor${BT} shiftL 1 i
  popCount = primitive "intPopCount"
  bit i = shiftL 1 i
  zeroBits = 0

instance Bits Integer where
  shift = builtinShift
  rotate = shift
  bitSize _ = errorWithoutStackTrace "Data.Bits.bitSize(Integer)"
  bitSizeMaybe _ = Nothing
  isSigned _ = True
  (.&.) = primitive "integerAnd"
  (.|.) = primitive "integerOr"
  xor = primitive "integerXor"
  complement = primitive "integerComplement"
  shiftL x n = primitive "integerShiftL" x (toInteger n)
  shiftR x n = primitive "integerShiftR" x (toInteger n)
  testBit = primitive "integerTestBit"
  setBit = primitive "integerSetBit"
  clearBit = primitive "integerClearBit"
  complementBit = primitive "integerComplementBit"
  popCount x = fromInteger (primitive "integerPopCount" x)
  bit = primitive "integerBit"
  zeroBits = 0

instance Bits Word where
  shift x n = x ${BT}seq${BT} builtinShift x n
  rotate = primitive "wordRotate"
  bitSize _ = 64
  bitSizeMaybe _ = Just 64
  isSigned _ = False
  (.&.) = primitive "wordAnd"
  (.|.) = primitive "wordOr"
  xor = primitive "wordXor"
  complement = primitive "wordComplement"
  shiftL x n = primitive "wordShiftL" x (toInteger n)
  shiftR x n = primitive "wordShiftR" x (toInteger n)
  testBit x i = (x .&. shiftL 1 i) /= 0
  setBit x i = x .|. shiftL 1 i
  clearBit x i = x .&. complement (shiftL 1 i)
  complementBit x i = x ${BT}xor${BT} shiftL 1 i
  popCount x = fromInteger (primitive "wordPopCount" x)
  bit i = shiftL 1 i
  zeroBits = 0

instance Bits Bool where
  shift x n = if n == 0 then x else False
  rotate x _ = x
  bitSize _ = 1
  bitSizeMaybe _ = Just 1
  isSigned _ = False
  (.&.) = (&&)
  (.|.) = (||)
  xor a b = a /= b
  complement = not
  shiftL = shift
  shiftR = shift
  testBit x i = i == 0 && x
  setBit x i = if i == 0 then True else x
  clearBit x i = if i == 0 then False else x
  complementBit x i = if i == 0 then not x else x
  popCount x = if x then 1 else 0
  bit i = i == 0
  zeroBits = False

class Bits a => FiniteBits a where
  finiteBitSize :: a -> Int
  countLeadingZeros, countTrailingZeros :: a -> Int
  countLeadingZeros x = (w-1) - go (w-1)
    where w = finiteBitSize x
          go i = if i < 0 then i else if testBit x i then i else go (i-1)
  countTrailingZeros x = go 0
    where w = finiteBitSize x
          go i = if i >= w then i else if testBit x i then i else go (i+1)

instance FiniteBits Int where
  finiteBitSize _ = 64
  countLeadingZeros = primitive "leadingZeros64"
  countTrailingZeros = primitive "trailingZeros64"

instance FiniteBits Word where
  finiteBitSize _ = 64
  countLeadingZeros x = primitive "leadingZeros64" (toInteger x)
  countTrailingZeros x = primitive "trailingZeros64" (toInteger x)

instance FiniteBits Bool where
  finiteBitSize _ = 1
  countLeadingZeros x = if x then 0 else 1
  countTrailingZeros x = if x then 0 else 1

-- Data.Ord

data Down a = Down { getDown :: !a }

instance Eq a => Eq (Down a) where
  Down a == Down b = a == b

instance Ord a => Ord (Down a) where
  compare (Down x) (Down y) = compare y x
  Down x < Down y = y < x
  Down x > Down y = y > x
  Down x <= Down y = y <= x
  Down x >= Down y = y >= x
  min (Down x) (Down y) = Down (max y x)
  max (Down x) (Down y) = Down (min y x)

instance Show a => Show (Down a) where
  showsPrec d (Down x) = showParen (d >= 11) (showString "Down " . showsPrec 11 x)

instance Read a => Read (Down a) where
  readsPrec d = readParen (d > 10) (\r -> [(Down x,t) | ("Down",s) <- lex r, (x,t) <- readsPrec 11 s])

instance Bounded a => Bounded (Down a) where
  minBound = Down maxBound
  maxBound = Down minBound

instance (Enum a, Bounded a, Eq a) => Enum (Down a) where
  succ (Down x) = Down (pred x)
  pred (Down x) = Down (succ x)
  fromEnum (Down x) = complement (fromEnum x)
  toEnum n = Down (toEnum (complement n))
  enumFrom (Down x) = if x == minBound then [Down x] else map Down (enumFromThen x (pred x))
  enumFromThen (Down x) (Down y) = map Down (enumFromThen x y)

instance Functor Down where
  fmap f (Down x) = Down (f x)

instance Applicative Down where
  pure = Down
  Down f <*> Down x = Down (f x)

instance Monad Down where
  Down x >>= f = f x

instance Foldable Down where
  foldMap f (Down x) = f x

instance Traversable Down where
  traverse f (Down x) = Down <$> f x

instance Semigroup a => Semigroup (Down a) where
  Down x <> Down y = Down (x <> y)
  stimes n (Down x) = Down (stimes n x)

instance Monoid a => Monoid (Down a) where
  mempty = Down mempty

instance Num a => Num (Down a) where
  Down x + Down y = Down (x + y)
  Down x - Down y = Down (x - y)
  Down x * Down y = Down (x * y)
  negate (Down x) = Down (negate x)
  abs (Down x) = Down (abs x)
  signum (Down x) = Down (signum x)
  fromInteger x = Down (fromInteger x)

instance Real a => Real (Down a) where
  toRational (Down x) = toRational x

instance Fractional a => Fractional (Down a) where
  Down x / Down y = Down (x / y)
  recip (Down x) = Down (recip x)
  fromRational x = Down (fromRational x)
  fromDecimalText text = Down (fromDecimalText text)

instance RealFrac a => RealFrac (Down a) where
  properFraction (Down x) = let (i,f) = properFraction x in (i,Down f)

instance Floating a => Floating (Down a) where
  pi = Down pi
  Down x ** Down y = Down (x ** y)
  logBase (Down x) (Down y) = Down (logBase x y)
  exp (Down x) = Down (exp x)
  log (Down x) = Down (log x)
  sqrt (Down x) = Down (sqrt x)
  sin (Down x) = Down (sin x)
  cos (Down x) = Down (cos x)
  tan (Down x) = Down (tan x)
  asin (Down x) = Down (asin x)
  acos (Down x) = Down (acos x)
  atan (Down x) = Down (atan x)
  sinh (Down x) = Down (sinh x)
  cosh (Down x) = Down (cosh x)
  tanh (Down x) = Down (tanh x)
  asinh (Down x) = Down (asinh x)
  acosh (Down x) = Down (acosh x)
  atanh (Down x) = Down (atanh x)

instance RealFloat a => RealFloat (Down a) where
  floatRadix (Down x) = floatRadix x
  floatDigits (Down x) = floatDigits x
  floatRange (Down x) = floatRange x
  decodeFloat (Down x) = decodeFloat x
  encodeFloat m e = Down (encodeFloat m e)
  exponent (Down x) = exponent x
  significand (Down x) = Down (significand x)
  scaleFloat n (Down x) = Down (scaleFloat n x)
  atan2 (Down y) (Down x) = Down (atan2 y x)
  isNaN (Down x) = isNaN x
  isInfinite (Down x) = isInfinite x
  isDenormalized (Down x) = isDenormalized x
  isNegativeZero (Down x) = isNegativeZero x
  isIEEE (Down x) = isIEEE x

`;
