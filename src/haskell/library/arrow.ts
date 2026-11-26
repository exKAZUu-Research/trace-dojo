import { BT } from './source';

/** `Data.Bifunctor`, as GHC's base defines it. */
export const BIFUNCTOR_SOURCE = String.raw`module Data.Bifunctor.Internal where

import Base

class Bifunctor p where
  {-# MINIMAL bimap | first, second #-}
  bimap :: (a -> b) -> (c -> d) -> p a c -> p b d
  bimap f g = first f . second g
  first :: (a -> b) -> p a c -> p b c
  first f = bimap f id
  second :: (b -> c) -> p a b -> p a c
  second = bimap id

instance Bifunctor (,) where
  bimap f g ~(a, b) = (f a, g b)

instance Bifunctor ((,,) x1) where
  bimap f g ~(x1, a, b) = (x1, f a, g b)

instance Bifunctor ((,,,) x1 x2) where
  bimap f g ~(x1, x2, a, b) = (x1, x2, f a, g b)

instance Bifunctor ((,,,,) x1 x2 x3) where
  bimap f g ~(x1, x2, x3, a, b) = (x1, x2, x3, f a, g b)

instance Bifunctor ((,,,,,) x1 x2 x3 x4) where
  bimap f g ~(x1, x2, x3, x4, a, b) = (x1, x2, x3, x4, f a, g b)

instance Bifunctor ((,,,,,,) x1 x2 x3 x4 x5) where
  bimap f g ~(x1, x2, x3, x4, x5, a, b) = (x1, x2, x3, x4, x5, f a, g b)

instance Bifunctor Either where
  bimap f _ (Left a) = Left (f a)
  bimap _ g (Right b) = Right (g b)

instance Bifunctor Const where
  bimap f _ (Const a) = Const (f a)
`;

