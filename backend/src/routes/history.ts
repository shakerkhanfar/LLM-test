import prisma from "../lib/prisma";
import fs from "fs";
const LOG_FILE = require("path").join(__dirname, "../../import.log");
function flog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, line);
}
/**
 * History evaluation routes.
 * Imports past calls from Hamsa and evaluates them against the project's criteria.
 *
 * Flow:
 * 1. Download Excel export from Hamsa (contains list of conversation IDs + metadata)
 * 2. Parse Excel to extract conversationIds (and any available transcript/status data)
 * 3. Create Run stubs immediately in the DB → return to caller
 * 4. Background: for each run, fetch conversation details (logs + transcript), then evaluate
 *    - conv.logs from fetchConversation is stored directly as callLog
 *    - fetchCallLog(jobId) is also attempted for supplemental log data
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth";
import * as XLSX from "xlsx";
import {
  exportConversations,
  fetchConversation,
  fetchCallLog,
  extractTranscriptFromConversation,
  extractJobIdFromConversation,
  requestConversationExport,
  pollExportStatus,
  downloadAndParseExportCsv,
} from "../services/hamsaApi";
import { runEvaluationCheck } from "../services/evaluationRunner";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/history/:projectId/import-ids
 *
 * Import calls by conversation IDs. Accepts a list of IDs,
 * creates run stubs, then fetches conversation details and evaluates
 * one at a time with delays to avoid rate limits.
 *
 * Body: { conversationIds: string[], delay?: number }
 */
router.post("/:projectId/import-ids", async (req: AuthRequest, res) => {
  const { projectId } = req.params;
  const { conversationIds, delay = 3000 } = req.body;

  if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
    return res.status(400).json({ error: "conversationIds must be a non-empty array" });
  }

  // Validate and deduplicate
  const validIds = [...new Set(
    conversationIds
      .map((id: unknown) => typeof id === "string" ? id.trim() : "")
      .filter((id: string) => UUID_RE.test(id))
  )];

  if (validIds.length === 0) {
    return res.status(400).json({ error: "No valid conversation IDs found. Expected UUID format." });
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== (req as any).userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const apiKey = project.hamsaApiKey || process.env.HAMSA_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: "No Hamsa API key configured for this project" });
  }

  // Deduplicate against existing runs
  const existingRuns = await prisma.run.findMany({
    where: { projectId, conversationId: { in: validIds } },
    select: { conversationId: true },
  });
  const existingIds = new Set(existingRuns.map((r) => r.conversationId));
  const newIds = validIds.filter((id: string) => !existingIds.has(id));

  // Respond immediately
  res.json({
    ok: true,
    total: validIds.length,
    new: newIds.length,
    skipped: validIds.length - newIds.length,
    message: newIds.length > 0
      ? `Importing ${newIds.length} calls in the background (${validIds.length - newIds.length} already imported).`
      : "All conversation IDs are already imported.",
  });

  if (newIds.length === 0) return;

  // Background: create stubs, fetch details, evaluate — one at a time
  (async () => {
    const throttleMs = Math.max(1000, Math.min(10000, Number(delay) || 3000));
    let completed = 0;
    let failed = 0;

    for (const convId of newIds) {
      try {
        flog(`[ImportIDs] ${completed + failed + 1}/${newIds.length} Processing ${convId}`);

        // Create run stub
        const run = await prisma.run.create({
          data: {
            projectId,
            source: "HISTORY",
            conversationId: convId,
            modelUsed: null,
            status: "PENDING",
            startedAt: new Date(),
          },
        }).catch((err: any) => {
          if (err?.code === "P2002") return null; // duplicate — skip
          throw err;
        });

        if (!run) { flog(`[ImportIDs] Skipping duplicate ${convId}`); continue; }

        // Fetch conversation details
        const conv = await fetchConversation(convId, apiKey);
        const transcript = extractTranscriptFromConversation(conv);
        const callLog = Array.isArray(conv?.logs) && conv.logs.length > 0 ? conv.logs : null;
        const callStatus = conv?.status || null;
        const callDuration = typeof conv?.callDuration === "number" ? conv.callDuration : null;
        const callDate = conv?.createdAt ? new Date(conv.createdAt) : null;
        const outcomeResult = conv?.jobResponse?.outcomeResult ?? null;
        const callOutcome: string | null = outcomeResult?.call_outcome ?? null;
        const jobId = extractJobIdFromConversation(conv);
        const modelUsed = conv?.agentDetails?.llm?.model || conv?.voiceAgent?.llm?.model || conv?.model || null;

        await prisma.run.update({
          where: { id: run.id },
          data: {
            transcript: transcript as any,
            callLog: callLog as any,
            callStatus,
            callDuration,
            callDate,
            callOutcome,
            outcomeResult: outcomeResult as any,
            hamsaCallId: jobId,
            modelUsed,
            webhookData: conv as any,
            status: "AWAITING_DATA",
          },
        });

        // Try supplemental logs
        if (jobId) {
          try {
            const logs = await fetchCallLog(jobId, apiKey);
            if (Array.isArray(logs) && logs.length > (callLog?.length ?? 0)) {
              await prisma.run.update({ where: { id: run.id }, data: { callLog: logs as any } });
            }
          } catch {}
        }

        // Trigger evaluation
        await runEvaluationCheck(run.id);
        completed++;

        await new Promise((r) => setTimeout(r, throttleMs));
      } catch (err) {
        const errMsg = (err as Error).message;
        flog(`[ImportIDs] Failed ${convId}: ${errMsg}`);
        // Mark the stub as FAILED so it doesn't stay PENDING forever
        try {
          await prisma.run.updateMany({
            where: { projectId, conversationId: convId, status: "PENDING" },
            data: { status: "FAILED", errorLog: `Import failed: ${errMsg.slice(0, 500)}` },
          });
        } catch {}
        failed++;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    flog(`[ImportIDs] Done: ${completed} succeeded, ${failed} failed out of ${newIds.length}`);
  })();
});

