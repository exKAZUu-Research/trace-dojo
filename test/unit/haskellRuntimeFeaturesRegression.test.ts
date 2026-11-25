import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
import type { ProgramInput } from '../../src/interpreter/programIo';

function run(source: string, input?: ProgramInput): unknown {
  const execution = executeProgram('haskell', source, input);
  if (execution.kind !== 'executed') return execution;
  const { stdout, stderr, finalFiles, uncaughtException } = execution;
  return { stdout, stderr, finalFiles, uncaughtException };
}

test.each([
  [
    'numbers, a line of them, and the rest of the input',
    'import Data.Char (toUpper)\nmain = do\n  n <- readLn :: IO Int\n  xs <- fmap (map read . words) getLine :: IO [Int]\n  print (n + sum xs)\n  rest <- getContents\n  putStr (map toUpper rest)',
    '2\n3 4\nab\ncd\n',
    '9\nAB\nCD\n',
  ],
  ['interact', 'main = interact (unlines . map reverse . lines)', 'abc\nde\n', 'cba\ned\n'],
  [
    'reading lines until the end of the input',
    'import System.IO\nloop acc = do\n  eof <- isEOF\n  if eof then print acc else getLine >>= \\l -> loop (acc + read l)\nmain = loop (0 :: Int)',
    '1\n2\n3\n',
    '6\n',
  ],
])('standard input is read as in GHC: %s', (_name, source, stdin, stdout) => {
  expect(run(source, { stdin })).toMatchObject({ stdout, uncaughtException: undefined });
});

test('files are read, written, and appended to, in a file system of the run', () => {
  const source =
    'main = do\n  s <- readFile "in.txt"\n  writeFile "out.txt" (reverse s)\n  appendFile "out.txt" "!"\n  readFile "out.txt" >>= putStrLn';
  expect(run(source, { files: { 'in.txt': 'abc' } })).toMatchObject({
    stdout: 'cba!\n',
    finalFiles: { 'in.txt': 'abc', 'out.txt': 'cba!' },
  });
});

test('standard error is kept apart from standard output', () => {
  expect(run('import System.IO\nmain = hPutStrLn stderr "warning" >> putStrLn "out"')).toMatchObject({
    stdout: 'out\n',
    stderr: 'warning\n',
  });
});

test('exceptions are caught by their types', () => {
  const source =
    'import Control.Exception\nmain = do\n  r <- try (evaluate (1 `div` (0 :: Int)))\n  either (\\e -> putStrLn ("caught: " ++ show (e :: ArithException))) print r\n  handle (\\(ErrorCall m) -> putStrLn ("error: " ++ m)) (error "boom")';
  expect(run(source)).toMatchObject({ stdout: 'caught: divide by zero\nerror: boom\n', uncaughtException: undefined });
});

test('exitWith ends the program without a message', () => {
  const source = 'import System.Exit\nmain = putStrLn "before" >> exitWith (ExitFailure 3) >> putStrLn "after"';
  expect(run(source)).toMatchObject({ stdout: 'before\n', stderr: '', uncaughtException: undefined });
});

test('a Template Haskell splice runs while the program compiles', () => {
  const source =
    '{-# LANGUAGE TemplateHaskell #-}\nimport Language.Haskell.TH\nmain = print ($(litE (integerL 6)) * 7 :: Int)';
  expect(run(source)).toMatchObject({ stdout: '42\n' });
});

test.each([
  ['the network', 'import Network.Socket\nmain = print 1'],
  ['threads', 'import Control.Concurrent\nmain = forkIO (print 1) >> print 2'],
  [
    'foreign functions',
    '{-# LANGUAGE ForeignFunctionInterface #-}\nforeign import ccall "sin" c_sin :: Double -> Double\nmain = print 1',
  ],
  [
    'what reify asks of the compiler',
    '{-# LANGUAGE TemplateHaskell #-}\nimport Language.Haskell.TH\nmain = runQ (reify (mkName "x")) >> print 1',
  ],
])('%s stays unavailable', (_name, source) => {
  const execution = executeProgram('haskell', source);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError') {
    expect(execution.diagnostics[0]?.message).toContain('は、この採点環境では使えません。');
  }
});

test.each([
  [
    'a lazy read the program never forces',
    'main = do\n  s <- readFile "a.txt"\n  writeFile "a.txt" "changed"\n  putStrLn "done"',
  ],
  [
    'Debug.Trace output of a value the program never uses',
    'import Debug.Trace\nmain = do\n  let x = trace "unused" (42 :: Int)\n  putStrLn "done"',
  ],
])('a trace performs the same effects as the run: %s', (_name, source) => {
  const input = { files: { 'a.txt': 'original' } };
  const { stdout, stderr, finalFiles, uncaughtException } = traceProgram('haskell', source, source, input);
  expect({ stdout, stderr, finalFiles, uncaughtException }).toEqual(run(source, input));
});
