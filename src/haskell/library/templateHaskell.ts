/**
 * Template Haskell's library, `Language.Haskell.TH`: the syntax trees of expressions, patterns, types, and
 * declarations as the template-haskell package that GHC 9.14.1 comes with defines them, the `Q` monad, the functions
 * that build the trees, `Lift`, and `pprint`. It also renders a tree as source text, which a splice puts in place.
 */
export const TEMPLATE_HASKELL_SOURCE = String.raw`module Language.Haskell.TH.Internal where

import Base
import qualified Base as B

-- Names

newtype ModName = ModName String deriving (Eq, Ord, Show)

newtype PkgName = PkgName String deriving (Eq, Ord, Show)

newtype OccName = OccName String deriving (Eq, Ord, Show)

data NameSpace = VarName | DataName | TcClsName deriving (Eq, Ord, Show)

data NameFlavour
  = NameS
  | NameQ ModName
  | NameU Integer
  | NameL Integer
  | NameG NameSpace PkgName ModName
  deriving (Eq, Ord, Show)

data Name = Name OccName NameFlavour deriving (Eq)

instance Ord Name where
  compare (Name (OccName a) fa) (Name (OccName b) fb) = compare (fa, a) (fb, b)

instance Show Name where
  show = showName

showName :: Name -> String
showName (Name (OccName occ) flavour) = case flavour of
  NameS -> occ
  NameQ (ModName m) -> m ++ "." ++ occ
  NameU u -> occ ++ "_" ++ show u
  NameL u -> occ ++ "_" ++ show u
  NameG _ _ (ModName m) -> m ++ "." ++ occ

mkName :: String -> Name
mkName str = split [] (reverse str)
  where
    split occ [] = Name (OccName str) NameS
    split occ ('.' : rev)
      | not (null occ), isModule rev, not (null rev) = Name (OccName occ) (NameQ (ModName (reverse rev)))
    split occ (c : rev) = split (c : occ) rev
    isModule rev = case reverse rev of
      (c : _) -> isUpper c && all (\x -> isAlphaNum x || x == '.' || x == '_' || x == '\'') rev
      [] -> False

nameBase :: Name -> String
nameBase (Name (OccName occ) _) = occ

nameModule :: Name -> Maybe String
nameModule (Name _ (NameQ (ModName m))) = Just m
nameModule (Name _ (NameG _ _ (ModName m))) = Just m
nameModule _ = Nothing

namePackage :: Name -> Maybe String
namePackage (Name _ (NameG _ (PkgName p) _)) = Just p
namePackage _ = Nothing

nameSpace :: Name -> Maybe NameSpace
nameSpace (Name _ (NameG ns _ _)) = Just ns
nameSpace _ = Nothing

mkNameG_v :: String -> String -> String -> Name
mkNameG_v pkg m occ = Name (OccName occ) (NameG VarName (PkgName pkg) (ModName m))

mkNameG_d :: String -> String -> String -> Name
mkNameG_d pkg m occ = Name (OccName occ) (NameG DataName (PkgName pkg) (ModName m))

mkNameG_tc :: String -> String -> String -> Name
mkNameG_tc pkg m occ = Name (OccName occ) (NameG TcClsName (PkgName pkg) (ModName m))

mkNameU :: String -> Integer -> Name
mkNameU occ u = Name (OccName occ) (NameU u)

mkNameS :: String -> Name
mkNameS occ = Name (OccName occ) NameS

-- The syntax trees

data Lit
  = CharL Char
  | StringL String
  | IntegerL Integer
  | RationalL Rational
  | IntPrimL Integer
  | WordPrimL Integer
  | FloatPrimL Rational
  | DoublePrimL Rational
  | CharPrimL Char
  deriving (Eq, Ord, Show)

data Exp
  = VarE Name
  | ConE Name
  | LitE Lit
  | AppE Exp Exp
  | AppTypeE Exp Type
  | InfixE (Maybe Exp) Exp (Maybe Exp)
  | UInfixE Exp Exp Exp
  | ParensE Exp
  | LamE [Pat] Exp
  | LamCaseE [Match]
  | LamCasesE [Clause]
  | TupE [Maybe Exp]
  | UnboxedTupE [Maybe Exp]
  | UnboxedSumE Exp Int Int
  | CondE Exp Exp Exp
  | MultiIfE [(Guard, Exp)]
  | LetE [Dec] Exp
  | CaseE Exp [Match]
  | DoE (Maybe ModName) [Stmt]
  | MDoE (Maybe ModName) [Stmt]
  | CompE [Stmt]
  | ArithSeqE Range
  | ListE [Exp]
  | SigE Exp Type
  | RecConE Name [FieldExp]
  | RecUpdE Exp [FieldExp]
  | StaticE Exp
  | UnboundVarE Name
  | LabelE String
  | ImplicitParamVarE String
  | GetFieldE Exp String
  | ProjectionE (NonEmpty String)
  | TypedBracketE Exp
  | TypedSpliceE Exp
  | TypeE Type
  deriving (Eq, Ord, Show)

type FieldExp = (Name, Exp)

data Pat
  = LitP Lit
  | VarP Name
  | TupP [Pat]
  | UnboxedTupP [Pat]
  | UnboxedSumP Pat Int Int
  | ConP Name [Type] [Pat]
  | InfixP Pat Name Pat
  | UInfixP Pat Name Pat
  | ParensP Pat
  | TildeP Pat
  | BangP Pat
  | AsP Name Pat
  | WildP
  | RecP Name [FieldPat]
  | ListP [Pat]
  | SigP Pat Type
  | ViewP Exp Pat
  | TypeP Type
  | InvisP Type
  | OrP (NonEmpty Pat)
  deriving (Eq, Ord, Show)

type FieldPat = (Name, Pat)

data Match = Match Pat Body [Dec] deriving (Eq, Ord, Show)

data Clause = Clause [Pat] Body [Dec] deriving (Eq, Ord, Show)

data Body = GuardedB [(Guard, Exp)] | NormalB Exp deriving (Eq, Ord, Show)

data Guard = NormalG Exp | PatG [Stmt] deriving (Eq, Ord, Show)

data Stmt = BindS Pat Exp | LetS [Dec] | NoBindS Exp | ParS [[Stmt]] | RecS [Stmt] deriving (Eq, Ord, Show)

data Range = FromR Exp | FromThenR Exp Exp | FromToR Exp Exp | FromThenToR Exp Exp Exp deriving (Eq, Ord, Show)

data Type
  = ForallT [TyVarBndr Specificity] Cxt Type
  | ForallVisT [TyVarBndr ()] Type
  | AppT Type Type
  | AppKindT Type Kind
  | SigT Type Kind
  | VarT Name
  | ConT Name
  | PromotedT Name
  | InfixT Type Name Type
  | UInfixT Type Name Type
  | PromotedInfixT Type Name Type
  | PromotedUInfixT Type Name Type
  | ParensT Type
  | TupleT Int
  | UnboxedTupleT Int
  | UnboxedSumT Int
  | ArrowT
  | MulArrowT
  | EqualityT
  | ListT
  | PromotedTupleT Int
  | PromotedNilT
  | PromotedConsT
  | StarT
  | ConstraintT
  | LitT TyLit
  | WildCardT
  | ImplicitParamT String Type
  deriving (Eq, Ord, Show)

data TyLit = NumTyLit Integer | StrTyLit String | CharTyLit Char deriving (Eq, Ord, Show)

data Specificity = SpecifiedSpec | InferredSpec deriving (Eq, Ord, Show)

data BndrVis = BndrReq | BndrInvis deriving (Eq, Ord, Show)

data TyVarBndr flag = PlainTV Name flag | KindedTV Name flag Kind deriving (Eq, Ord, Show)

type Kind = Type

type Pred = Type

type Cxt = [Pred]

data Dec
  = FunD Name [Clause]
  | ValD Pat Body [Dec]
  | DataD Cxt Name [TyVarBndr BndrVis] (Maybe Kind) [Con] [DerivClause]
  | NewtypeD Cxt Name [TyVarBndr BndrVis] (Maybe Kind) Con [DerivClause]
  | TypeDataD Name [TyVarBndr BndrVis] (Maybe Kind) [Con]
  | TySynD Name [TyVarBndr BndrVis] Type
  | ClassD Cxt Name [TyVarBndr BndrVis] [FunDep] [Dec]
  | InstanceD (Maybe Overlap) Cxt Type [Dec]
  | SigD Name Type
  | KiSigD Name Kind
  | InfixD Fixity NamespaceSpecifier Name
  | DefaultD [Type]
  | RoleAnnotD Name [Role]
  | StandaloneDerivD (Maybe DerivStrategy) Cxt Type
  | DefaultSigD Name Type
  | ImplicitParamBindD String Exp
  deriving (Eq, Ord, Show)

data Con
  = NormalC Name [BangType]
  | RecC Name [VarBangType]
  | InfixC BangType Name BangType
  | ForallC [TyVarBndr Specificity] Cxt Con
  | GadtC [Name] [BangType] Type
  | RecGadtC [Name] [VarBangType] Type
  deriving (Eq, Ord, Show)

data Bang = Bang SourceUnpackedness SourceStrictness deriving (Eq, Ord, Show)

data SourceUnpackedness = NoSourceUnpackedness | SourceNoUnpack | SourceUnpack deriving (Eq, Ord, Show)

data SourceStrictness = NoSourceStrictness | SourceLazy | SourceStrict deriving (Eq, Ord, Show)

type BangType = (Bang, Type)

type VarBangType = (Name, Bang, Type)

data DerivClause = DerivClause (Maybe DerivStrategy) Cxt deriving (Eq, Ord, Show)

data DerivStrategy = StockStrategy | AnyclassStrategy | NewtypeStrategy | ViaStrategy Type deriving (Eq, Ord, Show)

data FunDep = FunDep [Name] [Name] deriving (Eq, Ord, Show)

data Overlap = Overlappable | Overlapping | Overlaps | Incoherent deriving (Eq, Ord, Show)

data Fixity = Fixity Int FixityDirection deriving (Eq, Ord, Show)

data FixityDirection = InfixL | InfixR | InfixN deriving (Eq, Ord, Show)

data NamespaceSpecifier = NoNamespaceSpecifier | TypeNamespaceSpecifier | DataNamespaceSpecifier deriving (Eq, Ord, Show)

data Role = NominalR | RepresentationalR | PhantomR | InferR deriving (Eq, Ord, Show)

-- The Q monad

newtype Q a = Q { unQ :: IO a }

runQ :: Q a -> IO a
runQ (Q io) = io

runIO :: IO a -> Q a
runIO = Q

instance Functor Q where
  fmap f (Q io) = Q (fmap f io)

instance Applicative Q where
  pure x = Q (pure x)
  Q f <*> Q x = Q (f <*> x)

instance Monad Q where
  Q m >>= k = Q (m >>= \x -> unQ (k x))

instance MonadFail Q where
  fail s = Q (ioError (userError s))

instance MonadFix Q where
  mfix f = Q (mfix (unQ . f))

instance Semigroup a => Semigroup (Q a) where
  a <> b = liftA2 (<>) a b

instance Monoid a => Monoid (Q a) where
  mempty = pure mempty

class Monad m => Quote m where
  newName :: String -> m Name

instance Quote Q where
  newName s = Q (newNameIO s)

instance Quote IO where
  newName = newNameIO

newNameIO :: String -> IO Name
newNameIO s = fmap (mkNameU s) (thNewUnique ())

thNewUnique :: () -> IO Integer
thNewUnique = primitive "thNewUnique"

reportWarning :: String -> Q ()
reportWarning s = Q (hPutStrLn stderr ("Template Haskell error: " ++ s))

-- An error the splice reports, marked so that the compiler fails the splice with it once the splice ends.
reportError :: String -> Q ()
reportError s = Q (hPutStr stderr ("\1" ++ s ++ "\1"))

report :: Bool -> String -> Q ()
report True = reportError
report False = reportWarning

recover :: Q a -> Q a -> Q a
recover (Q handler) (Q action) = Q (action ${'`'}catchAny${'`'} handler)
  where catchAny io h = catch io (\e -> const h (e :: SomeException))

-- What the compiler knows about the program, which splices here cannot ask

data Info
  = ClassI Dec [Dec]
  | TyConI Dec
  | DataConI Name Type Name
  | VarI Name Type (Maybe Dec)
  | TyVarI Name Type
  deriving (Eq, Show)

data Loc = Loc
  { loc_filename :: String
  , loc_package :: String
  , loc_module :: String
  , loc_start :: (Int, Int)
  , loc_end :: (Int, Int)
  }
  deriving (Eq, Show)

data Extension = TemplateHaskell deriving (Eq, Show)

reify :: Name -> Q Info
reify _ = fail "reify"

reifyInstances :: Name -> [Type] -> Q [Dec]
reifyInstances _ _ = fail "reifyInstances"

reifyFixity :: Name -> Q (Maybe Fixity)
reifyFixity _ = fail "reifyFixity"

reifyType :: Name -> Q Type
reifyType _ = fail "reifyType"

reifyRoles :: Name -> Q [Role]
reifyRoles _ = fail "reifyRoles"

isInstance :: Name -> [Type] -> Q Bool
isInstance _ _ = fail "isInstance"

lookupTypeName :: String -> Q (Maybe Name)
lookupTypeName _ = fail "lookupTypeName"

lookupValueName :: String -> Q (Maybe Name)
lookupValueName _ = fail "lookupValueName"

location :: Q Loc
location = fail "location"

addTopDecls :: [Dec] -> Q ()
addTopDecls _ = fail "addTopDecls"

isExtEnabled :: Extension -> Q Bool
isExtEnabled _ = fail "isExtEnabled"

extsEnabled :: Q [Extension]
extsEnabled = fail "extsEnabled"

-- Typed expressions

newtype TExp a = TExp { unType :: Exp }

newtype Code m a = Code { examineCode :: m (TExp a) }

unTypeCode :: Quote m => Code m a -> m Exp
unTypeCode (Code m) = fmap unType m

unsafeCodeCoerce :: Quote m => m Exp -> Code m a
unsafeCodeCoerce m = Code (fmap TExp m)

liftCode :: m (TExp a) -> Code m a
liftCode = Code

hoistCode :: Monad m => (forall x. m x -> n x) -> Code m a -> Code n a
hoistCode f (Code m) = Code (f m)

bindCode :: Monad m => m a -> (a -> Code m b) -> Code m b
bindCode m k = Code (m >>= examineCode . k)

joinCode :: Monad m => m (Code m a) -> Code m a
joinCode m = Code (m >>= examineCode)

-- The typed quote [|| e ||] of an expression of type a, whose function only fixes a, never running.
typedQuote :: Quote m => (() -> a) -> m Exp -> Code m a
typedQuote _ = unsafeCodeCoerce

-- Lifting values into expressions

class Lift t where
  lift :: Quote m => t -> m Exp
  liftTyped :: Quote m => t -> Code m t
  liftTyped = unsafeCodeCoerce . lift

instance Lift Integer where
  lift x = return (LitE (IntegerL x))

instance Lift Int where
  lift x = return (LitE (IntegerL (toInteger x)))

instance Lift Word where
  lift x = return (LitE (IntegerL (toInteger x)))

instance Lift Char where
  lift x = return (LitE (CharL x))

instance Lift Double where
  lift x = return (LitE (RationalL (toRational x)))

instance Lift Float where
  lift x = return (LitE (RationalL (toRational x)))

instance Integral a => Lift (Ratio a) where
  lift x = return (LitE (RationalL (toRational x)))

instance Lift Bool where
  lift True = return (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Types" "True"))
  lift False = return (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Types" "False"))

instance Lift () where
  lift () = return (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Tuple" "()"))

instance Lift Ordering where
  lift o = return (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Types" (show o)))

instance Lift a => Lift (Maybe a) where
  lift Nothing = return (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Maybe" "Nothing"))
  lift (Just x) = fmap (AppE (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Maybe" "Just"))) (lift x)

instance (Lift a, Lift b) => Lift (Either a b) where
  lift (Left x) = fmap (AppE (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Data.Either" "Left"))) (lift x)
  lift (Right x) = fmap (AppE (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Data.Either" "Right"))) (lift x)

instance Lift a => Lift [a] where
  lift xs = fmap ListE (mapM lift xs)

instance Lift a => Lift (NonEmpty a) where
  lift (x :| xs) = do
    x' <- lift x
    xs' <- lift xs
    return (InfixE (Just x') (ConE (mkNameG_d "ghc-internal" "GHC.Internal.Base" ":|")) (Just xs'))

instance (Lift a, Lift b) => Lift (a, b) where
  lift (a, b) = do
    a' <- lift a
    b' <- lift b
    return (TupE [Just a', Just b'])

instance (Lift a, Lift b, Lift c) => Lift (a, b, c) where
  lift (a, b, c) = do
    a' <- lift a
    b' <- lift b
    c' <- lift c
    return (TupE [Just a', Just b', Just c'])

instance (Lift a, Lift b, Lift c, Lift d) => Lift (a, b, c, d) where
  lift (a, b, c, d) = do
    a' <- lift a
    b' <- lift b
    c' <- lift c
    d' <- lift d
    return (TupE [Just a', Just b', Just c', Just d'])

liftString :: Quote m => String -> m Exp
liftString s = return (LitE (StringL s))

liftData :: (Quote m, Lift a) => a -> m Exp
liftData = lift

-- Building the trees: literals

integerL :: Integer -> Lit
integerL = IntegerL

stringL :: String -> Lit
stringL = StringL

charL :: Char -> Lit
charL = CharL

rationalL :: Rational -> Lit
rationalL = RationalL

intPrimL :: Integer -> Lit
intPrimL = IntPrimL

wordPrimL :: Integer -> Lit
wordPrimL = WordPrimL

floatPrimL :: Rational -> Lit
floatPrimL = FloatPrimL

doublePrimL :: Rational -> Lit
doublePrimL = DoublePrimL

charPrimL :: Char -> Lit
charPrimL = CharPrimL

-- Expressions

varE :: Quote m => Name -> m Exp
varE = return . VarE

conE :: Quote m => Name -> m Exp
conE = return . ConE

litE :: Quote m => Lit -> m Exp
litE = return . LitE

appE :: Quote m => m Exp -> m Exp -> m Exp
appE = liftA2 AppE

appsE :: Quote m => [m Exp] -> m Exp
appsE [] = error "appsE []"
appsE [x] = x
appsE (x : y : zs) = appsE (appE x y : zs)

appTypeE :: Quote m => m Exp -> m Type -> m Exp
appTypeE = liftA2 AppTypeE

infixE :: Quote m => Maybe (m Exp) -> m Exp -> Maybe (m Exp) -> m Exp
infixE ma op mb = do
  a <- sequenceA ma
  o <- op
  b <- sequenceA mb
  return (InfixE a o b)

infixApp :: Quote m => m Exp -> m Exp -> m Exp -> m Exp
infixApp a op b = infixE (Just a) op (Just b)

sectionL :: Quote m => m Exp -> m Exp -> m Exp
sectionL a op = infixE (Just a) op Nothing

sectionR :: Quote m => m Exp -> m Exp -> m Exp
sectionR op b = infixE Nothing op (Just b)

uInfixE :: Quote m => m Exp -> m Exp -> m Exp -> m Exp
uInfixE a op b = UInfixE <$> a <*> op <*> b

parensE :: Quote m => m Exp -> m Exp
parensE = fmap ParensE

lamE :: Quote m => [m Pat] -> m Exp -> m Exp
lamE ps e = LamE <$> sequenceA ps <*> e

lam1E :: Quote m => m Pat -> m Exp -> m Exp
lam1E p = lamE [p]

lamCaseE :: Quote m => [m Match] -> m Exp
lamCaseE ms = LamCaseE <$> sequenceA ms

lamCasesE :: Quote m => [m Clause] -> m Exp
lamCasesE cs = LamCasesE <$> sequenceA cs

tupE :: Quote m => [m Exp] -> m Exp
tupE es = fmap (TupE . map Just) (sequenceA es)

tupSectionE :: Quote m => [Maybe (m Exp)] -> m Exp
tupSectionE es = fmap TupE (traverse sequenceA es)

condE :: Quote m => m Exp -> m Exp -> m Exp -> m Exp
condE c a b = CondE <$> c <*> a <*> b

multiIfE :: Quote m => [m (Guard, Exp)] -> m Exp
multiIfE alts = MultiIfE <$> sequenceA alts

letE :: Quote m => [m Dec] -> m Exp -> m Exp
letE ds e = LetE <$> sequenceA ds <*> e

caseE :: Quote m => m Exp -> [m Match] -> m Exp
caseE e ms = CaseE <$> e <*> sequenceA ms

doE :: Quote m => [m Stmt] -> m Exp
doE ss = DoE Nothing <$> sequenceA ss

mdoE :: Quote m => [m Stmt] -> m Exp
mdoE ss = MDoE Nothing <$> sequenceA ss

compE :: Quote m => [m Stmt] -> m Exp
compE ss = CompE <$> sequenceA ss

arithSeqE :: Quote m => m Range -> m Exp
arithSeqE = fmap ArithSeqE

fromE :: Quote m => m Exp -> m Exp
fromE a = arithSeqE (FromR <$> a)

fromThenE :: Quote m => m Exp -> m Exp -> m Exp
fromThenE a b = arithSeqE (FromThenR <$> a <*> b)

fromToE :: Quote m => m Exp -> m Exp -> m Exp
fromToE a b = arithSeqE (FromToR <$> a <*> b)

fromThenToE :: Quote m => m Exp -> m Exp -> m Exp -> m Exp
fromThenToE a b c = arithSeqE (FromThenToR <$> a <*> b <*> c)

listE :: Quote m => [m Exp] -> m Exp
listE es = ListE <$> sequenceA es

sigE :: Quote m => m Exp -> m Type -> m Exp
sigE = liftA2 SigE

recConE :: Quote m => Name -> [m (Name, Exp)] -> m Exp
recConE c fs = RecConE c <$> sequenceA fs

recUpdE :: Quote m => m Exp -> [m (Name, Exp)] -> m Exp
recUpdE e fs = RecUpdE <$> e <*> sequenceA fs

fieldExp :: Quote m => Name -> m Exp -> m (Name, Exp)
fieldExp n = fmap (\e -> (n, e))

stringE :: Quote m => String -> m Exp
stringE = litE . stringL

staticE :: Quote m => m Exp -> m Exp
staticE = fmap StaticE

unboundVarE :: Quote m => Name -> m Exp
unboundVarE = return . UnboundVarE

labelE :: Quote m => String -> m Exp
labelE = return . LabelE

implicitParamVarE :: Quote m => String -> m Exp
implicitParamVarE = return . ImplicitParamVarE

getFieldE :: Quote m => m Exp -> String -> m Exp
getFieldE e f = fmap (\x -> GetFieldE x f) e

projectionE :: Quote m => NonEmpty String -> m Exp
projectionE = return . ProjectionE

typedBracketE :: Quote m => m Exp -> m Exp
typedBracketE = fmap TypedBracketE

typedSpliceE :: Quote m => m Exp -> m Exp
typedSpliceE = fmap TypedSpliceE

typeE :: Quote m => m Type -> m Exp
typeE = fmap TypeE

-- Patterns

litP :: Quote m => Lit -> m Pat
litP = return . LitP

varP :: Quote m => Name -> m Pat
varP = return . VarP

tupP :: Quote m => [m Pat] -> m Pat
tupP ps = TupP <$> sequenceA ps

conP :: Quote m => Name -> [m Pat] -> m Pat
conP n ps = ConP n [] <$> sequenceA ps

infixP :: Quote m => m Pat -> Name -> m Pat -> m Pat
infixP a n b = (\x y -> InfixP x n y) <$> a <*> b

uInfixP :: Quote m => m Pat -> Name -> m Pat -> m Pat
uInfixP a n b = (\x y -> UInfixP x n y) <$> a <*> b

parensP :: Quote m => m Pat -> m Pat
parensP = fmap ParensP

tildeP :: Quote m => m Pat -> m Pat
tildeP = fmap TildeP

bangP :: Quote m => m Pat -> m Pat
bangP = fmap BangP

asP :: Quote m => Name -> m Pat -> m Pat
asP n = fmap (AsP n)

wildP :: Quote m => m Pat
wildP = return WildP

recP :: Quote m => Name -> [m FieldPat] -> m Pat
recP n fs = RecP n <$> sequenceA fs

fieldPat :: Quote m => Name -> m Pat -> m FieldPat
fieldPat n = fmap (\p -> (n, p))

listP :: Quote m => [m Pat] -> m Pat
listP ps = ListP <$> sequenceA ps

sigP :: Quote m => m Pat -> m Type -> m Pat
sigP = liftA2 SigP

viewP :: Quote m => m Exp -> m Pat -> m Pat
viewP = liftA2 ViewP

-- Bodies, guards, statements, matches, and clauses

normalB :: Quote m => m Exp -> m Body
normalB = fmap NormalB

guardedB :: Quote m => [m (Guard, Exp)] -> m Body
guardedB gs = GuardedB <$> sequenceA gs

normalG :: Quote m => m Exp -> m Guard
normalG = fmap NormalG

normalGE :: Quote m => m Exp -> m Exp -> m (Guard, Exp)
normalGE g e = (\a b -> (NormalG a, b)) <$> g <*> e

patG :: Quote m => [m Stmt] -> m Guard
patG ss = PatG <$> sequenceA ss

patGE :: Quote m => [m Stmt] -> m Exp -> m (Guard, Exp)
patGE ss e = (\a b -> (PatG a, b)) <$> sequenceA ss <*> e

bindS :: Quote m => m Pat -> m Exp -> m Stmt
bindS = liftA2 BindS

letS :: Quote m => [m Dec] -> m Stmt
letS ds = LetS <$> sequenceA ds

noBindS :: Quote m => m Exp -> m Stmt
noBindS = fmap NoBindS

parS :: Quote m => [[m Stmt]] -> m Stmt
parS sss = ParS <$> traverse sequenceA sss

recS :: Quote m => [m Stmt] -> m Stmt
recS ss = RecS <$> sequenceA ss

match :: Quote m => m Pat -> m Body -> [m Dec] -> m Match
match p b ds = Match <$> p <*> b <*> sequenceA ds

clause :: Quote m => [m Pat] -> m Body -> [m Dec] -> m Clause
clause ps b ds = Clause <$> sequenceA ps <*> b <*> sequenceA ds

-- Declarations

funD :: Quote m => Name -> [m Clause] -> m Dec
funD n cs = FunD n <$> sequenceA cs

valD :: Quote m => m Pat -> m Body -> [m Dec] -> m Dec
valD p b ds = ValD <$> p <*> b <*> sequenceA ds

sigD :: Quote m => Name -> m Type -> m Dec
sigD n = fmap (SigD n)

kiSigD :: Quote m => Name -> m Kind -> m Dec
kiSigD n = fmap (KiSigD n)

tySynD :: Quote m => Name -> [TyVarBndr BndrVis] -> m Type -> m Dec
tySynD n vs = fmap (TySynD n vs)

dataD :: Quote m => m Cxt -> Name -> [TyVarBndr BndrVis] -> Maybe Kind -> [m Con] -> [m DerivClause] -> m Dec
dataD c n vs k cons ds = (\c' cons' ds' -> DataD c' n vs k cons' ds') <$> c <*> sequenceA cons <*> sequenceA ds

newtypeD :: Quote m => m Cxt -> Name -> [TyVarBndr BndrVis] -> Maybe Kind -> m Con -> [m DerivClause] -> m Dec
newtypeD c n vs k con ds = (\c' con' ds' -> NewtypeD c' n vs k con' ds') <$> c <*> con <*> sequenceA ds

classD :: Quote m => m Cxt -> Name -> [TyVarBndr BndrVis] -> [FunDep] -> [m Dec] -> m Dec
classD c n vs fds ds = (\c' ds' -> ClassD c' n vs fds ds') <$> c <*> sequenceA ds

instanceD :: Quote m => m Cxt -> m Type -> [m Dec] -> m Dec
instanceD c t ds = InstanceD Nothing <$> c <*> t <*> sequenceA ds

instanceWithOverlapD :: Quote m => Maybe Overlap -> m Cxt -> m Type -> [m Dec] -> m Dec
instanceWithOverlapD o c t ds = InstanceD o <$> c <*> t <*> sequenceA ds

standaloneDerivD :: Quote m => m Cxt -> m Type -> m Dec
standaloneDerivD c t = StandaloneDerivD Nothing <$> c <*> t

defaultSigD :: Quote m => Name -> m Type -> m Dec
defaultSigD n = fmap (DefaultSigD n)

infixLD :: Quote m => Int -> Name -> m Dec
infixLD p n = return (InfixD (Fixity p InfixL) NoNamespaceSpecifier n)

infixRD :: Quote m => Int -> Name -> m Dec
infixRD p n = return (InfixD (Fixity p InfixR) NoNamespaceSpecifier n)

infixND :: Quote m => Int -> Name -> m Dec
infixND p n = return (InfixD (Fixity p InfixN) NoNamespaceSpecifier n)

defaultD :: Quote m => [m Type] -> m Dec
defaultD ts = DefaultD <$> sequenceA ts

roleAnnotD :: Quote m => Name -> [Role] -> m Dec
roleAnnotD n rs = return (RoleAnnotD n rs)

cxt :: Quote m => [m Pred] -> m Cxt
cxt = sequenceA

normalC :: Quote m => Name -> [m BangType] -> m Con
normalC n bts = NormalC n <$> sequenceA bts

recC :: Quote m => Name -> [m VarBangType] -> m Con
recC n vbts = RecC n <$> sequenceA vbts

infixC :: Quote m => m BangType -> Name -> m BangType -> m Con
infixC a n b = (\x y -> InfixC x n y) <$> a <*> b

bang :: Quote m => m SourceUnpackedness -> m SourceStrictness -> m Bang
bang = liftA2 Bang

bangType :: Quote m => m Bang -> m Type -> m BangType
bangType = liftA2 (,)

varBangType :: Quote m => Name -> m BangType -> m VarBangType
varBangType n = fmap (\(b, t) -> (n, b, t))

noSourceUnpackedness :: Quote m => m SourceUnpackedness
noSourceUnpackedness = return NoSourceUnpackedness

sourceNoUnpack :: Quote m => m SourceUnpackedness
sourceNoUnpack = return SourceNoUnpack

sourceUnpack :: Quote m => m SourceUnpackedness
sourceUnpack = return SourceUnpack

noSourceStrictness :: Quote m => m SourceStrictness
noSourceStrictness = return NoSourceStrictness

sourceLazy :: Quote m => m SourceStrictness
sourceLazy = return SourceLazy

sourceStrict :: Quote m => m SourceStrictness
sourceStrict = return SourceStrict

-- A via deriving clause of a quote, whose via type the quote builds.
quoteDerivVia :: Quote m => m Type -> [m Pred] -> m DerivClause
quoteDerivVia t ps = (\via cs -> DerivClause (Just (ViaStrategy via)) cs) <$> t <*> sequenceA ps

derivClause :: Quote m => Maybe DerivStrategy -> [m Pred] -> m DerivClause
derivClause s ps = DerivClause s <$> sequenceA ps

plainTV :: Name -> TyVarBndr ()
plainTV n = PlainTV n ()

kindedTV :: Name -> Kind -> TyVarBndr ()
kindedTV n k = KindedTV n () k

plainBndrTV :: Name -> TyVarBndr BndrVis
plainBndrTV n = PlainTV n BndrReq

-- Types

conT :: Quote m => Name -> m Type
conT = return . ConT

varT :: Quote m => Name -> m Type
varT = return . VarT

appT :: Quote m => m Type -> m Type -> m Type
appT = liftA2 AppT

appKindT :: Quote m => m Type -> m Kind -> m Type
appKindT = liftA2 AppKindT

arrowT :: Quote m => m Type
arrowT = return ArrowT

mulArrowT :: Quote m => m Type
mulArrowT = return MulArrowT

listT :: Quote m => m Type
listT = return ListT

tupleT :: Quote m => Int -> m Type
tupleT = return . TupleT

sigT :: Quote m => m Type -> m Kind -> m Type
sigT = liftA2 SigT

litT :: Quote m => m TyLit -> m Type
litT = fmap LitT

numTyLit :: Quote m => Integer -> m TyLit
numTyLit = return . NumTyLit

strTyLit :: Quote m => String -> m TyLit
strTyLit = return . StrTyLit

charTyLit :: Quote m => Char -> m TyLit
charTyLit = return . CharTyLit

promotedT :: Quote m => Name -> m Type
promotedT = return . PromotedT

equalityT :: Quote m => m Type
equalityT = return EqualityT

wildCardT :: Quote m => m Type
wildCardT = return WildCardT

starK :: Kind
starK = StarT

constraintK :: Kind
constraintK = ConstraintT

forallT :: Quote m => [TyVarBndr Specificity] -> m Cxt -> m Type -> m Type
forallT vs c t = ForallT vs <$> c <*> t

infixT :: Quote m => m Type -> Name -> m Type -> m Type
infixT a n b = (\x y -> InfixT x n y) <$> a <*> b

parensT :: Quote m => m Type -> m Type
parensT = fmap ParensT

-- Pretty printing, as pprint shows trees

class Ppr a where
  ppr :: a -> String
  pprList :: [a] -> String
  pprList xs = intercalate "\n" (map ppr xs)

instance Ppr a => Ppr [a] where
  ppr = pprList

pprint :: Ppr a => a -> String
pprint = ppr

instance Ppr Name where
  ppr = pprNamePrefix

instance Ppr Lit where
  ppr = pprLit 0

instance Ppr Exp where
  ppr = pprExp 0

instance Ppr Pat where
  ppr = pprPat 0

instance Ppr Type where
  ppr = pprType 0

instance Ppr Dec where
  ppr = pprDec
  pprList ds = intercalate "\n" (map pprDec ds)

instance Ppr Match where
  ppr (Match p b ds) = pprPat 0 p ++ pprBody " ->" b ++ pprWhere ds

instance Ppr Clause where
  ppr (Clause ps b ds) = unwords (map (pprPat 3) ps) ++ pprBody " =" b ++ pprWhere ds

instance Ppr Stmt where
  ppr = pprStmt

isSymOcc :: String -> Bool
isSymOcc "" = False
isSymOcc s@(c : _) = s /= "()" && s /= "[]" && not (isAlpha c || c == '_' || c == '(' || c == '[' || c == '\'')

pprNamePrefix :: Name -> String
pprNamePrefix n = if isSymOcc (nameBase n) then "(" ++ showName n ++ ")" else showName n

pprNameInfix :: Name -> String
pprNameInfix n = if isSymOcc (nameBase n) then showName n else "${'`'}" ++ showName n ++ "${'`'}"

-- Parts on one line when they fit GHC's line width, and on lines of their own, indented by one, when they do not.
pprSep :: [String] -> String
pprSep parts =
  let one = unwords parts
  in if length one <= 100 && notElem '\n' one then one else intercalate "\n " parts

parensIf :: Bool -> String -> String
parensIf True s = "(" ++ s ++ ")"
parensIf False s = s

pprLit :: Int -> Lit -> String
pprLit p (IntegerL i) = parensIf (p > 1 && i < 0) (show i)
pprLit _ (CharL c) = show c
pprLit _ (StringL s) = show s
pprLit p (RationalL r) = parensIf (p > 1 && r < 0) (showRational r)
pprLit p (IntPrimL i) = parensIf (p > 1 && i < 0) (show i ++ "#")
pprLit _ (WordPrimL i) = show i ++ "##"
pprLit _ (FloatPrimL r) = showRational r ++ "#"
pprLit _ (DoublePrimL r) = showRational r ++ "##"
pprLit _ (CharPrimL c) = show c ++ "#"

showRational :: Rational -> String
showRational r = case decimal r of
  Just s -> s
  Nothing -> show (numerator r) ++ " / " ++ show (denominator r)
  where
    decimal x
      | x < 0 = fmap ('-' :) (decimal (negate x))
      | otherwise = finite (numerator x) (denominator x)
    finite n d = if twosAndFives d then Just (digits n d) else Nothing
    twosAndFives d
      | d == 1 = True
      | d ${'`'}mod${'`'} 2 == 0 = twosAndFives (d ${'`'}div${'`'} 2)
      | d ${'`'}mod${'`'} 5 == 0 = twosAndFives (d ${'`'}div${'`'} 5)
      | otherwise = False
    digits n d = show (n ${'`'}div${'`'} d) ++ "." ++ fraction (n ${'`'}mod${'`'} d) d
    fraction 0 _ = "0"
    fraction n d = go n d
    go 0 _ = ""
    go n d = show ((n * 10) ${'`'}div${'`'} d) ++ go ((n * 10) ${'`'}mod${'`'} d) d

pprExp :: Int -> Exp -> String
pprExp _ (VarE n) = pprNamePrefix n
pprExp _ (ConE n) = pprNamePrefix n
pprExp p (LitE l) = pprLit p l
pprExp p (AppE f x) = parensIf (p >= 3) (pprExp 2 f ++ " " ++ pprExp 3 x)
pprExp p (AppTypeE f t) = parensIf (p >= 3) (pprExp 2 f ++ " @" ++ pprType 3 t)
pprExp p (InfixE (Just a) op (Just b)) = parensIf (p >= 1) (pprExp 1 a ++ " " ++ pprOp op ++ " " ++ pprExp 1 b)
pprExp _ (InfixE (Just a) op Nothing) = "(" ++ pprExp 1 a ++ " " ++ pprOp op ++ ")"
pprExp _ (InfixE Nothing op (Just b)) = "(" ++ pprOp op ++ " " ++ pprExp 1 b ++ ")"
pprExp _ (InfixE Nothing op Nothing) = "(" ++ pprOp op ++ ")"
pprExp p (UInfixE a op b) = parensIf (p >= 1) (pprExp 1 a ++ " " ++ pprOp op ++ " " ++ pprExp 1 b)
pprExp _ (ParensE e) = "(" ++ pprExp 0 e ++ ")"
pprExp p (LamE ps e) = parensIf (p > 0) ("\\" ++ unwords (map (pprPat 3) ps) ++ " -> " ++ pprExp 0 e)
pprExp p (LamCaseE ms) = parensIf (p > 0) ("\\case\n" ++ indent (intercalate "\n" (map ppr ms)))
pprExp _ (TupE es) = "(" ++ intercalate ", " (map (maybe "" (pprExp 0)) es) ++ ")"
pprExp p (CondE c a b) = parensIf (p > 0) (pprSep ["if " ++ pprExp 0 c, "then " ++ pprExp 0 a, "else " ++ pprExp 0 b])
pprExp p (MultiIfE alts) = parensIf (p > 0) ("if " ++ intercalate "\n   " [ "| " ++ pprGuard g ++ " -> " ++ pprExp 0 e | (g, e) <- alts ])
pprExp p (LetE ds e) = parensIf (p > 0) ("let " ++ indentAfterFirst 4 (intercalate "\n" (map pprDec ds)) ++ "\n in " ++ pprExp 0 e)
pprExp p (CaseE e ms) = parensIf (p > 0) ("case " ++ pprExp 0 e ++ " of {\n" ++ indent (intercalate ";\n" (map ppr ms)) ++ " }")
pprExp p (DoE _ ss) = parensIf (p > 0) ("do {" ++ intercalate "; " (map pprStmt ss) ++ "}")
pprExp p (MDoE _ ss) = parensIf (p > 0) ("mdo {" ++ intercalate "; " (map pprStmt ss) ++ "}")
pprExp _ (CompE ss) = case reverse ss of
  (NoBindS e : rest) -> "[" ++ pprExp 0 e ++ " | " ++ intercalate ", " (map pprStmt (reverse rest)) ++ "]"
  _ -> "<<empty comprehension>>"
pprExp _ (ArithSeqE r) = "[" ++ pprRange r ++ "]"
pprExp _ (ListE es) = "[" ++ intercalate ", " (map (pprExp 0) es) ++ "]"
pprExp p (SigE e t) = parensIf (p > 0) (pprExp 1 e ++ " :: " ++ pprType 0 t)
pprExp _ (RecConE n fs) = pprNamePrefix n ++ "{" ++ intercalate ", " [pprNamePrefix f ++ " = " ++ pprExp 0 e | (f, e) <- fs] ++ "}"
pprExp _ (RecUpdE e fs) = pprExp 3 e ++ "{" ++ intercalate ", " [pprNamePrefix f ++ " = " ++ pprExp 0 x | (f, x) <- fs] ++ "}"
pprExp p (StaticE e) = parensIf (p >= 3) ("static " ++ pprExp 3 e)
pprExp _ (UnboundVarE n) = pprNamePrefix n
pprExp _ (LabelE s) = "#" ++ s
pprExp _ (ImplicitParamVarE s) = "?" ++ s
pprExp _ (GetFieldE e f) = pprExp 3 e ++ "." ++ f
pprExp _ (TypedBracketE e) = "[||" ++ pprExp 0 e ++ "||]"
pprExp _ (TypedSpliceE e) = "$$" ++ pprExp 3 e
pprExp _ (TypeE t) = "type " ++ pprType 3 t
pprExp _ e = show e

pprOp :: Exp -> String
pprOp (VarE n) = pprNameInfix n
pprOp (ConE n) = pprNameInfix n
pprOp (UnboundVarE n) = pprNameInfix n
pprOp e = "${'`'}" ++ pprExp 3 e ++ "${'`'}"

pprRange :: Range -> String
pprRange (FromR a) = pprExp 0 a ++ " .."
pprRange (FromThenR a b) = pprExp 0 a ++ ", " ++ pprExp 0 b ++ " .."
pprRange (FromToR a b) = pprExp 0 a ++ " .. " ++ pprExp 0 b
pprRange (FromThenToR a b c) = pprExp 0 a ++ ", " ++ pprExp 0 b ++ " .. " ++ pprExp 0 c

pprStmt :: Stmt -> String
pprStmt (BindS p e) = pprPat 0 p ++ " <- " ++ pprExp 0 e
pprStmt (LetS ds) = "let {" ++ intercalate "; " (map pprDec ds) ++ "}"
pprStmt (NoBindS e) = pprExp 0 e
pprStmt (ParS sss) = intercalate " | " (map (intercalate ", " . map pprStmt) sss)
pprStmt (RecS ss) = "rec {" ++ intercalate "; " (map pprStmt ss) ++ "}"

pprGuard :: Guard -> String
pprGuard (NormalG e) = pprExp 0 e
pprGuard (PatG ss) = intercalate ", " (map pprStmt ss)

pprBody :: String -> Body -> String
pprBody eq (NormalB e) = eq ++ " " ++ pprExp 0 e
pprBody eq (GuardedB gs) = concat ["\n    | " ++ pprGuard g ++ eq ++ " " ++ pprExp 0 e | (g, e) <- gs]

pprWhere :: [Dec] -> String
pprWhere [] = ""
pprWhere ds = "\n    where\n" ++ indent (intercalate "\n" (map pprDec ds))

pprPat :: Int -> Pat -> String
pprPat p (LitP l) = pprLit p l
pprPat _ (VarP n) = pprNamePrefix n
pprPat _ (TupP ps) = "(" ++ intercalate ", " (map (pprPat 0) ps) ++ ")"
pprPat _ (ConP n _ []) = pprNamePrefix n
pprPat p (ConP n _ ps) = parensIf (p >= 2) (pprNamePrefix n ++ " " ++ unwords (map (pprPat 3) ps))
pprPat p (InfixP a n b) = parensIf (p >= 2) (pprPat 2 a ++ " " ++ pprNameInfix n ++ " " ++ pprPat 2 b)
pprPat p (UInfixP a n b) = parensIf (p >= 2) (pprPat 2 a ++ " " ++ pprNameInfix n ++ " " ++ pprPat 2 b)
pprPat _ (ParensP q) = "(" ++ pprPat 0 q ++ ")"
pprPat _ (TildeP q) = "~" ++ pprPat 3 q
pprPat _ (BangP q) = "!" ++ pprPat 3 q
pprPat _ (AsP n q) = pprNamePrefix n ++ "@" ++ pprPat 3 q
pprPat _ WildP = "_"
pprPat _ (RecP n fs) = pprNamePrefix n ++ " {" ++ intercalate ", " [pprNamePrefix f ++ " = " ++ pprPat 0 q | (f, q) <- fs] ++ "}"
pprPat _ (ListP ps) = "[" ++ intercalate ", " (map (pprPat 0) ps) ++ "]"
pprPat p (SigP q t) = parensIf (p > 0) (pprPat 1 q ++ " :: " ++ pprType 0 t)
pprPat p (ViewP e q) = parensIf (p > 0) (pprExp 1 e ++ " -> " ++ pprPat 0 q)
pprPat _ q = show q

pprType :: Int -> Type -> String
pprType p (ForallT vs c t) =
  parensIf (p > 0) ("forall " ++ unwords (map pprTyVar vs) ++ " . " ++ pprCxt c ++ pprType 0 t)
pprType p (AppT (AppT ArrowT a) b) = parensIf (p > 0) (pprType 1 a ++ " -> " ++ pprType 0 b)
pprType _ (AppT ListT a) = "[" ++ pprType 0 a ++ "]"
pprType p t@(AppT _ _) = case splitT t [] of
  (TupleT n, args) | length args == n -> "(" ++ intercalate ", " (map (pprType 0) args) ++ ")"
  (f, args) -> parensIf (p >= 3) (unwords (pprType 2 f : map (pprType 3) args))
  where
    splitT (AppT f x) acc = splitT f (x : acc)
    splitT f acc = (f, acc)
pprType _ (VarT n) = pprNamePrefix n
pprType _ (ConT n) = pprNamePrefix n
pprType _ (PromotedT n) = "'" ++ pprNamePrefix n
pprType p (SigT t k) = parensIf (p > 0) (pprType 1 t ++ " :: " ++ pprType 0 k)
pprType p (InfixT a n b) = parensIf (p > 0) (pprType 1 a ++ " " ++ pprNameInfix n ++ " " ++ pprType 1 b)
pprType _ (ParensT t) = "(" ++ pprType 0 t ++ ")"
pprType _ (TupleT 0) = "()"
pprType _ (TupleT n) = "(" ++ replicate (n - 1) ',' ++ ")"
pprType _ ArrowT = "(->)"
pprType _ EqualityT = "(~)"
pprType _ ListT = "[]"
pprType _ StarT = "*"
pprType _ ConstraintT = "Constraint"
pprType _ (LitT (NumTyLit n)) = show n
pprType _ (LitT (StrTyLit s)) = show s
pprType _ (LitT (CharTyLit c)) = show c
pprType _ WildCardT = "_"
pprType _ t = show t

pprTyVar :: TyVarBndr flag -> String
pprTyVar (PlainTV n _) = pprNamePrefix n
pprTyVar (KindedTV n _ k) = "(" ++ pprNamePrefix n ++ " :: " ++ pprType 0 k ++ ")"

pprCxt :: Cxt -> String
pprCxt [] = ""
pprCxt [c] = pprType 1 c ++ " => "
pprCxt cs = "(" ++ intercalate ", " (map (pprType 0) cs) ++ ") => "

pprDec :: Dec -> String
pprDec (FunD n cs) = intercalate "\n" [pprNamePrefix n ++ " " ++ ppr c | c <- cs]
pprDec (ValD p b ds) = pprPat 0 p ++ pprBody " =" b ++ pprWhere ds
pprDec (SigD n t) = pprNamePrefix n ++ " :: " ++ pprType 0 t
pprDec (KiSigD n k) = "type " ++ pprNamePrefix n ++ " :: " ++ pprType 0 k
pprDec (TySynD n vs t) = "type " ++ unwords (pprNamePrefix n : map pprTyVar vs) ++ " = " ++ pprType 0 t
pprDec (DataD c n vs _ cons ders) =
  "data " ++ pprCxt c ++ unwords (pprNamePrefix n : map pprTyVar vs) ++ pprCons cons ++ pprDerivs ders
pprDec (NewtypeD c n vs _ con ders) =
  "newtype " ++ pprCxt c ++ unwords (pprNamePrefix n : map pprTyVar vs) ++ pprCons [con] ++ pprDerivs ders
pprDec (ClassD c n vs fds ds) =
  "class " ++ pprCxt c ++ unwords (pprNamePrefix n : map pprTyVar vs) ++ pprFunDeps fds ++ pprMembers ds
pprDec (InstanceD o c t ds) = "instance " ++ maybe "" renderOverlap o ++ pprCxt c ++ pprType 0 t ++ pprMembers ds
pprDec (StandaloneDerivD _ c t) = "deriving instance " ++ pprCxt c ++ pprType 0 t
pprDec (DefaultSigD n t) = "default " ++ pprNamePrefix n ++ " :: " ++ pprType 0 t
pprDec (InfixD (Fixity p d) _ n) = dir d ++ " " ++ show p ++ " " ++ pprNameInfix n
  where
    dir InfixL = "infixl"
    dir InfixR = "infixr"
    dir InfixN = "infix"
pprDec (DefaultD ts) = "default (" ++ intercalate ", " (map (pprType 0) ts) ++ ")"
pprDec d = show d

pprMembers :: [Dec] -> String
pprMembers [] = ""
pprMembers ds = "\n    where\n" ++ indent (intercalate "\n" (map pprDec ds))

pprCons :: [Con] -> String
pprCons [] = ""
pprCons cons = "\n    = " ++ intercalate "\n    | " (map pprCon cons)

pprCon :: Con -> String
pprCon (NormalC n bts) = unwords (pprNamePrefix n : [pprBang b ++ pprType 3 t | (b, t) <- bts])
pprCon (RecC n vbts) = pprNamePrefix n ++ " {" ++ intercalate ", " [pprNamePrefix f ++ " :: " ++ pprBang b ++ pprType 0 t | (f, b, t) <- vbts] ++ "}"
pprCon (InfixC (b1, t1) n (b2, t2)) = pprBang b1 ++ pprType 2 t1 ++ " " ++ pprNameInfix n ++ " " ++ pprBang b2 ++ pprType 2 t2
pprCon c = show c

pprBang :: Bang -> String
pprBang (Bang _ SourceStrict) = "!"
pprBang (Bang _ SourceLazy) = "~"
pprBang _ = ""

pprDerivs :: [DerivClause] -> String
pprDerivs ds = concat ["\n    deriving " ++ pprDeriv s c | DerivClause s c <- ds]
  where
    classes [t] = pprType 0 t
    classes c = "(" ++ intercalate ", " (map (pprType 0) c) ++ ")"
    pprDeriv (Just (ViaStrategy t)) c = classes c ++ " via " ++ pprType 0 t
    pprDeriv s c = maybe "" renderStrategy s ++ classes c

pprFunDeps :: [FunDep] -> String
pprFunDeps [] = ""
pprFunDeps fds = " | " ++ intercalate ", " [unwords (map pprNamePrefix a) ++ " -> " ++ unwords (map pprNamePrefix b) | FunDep a b <- fds]

indent :: String -> String
indent s = intercalate "\n" (map ("    " ++) (lines s))

indentAfterFirst :: Int -> String -> String
indentAfterFirst n s = case lines s of
  [] -> ""
  (l : ls) -> intercalate "\n" (l : map (replicate n ' ' ++) ls)

-- Rendering trees as source text for splices: one line, with explicit braces, and names as the program refers to them

-- A new name is marked with its number, which the compiler drops where no other new name has the same name.
spliceName :: Name -> String
spliceName (Name (OccName occ) flavour) = case flavour of
  NameU u -> "\1" ++ occ ++ "\2" ++ show u ++ "\3"
  NameL u -> "\1" ++ occ ++ "\2" ++ show u ++ "\3"
  NameQ (ModName m) -> m ++ "." ++ occ
  _ -> occ

renderNamePrefix :: Name -> String
renderNamePrefix n = let s = spliceName n in if isSymOcc (nameBase n) then "(" ++ s ++ ")" else s

renderNameInfix :: Name -> String
renderNameInfix n = let s = spliceName n in if isSymOcc (nameBase n) then s else "${'`'}" ++ s ++ "${'`'}"

renderLit :: Lit -> String
renderLit (IntegerL i) = "(" ++ show i ++ ")"
renderLit (CharL c) = show c
renderLit (StringL s) = show s
renderLit (RationalL r) = "(" ++ show (numerator r) ++ " / " ++ show (denominator r) ++ ")"
renderLit l = pprLit 0 l

renderExp :: Exp -> String
renderExp (VarE n) = renderNamePrefix n
renderExp (ConE n) = renderNamePrefix n
renderExp (UnboundVarE n) = renderNamePrefix n
renderExp (LitE l) = renderLit l
renderExp (AppE f x) = "(" ++ renderExp f ++ " " ++ renderExp x ++ ")"
renderExp (AppTypeE f t) = "(" ++ renderExp f ++ " @" ++ renderTypeAtom t ++ ")"
renderExp (InfixE (Just a) op (Just b)) = "(" ++ renderExp a ++ " " ++ renderOp op ++ " " ++ renderExp b ++ ")"
renderExp (InfixE (Just a) op Nothing) = "(" ++ renderExp a ++ " " ++ renderOp op ++ ")"
renderExp (InfixE Nothing op (Just b)) = "(" ++ renderOp op ++ " " ++ renderExp b ++ ")"
renderExp (InfixE Nothing op Nothing) = "(" ++ renderOp op ++ ")"
-- An unresolved chain is written without inner parentheses, so that the operators' fixities order it, as in GHC.
renderExp (UInfixE a op b) = "(" ++ renderUInfix a ++ " " ++ renderOp op ++ " " ++ renderUInfix b ++ ")"
renderExp (ParensE e) = "(" ++ renderExp e ++ ")"
renderExp (LamE ps e) = "(\\" ++ unwords (map renderPat ps) ++ " -> " ++ renderExp e ++ ")"
renderExp (LamCaseE ms) = "(\\case {" ++ intercalate "; " (map renderMatch ms) ++ "})"
renderExp (TupE es) = "(" ++ intercalate ", " (map (maybe "" renderExp) es) ++ ")"
renderExp (CondE c a b) = "(if " ++ renderExp c ++ " then " ++ renderExp a ++ " else " ++ renderExp b ++ ")"
renderExp (MultiIfE alts) = "(if {" ++ concat [" | " ++ renderGuard g ++ " -> " ++ renderExp e | (g, e) <- alts] ++ " })"
renderExp (LetE ds e) = "(let {" ++ intercalate "; " (map renderDec ds) ++ "} in " ++ renderExp e ++ ")"
renderExp (CaseE e ms) = "(case " ++ renderExp e ++ " of {" ++ intercalate "; " (map renderMatch ms) ++ "})"
renderExp (DoE _ ss) = "(do {" ++ intercalate "; " (map renderStmt ss) ++ "})"
renderExp (MDoE _ ss) = "(mdo {" ++ intercalate "; " (map renderStmt ss) ++ "})"
renderExp (CompE ss) = case reverse ss of
  (NoBindS e : rest) -> "[" ++ renderExp e ++ " | " ++ intercalate ", " (map renderStmt (reverse rest)) ++ "]"
  _ -> error "renderExp: empty comprehension"
renderExp (ArithSeqE r) = "[" ++ renderRange r ++ "]"
renderExp (ListE es) = "[" ++ intercalate ", " (map renderExp es) ++ "]"
renderExp (SigE e t) = "(" ++ renderExp e ++ " :: " ++ renderType t ++ ")"
renderExp (RecConE n fs) = "(" ++ renderNamePrefix n ++ " {" ++ intercalate ", " [renderNamePrefix f ++ " = " ++ renderExp e | (f, e) <- fs] ++ "})"
renderExp (RecUpdE e fs) = "(" ++ renderExp e ++ " {" ++ intercalate ", " [renderNamePrefix f ++ " = " ++ renderExp x | (f, x) <- fs] ++ "})"
renderExp (LabelE s) = "#" ++ s
renderExp (ImplicitParamVarE s) = "?" ++ s
renderExp (GetFieldE e f) = "(" ++ renderExp e ++ ")." ++ f
renderExp (TypeE t) = "(type " ++ renderTypeAtom t ++ ")"
-- A tree with no spliced form here is unavailable. (This and the other render messages are Japanese, written with
-- escapes, since a library source is ASCII: "この形の式を作るスプライスは、この採点環境では使えません。" and the like.)
renderExp _ = errorWithoutStackTrace "\12371\12398\24418\12398\24335\12434\20316\12427\12473\12503\12521\12452\12473\12399\12289\12371\12398\25505\28857\29872\22659\12391\12399\20351\12360\12414\12379\12435\12290"

renderUInfix :: Exp -> String
renderUInfix (UInfixE a op b) = renderUInfix a ++ " " ++ renderOp op ++ " " ++ renderUInfix b
renderUInfix e = renderExp e

renderOp :: Exp -> String
renderOp (VarE n) = renderNameInfix n
renderOp (ConE n) = renderNameInfix n
renderOp (UnboundVarE n) = renderNameInfix n
renderOp e = "${'`'}" ++ renderExp e ++ "${'`'}"

renderRange :: Range -> String
renderRange (FromR a) = renderExp a ++ " .."
renderRange (FromThenR a b) = renderExp a ++ ", " ++ renderExp b ++ " .."
renderRange (FromToR a b) = renderExp a ++ " .. " ++ renderExp b
renderRange (FromThenToR a b c) = renderExp a ++ ", " ++ renderExp b ++ " .. " ++ renderExp c

renderStmt :: Stmt -> String
renderStmt (BindS p e) = renderPat p ++ " <- " ++ renderExp e
renderStmt (LetS ds) = "let {" ++ intercalate "; " (map renderDec ds) ++ "}"
renderStmt (NoBindS e) = renderExp e
renderStmt (ParS sss) = intercalate " | " (map (intercalate ", " . map renderStmt) sss)
renderStmt (RecS ss) = "rec {" ++ intercalate "; " (map renderStmt ss) ++ "}"

renderGuard :: Guard -> String
renderGuard (NormalG e) = renderExp e
renderGuard (PatG ss) = intercalate ", " (map renderStmt ss)

renderBody :: String -> Body -> String
renderBody eq (NormalB e) = " " ++ eq ++ " " ++ renderExp e
renderBody eq (GuardedB gs) = concat [" | " ++ renderGuard g ++ " " ++ eq ++ " " ++ renderExp e | (g, e) <- gs]

renderWhere :: [Dec] -> String
renderWhere [] = ""
renderWhere ds = " where {" ++ intercalate "; " (map renderDec ds) ++ "}"

renderMatch :: Match -> String
renderMatch (Match p b ds) = renderPat p ++ renderBody "->" b ++ renderWhere ds

renderPat :: Pat -> String
renderPat (LitP l) = renderLit l
renderPat (VarP n) = renderNamePrefix n
renderPat (TupP ps) = "(" ++ intercalate ", " (map renderPat ps) ++ ")"
renderPat (ConP n _ ps) = "(" ++ unwords (renderNamePrefix n : map renderPat ps) ++ ")"
renderPat (InfixP a n b) = "(" ++ renderPat a ++ " " ++ renderNameInfix n ++ " " ++ renderPat b ++ ")"
renderPat (UInfixP a n b) = "(" ++ renderPat a ++ " " ++ renderNameInfix n ++ " " ++ renderPat b ++ ")"
renderPat (ParensP p) = "(" ++ renderPat p ++ ")"
renderPat (TildeP p) = "(~" ++ renderPat p ++ ")"
renderPat (BangP p) = "(!" ++ renderPat p ++ ")"
renderPat (AsP n p) = "(" ++ renderNamePrefix n ++ "@" ++ renderPat p ++ ")"
renderPat WildP = "_"
renderPat (RecP n fs) = "(" ++ renderNamePrefix n ++ " {" ++ intercalate ", " [renderNamePrefix f ++ " = " ++ renderPat p | (f, p) <- fs] ++ "})"
renderPat (ListP ps) = "[" ++ intercalate ", " (map renderPat ps) ++ "]"
renderPat (SigP p t) = "(" ++ renderPat p ++ " :: " ++ renderType t ++ ")"
renderPat (ViewP e p) = "(" ++ renderExp e ++ " -> " ++ renderPat p ++ ")"
renderPat _ = errorWithoutStackTrace "\12371\12398\24418\12398\12497\12479\12540\12531\12434\20316\12427\12473\12503\12521\12452\12473\12399\12289\12371\12398\25505\28857\29872\22659\12391\12399\20351\12360\12414\12379\12435\12290"

renderTypeAtom :: Type -> String
renderTypeAtom t = "(" ++ renderType t ++ ")"

renderType :: Type -> String
renderType (ForallT vs c t) = (if null vs then "" else "forall " ++ unwords (map renderTyVar vs) ++ ". ") ++ renderCxt c ++ renderType t
renderType (AppT (AppT ArrowT a) b) = renderTypeAtom a ++ " -> " ++ renderTypeAtom b
renderType (AppT ListT a) = "[" ++ renderType a ++ "]"
renderType t@(AppT _ _) = case splitT t [] of
  (TupleT n, args) | length args == n -> "(" ++ intercalate ", " (map renderType args) ++ ")"
  (f, args) -> unwords (renderTypeAtom f : map renderTypeAtom args)
  where
    splitT (AppT f x) acc = splitT f (x : acc)
    splitT f acc = (f, acc)
renderType (VarT n) = renderNamePrefix n
renderType (ConT n) = renderNamePrefix n
renderType (PromotedT n) = "'" ++ renderNamePrefix n
renderType (SigT t k) = "(" ++ renderType t ++ " :: " ++ renderType k ++ ")"
renderType (InfixT a n b) = renderTypeAtom a ++ " " ++ renderNameInfix n ++ " " ++ renderTypeAtom b
renderType (ParensT t) = renderTypeAtom t
renderType (TupleT 0) = "()"
renderType (TupleT n) = "(" ++ replicate (n - 1) ',' ++ ")"
renderType ArrowT = "(->)"
renderType ListT = "[]"
renderType EqualityT = "(~)"
renderType StarT = "Type"
renderType ConstraintT = "Constraint"
renderType (LitT (NumTyLit n)) = show n
renderType (LitT (StrTyLit s)) = show s
renderType (LitT (CharTyLit c)) = show c
renderType WildCardT = "_"
renderType _ = errorWithoutStackTrace "\12371\12398\24418\12398\22411\12434\20316\12427\12473\12503\12521\12452\12473\12399\12289\12371\12398\25505\28857\29872\22659\12391\12399\20351\12360\12414\12379\12435\12290"

renderTyVar :: TyVarBndr flag -> String
renderTyVar (PlainTV n _) = renderNamePrefix n
renderTyVar (KindedTV n _ k) = "(" ++ renderNamePrefix n ++ " :: " ++ renderType k ++ ")"

renderCxt :: Cxt -> String
renderCxt [] = ""
renderCxt cs = "(" ++ intercalate ", " (map renderType cs) ++ ") => "

renderDec :: Dec -> String
renderDec (FunD n cs) = intercalate "; " [unwords (renderNamePrefix n : map renderPat ps) ++ renderBody "=" b ++ renderWhere ds | Clause ps b ds <- cs]
renderDec (ValD p b ds) = renderPat p ++ renderBody "=" b ++ renderWhere ds
renderDec (SigD n t) = renderNamePrefix n ++ " :: " ++ renderType t
renderDec (KiSigD n k) = "type " ++ renderNamePrefix n ++ " :: " ++ renderType k
renderDec (TySynD n vs t) = "type " ++ unwords (renderNamePrefix n : map renderTyVar vs) ++ " = " ++ renderType t
renderDec (DataD c n vs k cons ders) =
  "data " ++ renderCxt c ++ unwords (renderNamePrefix n : map renderTyVar vs) ++ renderKindSig k ++ renderCons cons ++ renderDerivs ders
renderDec (NewtypeD c n vs k con ders) =
  "newtype " ++ renderCxt c ++ unwords (renderNamePrefix n : map renderTyVar vs) ++ renderKindSig k ++ renderCons [con] ++ renderDerivs ders
renderDec (ClassD c n vs fds ds) =
  "class " ++ renderCxt c ++ unwords (renderNamePrefix n : map renderTyVar vs) ++ renderFunDeps fds ++ renderMembers ds
renderDec (InstanceD o c t ds) = "instance " ++ maybe "" renderOverlap o ++ renderCxt c ++ renderType t ++ renderMembers ds
renderDec (StandaloneDerivD s c t) = "deriving " ++ maybe "" renderStrategy s ++ "instance " ++ renderCxt c ++ renderType t
renderDec (DefaultSigD n t) = "default " ++ renderNamePrefix n ++ " :: " ++ renderType t
renderDec (InfixD (Fixity p d) _ n) = dir d ++ " " ++ show p ++ " " ++ renderNameInfix n
  where
    dir InfixL = "infixl"
    dir InfixR = "infixr"
    dir InfixN = "infix"
renderDec (DefaultD ts) = "default (" ++ intercalate ", " (map renderType ts) ++ ")"
renderDec (RoleAnnotD n rs) = "type role " ++ renderNamePrefix n ++ concatMap role rs
  where
    role NominalR = " nominal"
    role RepresentationalR = " representational"
    role PhantomR = " phantom"
    role InferR = " _"
renderDec _ = errorWithoutStackTrace "\12371\12398\24418\12398\23459\35328\12434\20316\12427\12473\12503\12521\12452\12473\12399\12289\12371\12398\25505\28857\29872\22659\12391\12399\20351\12360\12414\12379\12435\12290"

renderKindSig :: Maybe Kind -> String
renderKindSig Nothing = ""
renderKindSig (Just k) = " :: " ++ renderType k

renderOverlap :: Overlap -> String
renderOverlap Overlappable = "{-# OVERLAPPABLE #-} "
renderOverlap Overlapping = "{-# OVERLAPPING #-} "
renderOverlap Overlaps = "{-# OVERLAPS #-} "
renderOverlap Incoherent = "{-# INCOHERENT #-} "

renderStrategy :: DerivStrategy -> String
renderStrategy StockStrategy = "stock "
renderStrategy AnyclassStrategy = "anyclass "
renderStrategy NewtypeStrategy = "newtype "
renderStrategy (ViaStrategy t) = "via " ++ renderTypeAtom t ++ " "

renderFunDeps :: [FunDep] -> String
renderFunDeps [] = ""
renderFunDeps fds = " | " ++ intercalate ", " [unwords (map renderNamePrefix a) ++ " -> " ++ unwords (map renderNamePrefix b) | FunDep a b <- fds]

renderMembers :: [Dec] -> String
renderMembers [] = ""
renderMembers ds = " where {" ++ intercalate "; " (map renderDec ds) ++ "}"

renderCons :: [Con] -> String
renderCons [] = ""
renderCons cons = " = " ++ intercalate " | " (map renderCon cons)

renderCon :: Con -> String
renderCon (NormalC n bts) = unwords (renderNamePrefix n : [renderBang b ++ renderTypeAtom t | (b, t) <- bts])
renderCon (RecC n vbts) = renderNamePrefix n ++ " {" ++ intercalate ", " [renderNamePrefix f ++ " :: " ++ renderBang b ++ renderTypeAtom t | (f, b, t) <- vbts] ++ "}"
renderCon (InfixC (b1, t1) n (b2, t2)) = renderBang b1 ++ renderTypeAtom t1 ++ " " ++ renderNameInfix n ++ " " ++ renderBang b2 ++ renderTypeAtom t2
renderCon (ForallC vs c con) = "forall " ++ unwords (map renderTyVar vs) ++ ". " ++ renderCxt c ++ renderCon con
renderCon _ = errorWithoutStackTrace "\12371\12398\24418\12398\27083\25104\23376\65288GADT \12398\27083\25104\23376\12394\12393\65289\12434\20316\12427\12473\12503\12521\12452\12473\12399\12289\12371\12398\25505\28857\29872\22659\12391\12399\20351\12360\12414\12379\12435\12290"

renderBang :: Bang -> String
renderBang (Bang _ SourceStrict) = "!"
renderBang (Bang _ SourceLazy) = "~"
renderBang _ = ""

renderDerivs :: [DerivClause] -> String
renderDerivs ds = concat [renderDeriv s ("(" ++ intercalate ", " (map renderType c) ++ ")") | DerivClause s c <- ds]
  where
    -- A via type comes after the classes: deriving (C) via T.
    renderDeriv (Just (ViaStrategy t)) classes = " deriving " ++ classes ++ " via " ++ renderTypeAtom t
    renderDeriv s classes = " deriving " ++ maybe "" renderStrategy s ++ classes

-- What a splice gives, which the compiler reads from the output of the program that runs it.

class Splice a where
  renderSplice :: a -> String

instance Splice Exp where
  renderSplice = renderExp

instance Splice Pat where
  renderSplice = renderPat

instance Splice Type where
  renderSplice = renderType

instance Splice Dec where
  renderSplice = renderDec

instance Splice a => Splice [a] where
  renderSplice xs = intercalate "; " (map renderSplice xs)

runSplice :: Splice a => Q a -> IO ()
-- The code a splice spells, after a mark that keeps it apart from what the splice prints itself while it runs.
runSplice (Q io) = io >>= \x -> putStr ("\0" ++ renderSplice x)

runDecSplice :: Q [Dec] -> IO ()
runDecSplice = runSplice

runTypedSplice :: Code Q a -> IO ()
runTypedSplice code = runSplice (unTypeCode code)

-- Quasi-quoters, whose functions turn a quasi-quote's text into trees

data QuasiQuoter = QuasiQuoter
  { quoteExp :: String -> Q Exp
  , quotePat :: String -> Q Pat
  , quoteType :: String -> Q Type
  , quoteDec :: String -> Q [Dec]
  }

-- The names the quotes of a program refer to

quoteGlobalVar :: Quote m => String -> String -> m Exp
quoteGlobalVar m occ = return (VarE (mkNameG_v (packageOf m) m occ))

quoteGlobalCon :: Quote m => String -> String -> m Exp
quoteGlobalCon m occ = return (ConE (mkNameG_d (packageOf m) m occ))

quoteGlobalType :: Quote m => String -> String -> m Type
quoteGlobalType m occ = return (ConT (mkNameG_tc (packageOf m) m occ))

packageOf :: String -> String
packageOf m = if m == "Main" then "main" else "ghc-internal"
`;
