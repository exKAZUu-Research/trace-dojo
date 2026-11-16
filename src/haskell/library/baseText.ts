import { BT } from './source';

/** `Show` and `Read`, the lexer they share, number formatting as GHC.Float does it, and `Numeric`. */
export const BASE_TEXT = String.raw`
class Show a where
  showsPrec :: Int -> a -> ShowS
  show :: a -> String
  showList :: [a] -> ShowS
  showsPrec _ x s = show x ++ s
  show x = showsPrec 0 x ""
  showList ls s = showListWith shows ls s

showListWith :: (a -> ShowS) -> [a] -> ShowS
showListWith _ [] s = "[]" ++ s
showListWith showx (x:xs) s = '[' : showx x (showl xs)
  where showl [] = ']' : s
        showl (y:ys) = ',' : showx y (showl ys)

shows :: Show a => a -> ShowS
shows = showsPrec 0

showChar :: Char -> ShowS
showChar = (:)

showString :: String -> ShowS
showString = (++)

showParen :: Bool -> ShowS -> ShowS
showParen b p = if b then showChar '(' . p . showChar ')' else p

showSpace :: ShowS
showSpace = \xs -> ' ' : xs

print :: Show a => a -> IO ()
print x = putStrLn (show x)

intShow :: Int -> String
intShow = primitive "intShow"

integerShow :: Integer -> String
integerShow = primitive "integerShow"

instance Show Int where
  showsPrec p n r = if n < 0 && p > 6 then '(' : intShow n ++ (')' : r) else intShow n ++ r

instance Show Integer where
  showsPrec p n r = if n < 0 && p > 6 then '(' : integerShow n ++ (')' : r) else integerShow n ++ r

instance Show Word where
  showsPrec _ n r = primitive "wordShow" n ++ r

instance Show Double where
  showsPrec p x = showSignedFloat showFloat p x
  showList = showListWith (showsPrec 0)

instance Show Float where
  showsPrec p x = showSignedFloat showFloat p x
  showList = showListWith (showsPrec 0)

showSignedFloat :: RealFloat a => (a -> ShowS) -> Int -> a -> ShowS
showSignedFloat showPos p x =
  if x < fromInteger 0 || isNegativeZero x
    then showParen (p > 6) (showChar '-' . showPos (negate x))
    else showPos x

showFloat :: RealFloat a => a -> ShowS
showFloat x = showString (formatRealFloat FFGeneric Nothing x)

instance Show Bool where
  showsPrec _ True = showString "True"
  showsPrec _ False = showString "False"

instance Show Ordering where
  showsPrec _ LT = showString "LT"
  showsPrec _ EQ = showString "EQ"
  showsPrec _ GT = showString "GT"

instance Show () where
  showsPrec _ () = showString "()"

instance Show a => Show (Maybe a) where
  showsPrec _ Nothing = showString "Nothing"
  showsPrec d (Just x) = showParen (d >= 11) (showString "Just " . showsPrec 11 x)

instance (Show a, Show b) => Show (Either a b) where
  showsPrec d (Left x) = showParen (d >= 11) (showString "Left " . showsPrec 11 x)
  showsPrec d (Right x) = showParen (d >= 11) (showString "Right " . showsPrec 11 x)

instance Show a => Show [a] where
  showsPrec _ = showList

instance Show a => Show (Ratio a) where
  showsPrec p (x :% y) = showParen (p > 7) (showsPrec 8 x . showString " % " . showsPrec 8 y)

instance Show Char where
  showsPrec _ '\'' = showString "'\\''"
  showsPrec _ c = showChar '\'' . showLitChar c . showChar '\''
  showList cs = showChar '"' . showLitString cs . showChar '"'

showLitString :: String -> ShowS
showLitString [] s = s
showLitString ('"' : cs) s = showString "\\\"" (showLitString cs s)
showLitString (c : cs) s = showLitChar c (showLitString cs s)

showLitChar :: Char -> ShowS
showLitChar c s | c > '\DEL' = showChar '\\' (protectEsc isDigit (shows (ord c)) s)
showLitChar '\DEL' s = showString "\\DEL" s
showLitChar '\\' s = showString "\\\\" s
showLitChar c s | c >= ' ' = showChar c s
showLitChar '\a' s = showString "\\a" s
showLitChar '\b' s = showString "\\b" s
showLitChar '\f' s = showString "\\f" s
showLitChar '\n' s = showString "\\n" s
showLitChar '\r' s = showString "\\r" s
showLitChar '\t' s = showString "\\t" s
showLitChar '\v' s = showString "\\v" s
showLitChar '\SO' s = protectEsc (== 'H') (showString "\\SO") s
showLitChar c s = showString ('\\' : (asciiTab !! ord c)) s

protectEsc :: (Char -> Bool) -> ShowS -> ShowS
protectEsc p f = f . cont
  where cont s = case s of
          (c:_) -> if p c then "\\&" ++ s else s
          _ -> s

asciiTab :: [String]
asciiTab = ["NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL",
            "BS", "HT", "LF", "VT", "FF", "CR", "SO", "SI",
            "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB",
            "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US",
            "SP"]

-- Number formatting, as GHC.Float does it

data FFFormat = FFExponent | FFFixed | FFGeneric

primFloatDigits :: Bool -> a -> ([Int], Int)
primFloatDigits isFloat x = if isFloat then primitive "floatDigits" x else primitive "doubleDigits" x

floatToDigits10 :: RealFloat a => a -> ([Int], Int)
floatToDigits10 x = primFloatDigits (floatDigits x == 24) x

formatRealFloat :: RealFloat a => FFFormat -> Maybe Int -> a -> String
formatRealFloat fmt decs x = formatRealFloatAlt fmt decs False x

formatRealFloatAlt :: RealFloat a => FFFormat -> Maybe Int -> Bool -> a -> String
formatRealFloatAlt fmt decs alt x =
  if isNaN x then "NaN"
  else if isInfinite x then (if x < fromInteger 0 then "-Infinity" else "Infinity")
  else if x < fromInteger 0 || isNegativeZero x then '-' : doFmt fmt (floatToDigits10 (negate x))
  else doFmt fmt (floatToDigits10 x)
  where
    doFmt format (is, e) =
      let ds = map intToDigit is in
      case format of
        FFGeneric -> doFmt (if e < 0 || e > 7 then FFExponent else FFFixed) (is, e)
        FFExponent -> case decs of
          Nothing ->
            let show_e' = show (e - 1) in
            case ds of
              "0" -> "0.0e0"
              [d] -> d : ".0e" ++ show_e'
              (d:ds') -> d : '.' : ds' ++ "e" ++ show_e'
              [] -> errorWithoutStackTrace "formatRealFloat/doFmt/FFExponent: []"
          Just d ->
            if d <= 0
              then (case is of
                      [0] -> "0e0"
                      _ -> let (ei, is') = roundTo 10 1 is
                               n = head (map intToDigit (if ei > 0 then init is' else is'))
                           in n : 'e' : show (e - 1 + ei))
              else let dec' = max d 1 in
                   case is of
                     [0] -> '0' : '.' : take dec' (repeat '0') ++ "e0"
                     _ -> let (ei, is') = roundTo 10 (dec' + 1) is
                              digits = map intToDigit (if ei > 0 then init is' else is')
                          in head digits : '.' : tail digits ++ 'e' : show (e - 1 + ei)
        FFFixed ->
          let mk0 ls = case ls of
                         "" -> "0"
                         _ -> ls
          in case decs of
               Nothing -> if e <= 0 then "0." ++ replicate (negate e) '0' ++ ds
                          else let f n s rs = if n == 0 then mk0 (reverse s) ++ '.' : mk0 rs
                                              else case rs of
                                                     "" -> f (n - 1) ('0' : s) ""
                                                     (r:rs') -> f (n - 1) (r : s) rs'
                               in f e "" ds
               Just dec ->
                 let dec' = max dec 0 in
                 if e >= 0
                   then let (ei, is') = roundTo 10 (dec' + e) is
                            (ls, rs) = splitAt (e + ei) (map intToDigit is')
                        in mk0 ls ++ (if null rs && not alt then "" else '.' : rs)
                   else let (ei, is') = roundTo 10 dec' (replicate (negate e) 0 ++ is)
                            digits = map intToDigit (if ei > 0 then is' else 0 : is')
                        in head digits : (if null (tail digits) && not alt then "" else '.' : tail digits)

roundTo :: Int -> Int -> [Int] -> (Int, [Int])
roundTo base d is =
  case f d True is of
    (0, xs) -> (0, xs)
    (1, xs) -> (1, 1 : xs)
    _ -> error "roundTo: bad Value"
  where
    b2 = base ${BT}quot${BT} 2
    f n _ [] = (0, replicate n 0)
    f 0 e (x:xs) = if x == b2 && e && all (== 0) xs then (0, []) else (if x >= b2 then 1 else 0, [])
    f n _ (i:xs) = let (c, ds) = f (n - 1) (even i) xs
                       i' = c + i
                   in if i' == base then (1, 0 : ds) else (0, i' : ds)

intToDigit :: Int -> Char
intToDigit i =
  if i >= 0 && i <= 9 then chr (ord '0' + i)
  else if i >= 10 && i <= 15 then chr (ord 'a' + i - 10)
  else errorWithoutStackTrace ("Char.intToDigit: not a digit " ++ show i)

digitToInt :: Char -> Int
digitToInt c =
  if isDigit c then ord c - ord '0'
  else if c >= 'a' && c <= 'f' then ord c - ord 'a' + 10
  else if c >= 'A' && c <= 'F' then ord c - ord 'A' + 10
  else errorWithoutStackTrace ("Char.digitToInt: not a digit " ++ show c)

showFFloat :: RealFloat a => Maybe Int -> a -> ShowS
showFFloat d x = showString (formatRealFloat FFFixed d x)

showEFloat :: RealFloat a => Maybe Int -> a -> ShowS
showEFloat d x = showString (formatRealFloat FFExponent d x)

showGFloat :: RealFloat a => Maybe Int -> a -> ShowS
showGFloat d x = showString (formatRealFloat FFGeneric d x)

showFFloatAlt :: RealFloat a => Maybe Int -> a -> ShowS
showFFloatAlt d x = showString (formatRealFloatAlt FFFixed d True x)

showGFloatAlt :: RealFloat a => Maybe Int -> a -> ShowS
showGFloatAlt d x = showString (formatRealFloatAlt FFGeneric d True x)

showIntAtBase :: Integral a => a -> (Int -> Char) -> a -> ShowS
showIntAtBase base toChr n0 r0 =
  if base <= fromInteger 1 then errorWithoutStackTrace "Numeric.showIntAtBase: applied to unsupported base"
  else if n0 < fromInteger 0 then errorWithoutStackTrace "Numeric.showIntAtBase: applied to negative number"
  else showIt (quotRem n0 base) r0
  where
    showIt (n, d) r = let c = toChr (fromIntegral d)
                          r' = c : r
                      in c ${BT}seq${BT} (if n == fromInteger 0 then r' else showIt (quotRem n base) r')

showHex :: Integral a => a -> ShowS
showHex = showIntAtBase (fromInteger 16) intToDigit

showOct :: Integral a => a -> ShowS
showOct = showIntAtBase (fromInteger 8) intToDigit

showBin :: Integral a => a -> ShowS
showBin = showIntAtBase (fromInteger 2) intToDigit

showInt :: Integral a => a -> ShowS
showInt n r = if n < fromInteger 0 then errorWithoutStackTrace "Numeric.showInt: can't show negative numbers" else integerShow (toInteger n) ++ r

showSigned :: Real a => (a -> ShowS) -> Int -> a -> ShowS
showSigned showPos p x = if x < fromInteger 0 then showParen (p > 6) (showChar '-' . showPos (negate x)) else showPos x

-- Read

class Read a where
  readsPrec :: Int -> ReadS a
  readList :: ReadS [a]
  readList = readListDefault

readListDefault :: Read a => ReadS [a]
readListDefault = readParen False (\r -> [pr | ("[", s) <- lex r, pr <- readl s])
  where readl s = [([], t) | ("]", t) <- lex s] ++ [(x : xs, u) | (x, t) <- reads s, (xs, u) <- readl' t]
        readl' s = [([], t) | ("]", t) <- lex s] ++ [(x : xs, v) | (",", t) <- lex s, (x, u) <- reads t, (xs, v) <- readl' u]

reads :: Read a => ReadS a
reads = readsPrec 0

read :: Read a => String -> a
read s = case [x | (x, t) <- reads s, ("", "") <- lex t] of
  [x] -> x
  [] -> errorWithoutStackTrace "Prelude.read: no parse"
  _ -> errorWithoutStackTrace "Prelude.read: ambiguous parse"

readMaybe :: Read a => String -> Maybe a
readMaybe s = case [x | (x, t) <- reads s, ("", "") <- lex t] of
  [x] -> Just x
  _ -> Nothing

readEither :: Read a => String -> Either String a
readEither s = case [x | (x, t) <- reads s, ("", "") <- lex t] of
  [x] -> Right x
  [] -> Left "Prelude.read: no parse"
  _ -> Left "Prelude.read: ambiguous parse"

readParen :: Bool -> ReadS a -> ReadS a
readParen b g = if b then mandatory else optional
  where optional r = g r ++ mandatory r
        mandatory r = [(x, u) | ("(", s) <- lex r, (x, t) <- optional s, (")", u) <- lex t]

readsReturn :: a -> ReadS a
readsReturn x s = [(x, s)]

readsFail :: ReadS a
readsFail _ = []

readsBind :: ReadS a -> (a -> ReadS b) -> ReadS b
readsBind m k s = [r | (x, t) <- m s, r <- k x t]

readsThen :: ReadS () -> ReadS b -> ReadS b
readsThen m k s = [r | (_, t) <- m s, r <- k t]

readsAlt :: ReadS a -> ReadS a -> ReadS a
readsAlt m n s = m s ++ n s

readsToken :: String -> ReadS ()
readsToken token s = [((), t) | (lexeme, t) <- lex s, lexeme == token]

lex :: ReadS String
lex "" = [("", "")]
lex (c:s) | isSpace c = lex (dropWhile isSpace s)
lex ('\'':s) = [('\'' : ch ++ "'", t) | (ch, '\'':t) <- lexLitChar s, ch /= "'"]
lex ('"':s) = [('"' : str, t) | (str, t) <- lexString s]
lex ('0':b:s) | baseOf b /= 0 && not (null ds) = [('0' : b : ds, t)]
  where (ds, t) = span (isDigitOfBase (baseOf b)) s
lex (c:s) | isSingle c = [([c], s)]
          | isSym c = [(c : sym, t) | (sym, t) <- [span isSym s]]
          | isAlpha c || c == '_' = [(c : nam, t) | (nam, t) <- [span isIdChar s]]
          | isDigit c = [(c : ds ++ fe, t) | (ds, s') <- [span isDigit s], (fe, t) <- lexFracExp s']
          | otherwise = []

isSingle :: Char -> Bool
isSingle c = c ${BT}elem${BT} ",;()[]{}${BT}"

isSym :: Char -> Bool
isSym c = c ${BT}elem${BT} "!@#$%&*+./<=>?\\^|:-~"

isIdChar :: Char -> Bool
isIdChar c = isAlphaNum c || c ${BT}elem${BT} "_'"

lexString :: ReadS String
lexString ('"':s) = [("\"", s)]
lexString s = [(ch ++ str, u) | (ch, t) <- lexStrItem s, (str, u) <- lexString t]

lexStrItem :: ReadS String
lexStrItem ('\\':'&':s) = [("\\&", s)]
lexStrItem ('\\':c:s) | isSpace c = [("\\&", t) | '\\':t <- [dropWhile isSpace s]]
lexStrItem s = lexLitChar s

lexFracExp :: ReadS String
lexFracExp ('.':c:cs) | isDigit c = [('.' : ds ++ e, u) | (ds, t) <- lexDigits (c:cs), (e, u) <- lexExp t]
lexFracExp s = lexExp s

lexExp :: ReadS String
lexExp (e:s) | e ${BT}elem${BT} "eE" = [(e : c : ds, u) | (c:t) <- [s], c ${BT}elem${BT} "+-", (ds, u) <- lexDigits t] ++ [(e : ds, t) | (ds, t) <- lexDigits s]
lexExp s = [("", s)]

lexDigits :: ReadS String
lexDigits s = [(cs, t) | (cs, t) <- [span isDigit s], not (null cs)]

lexLitChar :: ReadS String
lexLitChar ('\\':s) = [('\\' : esc, t) | (esc, t) <- lexEsc s]
  where lexEsc (c:s') | c ${BT}elem${BT} "abfnrtv\\\"'" = [([c], s')]
        lexEsc s'@(d:_) | isDigit d = [span isDigit s']
        lexEsc ('^':c:s') | c >= '@' && c <= '_' = [(['^', c], s')]
        lexEsc s' = [(name, drop (length name) s') | name <- escapeNames, take (length name) s' == name]
lexLitChar (c:s) = [([c], s)]
lexLitChar "" = []

escapeNames :: [String]
escapeNames = ["DEL", "SOH"] ++ asciiTab

readLitChar :: ReadS Char
readLitChar s = [(c, t) | (lexeme, t) <- lexLitChar s, Just c <- [decodeLitChar lexeme]]

decodeLitChar :: String -> Maybe Char
decodeLitChar [c] = Just c
decodeLitChar ('\\':rest) = case rest of
  "a" -> Just '\a'
  "b" -> Just '\b'
  "f" -> Just '\f'
  "n" -> Just '\n'
  "r" -> Just '\r'
  "t" -> Just '\t'
  "v" -> Just '\v'
  "\\" -> Just '\\'
  "\"" -> Just '"'
  "'" -> Just '\''
  "DEL" -> Just '\DEL'
  ['^', c] -> Just (chr (ord c - 64))
  _ -> if all isDigit rest && not (null rest) then (let n = read rest :: Integer in if n > 1114111 then Nothing else Just (chr (fromInteger n)))
       else case [i | (i, name) <- zip [0..] asciiTab, name == rest] of
              (i:_) -> Just (chr (if rest == "SP" then 32 else i))
              [] -> Nothing
decodeLitChar _ = Nothing

decodeString :: String -> Maybe String
decodeString s = case s of
  "\"" -> Just ""
  _ -> case lexStrItem s of
    [(item, t)] -> if item == "\\&" then decodeString t else case decodeLitChar item of
      Just c -> fmap (c :) (decodeString t)
      Nothing -> Nothing
    _ -> Nothing

readDecimal :: String -> Integer
readDecimal = primitive "readDecimal"

readFloatText :: String -> (Integer, Integer)
readFloatText = primitive "readFloatText"

readSignedNumber :: (String -> Maybe a) -> (a -> a) -> ReadS a
readSignedNumber conv neg r = direct r ++ paren r
  where direct s = [(x, t) | (tok, t) <- lex s, Just x <- [conv tok]]
                     ++ [(neg x, u) | ("-", t) <- lex s, (tok, u) <- lex t, Just x <- [conv tok]]
        paren s = [(x, u) | ("(", t) <- lex s, (x, t') <- direct t ++ paren t, (")", u) <- lex t']

convInteger :: String -> Maybe Integer
convInteger tok = case convBased tok of
  Just n -> Just n
  Nothing -> if not (null tok) && all isDigit tok then Just (readDecimal tok) else Nothing

-- A hexadecimal, octal, or binary token such as 0x1F, which GHC's Read accepts for every number type.
convBased :: String -> Maybe Integer
convBased tok = case tok of
  ('0':b:ds) | baseOf b /= 0 && not (null ds) && all (isDigitOfBase (baseOf b)) ds ->
    Just (foldl (\n d -> n * toInteger (baseOf b) + toInteger (digitToInt d)) 0 ds)
  _ -> Nothing

-- The base a letter after 0 selects, or 0 for none.
baseOf :: Char -> Int
baseOf b = if b ${BT}elem${BT} "xX" then 16 else if b ${BT}elem${BT} "oO" then 8 else if b ${BT}elem${BT} "bB" then 2 else 0

isDigitOfBase :: Int -> Char -> Bool
isDigitOfBase base c = case base of
  16 -> isHexDigit c
  8 -> isOctDigit c
  _ -> c == '0' || c == '1'

convFractional :: Fractional a => String -> Maybe a
convFractional tok = case tok of
  "NaN" -> Just (fromInteger 0 / fromInteger 0)
  "Infinity" -> Just (fromInteger 1 / fromInteger 0)
  _ -> case convBased tok of
    Just n -> Just (fromInteger n)
    Nothing -> case tok of
      (c:_) -> if isDigit c then (let (n, d) = readFloatText tok in Just (fromRational (n :% d))) else Nothing
      _ -> Nothing

instance Read Int where
  readsPrec _ = readSignedNumber (fmap fromInteger . convInteger) negate

instance Read Integer where
  readsPrec _ = readSignedNumber convInteger negate

instance Read Word where
  readsPrec _ = readSignedNumber (fmap fromInteger . convInteger) negate

instance (Integral a, Read a) => Read (Ratio a) where
  readsPrec p = readParen (p > 7) (\r -> [(x % y, u) | (x, s) <- readsPrec 8 r, ("%", t) <- lex s, (y, u) <- readsPrec 8 t])

instance Read Double where
  readsPrec _ = readSignedNumber convFractional negate

instance Read Float where
  readsPrec _ = readSignedNumber convFractional negate

instance Read Char where
  readsPrec _ = readParen False (\r -> [(c, t) | ('\'':lexeme, t) <- lex r, Just c <- [decodeLitChar (init lexeme)]])
  readList = readParen False (\r -> [(str, t) | ('"':lexeme, t) <- lex r, Just str <- [decodeString lexeme]]) ${BT}readsAlt${BT} readListDefault

instance Read a => Read [a] where
  readsPrec _ = readList

instance Read () where
  readsPrec _ = readParen False (\r -> [((), t) | ("(", s) <- lex r, (")", t) <- lex s])

instance Read Bool where
  readsPrec _ = readParen False (\r -> [(b, t) | (tok, t) <- lex r, (name, b) <- [("False", False), ("True", True)], tok == name])

instance Read Ordering where
  readsPrec _ = readParen False (\r -> [(o, t) | (tok, t) <- lex r, (name, o) <- [("LT", LT), ("EQ", EQ), ("GT", GT)], tok == name])

instance Read a => Read (Maybe a) where
  readsPrec d r = readParen False (\s -> [(Nothing, t) | ("Nothing", t) <- lex s]) r
                  ++ readParen (d > 10) (\s -> [(Just x, u) | ("Just", t) <- lex s, (x, u) <- readsPrec 11 t]) r

instance (Read a, Read b) => Read (Either a b) where
  readsPrec d r = readParen (d > 10) (\s -> [(Left x, u) | ("Left", t) <- lex s, (x, u) <- readsPrec 11 t]) r
                  ++ readParen (d > 10) (\s -> [(Right x, u) | ("Right", t) <- lex s, (x, u) <- readsPrec 11 t]) r

readHex :: (Eq a, Num a) => ReadS a
readHex s = [(fromInteger (primitive "readHexText" ds), t) | (ds, t) <- [span isHexDigit s], not (null ds)]

readOct :: (Eq a, Num a) => ReadS a
readOct s = [(fromInteger (primitive "readOctText" ds), t) | (ds, t) <- [span isOctDigit s], not (null ds)]

readDec :: (Eq a, Num a) => ReadS a
readDec s = [(fromInteger (readDecimal ds), t) | (ds, t) <- [span isDigit s], not (null ds)]
`;
