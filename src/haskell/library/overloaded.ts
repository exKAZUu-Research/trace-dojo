/** The classes of overloaded literals: strings, lists, and labels, which OverloadedStrings and the like use. */
export const OVERLOADED_SOURCE = String.raw`
import Base
import qualified Data.Set.Internal as S
import qualified Data.Map.Internal as M

class IsString a where
  fromString :: String -> a

instance (a ~ Char) => IsString [a] where
  fromString xs = xs

class IsList l where
  type Item l
  fromList :: [Item l] -> l
  fromListN :: Int -> [Item l] -> l
  fromListN _ = fromList
  toList :: l -> [Item l]

instance IsList [a] where
  type Item [a] = a
  fromList xs = xs
  toList xs = xs

instance Ord a => IsList (S.Set a) where
  type Item (S.Set a) = a
  fromList = S.fromList
  toList = S.toList

instance Ord k => IsList (M.Map k v) where
  type Item (M.Map k v) = (k, v)
  fromList = M.fromList
  toList = M.toList

class IsLabel (x :: Symbol) a where
  fromLabel :: a
`;

/** The functions the conversion of overloaded literals calls, apart from any names the program defines. */
export const OVERLOADED_SUPPORT = String.raw`
overloadedFromString :: IsString a => String -> a
overloadedFromString = fromString

overloadedFromListN :: IsList l => Int -> [Item l] -> l
overloadedFromListN = fromListN

overloadedFromList :: IsList l => [Item l] -> l
overloadedFromList = fromList

overloadedToList :: IsList l => l -> [Item l]
overloadedToList = toList

overloadedFromLabel :: forall x a. IsLabel x a => a
overloadedFromLabel = fromLabel @x

overloadedStringEq :: (Eq a, IsString a) => String -> a -> Bool
overloadedStringEq s x = x == fromString s
`;
