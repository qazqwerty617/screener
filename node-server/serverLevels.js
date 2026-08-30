"use strict";

const formationEngine = require("./public/js/formationEngine");

/**
 * Server-side wrapper — exposes individual + unified scan.
 * scanAll() performs one normalize + one swing pass for all 4 detectors.
 */

function scanAll(rawCandles, minTouches) {
  try { return formationEngine.scanAll(rawCandles, minTouches || 2); }
  catch (_) { return { horizontals: [], cascades: [], trendlines: [], retests: [] }; }
}

function detectChartLevelsAndTouches(rawCandles) {
  try { return formationEngine.detectHorizontals(rawCandles, 2); } catch (_) { return []; }
}
function detectHorizontals(rawCandles, minTouches) {
  try { return formationEngine.detectHorizontals(rawCandles, minTouches || 2); } catch (_) { return []; }
}
function detectCascades(rawCandles, minCount) {
  try { return formationEngine.detectCascades(rawCandles, minCount || 2); } catch (_) { return []; }
}
function detectTrendlines(rawCandles, minTouches) {
  try { return formationEngine.detectTrendlines(rawCandles, minTouches || 2); } catch (_) { return []; }
}
function detectRetests(rawCandles) {
  try { return formationEngine.detectRetests(rawCandles); } catch (_) { return []; }
}
function detectApproachingRetests(rawCandles) {
  try { return formationEngine.detectApproachingRetests(rawCandles); } catch (_) { return []; }
}

module.exports = {
  scanAll,
  detectChartLevelsAndTouches,
  detectHorizontals,
  detectCascades,
  detectTrendlines,
  detectRetests,
  detectApproachingRetests
};
