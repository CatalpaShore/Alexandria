import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const projectRoot = path.resolve(import.meta.dirname, "..");
const databasePath = path.join(projectRoot, "data", "media-wall.sqlite");
const externalRoot = path.resolve(process.env.AMW_EXTERNAL_AI_ROOT ?? path.resolve(process.env.DATA_DIR ?? ".local/data", "external-ai"));
const benchmarkRootArg = process.argv.find((value) => value.startsWith("--output="));
const benchmarkRoot = benchmarkRootArg
  ? path.resolve(benchmarkRootArg.slice("--output=".length))
  : path.join(externalRoot, "benchmarks", `content-preview-concurrency-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const photoWidth = Math.min(Number.parseInt(process.env.AMW_CONTENT_PREVIEW_PHOTO_WIDTH ?? "960", 10), 1920);
const gifWidth = Math.min(Number.parseInt(process.env.AMW_CONTENT_PREVIEW_GIF_WIDTH ?? "480", 10), 960);
const gifSeconds = Math.min(Number.parseInt(process.env.AMW_CONTENT_PREVIEW_GIF_SECONDS ?? "4", 10), 12);
const gifFps = Math.min(Number.parseInt(process.env.AMW_CONTENT_PREVIEW_GIF_FPS ?? "6", 10), 12);
const gifMaxBytes = Number.parseInt(process.env.AMW_CONTENT_PREVIEW_GIF_MAX_MB ?? "6", 10) * 1024 * 1024;
const ffmpegThreads = Math.min(Number.parseInt(process.env.MEDIA_WORKER_FFMPEG_THREADS ?? "2", 10), 4);
const sourceCap = 6;
const testedConcurrency = [4, 6, 8, 10];
const sampleCounts = new Map([["Japan-1", 6], ["Japan-2", 4]]);
const gifAnchorIndexes = new Set([2, 6, 10]);

function isInsideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function calculateAnchors(durationSeconds) {
  const tail = Math.min(300, Math.max(10, durationSeconds * 0.03));
  let start = 300;
  let end = durationSeconds - tail;
  let fallbackShort = false;
  if (durationSeconds <= 300 || end - start < 60) {
    start = Math.max(1, durationSeconds * 0.1);
    end = Math.max(start + 1, durationSeconds * 0.9);
    fallbackShort = true;
  }
  const anchors = Array.from({ length: 12 }, (_, index) => start + ((index + 1) * (end - start)) / 13);
  return { start, end, fallbackShort, anchors };
}

function selectSamples() {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  const select = database.prepare(`
    WITH latest AS (
      SELECT id, media_id, status, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY media_id
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS rank
      FROM media_jobs
      WHERE job_type = 'content-preview'
    )
    SELECT media.id, media.source_name AS sourceName, media.source_root AS sourceRoot,
      media.normalized_code AS code, media.absolute_path AS absolutePath,
      media.duration_seconds AS durationSeconds, media.size, latest.created_at AS queuedAt
    FROM latest
    JOIN media_files media ON media.id = latest.media_id
    WHERE latest.rank = 1 AND latest.status = 'pending'
      AND media.source_name = @sourceName
      AND media.duration_seconds > 360
    ORDER BY latest.created_at ASC, media.id ASC
    LIMIT @limit
  `);
  const rows = [];
  for (const [sourceName, limit] of sampleCounts) {
    const selected = select.all({ sourceName, limit });
    if (selected.length !== limit) {
      throw new Error(`Expected ${limit} pending samples from ${sourceName}, found ${selected.length}`);
    }
    rows.push(...selected);
  }
  database.close();
  return rows.map((row, benchmarkIndex) => {
    if (!fs.existsSync(row.absolutePath)) throw new Error(`Sample source is unavailable: ${row.absolutePath}`);
    return {
      ...row,
      benchmarkIndex,
      phase: benchmarkIndex % 3,
      sourceVolume: row.absolutePath.split(path.sep).slice(0, 3).join(path.sep),
      durationMinutes: Math.round((row.durationSeconds / 60) * 10) / 10,
      sizeGiB: Math.round((row.size / 1024 ** 3) * 100) / 100
    };
  });
}

function parseTimeMetrics(stderr) {
  const read = (name) => {
    const suffix = stderr.match(new RegExp(`([0-9.]+)\\s+${name.replaceAll(" ", "\\s+")}`));
    const prefix = stderr.match(new RegExp(`${name.replaceAll(" ", "\\s+")}\\s+([0-9.]+)`));
    return Number.parseFloat(suffix?.[1] ?? prefix?.[1] ?? "0") || 0;
  };
  return {
    realSeconds: read("real"),
    userSeconds: read("user"),
    systemSeconds: read("sys"),
    maxRssBytes: read("maximum resident set size")
  };
}

function runCommand(command, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${command} timed out`)));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 128 * 1024) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => {
      const message = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve(message);
      else reject(new Error(message.trim().slice(-4000) || `${command} exited with ${code}`));
    }));
  });
}

