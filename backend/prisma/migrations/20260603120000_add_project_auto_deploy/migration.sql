-- AlterTable: auto-deploy-on-push toggle (default true preserves existing behavior)
ALTER TABLE "Project" ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT true;