// CUSTOM period requires both dates
const VALID_PERIODS = new Set([
  "LAST_HOUR", "TODAY", "YESTERDAY", "THIS_WEEK", "THIS_MONTH", "CUSTOM",
]);

/**
 * POST /api/history/:projectId/import
 *
 * Body: { period?, startDate?, endDate?, status?, limit? }
 *
 * Returns immediately after creating run stubs.
 * Background workers then fetch conversation details and trigger evaluation.
 */
router.post("/:projectId/import", async (req: AuthRequest, res) => {
  const { projectId } = req.params;
  // timezoneOffsetMinutes: client's UTC offset in minutes (e.g. 180 for UTC+3).
  // Used to compute start/end epoch timestamps that match the user's local midnight,
  // not the server's UTC midnight. Defaults to 0 (UTC) if not provided.
  const { period = "THIS_MONTH", startDate, endDate, status, limit = 50, timezoneOffsetMinutes = 0 } = req.body;

  // ── Input validation ────────────────────────────────────────────
  if (!VALID_PERIODS.has(period)) {
    return res.status(400).json({ error: `Invalid period. Must be one of: ${[...VALID_PERIODS].join(", ")}` });
  }
  if (period === "CUSTOM" && (!startDate || !endDate)) {
    return res.status(400).json({ error: "Both startDate and endDate are required for CUSTOM period" });
  }
  const importLimit = Math.min(Math.max(1, parseInt(limit) || 50), 500);

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  const apiKey = project.hamsaApiKey || undefined;
  if (!apiKey && !process.env.HAMSA_API_KEY) {
    return res.status(400).json({ error: "No Hamsa API key configured for this project" });
  }

  flog(`[History] Starting import for project ${projectId}, agent ${project.agentId}`);

  // Build shared time range options.
  // timeDifference: Hamsa expects the user's UTC offset in hours as a string (e.g. "3" for UTC+3).
  // We send plain UTC midnight/end-of-day epochs and let Hamsa apply the offset itself,
  // matching exactly what Hamsa's own dashboard does.
  const tzOffsetHours = (Number(timezoneOffsetMinutes) || 0) / 60;
  const timeDifference = String(tzOffsetHours);
  const timeOptions = {
    period: period === "CUSTOM" ? "CUSTOM" : period,
    timeDifference,
    ...(status ? { status } : {}),
    ...(period === "CUSTOM" && startDate && endDate ? {
      // Plain UTC midnight / end-of-day. Hamsa applies timeDifference server-side.
      startPeriod: new Date(startDate + "T00:00:00.000Z").getTime(),
      endPeriod:   new Date(endDate   + "T23:59:59.999Z").getTime(),
    } : {}),
  };

  // ── Step 1: Download Excel export (with auto-chunking on 500/504) ──
  //
  // Hamsa's export endpoint can crash with 500 Internal Server Error for busy
  // agents over long date ranges. Workaround: if a single export fails, split
  // the window and retry each half. Recursively halve down to ~1 hour chunks.
  let conversationIds: string[] = [];
  try {
    conversationIds = await exportWithChunking(
      project.agentId,
      timeOptions,
      apiKey,
      /* recursion depth */ 0,
    );
    flog(`[History] Excel: parsed ${conversationIds.length} total conversation IDs (after chunking if needed)`);
  } catch (err) {
    return res.status(502).json({ error: `Failed to fetch conversations from Hamsa: ${(err as Error).message}` });
  }

  if (conversationIds.length === 0) {
    return res.json({
      started: false,
      imported: 0,
      runIds: [],
      message: "No conversations found in the specified period",
    });
  }

  // Hamsa's export is newest-first. Reverse → oldest calls first.
  // We do NOT pre-slice: the background worker will continue past the initial
  // buffer if early calls turn out to be failed/no-answer, fetching more until
  // it collects `importLimit` completed calls (or exhausts the date range).
  const oldestFirst = [...conversationIds].reverse();

  // ── Step 3: Find already-imported conversations ─────────────────
  const existingRuns = await prisma.run.findMany({
    where: { projectId, conversationId: { in: oldestFirst } },
    select: { conversationId: true, id: true },
  });
  const existingByConvId = new Map(existingRuns.map((r) => [r.conversationId!, r.id]));

  // IDs that haven't been imported yet, in oldest-first order
  const newConvIds = oldestFirst.filter((id) => !existingByConvId.has(id));

  // Create stubs for the first `importLimit` new IDs immediately so the UI
  // shows something right away. The background worker will create more stubs
  // lazily if too many of these turn out to be failed/no-answer calls.
  const initialBatch = newConvIds.slice(0, importLimit);
  const lazyBatch = newConvIds.slice(importLimit); // processed on-demand if needed

  const now = new Date();
  const stubsCreated: { id: string; conversationId: string }[] = [];
  for (const convId of initialBatch) {
    const run = await prisma.run.create({
      data: {
        projectId,
        source: "HISTORY",
        conversationId: convId,
        modelUsed: null,
        status: "PENDING",
        startedAt: now,
      },
    });
    stubsCreated.push({ id: run.id, conversationId: convId });
  }

  // ── Step 4: Return immediately, hydrate in background ──────────
  res.json({
    started: true,
    imported: stubsCreated.length,
    alreadyImported: existingRuns.length,
    total: conversationIds.length,
    processed: initialBatch.length,
    runIds: stubsCreated.map((s) => s.id),
    message: `Importing up to ${importLimit} completed calls in the background.`,
  });

  // Fire-and-forget: process initial stubs + lazy IDs, stop at importLimit valid calls
  hydrateRunsInBackground(stubsCreated, lazyBatch, apiKey, projectId, importLimit);
});

