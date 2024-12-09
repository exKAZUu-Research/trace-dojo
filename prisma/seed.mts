import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // do nothing
}

try {
  await main();
} catch (error) {
  console.error(error);
} finally {
  await prisma.$disconnect();
  process.exit(1);
}
