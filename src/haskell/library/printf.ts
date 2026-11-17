import { BT } from './source';

export const PRINTF_SOURCE = String.raw`module Text.Printf.Internal where

import Base

data UPrintf = UInteger Integer Integer Char | UChar Char | UString String | UDouble Double | UFloat Float

class PrintfArg a where
  formatArg :: a -> UPrintf

class IsChar c where
  toChar :: c -> Char
  fromChar :: Char -> c

instance IsChar Char where
  toChar c = c
  fromChar c = c

instance PrintfArg Int where
  formatArg x = UInteger (toInteger x) 18446744073709551616 'd'

instance PrintfArg Word where
  formatArg x = UInteger (toInteger x) 0 'u'

instance PrintfArg Integer where
  formatArg x = UInteger x 0 'd'

instance PrintfArg Double where
  formatArg x = UDouble x

instance PrintfArg Float where
  formatArg x = UFloat x

instance PrintfArg Char where
  formatArg c = UChar c

instance IsChar c => PrintfArg [c] where
  formatArg s = UString (map toChar s)

class PrintfType t where
  spr :: String -> [UPrintf] -> t

instance IsChar c => PrintfType [c] where
  spr fmts args = map fromChar (uprintf fmts (reverse args))

instance PrintfType (IO a) where
  spr fmts args = printfPutStr (uprintf fmts (reverse args))

instance (PrintfArg a, PrintfType r) => PrintfType (a -> r) where
  spr fmts args = \a -> spr fmts (formatArg a : args)

class HPrintfType t where
  hspr :: Handle -> String -> [UPrintf] -> t

instance HPrintfType (IO a) where
  hspr h fmts args = printfHPutStr h (uprintf fmts (reverse args))

instance (PrintfArg a, HPrintfType r) => HPrintfType (a -> r) where
  hspr h fmts args = \a -> hspr h fmts (formatArg a : args)

printfHPutStr :: Handle -> String -> IO a
printfHPutStr = primitive "hPutStr"

hPrintf :: HPrintfType r => Handle -> String -> r
hPrintf h fmts = hspr h fmts []

printfPutStr :: String -> IO a
printfPutStr = primitive "putStr"

printf :: PrintfType r => String -> r
printf fmts = spr fmts []

data Spec = Spec Bool Bool Bool Bool Bool (Maybe Int) (Maybe Int) String Char

perror :: String -> a
perror s = errorWithoutStackTrace ("printf: " ++ s)

uprintf :: String -> [UPrintf] -> String
uprintf "" [] = ""
uprintf "" (_:_) = perror "formatting string ended prematurely"
uprintf ('%':'%':cs) us = '%' : uprintf cs us
uprintf ('%':_) [] = perror "argument list ended prematurely"
uprintf ('%':cs) us = case parseSpec cs us of
  (spec, rest, args) -> case args of
    [] -> perror "argument list ended prematurely"
    (u:remaining) -> formatOne spec u ++ uprintf rest remaining
uprintf (c:cs) us = c : uprintf cs us

parseSpec :: String -> [UPrintf] -> (Spec, String, [UPrintf])
parseSpec s0 args = flags False False False False False s0
  where
    flags minus plus space zero alt s = case s of
      ('-':r) -> flags True plus space zero alt r
      ('+':r) -> flags minus True space zero alt r
      (' ':r) -> flags minus plus True zero alt r
      ('0':r) -> flags minus plus space True alt r
      ('#':r) -> flags minus plus space zero True r
      _ -> case dimension s args of
        (width, r1, args1) -> case precision r1 args1 of
          (prec, r2, args2) ->
            let (mods,r3) = case args2 of
                  (UInteger _ _ _:_) -> modifier r2
                  (UChar _:_) -> modifier r2
                  _ -> ("",r2)
                left = maybe minus (\w -> w < 0 || minus) width
                width' = fmap abs width
            in case r3 of
                 (c:r4) -> (Spec left plus space zero alt width' prec mods c, r4, args2)
                 [] -> perror "formatting string ended prematurely"
    modifier ('h':'h':r) = ("hh",r)
    modifier ('l':'l':r) = ("ll",r)
    modifier ('h':r) = ("h",r)
    modifier ('l':r) = ("l",r)
    modifier ('L':r) = ("L",r)
    modifier r = ("",r)
    dimension ('*':r) us = case us of
      [] -> perror "argument list ended prematurely"
      (u:rest) -> (Just (dynamicNumber u), r, rest)
    dimension s us = let (ds, rest) = span isDigit s in (if null ds then Nothing else Just (read ds), rest, us)
    precision ('.':r) us = case dimension r us of
      (p, rest, remaining) -> (Just (maybe 0 id p), rest, remaining)
    precision s us = (Nothing, s, us)
    dynamicNumber (UInteger n _ _) = fromInteger n
    dynamicNumber (UChar c) = ord c
    dynamicNumber _ = perror "bad formatting char 'd'"

formatOne :: Spec -> UPrintf -> String
formatOne spec@(Spec minus plus space zero alt width prec mods c) u = integralWidth ${BT}seq${BT} case u of
  UInteger n bound def -> case c of
    'd' -> field True (signed (n < 0) (digitsMin (show (abs n))))
    'i' -> field True (signed (n < 0) (digitsMin (show (abs n))))
    'v' -> formatOne (Spec minus plus space zero alt width prec mods def) u
    'u' -> radix n bound 10 ""
    'x' -> radix n bound 16 "0x"
    'X' -> map toUpper (radix n bound 16 "0x")
    'o' -> radix n bound 8 "0"
    'b' -> radix n bound 2 "0b"
    'c' -> charValue n
    _ -> badChar
  UChar ch -> case c of
    'c' -> charValue (toInteger (ord ch))
    'v' -> charValue (toInteger (ord ch))
    _ -> formatOne spec (UInteger (toInteger (ord ch)) 0 'd')
  UString str -> case c of
    's' -> field False ("", maybe str (\p -> take p str) prec)
    'v' -> field False ("", maybe str (\p -> take p str) prec)
    _ -> badChar
  UDouble d -> formatReal d
  UFloat d -> formatReal d
  where
    formatReal :: RealFloat a => a -> String
    formatReal d = case c of
      'v' -> formatOne (Spec minus plus space zero alt width prec mods 'g') u
      _ -> if c ${BT}elem${BT} "eEfFgG"
             then field True (signed (d < 0 || isNegativeZero d) (caseConvert (showFn (toLower c) (abs d))))
             else badChar
    badChar = perror ("bad formatting char " ++ show c)
    digitsMin ds = case prec of
      Just p -> if p == 0 && ds == "0" then "" else replicate (p - length ds) '0' ++ ds
      Nothing -> ds
    charValue n = if n >= 0 && n <= 1114111 && maybe True (const False) prec && null mods
      then field False ("", [chr (fromInteger n)]) else perror "illegal char conversion"
    integralWidth = case u of
      UInteger _ _ _ -> forceWidth
      UChar _ -> forceWidth
      _ -> ()
    forceWidth = case prec of
      Nothing -> ()
      Just _ -> maybe () (\w -> w ${BT}seq${BT} ()) width
    radix n bound base prefix = field True parts
      where converted = unsigned n bound
            ds = digitsMin (showIntAtBase base intToDigit converted "")
            pre = if alt && n /= 0 then prefix else ""
            parts = case pre of
              "" -> converted ${BT}seq${BT} ("", ds)
              "0" -> case ds of
                ('0':_) -> ("", ds)
                _ -> (pre, ds)
              _ -> (pre, ds)
    unsigned n bound = if n < 0 then
      let offset = case mods of
            "hh" -> 256
            "h" -> 65536
            "l" -> 4294967296
            "ll" -> 18446744073709551616
            "L" -> 18446744073709551616
            _ -> bound
          converted = n + offset
      in if offset > 0 && converted >= 0 then converted else perror "bad argument"
      else n
    signed negative ds = if negative then ("-",ds) else (if plus then "+" else if space then " " else "",ds)
    caseConvert = if isUpper c then map toUpper else id
    showFn ch x = case ch of
      'e' -> showEFloat prec x ""
      'f' -> if alt then showFFloatAlt prec x "" else showFFloat prec x ""
      _ -> if alt then showGFloatAlt prec x "" else showGFloat prec x ""
    zeroPadding = case u of
      UDouble _ -> True
      UFloat _ -> True
      _ -> case prec of
        Nothing -> True
        Just _ -> False
    field numeric (prefix, ds) =
      let zeros = not minus && zero && (not numeric || zeroPadding)
          natural = length prefix + length ds
          fill = case width of
            Just w -> if w > natural then replicate (w - natural) (if zeros then '0' else ' ') else ""
            Nothing -> ""
      in if minus then prefix ++ ds ++ fill
         else if zeros then prefix ++ fill ++ ds
         else fill ++ prefix ++ ds

`;
