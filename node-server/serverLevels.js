"use strict";

const formationEngine = require("./public/js/formationEngine");

/**
 * Shared server/browser cascade detector. Keeping one implementation prevents
 * the formations tab and screener chart from disagreeing about geometry.
 */
function detectChartLevelsAndTouches(rawCandles) {
  try {
    return formationEngine.detectCascades(rawCandles, 1);
  } catch (_) {
    return [];
  }
}

module.exports = { detectChartLevelsAndTouches };
