# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""7-table DDL — exact copy of insight's export-service.ts DDL.

The cannbot-insight adapter reads this exact schema. Any deviation breaks import.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3

DDL = """
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "label" TEXT,
    "query" TEXT,
    "framework" TEXT NOT NULL DEFAULT 'unknown',
    "model" TEXT,
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" DATETIME,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalReasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "totalLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "totalToolCallCount" INTEGER NOT NULL DEFAULT 0,
    "totalLlmCallCount" INTEGER NOT NULL DEFAULT 0,
    "totalSkillLoadCount" INTEGER NOT NULL DEFAULT 0,
    "totalSubagentCount" INTEGER NOT NULL DEFAULT 0,
    "rootExecutionId" TEXT,
    "sourcePath" TEXT,
    "parentId" TEXT,
    "version" TEXT,
    "directory" TEXT,
    "summaryAdditions" INTEGER NOT NULL DEFAULT 0,
    "summaryDeletions" INTEGER NOT NULL DEFAULT 0,
    "summaryFiles" INTEGER NOT NULL DEFAULT 0,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Turn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "contentJson" TEXT,
    "contentSummary" TEXT,
    "inputMessagesJson" TEXT,
    "inputMessagesCount" INTEGER NOT NULL DEFAULT 0,
    "inputMessagesTokens" INTEGER NOT NULL DEFAULT 0,
    "contextWindowPct" REAL,
    "agentName" TEXT,
    "subagentName" TEXT,
    "subagentSessionId" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt_ts" DATETIME,
    "completedAt" DATETIME,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ttftMs" INTEGER,
    "model" TEXT,
    "modelId" TEXT,
    "providerId" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "finishReason" TEXT,
    "isSubagent" BOOLEAN NOT NULL DEFAULT false,
    "parentExecutionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsJson" TEXT,
    "resultJson" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ok',
    "errorType" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "dispatchBridgeId" TEXT,
    "isSkillRelated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolCall_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillVersion" INTEGER,
    "eventType" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "argsJson" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT,
    "agentSessionId" TEXT,
    "isSubagent" BOOLEAN NOT NULL DEFAULT false,
    "subagentType" TEXT,
    "subagentName" TEXT,
    "parentExecutionId" TEXT,
    "rootExecutionId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "maxSingleCallTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallErrorCount" INTEGER NOT NULL DEFAULT 0,
    "llmCallCount" INTEGER NOT NULL DEFAULT 0,
    "skillLoadCount" INTEGER NOT NULL DEFAULT 0,
    "skillInvokeCount" INTEGER NOT NULL DEFAULT 0,
    "finalResult" TEXT,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Execution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExecutionSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillVersion" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionSkill_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillVersion" INTEGER,
    "invocationCount" INTEGER NOT NULL DEFAULT 0,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSkill_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "InteractionBridge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "dispatchExecutionId" TEXT NOT NULL,
    "dispatchTurnId" TEXT,
    "dispatchToolCallId" TEXT,
    "dispatchContent" TEXT,
    "dispatchTimestamp" DATETIME,
    "responseExecutionId" TEXT,
    "responseTurnId" TEXT,
    "responseContent" TEXT,
    "responseTimestamp" DATETIME,
    "subagentSessionId" TEXT,
    "subagentType" TEXT,
    "subagentName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'dispatched',
    "subagentTokens" INTEGER NOT NULL DEFAULT 0,
    "subagentLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InteractionBridge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Session_taskId_framework_key" ON "Session"("taskId", "framework");
CREATE INDEX "Turn_sessionId_turnIndex_idx" ON "Turn"("sessionId", "turnIndex");
CREATE INDEX "Turn_sessionId_isSubagent_idx" ON "Turn"("sessionId", "isSubagent");
CREATE INDEX "Turn_subagentSessionId_idx" ON "Turn"("subagentSessionId");
CREATE INDEX "Turn_agentName_idx" ON "Turn"("agentName");
CREATE INDEX "ToolCall_turnId_idx" ON "ToolCall"("turnId");
CREATE INDEX "ToolCall_toolName_idx" ON "ToolCall"("toolName");
CREATE INDEX "ToolCall_toolName_state_idx" ON "ToolCall"("toolName", "state");
CREATE INDEX "SkillEvent_turnId_idx" ON "SkillEvent"("turnId");
CREATE INDEX "SkillEvent_skillName_idx" ON "SkillEvent"("skillName");
CREATE INDEX "SkillEvent_skillName_eventType_idx" ON "SkillEvent"("skillName", "eventType");
CREATE INDEX "Execution_sessionId_idx" ON "Execution"("sessionId");
CREATE INDEX "Execution_parentExecutionId_idx" ON "Execution"("parentExecutionId");
CREATE INDEX "Execution_rootExecutionId_idx" ON "Execution"("rootExecutionId");
CREATE INDEX "Execution_isSubagent_idx" ON "Execution"("isSubagent");
CREATE INDEX "Execution_agentSessionId_idx" ON "Execution"("agentSessionId");
CREATE INDEX "ExecutionSkill_skillName_skillVersion_idx" ON "ExecutionSkill"("skillName", "skillVersion");
CREATE INDEX "ExecutionSkill_executionId_idx" ON "ExecutionSkill"("executionId");
CREATE INDEX "SessionSkill_skillName_idx" ON "SessionSkill"("skillName");
CREATE UNIQUE INDEX "SessionSkill_sessionId_skillName_key" ON "SessionSkill"("sessionId", "skillName");
CREATE INDEX "InteractionBridge_sessionId_idx" ON "InteractionBridge"("sessionId");
CREATE INDEX "InteractionBridge_dispatchExecutionId_idx" ON "InteractionBridge"("dispatchExecutionId");
CREATE INDEX "InteractionBridge_responseExecutionId_idx" ON "InteractionBridge"("responseExecutionId");
CREATE INDEX "InteractionBridge_subagentSessionId_idx" ON "InteractionBridge"("subagentSessionId");
CREATE INDEX "InteractionBridge_status_idx" ON "InteractionBridge"("status");
"""


def create_tables(conn: sqlite3.Connection) -> None:
    """Execute the 7-table DDL on a fresh sqlite connection."""
    conn.executescript(DDL)
