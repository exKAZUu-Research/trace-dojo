/**
 * Standard input, files, exceptions, mutable references, the ST monad, the program's exit, and debugging output, as
 * GHC's base defines them. Primitives read and write the run's standard streams and its virtual file system.
 */
export const SYSTEM_IO = String.raw`
-- Exceptions

data SomeException = forall e. Exception e => SomeException e

class Show e => Exception e where
  toException :: e -> SomeException
  fromException :: SomeException -> Maybe e
  displayException :: e -> String
  toException = SomeException
  fromException (SomeException e) = castException e
  displayException = show

castException :: (Exception a, Exception b) => a -> Maybe b
castException = primitive "castException"

instance Show SomeException where
  showsPrec p (SomeException e) = showsPrec p e

instance Exception SomeException where
  toException e = e
  fromException e = Just e
  displayException (SomeException e) = displayException e

data ErrorCall = ErrorCall String

instance Eq ErrorCall where
  ErrorCall a == ErrorCall b = a == b

instance Ord ErrorCall where
  compare (ErrorCall a) (ErrorCall b) = compare a b

instance Show ErrorCall where
  showsPrec _ (ErrorCall message) = showString message

instance Exception ErrorCall

data ArithException = Overflow | Underflow | LossOfPrecision | DivideByZero | Denormal | RatioZeroDenominator

instance Eq ArithException where
  a == b = primConTag a == primConTag b

instance Ord ArithException where
  compare a b = compare (primConTag a) (primConTag b)

instance Show ArithException where
  showsPrec _ Overflow = showString "arithmetic overflow"
  showsPrec _ Underflow = showString "arithmetic underflow"
  showsPrec _ LossOfPrecision = showString "loss of precision"
  showsPrec _ DivideByZero = showString "divide by zero"
  showsPrec _ Denormal = showString "denormal"
  showsPrec _ RatioZeroDenominator = showString "Ratio has zero denominator"

instance Exception ArithException

newtype PatternMatchFail = PatternMatchFail String

instance Show PatternMatchFail where
  showsPrec _ (PatternMatchFail message) = showString message

instance Exception PatternMatchFail

newtype AssertionFailed = AssertionFailed String

instance Show AssertionFailed where
  showsPrec _ (AssertionFailed message) = showString message

instance Exception AssertionFailed

data ArrayException = IndexOutOfBounds String | UndefinedElement String

instance Show ArrayException where
  showsPrec _ (IndexOutOfBounds s) = showString "array index out of range" . (if null s then id else showString ": " . showString s)
  showsPrec _ (UndefinedElement s) = showString "undefined array element" . (if null s then id else showString ": " . showString s)

instance Exception ArrayException

data ExitCode = ExitSuccess | ExitFailure Int

instance Eq ExitCode where
  ExitSuccess == ExitSuccess = True
  ExitFailure a == ExitFailure b = a == b
  _ == _ = False

instance Ord ExitCode where
  compare ExitSuccess ExitSuccess = EQ
  compare ExitSuccess (ExitFailure _) = LT
  compare (ExitFailure _) ExitSuccess = GT
  compare (ExitFailure a) (ExitFailure b) = compare a b

instance Show ExitCode where
  showsPrec _ ExitSuccess = showString "ExitSuccess"
  showsPrec d (ExitFailure n) = showParen (d >= 11) (showString "ExitFailure " . showsPrec 11 n)

instance Read ExitCode where
  readsPrec d s = [(ExitSuccess, rest) | ("ExitSuccess", rest) <- lex s] ++ readParen (d > 10) (\r -> [(ExitFailure n, t) | ("ExitFailure", u) <- lex r, (n, t) <- readsPrec 11 u]) s

instance Exception ExitCode

-- The exception a built-in failure raises, which a catch sees: its kind and its message, and for an IO error, its
-- type, its location, and its file name.
primException :: String -> String -> String -> String -> String -> SomeException
primException kind message ioType location file = case kind of
  "arith" -> toException (arithException message)
  "pattern" -> toException (PatternMatchFail message)
  "io" -> toException (IOError Nothing (ioErrorType ioType) location message Nothing (if null file then Nothing else Just file))
  "exit" -> toException (if message == "0" then ExitSuccess else ExitFailure (read message))
  _ -> toException (ErrorCall message)

arithException :: String -> ArithException
arithException message = case message of
  "arithmetic overflow" -> Overflow
  "arithmetic underflow" -> Underflow
  "loss of precision" -> LossOfPrecision
  "denormal" -> Denormal
  "Ratio has zero denominator" -> RatioZeroDenominator
  _ -> DivideByZero

-- Whether an exception ends the program without a message: an exit code.
primExitCode :: SomeException -> Int
primExitCode e = case fromException e of
  Just ExitSuccess -> 0
  Just (ExitFailure n) -> n
  Nothing -> -1

primDisplayException :: SomeException -> String
primDisplayException = displayException

throwSome :: SomeException -> a
throwSome = primitive "throwSome"

throw :: Exception e => e -> a
throw e = throwSome (toException e)

throwIO :: Exception e => e -> IO a
throwIO e = return () >>= \_ -> throwSome (toException e)

catchSome :: IO a -> (SomeException -> IO a) -> IO a
catchSome = primitive "catchSome"

catch :: Exception e => IO a -> (e -> IO a) -> IO a
catch action handler = catchSome action (\e -> case fromException e of
  Just caught -> handler caught
  Nothing -> throwIO e)

handle :: Exception e => (e -> IO a) -> IO a -> IO a
handle = flip catch

catchJust :: Exception e => (e -> Maybe b) -> IO a -> (b -> IO a) -> IO a
catchJust p action handler = catch action (\e -> case p e of
  Nothing -> throwIO e
  Just b -> handler b)

handleJust :: Exception e => (e -> Maybe b) -> (b -> IO a) -> IO a -> IO a
handleJust p handler action = catchJust p action handler

try :: Exception e => IO a -> IO (Either e a)
try action = catch (fmap Right action) (return . Left)

tryJust :: Exception e => (e -> Maybe b) -> IO a -> IO (Either b a)
tryJust p action = do
  r <- try action
  case r of
    Right v -> return (Right v)
    Left e -> case p e of
      Nothing -> throwIO e
      Just b -> return (Left b)

evaluate :: a -> IO a
evaluate x = return () >>= \_ -> x ${'`'}seq${'`'} return x

onException :: IO a -> IO b -> IO a
onException action what = catchSome action (\e -> what >> throwIO e)

finally :: IO a -> IO b -> IO a
finally action final = do
  r <- action ${'`'}onException${'`'} final
  _ <- final
  return r

bracket :: IO a -> (a -> IO b) -> (a -> IO c) -> IO c
bracket before after thing = do
  a <- before
  r <- thing a ${'`'}onException${'`'} after a
  _ <- after a
  return r

bracket_ :: IO a -> IO b -> IO c -> IO c
bracket_ before after thing = bracket before (const after) (const thing)

bracketOnError :: IO a -> (a -> IO b) -> (a -> IO c) -> IO c
bracketOnError before after thing = do
  a <- before
  thing a ${'`'}onException${'`'} after a

data Handler a = forall e. Exception e => Handler (e -> IO a)

instance Functor Handler where
  fmap f (Handler h) = Handler (fmap f . h)

catches :: IO a -> [Handler a] -> IO a
catches action handlers = catchSome action (\e -> foldr (\(Handler h) rest -> case fromException e of
  Just caught -> h caught
  Nothing -> rest) (throwIO e) handlers)

mask :: ((IO a -> IO a) -> IO b) -> IO b
mask f = f id

mask_ :: IO a -> IO a
mask_ action = action

uninterruptibleMask :: ((IO a -> IO a) -> IO b) -> IO b
uninterruptibleMask f = f id

uninterruptibleMask_ :: IO a -> IO a
uninterruptibleMask_ action = action

assert :: Bool -> a -> a
assert _ x = x

-- IO errors

data IOErrorType = AlreadyExists | NoSuchThing | ResourceBusy | ResourceExhausted | EOF | IllegalOperation
  | PermissionDenied | UserError | UnsatisfiedConstraints | SystemError | ProtocolError | OtherError | InvalidArgument
  | InappropriateType | HardwareFault | UnsupportedOperation | TimeExpired | ResourceVanished | Interrupted

instance Eq IOErrorType where
  a == b = primConTag a == primConTag b

instance Show IOErrorType where
  showsPrec _ t = showString (case t of
    AlreadyExists -> "already exists"
    NoSuchThing -> "does not exist"
    ResourceBusy -> "resource busy"
    ResourceExhausted -> "resource exhausted"
    EOF -> "end of file"
    IllegalOperation -> "illegal operation"
    PermissionDenied -> "permission denied"
    UserError -> "user error"
    HardwareFault -> "hardware fault"
    InappropriateType -> "inappropriate type"
    Interrupted -> "interrupted"
    InvalidArgument -> "invalid argument"
    OtherError -> "failed"
    ProtocolError -> "protocol error"
    ResourceVanished -> "resource vanished"
    SystemError -> "system error"
    TimeExpired -> "timeout"
    UnsatisfiedConstraints -> "unsatisfied constraints"
    UnsupportedOperation -> "unsupported operation")

ioErrorType :: String -> IOErrorType
ioErrorType name = case name of
  "AlreadyExists" -> AlreadyExists
  "NoSuchThing" -> NoSuchThing
  "ResourceBusy" -> ResourceBusy
  "EOF" -> EOF
  "IllegalOperation" -> IllegalOperation
  "PermissionDenied" -> PermissionDenied
  "UserError" -> UserError
  "InappropriateType" -> InappropriateType
  "InvalidArgument" -> InvalidArgument
  _ -> OtherError

data IOException = IOError (Maybe Handle) IOErrorType String String (Maybe Int) (Maybe FilePath)

type IOError = IOException

instance Eq IOException where
  IOError h1 t1 l1 d1 e1 f1 == IOError h2 t2 l2 d2 e2 f2 = h1 == h2 && t1 == t2 && l1 == l2 && d1 == d2 && e1 == e2 && f1 == f2

instance Show IOException where
  showsPrec _ (IOError h t location description _ file) =
    (case file of
      Nothing -> case h of
        Nothing -> id
        Just handle -> showsPrec 11 handle . showString ": "
      Just name -> showString name . showString ": ")
    . (if null location then id else showString location . showString ": ")
    . showsPrec 11 t
    . (if null description then id else showString " (" . showString description . showString ")")

instance Exception IOException

ioError :: IOError -> IO a
ioError = throwIO

ioException :: IOException -> IO a
ioException = throwIO

userError :: String -> IOError
userError message = IOError Nothing UserError "" message Nothing Nothing

mkIOError :: IOErrorType -> String -> Maybe Handle -> Maybe FilePath -> IOError
mkIOError t location h file = IOError h t location "" Nothing file

catchIOError :: IO a -> (IOError -> IO a) -> IO a
catchIOError = catch

tryIOError :: IO a -> IO (Either IOError a)
tryIOError = try

modifyIOError :: (IOError -> IOError) -> IO a -> IO a
modifyIOError f action = catch action (\e -> ioError (f e))

annotateIOError :: IOError -> String -> Maybe Handle -> Maybe FilePath -> IOError
annotateIOError (IOError h t _ d e f) location h' f' = IOError (maybe h Just h') t location d e (maybe f Just f')

ioeGetErrorType :: IOError -> IOErrorType
ioeGetErrorType (IOError _ t _ _ _ _) = t

ioeGetErrorString :: IOError -> String
ioeGetErrorString (IOError _ t _ d _ _) = case t of
  UserError -> d
  _ -> show t

ioeGetLocation :: IOError -> String
ioeGetLocation (IOError _ _ l _ _ _) = l

ioeGetHandle :: IOError -> Maybe Handle
ioeGetHandle (IOError h _ _ _ _ _) = h

ioeGetFileName :: IOError -> Maybe FilePath
ioeGetFileName (IOError _ _ _ _ _ f) = f

ioeSetErrorType :: IOError -> IOErrorType -> IOError
ioeSetErrorType (IOError h _ l d e f) t = IOError h t l d e f

ioeSetErrorString :: IOError -> String -> IOError
ioeSetErrorString (IOError h t l _ e f) d = IOError h t l d e f

ioeSetLocation :: IOError -> String -> IOError
ioeSetLocation (IOError h t _ d e f) l = IOError h t l d e f

ioeSetHandle :: IOError -> Handle -> IOError
ioeSetHandle (IOError _ t l d e f) h = IOError (Just h) t l d e f

ioeSetFileName :: IOError -> FilePath -> IOError
ioeSetFileName (IOError h t l d e _) f = IOError h t l d e (Just f)

isAlreadyExistsError, isDoesNotExistError, isAlreadyInUseError, isFullError, isEOFError, isIllegalOperation, isPermissionError, isUserError, isResourceVanishedError :: IOError -> Bool
isAlreadyExistsError = (== AlreadyExists) . ioeGetErrorType
isDoesNotExistError = (== NoSuchThing) . ioeGetErrorType
isAlreadyInUseError = (== ResourceBusy) . ioeGetErrorType
isFullError = (== ResourceExhausted) . ioeGetErrorType
isEOFError = (== EOF) . ioeGetErrorType
isIllegalOperation = (== IllegalOperation) . ioeGetErrorType
isPermissionError = (== PermissionDenied) . ioeGetErrorType
isUserError = (== UserError) . ioeGetErrorType
isResourceVanishedError = (== ResourceVanished) . ioeGetErrorType

alreadyExistsErrorType, doesNotExistErrorType, alreadyInUseErrorType, fullErrorType, eofErrorType, illegalOperationErrorType, permissionErrorType, userErrorType :: IOErrorType
alreadyExistsErrorType = AlreadyExists
doesNotExistErrorType = NoSuchThing
alreadyInUseErrorType = ResourceBusy
fullErrorType = ResourceExhausted
eofErrorType = EOF
illegalOperationErrorType = IllegalOperation
permissionErrorType = PermissionDenied
userErrorType = UserError

isAlreadyExistsErrorType, isDoesNotExistErrorType, isAlreadyInUseErrorType, isFullErrorType, isEOFErrorType, isIllegalOperationErrorType, isPermissionErrorType, isUserErrorType :: IOErrorType -> Bool
isAlreadyExistsErrorType = (== AlreadyExists)
isDoesNotExistErrorType = (== NoSuchThing)
isAlreadyInUseErrorType = (== ResourceBusy)
isFullErrorType = (== ResourceExhausted)
isEOFErrorType = (== EOF)
isIllegalOperationErrorType = (== IllegalOperation)
isPermissionErrorType = (== PermissionDenied)
isUserErrorType = (== UserError)

-- Handles

data Handle = HandleStdout | HandleStderr | HandleStdin | HandleFile Int String

instance Show Handle where
  showsPrec _ HandleStdout = showString "{handle: <stdout>}"
  showsPrec _ HandleStderr = showString "{handle: <stderr>}"
  showsPrec _ HandleStdin = showString "{handle: <stdin>}"
  showsPrec _ (HandleFile _ path) = showString "{handle: " . showString path . showString "}"

instance Eq Handle where
  HandleFile a _ == HandleFile b _ = a == b
  a == b = primConTag a == primConTag b

stdout :: Handle
stdout = HandleStdout

stderr :: Handle
stderr = HandleStderr

stdin :: Handle
stdin = HandleStdin

data IOMode = ReadMode | WriteMode | AppendMode | ReadWriteMode

instance Eq IOMode where
  a == b = primConTag a == primConTag b

instance Ord IOMode where
  compare a b = compare (primConTag a) (primConTag b)

instance Show IOMode where
  showsPrec _ ReadMode = showString "ReadMode"
  showsPrec _ WriteMode = showString "WriteMode"
  showsPrec _ AppendMode = showString "AppendMode"
  showsPrec _ ReadWriteMode = showString "ReadWriteMode"

instance Enum IOMode where
  fromEnum = primConTag
  toEnum n = primConAt ReadMode n

data BufferMode = NoBuffering | LineBuffering | BlockBuffering (Maybe Int)

instance Eq BufferMode where
  NoBuffering == NoBuffering = True
  LineBuffering == LineBuffering = True
  BlockBuffering a == BlockBuffering b = a == b
  _ == _ = False

instance Show BufferMode where
  showsPrec _ NoBuffering = showString "NoBuffering"
  showsPrec _ LineBuffering = showString "LineBuffering"
  showsPrec d (BlockBuffering m) = showParen (d >= 11) (showString "BlockBuffering " . showsPrec 11 m)

openFile :: FilePath -> IOMode -> IO Handle
openFile path mode = primitive "openFile" path (primConTag mode)

withFile :: FilePath -> IOMode -> (Handle -> IO r) -> IO r
withFile path mode = bracket (openFile path mode) hClose

hClose :: Handle -> IO ()
hClose = primitive "hClose"

hPutStr :: Handle -> String -> IO ()
hPutStr = primitive "hPutStr"

hPutStrLn :: Handle -> String -> IO ()
hPutStrLn h s = hPutStr h (s ++ "\n")

hPutChar :: Handle -> Char -> IO ()
hPutChar h c = hPutStr h [c]

hPrint :: Show a => Handle -> a -> IO ()
hPrint h x = hPutStrLn h (show x)

hFlush :: Handle -> IO ()
hFlush = primitive "hFlush"

hSetBuffering :: Handle -> BufferMode -> IO ()
hSetBuffering = primitive "hSetBuffering"

hGetBuffering :: Handle -> IO BufferMode
hGetBuffering h = return () >>= \_ -> h ${'`'}seq${'`'} return (case h of
  HandleStdout -> LineBuffering
  HandleStdin -> LineBuffering
  HandleStderr -> NoBuffering
  _ -> BlockBuffering Nothing)

hSetEcho :: Handle -> Bool -> IO ()
hSetEcho h _ = h ${'`'}seq${'`'} return ()

hGetEcho :: Handle -> IO Bool
hGetEcho h = h ${'`'}seq${'`'} return True

hGetLine :: Handle -> IO String
hGetLine = primitive "hGetLine"

hGetContents :: Handle -> IO String
hGetContents = primitive "hGetContents"

hGetContents' :: Handle -> IO String
hGetContents' h = hGetContents h >>= \s -> length s ${'`'}seq${'`'} return s

hGetChar :: Handle -> IO Char
hGetChar = primitive "hGetChar"

hIsEOF :: Handle -> IO Bool
hIsEOF = primitive "hIsEOF"

hIsOpen :: Handle -> IO Bool
hIsOpen = primitive "hIsOpen"

hIsClosed :: Handle -> IO Bool
hIsClosed h = fmap not (hIsOpen h)

hReady :: Handle -> IO Bool
hReady h = fmap not (hIsEOF h)

hWaitForInput :: Handle -> Int -> IO Bool
hWaitForInput h _ = hReady h

getLine :: IO String
getLine = hGetLine stdin

getContents :: IO String
getContents = hGetContents stdin

getContents' :: IO String
getContents' = hGetContents' stdin

getChar :: IO Char
getChar = hGetChar stdin

isEOF :: IO Bool
isEOF = hIsEOF stdin

interact :: (String -> String) -> IO ()
interact f = getContents >>= \s -> putStr (f s)

readFile :: FilePath -> IO String
readFile path = openFile path ReadMode >>= hGetContents

readFile' :: FilePath -> IO String
readFile' path = withFile path ReadMode hGetContents'

writeFile :: FilePath -> String -> IO ()
writeFile path text = withFile path WriteMode (\h -> hPutStr h text)

appendFile :: FilePath -> String -> IO ()
appendFile path text = withFile path AppendMode (\h -> hPutStr h text)

readLn :: Read a => IO a
readLn = getLine >>= readIO

readIO :: Read a => String -> IO a
readIO s = return () >>= \_ -> case [x | (x, t) <- reads s, ("", "") <- lex t] of
  [x] -> return x
  [] -> ioError (userError "Prelude.readIO: no parse")
  _ -> ioError (userError "Prelude.readIO: ambiguous parse")

-- Exit and environment

exitWith :: ExitCode -> IO a
exitWith code = case code of
  ExitFailure 0 -> ioError (IOError Nothing InvalidArgument "exitWith" "ExitFailure 0" Nothing Nothing)
  _ -> throwIO code

exitFailure :: IO a
exitFailure = exitWith (ExitFailure 1)

exitSuccess :: IO a
exitSuccess = exitWith ExitSuccess

die :: String -> IO a
die message = hPutStrLn stderr message >> exitFailure

getArgs :: IO [String]
getArgs = return []

getProgName :: IO String
getProgName = return "Main.hs"

withArgs :: [String] -> IO a -> IO a
withArgs _ action = action

-- Mutable references

newIORef :: a -> IO (IORef a)
newIORef = primitive "newIORef"

readIORef :: IORef a -> IO a
readIORef = primitive "readIORef"

writeIORef :: IORef a -> a -> IO ()
writeIORef = primitive "writeIORef"

instance Eq (IORef a) where
  a == b = primSameRef a b

primSameRef :: IORef a -> IORef a -> Bool
primSameRef = primitive "sameRef"

modifyIORef :: IORef a -> (a -> a) -> IO ()
modifyIORef ref f = readIORef ref >>= \x -> writeIORef ref (f x)

modifyIORef' :: IORef a -> (a -> a) -> IO ()
modifyIORef' ref f = readIORef ref >>= \x -> let y = f x in y ${'`'}seq${'`'} writeIORef ref y

atomicModifyIORef :: IORef a -> (a -> (a, b)) -> IO b
atomicModifyIORef ref f = readIORef ref >>= \x -> let (y, r) = f x in writeIORef ref y >> return r

atomicModifyIORef' :: IORef a -> (a -> (a, b)) -> IO b
atomicModifyIORef' ref f = readIORef ref >>= \x -> case f x of (y, r) -> y ${'`'}seq${'`'} r ${'`'}seq${'`'} (writeIORef ref y >> return r)

atomicWriteIORef :: IORef a -> a -> IO ()
atomicWriteIORef = writeIORef

-- The ST monad, which runs as IO does behind its rank-2 type.

newtype ST s a = ST (IO a)

unST :: ST s a -> IO a
unST (ST io) = io

instance Functor (ST s) where
  fmap f (ST io) = ST (fmap f io)

instance Applicative (ST s) where
  pure x = ST (return x)
  ST f <*> ST x = ST (f <*> x)

instance Monad (ST s) where
  ST m >>= k = ST (m >>= \x -> unST (k x))

runST :: (forall s. ST s a) -> a
runST st = primRunIO (unST st)

primRunIO :: IO a -> a
primRunIO = primitive "runIOPure"

stToIO :: ST RealWorld a -> IO a
stToIO = unST

data RealWorld = RealWorld

newtype STRef s a = STRef (IORef a)

instance Eq (STRef s a) where
  STRef a == STRef b = a == b

newSTRef :: a -> ST s (STRef s a)
newSTRef x = ST (fmap STRef (newIORef x))

readSTRef :: STRef s a -> ST s a
readSTRef (STRef ref) = ST (readIORef ref)

writeSTRef :: STRef s a -> a -> ST s ()
writeSTRef (STRef ref) x = ST (writeIORef ref x)

modifySTRef :: STRef s a -> (a -> a) -> ST s ()
modifySTRef (STRef ref) f = ST (modifyIORef ref f)

modifySTRef' :: STRef s a -> (a -> a) -> ST s ()
modifySTRef' (STRef ref) f = ST (modifyIORef' ref f)

-- Type-level literals and proxies

data Proxy t = Proxy

instance Eq (Proxy t) where
  _ == _ = True

instance Ord (Proxy t) where
  compare _ _ = EQ

instance Show (Proxy t) where
  showsPrec _ _ = showString "Proxy"

instance Bounded (Proxy t) where
  minBound = Proxy
  maxBound = Proxy

asProxyTypeOf :: a -> proxy a -> a
asProxyTypeOf x _ = x

class KnownNat (n :: Natural)

class KnownSymbol (s :: Symbol)

natVal :: KnownNat n => proxy n -> Integer
natVal = primitive "literalOf"

symbolVal :: KnownSymbol s => proxy s -> String
symbolVal = primitive "literalOf"

getField :: HasField x r a => r -> a
getField = primitive "applyField"

coerce :: Coercible a b => a -> b
coerce = primitive "coerceApply"

-- Recursive monadic bindings, which mdo and rec blocks use.

class Monad m => MonadFix m where
  mfix :: (a -> m a) -> m a

instance MonadFix Maybe where
  mfix f = let a = f (fromJustFix a) in a

fromJustFix :: Maybe a -> a
fromJustFix (Just x) = x
fromJustFix Nothing = errorWithoutStackTrace "mfix Maybe: Nothing"

instance MonadFix [] where
  mfix f = case fix (f . head) of
    [] -> []
    (x : _) -> x : mfix (tail . f)

instance MonadFix (Either e) where
  mfix f = let a = f (fromRightFix a) in a

fromRightFix :: Either e a -> a
fromRightFix (Right x) = x
fromRightFix (Left _) = errorWithoutStackTrace "mfix Either: Left"

instance MonadFix IO where
  mfix = fixIO

instance MonadFix (ST s) where
  mfix f = ST (fixIO (unST . f))

fixIO :: (a -> IO a) -> IO a
fixIO k = do
  ref <- newIORef (errorWithoutStackTrace "cyclic evaluation in fixIO")
  answer <- unsafeInterleaveIO (readIORef ref)
  result <- k answer
  writeIORef ref result
  return result

fixST :: (a -> ST s a) -> ST s a
fixST = mfix

unsafeInterleaveIO :: IO a -> IO a
unsafeInterleaveIO = primitive "interleaveIO"

-- Debugging output, which goes to standard error as the value is evaluated.

trace :: String -> a -> a
trace = primitive "trace"

traceShow :: Show a => a -> b -> b
traceShow x = trace (show x)

traceShowId :: Show a => a -> a
traceShowId x = trace (show x) x

traceId :: String -> String
traceId s = trace s s

traceM :: Applicative f => String -> f ()
traceM s = trace s (pure ())

traceShowM :: (Show a, Applicative f) => a -> f ()
traceShowM x = traceM (show x)

traceWith :: (a -> String) -> a -> a
traceWith f x = trace (f x) x

traceShowWith :: Show b => (a -> b) -> a -> a
traceShowWith f = traceWith (show . f)
`;