/**
 * POST /api/history/:projectId/import-csv
 *
 * New async CSV export flow (works with Hamsa dev API):
 *   1. Request export → get exportId
 *   2. Poll until ready → get download URL
 *   3. Download CSV → parse conversation IDs
 *   4. For each conversation, fetch details via get-conversation API
 *   5. Create runs and evaluate
 *
 * Body: {
 *   hamsaProjectId: string,    // Hamsa project ID (not our project ID)
 *   startDate?: string,        // "2025-01-01" format
 *   endDate?: string,          // "2026-04-21" format
 *   limit?: number,            // max calls to import (default 50)
 *   apiBaseUrl?: string,       // override API base URL (e.g. "https://api-dev.tryhamsa.com")
 * }
 */
router.post("/:projectId/import-csv", async (req: AuthRequest, res) => {
  const { projectId } = req.params;
  const {
    hamsaProjectId,
    startDate,
    endDate,
    limit = 50,
    apiBaseUrl,
  } = req.body;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  const apiKey = project.hamsaApiKey || process.env.HAMSA_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: "No Hamsa API key configured for this project" });
  }

  if (!hamsaProjectId) {
    return res.status(400).json({ error: "hamsaProjectId is required" });
  }

  const importLimit = Math.min(Math.max(1, parseInt(limit) || 50), 500);

  // Default date range: last 30 days → now
  const startPeriod = startDate
    ? new Date(startDate + "T00:00:00.000Z").getTime()
    : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const endPeriod = endDate
    ? new Date(endDate + "T23:59:59.999Z").getTime()
    : Date.now();

  const baseUrl = apiBaseUrl || process.env.HAMSA_API_BASE || undefined;

  flog(`[CSV Import] Starting for project ${projectId}, agent ${project.agentId}, hamsa project ${hamsaProjectId}`);

  // ── Step 1: Request async export ──────────────────────────────────
  let exportId: string;
  try {
    exportId = await requestConversationExport(
      hamsaProjectId,
      project.agentId,
      { startPeriod, endPeriod },
      apiKey,
      baseUrl,
    );
    flog(`[CSV Import] Export requested, exportId: ${exportId}`);
  } catch (err) {
    return res.status(502).json({ error: `Failed to request export: ${(err as Error).message}` });
  }

  // Return the exportId immediately so the frontend can track progress.
  // The actual polling + import happens in the background.
  res.json({
    started: true,
    exportId,
    message: "Export requested. Polling for CSV in the background.",
  });

  // ── Background: poll, download, parse, hydrate ────────────────────
  (async () => {
    try {
      // Step 2: Poll until ready
      flog(`[CSV Import] Polling export status...`);
      const downloadUrl = await pollExportStatus(hamsaProjectId, exportId, apiKey, baseUrl);
      flog(`[CSV Import] Export ready, downloading CSV...`);

      // Step 3: Download and parse CSV
      const conversationIds = await downloadAndParseExportCsv(downloadUrl);
      flog(`[CSV Import] Parsed ${conversationIds.length} conversation IDs from CSV`);

      if (conversationIds.length === 0) {
        flog(`[CSV Import] No conversations found, done.`);
        return;
      }

      // Deduplicate against existing runs
      const existingRuns = await prisma.run.findMany({
        where: { projectId, conversationId: { in: conversationIds } },
        select: { conversationId: true },
      });
      const existingIds = new Set(existingRuns.map((r) => r.conversationId));
      const newConvIds = conversationIds.filter((id) => !existingIds.has(id));
      flog(`[CSV Import] ${newConvIds.length} new conversations (${existingIds.size} already imported)`);

      const toImport = newConvIds.slice(0, importLimit);

      // Step 4: Create stubs and hydrate
      const now = new Date();
      const stubs: { id: string; conversationId: string }[] = [];
      for (const convId of toImport) {
        try {
          const run = await prisma.run.create({
            data: {
              projectId,
              source: "HISTORY",
              conversationId: convId,
              modelUsed: null,
              status: "PENDING",
              startedAt: now,
            },
          });
          stubs.push({ id: run.id, conversationId: convId });
        } catch (createErr: any) {
          // P2002 = unique constraint violation (duplicate) — expected, skip silently
          if (createErr?.code === "P2002") {
            flog(`[CSV Import] Skipping duplicate conversation ${convId}`);
          } else {
            flog(`[CSV Import] Failed to create stub for ${convId}: ${createErr.message}`);
          }
        }
      }

      flog(`[CSV Import] Created ${stubs.length} run stubs, starting hydration...`);

      // Hydrate in batches of 3 (reuse existing hydrateRun function)
      const BATCH_SIZE = 3;
      let completed = 0;
      for (let i = 0; i < stubs.length; i += BATCH_SIZE) {
        const batch = stubs.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((s) => hydrateRun(s.id, s.conversationId, apiKey, projectId, baseUrl))
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value === "COMPLETED") completed++;
        }
      }

      flog(`[CSV Import] Done: ${completed}/${stubs.length} calls hydrated and evaluated`);
    } catch (err) {
      flog(`[CSV Import] Background import failed: ${(err as Error).message}`);
    }
  })();
});

