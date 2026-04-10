-- CreateTable
CREATE TABLE "AgentTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "thinkingText" TEXT NOT NULL DEFAULT '',
    "textOutput" TEXT NOT NULL DEFAULT '',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

CREATE INDEX "AgentTurn_sessionId_trackId_idx" ON "AgentTurn"("sessionId", "trackId");

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolInput" TEXT NOT NULL DEFAULT '',
    "toolOutput" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ToolCall_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "AgentTurn" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ToolCall_toolUseId_key" ON "ToolCall"("toolUseId");
