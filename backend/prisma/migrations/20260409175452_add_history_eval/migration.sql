-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('LIVE', 'HISTORY');

-- CreateEnum
CREATE TYPE "RunSource" AS ENUM ('LIVE', 'HISTORY');

-- AlterEnum
ALTER TYPE "CriterionType" ADD VALUE 'ACTION_CONSISTENCY';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "historyEndDate" TIMESTAMP(3),
ADD COLUMN     "historyStartDate" TIMESTAMP(3),
ADD COLUMN     "projectType" "ProjectType" NOT NULL DEFAULT 'LIVE';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "callDate" TIMESTAMP(3),
ADD COLUMN     "callDuration" INTEGER,
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "source" "RunSource" NOT NULL DEFAULT 'LIVE',
ALTER COLUMN "modelUsed" DROP NOT NULL;
