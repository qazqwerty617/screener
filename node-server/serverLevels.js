"use strict";

const formationEngine = require("./public/js/formationEngine");

/**
 * Clean unbroken horizontal S/R detector for server-side 24/7 scanning.
 * Rejects pierced levels and ensures at least 2 distinct swing bounces.
 */
function detectChartLevelsAndTouches(rawCandles) {
  try {
    return formationEngine.detectHorizontals(rawCandles, 2);
  } catch (_) {
    return [];
  }
}

module.exports = { detectChartLevelsAndTouches };
