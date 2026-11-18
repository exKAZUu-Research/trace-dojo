import { executeProgram } from '../../src/interpreter/program';

const count = 14_000;
const declarations = `class C0 a where f :: a -> Int
${Array.from({ length: count }, (_, index) => `class C${index} a => C${index + 1} a`).join('\n')}`;
const deep = executeProgram('haskell', `${declarations}\ng :: C${count} a => a -> Int\ng = f\nmain = print (1 :: Int)`);
const nested = executeProgram(
  'haskell',
  `class C0 a where f :: a -> Int
class C0 a => C1 a
class C1 a => C2 a
class C2 a => C3 a
instance C0 Int where f x = x + 6
instance C1 Int
instance C2 Int
instance C3 Int
class D a where d :: a -> Int
data Box a = Box a
instance C0 a => D (Box a) where d (Box x) = f x
g :: C3 a => a -> Int
g x = d (Box x)
main = print (g (1 :: Int))`
);
process.stdout.write(JSON.stringify([deep, nested]));
