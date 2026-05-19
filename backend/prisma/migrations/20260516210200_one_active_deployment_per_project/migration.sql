-- Enforce at most one active deployment per project.
CREATE UNIQUE INDEX "one_active_per_project"
  ON "Deployment" ("projectId")
  WHERE active = true;
