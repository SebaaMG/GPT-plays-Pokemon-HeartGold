const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { config } = require("../config");

const DS_NATIVE_FULL = { width: 256, height: 384 };
const DS_NATIVE_BOTTOM = { width: 256, height: 192 };
const REPO_ROOT = path.resolve(config.paths.baseDir, "..");

function resolveRuntimePath(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(REPO_ROOT, filePath);
}

function isOverworld(gameDataJson) {
  return !gameDataJson?.is_talking_to_npc && !gameDataJson?.battle_data?.in_battle;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function tileCodeToColor(code) {
  // Deterministic palette for borders (no gameplay logic).
  const c = Number(code);
  if (!Number.isFinite(c)) return "#888888";
  const hue = (c * 47) % 360;
  return `hsl(${hue} 70% 55%)`;
}

function screenshotRawPath(gameDataJson) {
  const rawPath =
    gameDataJson?.screenshot_raw_path ||
    gameDataJson?.emulator?.screenshotRawPath ||
    gameDataJson?.observationFreshness?.screenshotPath ||
    gameDataJson?.screenshotSnapshotPath ||
    gameDataJson?.emulator?.screenshotSnapshotPath ||
    gameDataJson?.observationFreshness?.screenshotSnapshotPath ||
    gameDataJson?.screenshot_path ||
    null;
  if (!rawPath || typeof rawPath !== "string") return null;
  return resolveRuntimePath(rawPath);
}

function screenshotSnapshotPath(gameDataJson) {
  const snapshotPath =
    gameDataJson?.screenshotSnapshotPath ||
    gameDataJson?.emulator?.screenshotSnapshotPath ||
    gameDataJson?.observationFreshness?.screenshotSnapshotPath ||
    null;
  if (!snapshotPath || typeof snapshotPath !== "string") return null;
  return resolveRuntimePath(snapshotPath);
}

function reportedScreenshotMtimeMs(gameDataJson) {
  const value =
    gameDataJson?.observationFreshness?.screenshotMtimeMs ??
    gameDataJson?.screenshotMtimeMs ??
    gameDataJson?.emulator?.screenshotMtimeMs ??
    null;
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function safeCacheKey(gameDataJson) {
  return String(
      gameDataJson?.screenshotCacheKey ||
      gameDataJson?.emulator?.screenshotCacheKey ||
      gameDataJson?.observationFreshness?.screenshotCacheKey ||
      gameDataJson?.observationFreshness?.screenshotHash ||
      Date.now()
  )
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
}

function explicitScreenshotCacheKey(gameDataJson) {
  const value =
    gameDataJson?.screenshotCacheKey ||
    gameDataJson?.emulator?.screenshotCacheKey ||
    gameDataJson?.observationFreshness?.screenshotCacheKey ||
    null;
  return value == null || value === "" ? null : String(value);
}

function explicitScreenshotHash(gameDataJson) {
  const value =
    gameDataJson?.observationFreshness?.screenshotHash ||
    gameDataJson?.screenshotHash ||
    gameDataJson?.emulator?.screenshotHash ||
    null;
  return value == null || value === "" ? null : String(value);
}

function requiresHeartGoldBenchmarkImageContract() {
  return config.isHeartGold && ["visual", "ram_assisted"].includes(config.observation.mode);
}

function safeObservationId(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
}

function screenshotIsStale(gameDataJson) {
  const freshness = gameDataJson?.observationFreshness || {};
  if (
    gameDataJson?.screenshotFresh === false ||
    gameDataJson?.emulator?.screenshotFresh === false ||
    freshness.screenshotFresh === false ||
    freshness.visualAvailable === false
  ) {
    return true;
  }
  const ageMs = Number(
    freshness.screenshotAgeMs ??
      gameDataJson?.screenshotAgeMs ??
      gameDataJson?.emulator?.screenshotAgeMs ??
      NaN
  );
  if (!Number.isFinite(ageMs) && config.isHeartGold && ["visual", "ram_assisted"].includes(config.observation.mode)) {
    return true;
  }
  return Number.isFinite(ageMs) && ageMs > config.observation.maxScreenshotAgeMs;
}

async function prepareModelImagePath(gameDataJson, options = {}) {
  const rawPath = screenshotRawPath(gameDataJson);
  const allowStaleSource = options.allowStaleSource === true;
  if (!rawPath) {
    return { path: null, error: "Missing screenshot_raw_path" };
  }
  if (requiresHeartGoldBenchmarkImageContract() && !explicitScreenshotHash(gameDataJson)) {
    return { path: null, error: "Missing screenshot hash" };
  }
  if (requiresHeartGoldBenchmarkImageContract() && !explicitScreenshotCacheKey(gameDataJson)) {
    return { path: null, error: "Missing screenshot cache key" };
  }
  if (screenshotIsStale(gameDataJson) && !allowStaleSource) {
    return { path: null, error: "Screenshot is stale" };
  }
  if (!fsSync.existsSync(rawPath)) {
    return { path: null, error: `Screenshot file does not exist: ${rawPath}` };
  }

  let rawStat;
  try {
    rawStat = await fs.stat(rawPath);
  } catch (error) {
    return { path: null, error: `Failed to stat screenshot: ${error.message}` };
  }

  const rawSourceMtimeMs = rawStat.mtimeMs;
  const rawSourceAgeMs = Math.max(0, Date.now() - rawSourceMtimeMs);
  const reportedMtimeMs = reportedScreenshotMtimeMs(gameDataJson);
  const rawReportedMtimeSkewMs =
    reportedMtimeMs === null ? null : Math.abs(rawSourceMtimeMs - reportedMtimeMs);
  const freshnessSlackMs = Math.max(1000, Number(config.observation.maxScreenshotAgeMs || 5000));
  const maxRawAgeMs = Number(config.observation.maxScreenshotAgeMs || 5000) + freshnessSlackMs;
  if (requiresHeartGoldBenchmarkImageContract() && !allowStaleSource) {
    if (rawSourceAgeMs > maxRawAgeMs) {
      return {
        path: null,
        error: `Screenshot source file is stale: rawSourceAgeMs=${Math.round(rawSourceAgeMs)} max=${maxRawAgeMs}`,
        rawPath,
        rawSourceMtimeMs,
        rawSourceAgeMs,
      };
    }
    if (rawReportedMtimeSkewMs !== null && rawReportedMtimeSkewMs > maxRawAgeMs) {
      return {
        path: null,
        error: `Screenshot source mtime does not match bridge freshness: skewMs=${Math.round(rawReportedMtimeSkewMs)} max=${maxRawAgeMs}`,
        rawPath,
        rawSourceMtimeMs,
        rawSourceAgeMs,
        reportedMtimeMs,
      };
    }
  }

  let rawBuffer;
  try {
    rawBuffer = await fs.readFile(rawPath);
  } catch (error) {
    return { path: null, error: `Failed to read screenshot: ${error.message}` };
  }

  let metadata = {};
  try {
    metadata = await sharp(rawBuffer).metadata();
  } catch (error) {
    return { path: null, error: `Failed to inspect screenshot: ${error.message}` };
  }

  const sourceRawWidth = Number(metadata.width) || Number(gameDataJson?.emulator?.screenWidth) || DS_NATIVE_FULL.width;
  const sourceRawHeight = Number(metadata.height) || Number(gameDataJson?.emulator?.screenHeight) || DS_NATIVE_FULL.height;
  if (
    requiresHeartGoldBenchmarkImageContract() &&
    (sourceRawWidth !== DS_NATIVE_FULL.width || sourceRawHeight !== DS_NATIVE_FULL.height)
  ) {
    return {
      path: null,
      error: `HeartGold model image rejected: raw screenshot dimensions must be ${DS_NATIVE_FULL.width}x${DS_NATIVE_FULL.height}, got ${sourceRawWidth}x${sourceRawHeight}`,
      rawPath,
      sourceRaw: { width: sourceRawWidth, height: sourceRawHeight },
    };
  }
  const scale = Math.max(1, Math.min(4, Number(options.scale || config.observation.modelImageScale || 2) || 2));
  const width = DS_NATIVE_FULL.width * scale;
  const height = DS_NATIVE_FULL.height * scale;
  const outDir = path.dirname(screenshotSnapshotPath(gameDataJson) || rawPath);
  const baseCacheKey = safeCacheKey(gameDataJson);
  const observationId = safeObservationId(options.observationId);
  const cacheKey = observationId ? `${baseCacheKey}_${observationId}`.slice(0, 140) : baseCacheKey;
  const modelPath = path.join(outDir, `ds_vision_${cacheKey}_model_x${scale}.png`);

  const upscaled = await sharp(rawBuffer)
    .resize({ width, height, kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  const modelImageSha256 = crypto.createHash("sha256").update(upscaled).digest("hex");
  await fs.writeFile(modelPath, upscaled);

  return {
    path: modelPath,
    rawPath,
    sha256: modelImageSha256,
    rawSourceMtimeMs,
    rawSourceAgeMs,
    rawReportedMtimeSkewMs,
    cacheKey,
    screenshotHash: explicitScreenshotHash(gameDataJson),
    screenshotFresh:
      gameDataJson?.observationFreshness?.screenshotFresh ??
      gameDataJson?.screenshotFresh ??
      gameDataJson?.emulator?.screenshotFresh ??
      null,
    screenshotAgeMs:
      gameDataJson?.observationFreshness?.screenshotAgeMs ??
      gameDataJson?.screenshotAgeMs ??
      gameDataJson?.emulator?.screenshotAgeMs ??
      null,
    rawWidth: DS_NATIVE_FULL.width,
    rawHeight: DS_NATIVE_FULL.height,
    sourceRaw: { width: sourceRawWidth, height: sourceRawHeight },
    width,
    height,
    scale,
    coordinateContract: {
      rawFull: { ...DS_NATIVE_FULL },
      bottom: { ...DS_NATIVE_BOTTOM },
      modelScaled: { width, height },
    },
    error: null,
  };
}

function estimateLabelStyle({ label, cellW, cellH, scale, maxFontSize }) {
  const charCount = Math.max(1, `${label ?? ""}`.length);
  const padding = Math.max(1, Math.round(scale * 0.5));
  const safeMaxFontSize = Number.isFinite(maxFontSize) ? maxFontSize : 22;

  // Safe-ish estimate for Arial digits + "x" width in ems (slightly pessimistic).
  const charWidthEm = 0.6;

  const maxByHeight = Math.floor(cellH - 2 * padding);
  const maxByWidth = Math.floor((cellW - 2 * padding) / (charCount * charWidthEm));

  let fontSize = clamp(Math.min(safeMaxFontSize, maxByHeight, maxByWidth), 6, safeMaxFontSize);
  let strokeWidth = Math.max(1, Math.round(fontSize * 0.12));

  // Refine with outline taken into account so the stroke doesn't spill out of the tile.
  const maxByWidth2 = Math.floor((cellW - 2 * (padding + strokeWidth)) / (charCount * charWidthEm));
  const maxByHeight2 = Math.floor(cellH - 2 * (padding + strokeWidth));
  fontSize = clamp(Math.min(fontSize, maxByWidth2, maxByHeight2), 6, safeMaxFontSize);
  strokeWidth = Math.max(1, Math.round(fontSize * 0.12));

  const textLength = Math.max(0, cellW - 2 * (padding + strokeWidth));

  return { fontSize, strokeWidth, textLength };
}

function buildOverlaySvg({ widthPx, heightPx, grid, originX, originY, playerX, playerY, scale }) {
  const rows = Array.isArray(grid) ? grid.length : 0;
  const cols = rows > 0 && Array.isArray(grid[0]) ? grid[0].length : 0;
  if (!rows || !cols) {
    return null;
  }

  // The screenshot always represents the GBA screen (15x10 meta-tiles).
  // When visibility is reduced (e.g. caves/gyms/pyramid), Python returns a smaller grid
  // centered on the player. We draw that smaller grid in the correct screen location
  // instead of stretching it to the whole image.
  const screenCols = 15;
  const screenRows = 10;
  const cellW = (widthPx / screenCols) | 0;
  const cellH = (heightPx / screenRows) | 0;

  const playerCol = playerX - originX; // local col in `grid`
  const playerRow = playerY - originY; // local row in `grid`
  const playerScreenCol = (screenCols / 2) | 0; // 7
  const playerScreenRow = (screenRows / 2) | 0; // 5

  const maxFontSize = clamp(Math.floor(10 * scale), 10, 22);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">`
  );

  // Semi-transparent background to improve readability.
  parts.push(`<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="rgba(0,0,0,0)" />`);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = c - playerCol;
      const dy = r - playerRow;
      const screenC = playerScreenCol + dx;
      const screenR = playerScreenRow + dy;
      if (screenC < 0 || screenC >= screenCols || screenR < 0 || screenR >= screenRows) {
        continue;
      }

      const x = screenC * cellW;
      const y = screenR * cellH;

      const worldX = originX + c;
      const worldY = originY + r;

      const code = grid[r]?.[c];
      const stroke = tileCodeToColor(code);

      parts.push(
        `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="none" stroke="${stroke}" stroke-width="${Math.max(
          1,
          Math.floor(scale)
        )}" />`
      );

      const label = `${worldX}x${worldY}`;
      const { fontSize, strokeWidth, textLength } = estimateLabelStyle({ label, cellW, cellH, scale, maxFontSize });
      const tx = x + cellW / 2;
      const ty = y + cellH / 2 + fontSize / 3;

      const textFit = textLength ? ` textLength="${textLength}" lengthAdjust="spacingAndGlyphs"` : "";

      // Outline + foreground text for readability.
      parts.push(
        `<text x="${tx}" y="${ty}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#000000" stroke="#000000" stroke-width="${strokeWidth}" paint-order="stroke"${textFit}>${label}</text>`
      );
      parts.push(
        `<text x="${tx}" y="${ty}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#ffffff"${textFit}>${label}</text>`
      );
    }
  }

  // Player highlight
  if (Number.isFinite(playerCol) && Number.isFinite(playerRow) && playerCol >= 0 && playerRow >= 0) {
    const px = playerScreenCol * cellW;
    const py = playerScreenRow * cellH;
    parts.push(
      `<rect x="${px}" y="${py}" width="${cellW}" height="${cellH}" fill="none" stroke="#00ff00" stroke-width="${Math.max(
        2,
        Math.floor(scale * 2)
      )}" />`
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

async function buildVisionPayload(gameDataJson) {
  const rawPath = screenshotRawPath(gameDataJson);
  if (!rawPath || typeof rawPath !== "string") {
    return { image1Base64: null, image2Base64: null, error: "Missing screenshot_raw_path" };
  }
  if (requiresHeartGoldBenchmarkImageContract() && !explicitScreenshotHash(gameDataJson)) {
    return { image1Base64: null, image2Base64: null, error: "Missing screenshot hash" };
  }
  if (requiresHeartGoldBenchmarkImageContract() && !explicitScreenshotCacheKey(gameDataJson)) {
    return { image1Base64: null, image2Base64: null, error: "Missing screenshot cache key" };
  }
  if (screenshotIsStale(gameDataJson)) {
    return { image1Base64: null, image2Base64: null, error: "Screenshot is stale" };
  }

  let rawStat;
  try {
    rawStat = await fs.stat(rawPath);
  } catch (error) {
    return { image1Base64: null, image2Base64: null, error: `Failed to stat screenshot: ${error.message}` };
  }

  const rawSourceMtimeMs = rawStat.mtimeMs;
  const rawSourceAgeMs = Math.max(0, Date.now() - rawSourceMtimeMs);
  const reportedMtimeMs = reportedScreenshotMtimeMs(gameDataJson);
  const rawReportedMtimeSkewMs =
    reportedMtimeMs === null ? null : Math.abs(rawSourceMtimeMs - reportedMtimeMs);
  const freshnessSlackMs = Math.max(1000, Number(config.observation.maxScreenshotAgeMs || 5000));
  const maxRawAgeMs = Number(config.observation.maxScreenshotAgeMs || 5000) + freshnessSlackMs;
  if (requiresHeartGoldBenchmarkImageContract()) {
    if (rawSourceAgeMs > maxRawAgeMs) {
      return {
        image1Base64: null,
        image2Base64: null,
        error: `Screenshot source file is stale: rawSourceAgeMs=${Math.round(rawSourceAgeMs)} max=${maxRawAgeMs}`,
      };
    }
    if (rawReportedMtimeSkewMs !== null && rawReportedMtimeSkewMs > maxRawAgeMs) {
      return {
        image1Base64: null,
        image2Base64: null,
        error: `Screenshot source mtime does not match bridge freshness: skewMs=${Math.round(rawReportedMtimeSkewMs)} max=${maxRawAgeMs}`,
      };
    }
  }

  let rawBuffer;
  try {
    rawBuffer = await fs.readFile(rawPath);
  } catch (e) {
    return { image1Base64: null, image2Base64: null, error: `Failed to read screenshot: ${e.message}` };
  }

  let metadata = {};
  try {
    metadata = await sharp(rawBuffer).metadata();
  } catch {
    metadata = {};
  }

  const rawWidth = Number(metadata.width) || Number(gameDataJson?.emulator?.screenWidth) || 240;
  const rawHeight = Number(metadata.height) || Number(gameDataJson?.emulator?.screenHeight) || 160;
  if (
    requiresHeartGoldBenchmarkImageContract() &&
    (rawWidth !== DS_NATIVE_FULL.width || rawHeight !== DS_NATIVE_FULL.height)
  ) {
    return {
      image1Base64: null,
      image2Base64: null,
      error: `HeartGold model image rejected: raw screenshot dimensions must be ${DS_NATIVE_FULL.width}x${DS_NATIVE_FULL.height}, got ${rawWidth}x${rawHeight}`,
    };
  }
  const isDs =
    gameDataJson?.game?.platform === "Nintendo DS" ||
    gameDataJson?.game?.profile === "heartgold" ||
    (rawWidth === 256 && rawHeight >= 384);

  // GBA screenshots are 240x160 and read well at x3. DS vertical layout is
  // 256x384, so the configured model scale keeps both screens inspectable.
  const scale = isDs ? (rawWidth >= 512 || rawHeight >= 768 ? 1 : config.observation.modelImageScale) : 3;
  const widthPx = rawWidth * scale;
  const heightPx = rawHeight * scale;

  const upscaled = await sharp(rawBuffer)
    .resize({ width: widthPx, height: heightPx, kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  const image1Base64 = upscaled.toString("base64");
  let image1Path = null;

  // Debug: always persist the generated vision screenshots next to the raw screenshot.
  // This keeps behavior stable and makes it easy to inspect what we actually sent.
  try {
    const outDir = path.dirname(rawPath);
    const cacheKey = String(gameDataJson?.screenshotCacheKey || gameDataJson?.emulator?.screenshotCacheKey || Date.now())
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 80);
    image1Path = path.join(outDir, isDs ? `ds_vision_${cacheKey}_model_x${scale}.png` : `gba_upscaled_${cacheKey}_x3.png`);
    await fs.writeFile(image1Path, upscaled);
  } catch {
    // Non-fatal: vision can still proceed without debug files.
  }

  // Overworld: add overlay image2 (raw + coords/grid).
  if (isDs || !isOverworld(gameDataJson)) {
    return { image1Base64, image1Path, image1Width: widthPx, image1Height: heightPx, rawWidth, rawHeight, scale, image2Base64: null, error: null };
  }

  const visible = gameDataJson?.visible_area_data;
  const grid = visible?.grid;
  const originX = Number(visible?.origin?.x);
  const originY = Number(visible?.origin?.y);
  const playerX = Number(gameDataJson?.current_trainer_data?.position?.x);
  const playerY = Number(gameDataJson?.current_trainer_data?.position?.y);

  const svg = buildOverlaySvg({
    widthPx,
    heightPx,
    grid,
    originX: Number.isFinite(originX) ? originX : playerX,
    originY: Number.isFinite(originY) ? originY : playerY,
    playerX: Number.isFinite(playerX) ? playerX : 0,
    playerY: Number.isFinite(playerY) ? playerY : 0,
    scale,
  });

  if (!svg) {
    return { image1Base64, image1Path, image1Width: widthPx, image1Height: heightPx, rawWidth, rawHeight, scale, image2Base64: null, error: null };
  }

  const overlayed = await sharp(upscaled)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();

  const image2Base64 = overlayed.toString("base64");

  try {
    const outDir = path.dirname(rawPath);
    await fs.writeFile(path.join(outDir, "gba_overlay_x3.png"), overlayed);
  } catch {
    // Non-fatal: vision can still proceed without debug files.
  }

  return { image1Base64, image1Path, image1Width: widthPx, image1Height: heightPx, rawWidth, rawHeight, scale, image2Base64, error: null };
}

module.exports = { buildVisionPayload, isOverworld, prepareModelImagePath, screenshotRawPath };