/**
 * GET /api/history/:projectId/export-status
 *
 * Check the status of an async export. Frontend can poll this.
 * Query: { hamsaProjectId, exportId, apiBaseUrl? }
 */
router.get("/:projectId/export-status", async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  const { hamsaProjectId, exportId, apiBaseUrl } = req.query as Record<string, string>;
  if (!hamsaProjectId || !exportId) {
    return res.status(400).json({ error: "hamsaProjectId and exportId are required" });
  }

  const apiKey = project.hamsaApiKey || process.env.HAMSA_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "No API key" });

  const base = apiBaseUrl || process.env.HAMSA_API_BASE || "https://api.tryhamsa.com";
  const params = new URLSearchParams({ projectId: hamsaProjectId, exportId });
  const url = `${base}/v1/agent-analytics/conversations/export/status?${params}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/history/:projectId/debug-conv/:convId
 * Fetches a raw conversation from Hamsa and returns the full object.
 * Shows exactly where the transcript and logs live.
 */
router.get("/:projectId/debug-conv/:convId", async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  try {
    const conv = await fetchConversation(req.params.convId, project.hamsaApiKey || undefined);
    const topKeys = Object.keys(conv ?? {});
    const callAnalysisKeys = conv?.callAnalysis ? Object.keys(conv.callAnalysis) : [];
    const logsCount = Array.isArray(conv?.logs) ? conv.logs.length : 0;
    const logsSample = Array.isArray(conv?.logs) ? conv.logs.slice(0, 3) : [];

    // Unique category+message combinations from logs
    const logSchema: Record<string, string[]> = {};
    if (Array.isArray(conv?.logs)) {
      for (const e of conv.logs) {
        const cat = e?.category ?? "?";
        const msg = e?.message ?? "?";
        if (!logSchema[cat]) logSchema[cat] = [];
        if (!logSchema[cat].includes(msg)) logSchema[cat].push(msg);
      }
    }

    return res.json({
      topKeys,
      callAnalysisKeys,
      callAnalysis: conv?.callAnalysis,
      jobResponse: conv?.jobResponse,
      status: conv?.status,
      callDuration: conv?.callDuration,
      mediaUrl: conv?.mediaUrl ? "[present]" : null,
      logsCount,
      logsSample,
      logSchema,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/history/:projectId/debug-excel
 * Downloads the Excel export and returns its columns + first 3 rows as JSON.
 * Dev/debug use only — lets us see exactly what Hamsa puts in the Excel.
 */
router.get("/:projectId/debug-excel", async (req: AuthRequest, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  try {
    const buf = await exportConversations(
      project.agentId,
      { period: "THIS_MONTH" },
      project.hamsaApiKey || undefined
    );
    const workbook = XLSX.read(buf, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName!];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return res.json({
      sheetName,
      totalRows: rows.length,
      columns,
      sampleRows: rows.slice(0, 3),
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/history/:projectId/status
 * Returns counts of runs in each status for the project.
 */
router.get("/:projectId/status", async (req: AuthRequest, res) => {
  // Ownership check via project lookup
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { userId: true } });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.userId !== null && project.userId !== req.userId) return res.status(403).json({ error: "Access denied" });

  const groups = await prisma.run.groupBy({
    by: ["status"],
    where: { projectId: req.params.projectId, source: "HISTORY" },
    _count: { status: true },
  });
  const total = await prisma.run.count({
    where: { projectId: req.params.projectId, source: "HISTORY" },
  });
  res.json({ total, byStatus: groups });
});

// ─── Background hydration ──────────────────────────────────────────

const CONCURRENCY = 3;

/**
 * Hydrate run stubs in the background.
 *
 * Processes `initialStubs` first (oldest → newest), then lazily creates stubs
 * from `lazyIds` if too many early calls turn out to be failed/no-answer.
 * Stops once `limit` *completed* calls have been evaluated, or all IDs are
 * exhausted. Remaining unprocessed PENDING stubs are deleted so they don't
 * pollute the table or trigger endless polling.
 */
async function hydrateRunsInBackground(
  initialStubs: { id: string; conversationId: string }[],
  lazyIds: string[],
  apiKey: string | undefined,
  projectId: string,
  limit: number
) {
  // Work queue: starts with pre-created stubs; lazy IDs appended as needed
  const queue: { id: string | null; conversationId: string }[] = [
    ...initialStubs.map((s) => ({ id: s.id, conversationId: s.conversationId })),
    ...lazyIds.map((id) => ({ id: null, conversationId: id })),
  ];

  let validCount = 0;
  const now = new Date();

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    if (validCount >= limit) {
      // Delete any remaining PENDING stubs we created but won't process
      const leftoverStubIds = queue
        .slice(i)
        .filter((q) => q.id !== null)
        .map((q) => q.id as string);
      if (leftoverStubIds.length > 0) {
        await prisma.run.deleteMany({
          where: { id: { in: leftoverStubIds }, status: "PENDING" },
        });
      }
      break;
    }

    const batch = queue.slice(i, i + CONCURRENCY);

    // Ensure every item in the batch has a run stub in the DB
    for (const item of batch) {
      if (item.id === null) {
        try {
          const run = await prisma.run.create({
            data: {
              projectId,
              source: "HISTORY",
              conversationId: item.conversationId,
              modelUsed: null,
              status: "PENDING",
              startedAt: now,
            },
          });
          item.id = run.id;
        } catch {
          // Duplicate or DB error — skip this ID
          item.id = "__skip__";
        }
      }
    }

    // Only send as many items as we still need to reach the limit
    const remaining = limit - validCount;
    const eligible = batch.filter((item) => item.id && item.id !== "__skip__");
    const toHydrate = eligible.slice(0, remaining); // never over-shoot the limit
    const toSkip = eligible.slice(remaining);       // excess items in this batch

    // Delete stubs for items we're skipping due to limit
    if (toSkip.length > 0) {
      await prisma.run.deleteMany({
        where: { id: { in: toSkip.map((s) => s.id as string) }, status: "PENDING" },
      });
    }

    const results = await Promise.allSettled(
      toHydrate.map((item) => hydrateRun(item.id!, item.conversationId, apiKey, projectId))
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value === "COMPLETED") {
        validCount++;
      }
    }
  }

  flog(`[History] Import done for project ${projectId}: ${validCount} completed calls evaluated`);
}

async function hydrateRun(
  runId: string,
  convId: string,
  apiKey: string | undefined,
  _projectId: string,
  apiBaseUrl?: string,
): Promise<"COMPLETED" | "FAILED"> {
  try {
    // Fetch conversation details from Hamsa
    const conv = await fetchConversation(convId, apiKey, apiBaseUrl);

    // Log the top-level keys of the conv object for debugging transcript extraction
    if (process.env.NODE_ENV !== "production") {
      const topKeys = Object.keys(conv ?? {});
      const callAnalysisKeys = conv?.callAnalysis ? Object.keys(conv.callAnalysis) : [];
      flog(`[History] conv keys for ${convId}: [${topKeys.join(", ")}]`);
      if (callAnalysisKeys.length) flog(`[History] callAnalysis keys: [${callAnalysisKeys.join(", ")}]`);
      // Log callAnalysis content to see any transcript data
      if (conv?.callAnalysis) {
        flog(`[History] callAnalysis sample: ${JSON.stringify(conv.callAnalysis).slice(0, 500)}`);
      }
      // Log jobResponse to understand jobId extraction
      if (conv?.jobResponse) {
        flog(`[History] jobResponse: ${JSON.stringify(conv.jobResponse).slice(0, 300)}`);
      }
      // Log ALL unique categories + messages from conv.logs to understand format
      if (Array.isArray(conv?.logs) && conv.logs.length > 0) {
        flog(`[History] conv.logs length: ${conv.logs.length}`);
        // Log first 5 entries in full to see the structure
        conv.logs.slice(0, 5).forEach((entry: any, i: number) => {
          flog(`[History] conv.logs[${i}]: ${JSON.stringify(entry).slice(0, 600)}`);
        });
        // Log all unique category+message pairs to map the schema
        const seen = new Set<string>();
        for (const e of conv.logs) {
          const key = `${e?.category}::${e?.message}`;
          if (!seen.has(key)) {
            seen.add(key);
            flog(`[History] LOG SCHEMA — cat="${e?.category}" msg="${e?.message}" payloadKeys=[${Object.keys(e?.payload ?? {}).join(",")}]`);
          }
        }
      }
    }

    // Extract Hamsa call outcome status (COMPLETED, FAILED, NO_ANSWER, etc.)
    const callStatus: string | null =
      conv?.status ||
      conv?.callAnalysis?.status ||
      conv?.callStatus ||
      null;

    const normalizedStatus = callStatus?.toUpperCase() ?? "";

    // If the call itself failed or had no answer, mark the run FAILED and return
    // early — do not count toward the valid-call limit
    if (["FAILED", "NO_ANSWER", "ERROR"].includes(normalizedStatus)) {
      await prisma.run.update({
        where: { id: runId },
        data: { callStatus, status: "FAILED", errorLog: `Hamsa call status: ${callStatus}` },
      });
      flog(`[History] Skipping run ${runId} (conv=${convId}): call was ${callStatus}`);
      return "FAILED";
    }

    // Extract transcript from conversation object (callAnalysis.transcription, etc.)
    const transcript = extractTranscriptFromConversation(conv);

    // conv.logs IS the execution log — store it directly as callLog.
    // This contains node movements, tool calls, variable extractions, etc.
    // used by DETERMINISTIC, STRUCTURAL, LATENCY, FLOW_PROGRESSION evaluators.
    const convLogs = Array.isArray(conv?.logs) && conv.logs.length > 0 ? conv.logs : null;

    // Determine model used
    const modelUsed =
      conv?.agentDetails?.llm?.model ||
      conv?.voiceAgent?.llm?.model ||
      (conv?.model !== "Hamsa" ? conv?.model : null) ||
      "unknown";

    // Determine call date and duration
    const callDate = conv?.createdAt ? new Date(conv.createdAt) : null;
    const callDuration = typeof conv?.callDuration === "number" ? conv.callDuration : null;

    // Get job ID for supplemental log fetch
    const jobId = extractJobIdFromConversation(conv);

    // Extract outcome result from jobResponse
    const outcomeResult = conv?.jobResponse?.outcomeResult ?? null;
    const callOutcome: string | null = outcomeResult?.call_outcome ?? null;

    // Update run with hydrated data (including conv.logs as callLog)
    await prisma.run.update({
      where: { id: runId },
      data: {
        modelUsed,
        callDate,
        callDuration,
        callStatus,
        callOutcome,
        outcomeResult: outcomeResult as any,
        hamsaCallId: jobId,
        transcript: transcript as any,
        callLog: convLogs as any,   // store embedded logs immediately
        webhookData: conv as any,
        status: "AWAITING_DATA",
      },
    });

    flog(`[History] Stored conv.logs (${convLogs?.length ?? 0} entries) as callLog for run ${runId}`);

    // Also try fetching supplemental logs via jobId (may have more detail)
    if (jobId) {
      try {
        const logs = await fetchCallLog(jobId, apiKey, apiBaseUrl);
        if (Array.isArray(logs) && logs.length > 0) {
          if (process.env.NODE_ENV !== "production") {
            flog(`[History] fetchCallLog returned ${logs.length} entries for ${convId}`);
            flog(`[History] callLog[0]: ${JSON.stringify(logs[0]).slice(0, 500)}`);
          }
          // Override with fetched logs only if they have more entries
          if (logs.length >= (convLogs?.length ?? 0)) {
            await prisma.run.update({
              where: { id: runId },
              data: { callLog: logs as any },
            });
          }
        }
      } catch (logErr) {
        flog(`[History] Supplemental log fetch failed for ${convId} (jobId=${jobId}): ${(logErr as Error).message}`);
      }
    } else {
      flog(`[History] No jobId for ${convId} — using embedded conv.logs only`);
    }

    // Trigger evaluation
    await runEvaluationCheck(runId);

    flog(`[History] Hydrated and evaluated run ${runId} (conv=${convId})`);
    return "COMPLETED";
  } catch (err) {
    flog(`[History] Failed to hydrate run ${runId} (conv=${convId}): ${(err as Error).message}`);
    await prisma.run.update({
      where: { id: runId },
      data: { status: "FAILED", errorLog: (err as Error).message },
    }).catch(() => {});
    return "FAILED";
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Parse conversation IDs from an Excel buffer.
 * Samples up to the first 5 data rows to detect which column contains UUIDs.
 * Prefers columns whose headers contain "conversation" or "id".
 */
function parseConversationIdsFromExcel(buffer: Buffer): string[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  flog(`[History] Excel: ${rows.length} rows, sheet="${sheetName}"`);
  if (rows.length === 0) return [];

  // Sample up to 5 rows to determine UUID columns
  const sampleRows = rows.slice(0, Math.min(5, rows.length));
  const allColumns = Object.keys(rows[0]);
  flog(`[History] Excel columns: ${allColumns.join(", ")}`);
  flog(`[History] Excel first row sample: ${JSON.stringify(rows[0]).slice(0, 300)}`);

  // Score each column: how many of the sample rows have a UUID value?
  const columnScores: Record<string, number> = {};
  for (const col of allColumns) {
    let uuidCount = 0;
    for (const row of sampleRows) {
      if (UUID_RE.test(String(row[col] || ""))) uuidCount++;
    }
    columnScores[col] = uuidCount;
  }

  // Columns where the majority of sampled rows are UUIDs
  const uuidColumns = allColumns.filter(
    (col) => columnScores[col] >= Math.ceil(sampleRows.length / 2)
  );

  // Prefer columns whose header contains "conversation" or "id"
  const preferredCols = uuidColumns.filter((k) => /conversation|^id$|\bid\b/i.test(k));
  const idColumn = preferredCols[0] || uuidColumns[0];

  if (!idColumn) {
    // Fallback: scan all cells for UUIDs — but deduplicate carefully
    // Only collect UUIDs that appear in the same position across rows (same column)
    // to avoid picking up agent IDs or user IDs from other columns
    const candidateCols: Record<string, Set<string>> = {};
    for (const row of rows) {
      for (const [col, val] of Object.entries(row)) {
        const s = String(val || "");
        if (UUID_RE.test(s)) {
          if (!candidateCols[col]) candidateCols[col] = new Set();
          candidateCols[col].add(s);
        }
      }
    }
    // Pick the column with the most UUIDs (likely the conversation list)
    const bestCol = Object.entries(candidateCols).sort((a, b) => b[1].size - a[1].size)[0];
    return bestCol ? Array.from(bestCol[1]) : [];
  }

  // Extract unique IDs from the identified column
  const ids = new Set<string>();
  for (const row of rows) {
    const val = String(row[idColumn] || "");
    if (UUID_RE.test(val)) ids.add(val);
  }
  return Array.from(ids);
}

/**
 * Convert a named period (TODAY, THIS_WEEK, etc.) into explicit UTC epoch
 * start/end timestamps so it can be subdivided by the chunking logic.
 * Returns null for unrecognized period names.
 */
function resolveNamedPeriod(period: string): { startPeriod: number; endPeriod: number } | null {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const d = new Date();
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  switch (period) {
    case "LAST_HOUR":  return { startPeriod: now - HOUR, endPeriod: now };
    case "TODAY":      return { startPeriod: utcMidnight, endPeriod: utcMidnight + DAY - 1 };
    case "YESTERDAY":  return { startPeriod: utcMidnight - DAY, endPeriod: utcMidnight - 1 };
    case "THIS_WEEK": {
      // Start of week = UTC Monday
      const dow = d.getUTCDay() || 7; // 1..7, Monday=1
      const monday = utcMidnight - (dow - 1) * DAY;
      return { startPeriod: monday, endPeriod: utcMidnight + DAY - 1 };
    }
    case "THIS_MONTH": {
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return { startPeriod: monthStart, endPeriod: utcMidnight + DAY - 1 };
    }
    default: return null;
  }
}

/**
 * Export conversations with automatic chunking when Hamsa's export endpoint
 * fails with 500/504 on large windows. Strategy: try the full window, if it
 * fails and has a start/end range, split the range in half and retry each half.
 * Recursively halve down to a 1-hour minimum window. Combines and deduplicates
 * conversation IDs from all successful chunks.
 */
async function exportWithChunking(
  agentId: string,
  options: { period?: string; startPeriod?: number; endPeriod?: number; timeDifference?: string; status?: string },
  apiKey: string | undefined,
  depth: number,
): Promise<string[]> {
  const MIN_CHUNK_MS = 60 * 60 * 1000; // 1 hour — stop halving below this
  const MAX_DEPTH = 10;                // safety: max ~2^10 = 1024 chunks

  try {
    const buf = await exportConversations(agentId, options, apiKey);
    const ids = parseConversationIdsFromExcel(buf);
    if (depth > 0) flog(`[History] Chunk depth=${depth}: got ${ids.length} IDs`);
    return ids;
  } catch (err) {
    const msg = (err as Error).message;
    const isRetryable = /500|504|timed out|aborted|Internal Server Error/i.test(msg);

    if (!isRetryable) throw err;
    if (depth >= MAX_DEPTH) throw err;

    // If no explicit date range, resolve the named period into concrete epochs
    // so we can split it. Only enter this branch once (at depth 0).
    if ((!options.startPeriod || !options.endPeriod) && options.period && options.period !== "CUSTOM") {
      const range = resolveNamedPeriod(options.period);
      if (range && depth === 0) {
        flog(`[History] Export failed with period=${options.period} — retrying as CUSTOM with chunking`);
        return exportWithChunking(agentId, { ...options, period: "CUSTOM", ...range }, apiKey, depth);
      }
      throw err;
    }
    if (!options.startPeriod || !options.endPeriod) throw err;

    const windowMs = options.endPeriod - options.startPeriod;
    if (windowMs <= MIN_CHUNK_MS) throw err; // reached minimum granularity

    // Split the window in half and recurse
    const mid = options.startPeriod + Math.floor(windowMs / 2);
    flog(`[History] Export failed at depth=${depth} (window=${Math.round(windowMs/3600000)}h) — splitting and retrying`);

    const leftOpts  = { ...options, period: "CUSTOM", endPeriod: mid };
    const rightOpts = { ...options, period: "CUSTOM", startPeriod: mid + 1 };

    const [leftIds, rightIds] = await Promise.all([
      exportWithChunking(agentId, leftOpts,  apiKey, depth + 1).catch(e => { flog(`[History] Left chunk failed: ${(e as Error).message}`); return [] as string[]; }),
      exportWithChunking(agentId, rightOpts, apiKey, depth + 1).catch(e => { flog(`[History] Right chunk failed: ${(e as Error).message}`); return [] as string[]; }),
    ]);

    // Deduplicate
    return Array.from(new Set([...leftIds, ...rightIds]));
  }
}

export default router;
