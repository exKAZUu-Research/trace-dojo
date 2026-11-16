import { BT } from './source';

/** `Text.Printf`, whose `printf` takes any number of arguments through the `PrintfType` class, as base does. */
export const PRINTF_SOURCE = String.raw`module Text.Printf.Internal where

import Base

data UPrintf = UInteger Integer Integer | UChar Char | UString String | UDouble Double

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

instance PrintfArg Integer where
  formatArg x = UInteger x 0

instance PrintfArg Double where
  formatArg x = UDouble x

instance PrintfArg Float where
  formatArg x = UDouble (realToFrac x)

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
uprintf ('%':cs) (u:us) = case parseSpec cs of
  (spec, rest) -> formatOne spec u ++ uprintf rest us
uprintf (c:cs) us = c : uprintf cs us

parseSpec :: String -> (Spec, String)
parseSpec s0 = flags False False False False False s0
  where
    flags minus plus space zero alt s = case s of
      ('-':r) -> flags True plus space zero alt r
      ('+':r) -> flags minus True space zero alt r
      (' ':r) -> flags minus plus True zero alt r
      ('0':r) -> flags minus plus space True alt r
      ('#':r) -> flags minus plus space zero True r
      _ -> let (w, r1) = span isDigit s
               width = if null w then Nothing else Just (read w)
               (prec, r2) = case r1 of
                 ('.':r) -> let (p, r') = span isDigit r in (Just (if null p then 0 else read p), r')
                 _ -> (Nothing, r1)
               r3 = dropWhile (\c -> c ${BT}elem${BT} "hlLqjzt") r2
           in case r3 of
                (c:r4) -> (Spec minus plus space zero alt width prec c, r4)
                [] -> perror "formatting string ended prematurely"

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
  UDouble d -> case c of
    'v' -> formatOne (Spec minus plus space zero alt width prec 'g') u
    _ -> if c ${BT}elem${BT} "eEfFgG"
           then pad True (signedDouble d (caseConvert (showFn (toLower c) (abs d))))
           else badChar
  where
    badChar = perror ("bad formatting char " ++ show c)
    digitsMin ds = case prec of
      Just p -> replicate (p - length ds) '0' ++ ds
      Nothing -> ds
    unsigned n bound = if n < 0 && bound > 0 then bound + n else n
    prefixAlt p ds = if alt then p ++ ds else ds
    signed n ds = if n < 0 then '-' : ds else if plus then '+' : ds else if space then ' ' : ds else ds
    signedDouble d ds = if d < 0 || isNegativeZero d then '-' : ds else if plus then '+' : ds else if space then ' ' : ds else ds
    caseConvert = if isUpper c then map toUpper else id
    showFn ch x = case ch of
      'e' -> showEFloat prec x ""
      'f' -> if alt then showFFloatAlt prec x "" else showFFloat prec x ""
      _ -> if alt then showGFloatAlt prec x "" else showGFloat prec x ""
    pad numeric s = case width of
      Nothing -> s
      Just w -> let n = w - length s in
        if n <= 0 then s
        else if minus then s ++ replicate n ' '
        else if zero && numeric then (case s of
          (sign:rest) -> if sign ${BT}elem${BT} "+- " then sign : replicate n '0' ++ rest else replicate n '0' ++ s
          [] -> replicate n '0')
        else replicate n ' ' ++ s
`;
