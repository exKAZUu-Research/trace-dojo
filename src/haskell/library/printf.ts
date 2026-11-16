import { BT } from './source';

/** `Text.Printf`, whose `printf` takes any number of arguments through the `PrintfType` class, as base does. */
export const PRINTF_SOURCE = String.raw`module Text.Printf.Internal where

import Base

data UPrintf = UInteger Integer Integer | UChar Char | UString String | UDouble Double | UFloat Float

class PrintfArg a where
  formatArg :: a -> UPrintf

class IsChar c where
  toChar :: c -> Char
  fromChar :: Char -> c

instance IsChar Char where
  toChar c = c
  fromChar c = c

instance PrintfArg Int where
  formatArg x = UInteger (toInteger x) 18446744073709551616

instance PrintfArg Word where
  formatArg x = UInteger (toInteger x) 0

instance PrintfArg Integer where
  formatArg x = UInteger x 0

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

data Spec = Spec Bool Bool Bool Bool Bool (Maybe Int) (Maybe Int) Char

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
            let r3 = dropWhile (\c -> c ${BT}elem${BT} "hlLqjzt") r2
                left = minus || maybe False (< 0) width
                width' = fmap abs width
            in case r3 of
                 (c:r4) -> (Spec left plus space zero alt width' prec c, r4, args2)
                 [] -> perror "formatting string ended prematurely"
    dimension ('*':r) us = case us of
      [] -> perror "argument list ended prematurely"
      (u:rest) -> (Just (dynamicNumber u), r, rest)
    dimension s us = let (ds, rest) = span isDigit s in (if null ds then Nothing else Just (read ds), rest, us)
    precision ('.':r) us = case dimension r us of
      (p, rest, remaining) -> (Just (maybe 0 id p), rest, remaining)
    precision s us = (Nothing, s, us)
    dynamicNumber (UInteger n _) = fromInteger n
    dynamicNumber (UChar c) = ord c
    dynamicNumber _ = perror "bad formatting char 'd'"

formatOne :: Spec -> UPrintf -> String
formatOne spec@(Spec minus plus space zero alt width prec c) u = case u of
  UInteger n bound -> case c of
    'd' -> pad True (signed n (digitsMin (show (abs n))))
    'i' -> pad True (signed n (digitsMin (show (abs n))))
    'v' -> pad True (signed n (digitsMin (show (abs n))))
    'u' -> pad True (digitsMin (show (unsigned n bound)))
    'x' -> pad True (prefixAlt "0x" (digitsMin (showIntAtBase 16 intToDigit (unsigned n bound) "")))
    'X' -> pad True (prefixAlt "0X" (map toUpper (digitsMin (showIntAtBase 16 intToDigit (unsigned n bound) ""))))
    'o' -> pad True (prefixAlt "0" (digitsMin (showIntAtBase 8 intToDigit (unsigned n bound) "")))
    'b' -> pad True (prefixAlt "0b" (digitsMin (showIntAtBase 2 intToDigit (unsigned n bound) "")))
    'c' -> pad False [chr (fromInteger n)]
    _ -> badChar
  UChar ch -> case c of
    'c' -> pad False [ch]
    'v' -> pad False [ch]
    _ -> formatOne spec (UInteger (toInteger (ord ch)) 0)
  UString str -> case c of
    's' -> pad False (maybe str (\p -> take p str) prec)
    'v' -> pad False (maybe str (\p -> take p str) prec)
    _ -> badChar
  UDouble d -> formatReal d
  UFloat d -> formatReal d
  where
    formatReal :: RealFloat a => a -> String
    formatReal d = case c of
      'v' -> formatOne (Spec minus plus space zero alt width prec 'g') u
      _ -> if c ${BT}elem${BT} "eEfFgG"
             then pad True (signedDouble d (caseConvert (showFn (toLower c) (abs d))))
             else badChar
    badChar = perror ("bad formatting char " ++ show c)
    digitsMin ds = case prec of
      Just p -> if p == 0 && ds == "0" then "" else replicate (p - length ds) '0' ++ ds
      Nothing -> ds
    unsigned n bound = if n < 0 && bound > 0 then bound + n else n
    prefixAlt p ds = if alt && not (null ds) && ds /= "0" && not (p == "0" && head ds == '0') then p ++ ds else ds
    signed n ds = if n < 0 then '-' : ds else if plus then '+' : ds else if space then ' ' : ds else ds
    signedDouble d ds = if d < 0 || isNegativeZero d then '-' : ds else if plus then '+' : ds else if space then ' ' : ds else ds
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
    pad numeric s = case width of
      Nothing -> s
      Just w -> let n = w - length s in
        if n <= 0 then s
        else if minus then s ++ replicate n ' '
        else if zero && numeric && zeroPadding then (case s of
          (sign:rest) -> if sign ${BT}elem${BT} "+- " then sign : replicate n '0' ++ rest else replicate n '0' ++ s
          [] -> replicate n '0')
        else replicate n ' ' ++ s
`;
