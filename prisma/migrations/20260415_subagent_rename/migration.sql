PRAGMA foreign_keys=OFF;

ALTER TABLE "Track" RENAME TO "Subagent";
ALTER TABLE "Session" RENAME COLUMN "maxTracks" TO "maxSubagents";
ALTER TABLE "EventRecord" RENAME COLUMN "trackId" TO "subagentId";
ALTER TABLE "AgentTurn" RENAME COLUMN "trackId" TO "subagentId";

DROP INDEX IF EXISTS "AgentTurn_sessionId_trackId_idx";
CREATE INDEX "AgentTurn_sessionId_subagentId_idx" ON "AgentTurn"("sessionId", "subagentId");

PRAGMA foreign_keys=ON;