async function runFfmpeg(args) {
  const stderr = await runCommand("/usr/bin/time", ["-l", "-p", "ffmpeg", ...args]);
  return parseTimeMetrics(stderr);
}

function seekArgs(timeSeconds, fastSeek) {
  return [...(fastSeek ? ["-noaccurate_seek"] : []), "-ss", timeSeconds.toFixed(3)];
}

function photoArgs(sample, timeSeconds, outputPath, fastSeek) {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...seekArgs(timeSeconds, fastSeek),
    "-fflags", "+discardcorrupt", "-err_detect", "ignore_err",
    "-i", sample.absolutePath,
    "-map", "0:V:0", "-frames:v", "1",
    "-vf", `scale=w=${photoWidth}:h=-2:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-q:v", "4", "-threads", String(ffmpegThreads), "-an", outputPath
  ];
}

function gifFilter(width, fps, colors) {
  return `[0:v:0]fps=${fps},scale=w=${width}:h=-2:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2,split[gif_a][gif_b];[gif_a]palettegen=max_colors=${colors}:stats_mode=diff[palette];[gif_b][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[gif_out]`;
}

function gifArgs(sample, timeSeconds, outputPath, width = gifWidth, fps = gifFps, colors = 128) {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...seekArgs(timeSeconds, false),
    "-t", String(gifSeconds),
    "-fflags", "+discardcorrupt", "-err_detect", "ignore_err",
    "-i", sample.absolutePath,
    "-filter_complex", gifFilter(width, fps, colors),
    "-map", "[gif_out]", "-loop", "0",
    "-threads", String(ffmpegThreads), "-an", outputPath
  ];
}

function mergeUsage(target, usage) {
  target.ffmpegRealSeconds += usage.realSeconds;
  target.ffmpegUserSeconds += usage.userSeconds;
  target.ffmpegSystemSeconds += usage.systemSeconds;
  target.peakFfmpegRssBytes = Math.max(target.peakFfmpegRssBytes, usage.maxRssBytes);
}

async function renderWithFallback({ targetSeconds, minSeconds, maxSeconds, outputPath, createArgs, allowFastSeek, usage }) {
  const offsets = [0, 2, -2, 10, -10, 30, -30];
  const attempted = new Set();
  let lastError;
  for (const offset of offsets) {
    const candidate = Math.min(Math.max(targetSeconds + offset, minSeconds), maxSeconds);
    const key = candidate.toFixed(3);
    if (attempted.has(key)) continue;
    attempted.add(key);
    for (const fastSeek of allowFastSeek ? [true, false] : [false]) {
      fs.rmSync(outputPath, { force: true });
      try {
        mergeUsage(usage, await runFfmpeg(createArgs(candidate, fastSeek)));
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return candidate;
        lastError = new Error("ffmpeg produced an empty benchmark asset");
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to decode benchmark asset");
}

async function inspectGif(filePath) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames,duration", "-of", "json", filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8") || `ffprobe exited with ${code}`));
    });
  });
  const stream = JSON.parse(stdout).streams?.[0] ?? {};
  return { frames: Number(stream.nb_read_frames ?? 0), durationSeconds: Number(stream.duration ?? 0) };
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function runSample(sample, mode, sampleOutputRoot) {
  const started = performance.now();
  const sampleRoot = path.join(sampleOutputRoot, `${String(sample.benchmarkIndex + 1).padStart(2, "0")}-${sample.code}`);
  fs.mkdirSync(sampleRoot, { recursive: true });
  const window = calculateAnchors(sample.durationSeconds);
  const assetIndexes = mode === "full"
    ? Array.from({ length: 12 }, (_, index) => index)
    : Array.from({ length: 4 }, (_, index) => sample.phase * 4 + index);
  const usage = {
    ffmpegRealSeconds: 0,
    ffmpegUserSeconds: 0,
    ffmpegSystemSeconds: 0,
    peakFfmpegRssBytes: 0
  };
  const assets = [];
  for (const anchorIndex of assetIndexes) {
    const targetSeconds = window.anchors[anchorIndex];
    if (gifAnchorIndexes.has(anchorIndex)) {
      const file = `anchor-${String(anchorIndex + 1).padStart(2, "0")}.gif`;
      const outputPath = path.join(sampleRoot, file);
      const preferredStart = Math.min(
        Math.max(window.start, targetSeconds - gifSeconds / 2),
        Math.max(window.start, window.end - gifSeconds)
      );
      const renderedAt = await renderWithFallback({
        targetSeconds: preferredStart,
        minSeconds: window.start,
        maxSeconds: Math.max(window.start, window.end - gifSeconds),
        outputPath,
        createArgs: (candidate) => gifArgs(sample, candidate, outputPath),
        allowFastSeek: false,
        usage
      });
      if (fs.statSync(outputPath).size > gifMaxBytes) {
        mergeUsage(usage, await runFfmpeg(gifArgs(sample, renderedAt, outputPath, Math.min(gifWidth, 400), Math.min(gifFps, 5), 96)));
      }
      const probe = await inspectGif(outputPath);
      assets.push({
        anchorIndex,
        kind: "gif",
        file,
        renderedAt,
        bytes: fs.statSync(outputPath).size,
        sha256: hashFile(outputPath),
        ...probe
      });
    } else {
      const file = `anchor-${String(anchorIndex + 1).padStart(2, "0")}.jpg`;
      const outputPath = path.join(sampleRoot, file);
      const renderedAt = await renderWithFallback({
        targetSeconds,
        minSeconds: window.start,
        maxSeconds: window.end,
        outputPath,
        createArgs: (candidate, fastSeek) => photoArgs(sample, candidate, outputPath, fastSeek),
        allowFastSeek: true,
        usage
      });
      assets.push({
        anchorIndex,
        kind: "photo",
        file,
        renderedAt,
        bytes: fs.statSync(outputPath).size,
        sha256: hashFile(outputPath)
      });
    }
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  const result = {
    benchmarkIndex: sample.benchmarkIndex,
    code: sample.code,
    sourceName: sample.sourceName,
    sourceVolume: sample.sourceVolume,
    phase: sample.phase,
    mode,
    elapsedSeconds,
    assetCount: assets.length,
    photoCount: assets.filter((asset) => asset.kind === "photo").length,
    gifCount: assets.filter((asset) => asset.kind === "gif").length,
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    usage,
    assets
  };
  writeJson(path.join(sampleRoot, "benchmark-manifest.json"), result);
  return result;
}

async function runPool(samples, concurrency, mode, runRoot) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = new Array(samples.length);
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      if (taskIndex >= samples.length) return;
      const sample = samples[taskIndex];
      try {
        results[taskIndex] = await runSample(sample, mode, runRoot);
        console.log(`BENCH_SAMPLE_DONE mode=${mode} c=${concurrency} code=${sample.code} seconds=${results[taskIndex].elapsedSeconds.toFixed(1)}`);
      } catch (error) {
        failures.push({ code: sample.code, error: error instanceof Error ? error.message : String(error) });
        console.error(`BENCH_SAMPLE_FAILED mode=${mode} c=${concurrency} code=${sample.code}:`, error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, samples.length) }, () => worker()));
  const elapsedSeconds = (performance.now() - started) / 1000;
  const completed = results.filter(Boolean);
  const photos = completed.reduce((sum, result) => sum + result.photoCount, 0);
  const gifs = completed.reduce((sum, result) => sum + result.gifCount, 0);
  const expectedPhotos = mode === "full" ? samples.length * 9 : samples.length * 3;
  const expectedGifs = mode === "full" ? samples.length * 3 : samples.length;
  const invalidGifs = completed.flatMap((result) => result.assets)
    .filter((asset) => asset.kind === "gif" && (asset.frames !== gifSeconds * gifFps || Math.abs(asset.durationSeconds - gifSeconds) > 0.15));
  if (photos !== expectedPhotos || gifs !== expectedGifs || invalidGifs.length > 0) {
    failures.push({
      code: "OUTPUT_AUDIT",
      error: `photos=${photos}/${expectedPhotos}, gifs=${gifs}/${expectedGifs}, invalidGifs=${invalidGifs.length}`
    });
  }
  const cpuSeconds = completed.reduce(
    (sum, result) => sum + result.usage.ffmpegUserSeconds + result.usage.ffmpegSystemSeconds,
    0
  );
  const result = {
    mode,
    concurrency,
    sourceCap,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds,
    sampleCount: samples.length,
    completedCount: completed.length,
    failureCount: failures.length,
    failures,
    photoCount: photos,
    gifCount: gifs,
    totalBytes: completed.reduce((sum, item) => sum + item.totalBytes, 0),
    microMoviesPerHour: mode === "micro" ? (completed.length / elapsedSeconds) * 3600 : null,
    equivalentFullMoviesPerHour: mode === "micro" ? (completed.length / elapsedSeconds) * 3600 / 3 : null,
    fullMoviesPerHour: mode === "full" ? (completed.length / elapsedSeconds) * 3600 : null,
    aggregateFfmpegCpuSeconds: cpuSeconds,
    averageFfmpegCpuCores: elapsedSeconds > 0 ? cpuSeconds / elapsedSeconds : 0,
    peakPerProcessFfmpegRssBytes: completed.reduce(
      (max, item) => Math.max(max, item.usage.peakFfmpegRssBytes),
      0
    ),
    samples: completed.map((item) => ({
      code: item.code,
      sourceName: item.sourceName,
      phase: item.phase,
      elapsedSeconds: item.elapsedSeconds,
      totalBytes: item.totalBytes
    }))
  };
  writeJson(path.join(runRoot, "run-result.json"), result);
  console.log(`BENCH_RUN_DONE mode=${mode} c=${concurrency} seconds=${elapsedSeconds.toFixed(1)} failures=${failures.length}`);
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
  if (!isInsideRoot(externalRoot, benchmarkRoot)) {
    throw new Error(`Benchmark output must stay inside verified external root: ${externalRoot}`);
  }
  fs.mkdirSync(benchmarkRoot, { recursive: true });
  const samples = selectSamples();
  writeJson(path.join(benchmarkRoot, "samples.json"), {
    generatedAt: new Date().toISOString(),
    databasePath,
    selection: "Earliest pending content-preview jobs: 6 Japan-1 + 4 Japan-2",
    samples
  });
  const configuration = {
    generatedAt: new Date().toISOString(),
    benchmarkRoot,
    testedConcurrency,
    sourceCap,
    sampleCount: samples.length,
    photoWidth,
    gifWidth,
    gifSeconds,
    gifFps,
    gifMaxBytes,
    ffmpegThreads,
    microProfile: "One production-equivalent 4-anchor phase per movie: 3 JPEG + 1 GIF",
    fullProfile: "Exact production profile per movie: 9 JPEG + 3 GIF",
    queueIsolation: "Read-only database selection; outputs only under the benchmark root"
  };
  writeJson(path.join(benchmarkRoot, "configuration.json"), configuration);
  console.log(`BENCHMARK_ROOT ${benchmarkRoot}`);
  console.log(`BENCHMARK_SAMPLES ${samples.map((sample) => `${sample.sourceName}:${sample.code}`).join(",")}`);

  const microRuns = [];
  const rounds = [
    { name: "forward", concurrency: testedConcurrency, samples },
    {
      name: "reverse",
      concurrency: [...testedConcurrency].reverse(),
      samples: [
        ...samples.filter((sample) => sample.sourceName === "Japan-1").reverse(),
        ...samples.filter((sample) => sample.sourceName === "Japan-2").reverse()
      ]
    }
  ];
  for (const round of rounds) {
    for (const concurrency of round.concurrency) {
      const runRoot = path.join(benchmarkRoot, "runs", `micro-${round.name}-c${concurrency}`);
      microRuns.push({ round: round.name, ...(await runPool(round.samples, concurrency, "micro", runRoot)) });
    }
  }

  const microSummary = testedConcurrency.map((concurrency) => {
    const runs = microRuns.filter((run) => run.concurrency === concurrency && run.failureCount === 0);
    const rates = runs.map((run) => run.equivalentFullMoviesPerHour);
    return {
      concurrency,
      validRuns: runs.length,
      medianEquivalentFullMoviesPerHour: rates.length ? median(rates) : 0,
      minEquivalentFullMoviesPerHour: rates.length ? Math.min(...rates) : 0,
      maxEquivalentFullMoviesPerHour: rates.length ? Math.max(...rates) : 0,
      orderSensitivityPercent: rates.length === 2 && median(rates) > 0
        ? (Math.abs(rates[0] - rates[1]) / median(rates)) * 100
        : null,
      averageFfmpegCpuCores: runs.length
        ? runs.reduce((sum, run) => sum + run.averageFfmpegCpuCores, 0) / runs.length
        : 0,
      failures: microRuns.filter((run) => run.concurrency === concurrency).reduce((sum, run) => sum + run.failureCount, 0)
    };
  }).sort((a, b) => b.medianEquivalentFullMoviesPerHour - a.medianEquivalentFullMoviesPerHour);
  const finalists = microSummary.filter((item) => item.validRuns === 2 && item.failures === 0).slice(0, 2);
  if (finalists.length < 2) throw new Error("Fewer than two concurrency settings passed both micro benchmark rounds");

  const fullRuns = [];
  for (const finalist of finalists) {
    const runRoot = path.join(benchmarkRoot, "runs", `full-confirm-c${finalist.concurrency}`);
    fullRuns.push(await runPool(samples, finalist.concurrency, "full", runRoot));
  }
  const validFullRuns = fullRuns.filter((run) => run.failureCount === 0);
  if (validFullRuns.length < 2) throw new Error("Exact-profile confirmation did not complete for both finalists");
  const peakExactRate = Math.max(...validFullRuns.map((run) => run.fullMoviesPerHour));
  const selected = [...validFullRuns]
    .filter((run) => run.fullMoviesPerHour >= peakExactRate * 0.97)
    .sort((a, b) => a.concurrency - b.concurrency)[0];
  const summary = {
    generatedAt: new Date().toISOString(),
    benchmarkRoot,
    configuration,
    samples: samples.map(({ id, code, sourceName, sourceVolume, durationMinutes, sizeGiB, phase }) => ({
      id, code, sourceName, sourceVolume, durationMinutes, sizeGiB, phase
    })),
    microRuns,
    microSummary,
    fullRuns,
    decisionRule: "Among zero-failure exact-profile finalists, choose the lowest concurrency within 3% of peak exact throughput",
    selectedConcurrency: selected.concurrency,
    selectedExactFullMoviesPerHour: selected.fullMoviesPerHour,
    peakExactFullMoviesPerHour: peakExactRate,
    selectedRelativeToPeak: selected.fullMoviesPerHour / peakExactRate,
    audit: {
      microRunsExpected: 8,
      microRunsCompleted: microRuns.length,
      fullRunsExpected: 2,
      fullRunsCompleted: fullRuns.length,
      totalFailures: [...microRuns, ...fullRuns].reduce((sum, run) => sum + run.failureCount, 0),
      formalDatabaseWrites: 0,
      formalPreviewManifestsWritten: 0
    }
  };
  writeJson(path.join(benchmarkRoot, "summary.json"), summary);
  console.log("BENCHMARK_COMPLETE");
  console.log(JSON.stringify(summary, null, 2));
}

await main();
