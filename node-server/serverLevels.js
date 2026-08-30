"use strict";

const formationEngine = require("./public/js/formationEngine");

/**
 * Server-side wrapper for FormationEngine with all pattern types.
 */
function detectChartLevelsAndTouches(rawCandles) {
  try {
    return formationEngine.detectHorizontals(rawCandles, 2);
  } catch (_) {
    return [];
  }
}

function detectHorizontals(rawCandles, minTouches = 2) {
  try {
    return formationEngine.detectHorizontals(rawCandles, minTouches);
  } catch (_) {
    return [];
  }
}

function detectCascades(rawCandles, minCount = 2) {
  try {
    return formationEngine.detectCascades(rawCandles, minCount);
  } catch (_) {
    return [];
  }
}

function detectTrendlines(rawCandles, minTouches = 2) {
  try {
    return formationEngine.detectTrendlines(rawCandles, minTouches);
  } catch (_) {
    return [];
  }
}

function detectRetests(rawCandles) {
  try {
    return formationEngine.detectRetests(rawCandles);
  } catch (_) {
    return [];
  }
}

function detectApproachingRetests(rawCandles) {
  try {
    return formationEngine.detectApproachingRetests(rawCandles);
  } catch (_) {
    return [];
  }
}

module.exports = {
  detectChartLevelsAndTouches,
  detectHorizontals,
  detectCascades,
  detectTrendlines,
  detectRetests,
  detectApproachingRetests
};