/** `Control.Category` and `Control.Arrow`, as GHC's base defines them. */
export const ARROW_SOURCE = String.raw`module Control.Arrow.Internal where

import Base hiding ((.), id)
import qualified Base as B

infixr 9 .
infixr 1 >>>, <<<
infixr 5 <+>
infixr 3 ***
infixr 3 &&&
infixr 2 +++
infixr 2 |||
infixr 1 ^>>, >>^
infixr 1 ^<<, <<^

class Category cat where
  id :: cat a a
  (.) :: cat b c -> cat a b -> cat a c

instance Category (->) where
  id = B.id
  (.) = (B..)

(<<<) :: Category cat => cat b c -> cat a b -> cat a c
(<<<) = (.)

(>>>) :: Category cat => cat a b -> cat b c -> cat a c
f >>> g = g . f

class Category a => Arrow a where
  {-# MINIMAL arr, (first | (***)) #-}
  arr :: (b -> c) -> a b c
  first :: a b c -> a (b,d) (c,d)
  first = (*** id)
  second :: a b c -> a (d,b) (d,c)
  second = (id ***)
  (***) :: a b c -> a b' c' -> a (b,b') (c,c')
  f *** g = first f >>> arr swap >>> first g >>> arr swap
    where swap ~(x,y) = (y,x)
  (&&&) :: a b c -> a b c' -> a b (c,c')
  f &&& g = arr (\b -> (b,b)) >>> f *** g

instance Arrow (->) where
  arr f = f
  (***) f g ~(x,y) = (f x, g y)

newtype Kleisli m a b = Kleisli { runKleisli :: a -> m b }

instance Functor m => Functor (Kleisli m a) where
  fmap f (Kleisli g) = Kleisli (fmap f . g)

instance Applicative m => Applicative (Kleisli m a) where
  pure = Kleisli . const . pure
  Kleisli f <*> Kleisli g = Kleisli $ \x -> f x <*> g x
  Kleisli f *> Kleisli g = Kleisli $ \x -> f x *> g x
  Kleisli f <* Kleisli g = Kleisli $ \x -> f x <* g x

instance Alternative m => Alternative (Kleisli m a) where
  empty = Kleisli $ const empty
  Kleisli f <|> Kleisli g = Kleisli $ \x -> f x <|> g x

instance Monad m => Monad (Kleisli m a) where
  Kleisli f >>= k = Kleisli $ \x -> f x >>= \a -> runKleisli (k a) x

instance MonadPlus m => MonadPlus (Kleisli m a) where
  mzero = Kleisli $ const mzero
  Kleisli f ${BT}mplus${BT} Kleisli g = Kleisli $ \x -> f x ${BT}mplus${BT} g x

instance Monad m => Category (Kleisli m) where
  id = Kleisli return
  (Kleisli f) . (Kleisli g) = Kleisli (\b -> g b >>= f)

instance Monad m => Arrow (Kleisli m) where
  arr f = Kleisli (return . f)
  first (Kleisli f) = Kleisli (\ ~(b,d) -> f b >>= \c -> return (c,d))
  second (Kleisli f) = Kleisli (\ ~(d,b) -> f b >>= \c -> return (d,c))

returnA :: Arrow a => a b b
returnA = id

(^>>) :: Arrow a => (b -> c) -> a c d -> a b d
f ^>> a = arr f >>> a

(>>^) :: Arrow a => a b c -> (c -> d) -> a b d
a >>^ f = a >>> arr f

(<<^) :: Arrow a => a c d -> (b -> c) -> a b d
a <<^ f = a <<< arr f

(^<<) :: Arrow a => (c -> d) -> a b c -> a b d
f ^<< a = arr f <<< a

class Arrow a => ArrowZero a where
  zeroArrow :: a b c

instance MonadPlus m => ArrowZero (Kleisli m) where
  zeroArrow = Kleisli (\_ -> mzero)

class ArrowZero a => ArrowPlus a where
  (<+>) :: a b c -> a b c -> a b c

instance MonadPlus m => ArrowPlus (Kleisli m) where
  Kleisli f <+> Kleisli g = Kleisli (\x -> f x ${BT}mplus${BT} g x)

class Arrow a => ArrowChoice a where
  {-# MINIMAL (left | (+++)) #-}
  left :: a b c -> a (Either b d) (Either c d)
  left = (+++ id)
  right :: a b c -> a (Either d b) (Either d c)
  right = (id +++)
  (+++) :: a b c -> a b' c' -> a (Either b b') (Either c c')
  f +++ g = left f >>> arr mirror >>> left g >>> arr mirror
    where
      mirror :: Either x y -> Either y x
      mirror (Left x) = Right x
      mirror (Right y) = Left y
  (|||) :: a b d -> a c d -> a (Either b c) d
  f ||| g = f +++ g >>> arr untag
    where
      untag (Left x) = x
      untag (Right y) = y

instance ArrowChoice (->) where
  left f = f +++ id
  right f = id +++ f
  f +++ g = (Left . f) ||| (Right . g)
  (|||) = either

instance Monad m => ArrowChoice (Kleisli m) where
  left f = f +++ arr id
  right f = arr id +++ f
  f +++ g = (f >>> arr Left) ||| (g >>> arr Right)
  Kleisli f ||| Kleisli g = Kleisli (either f g)

class Arrow a => ArrowApply a where
  app :: a (a b c, b) c

instance ArrowApply (->) where
  app (f,x) = f x

instance Monad m => ArrowApply (Kleisli m) where
  app = Kleisli (\(Kleisli f, x) -> f x)

newtype ArrowMonad a b = ArrowMonad (a () b)

instance Arrow a => Functor (ArrowMonad a) where
  fmap f (ArrowMonad m) = ArrowMonad $ m >>> arr f

instance Arrow a => Applicative (ArrowMonad a) where
  pure x = ArrowMonad (arr (const x))
  ArrowMonad f <*> ArrowMonad x = ArrowMonad (f &&& x >>> arr (uncurry id))

instance ArrowApply a => Monad (ArrowMonad a) where
  ArrowMonad m >>= f = ArrowMonad $
    m >>> arr (\x -> let ArrowMonad h = f x in (h, ())) >>> app

instance ArrowPlus a => Alternative (ArrowMonad a) where
  empty = ArrowMonad zeroArrow
  ArrowMonad x <|> ArrowMonad y = ArrowMonad (x <+> y)

instance (ArrowApply a, ArrowPlus a) => MonadPlus (ArrowMonad a)

leftApp :: ArrowApply a => a b c -> a (Either b d) (Either c d)
leftApp f = arr ((\b -> (arr (\() -> b) >>> f >>> arr Left, ())) |||
             (\d -> (arr (\() -> d) >>> arr Right, ()))) >>> app

class Arrow a => ArrowLoop a where
  loop :: a (b,d) (c,d) -> a b c

instance ArrowLoop (->) where
  loop f b = let (c,d) = f (b,d) in c

instance MonadFix m => ArrowLoop (Kleisli m) where
  loop (Kleisli f) = Kleisli (liftM fst . mfix . f')
    where f' x y = f (x, snd y)
`;
