const fs = require('node:fs');
const path = require('node:path');

function normalizeToken(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function createTransientTestBuildDir(workspaceRoot, options = {}) {
  const runsRoot = path.join(workspaceRoot, '.test-dist-runs');
  const timestamp = normalizeToken(options.timestamp, new Date().toISOString().replace(/[-:.]/g, ''));
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? String(options.pid) : String(process.pid);
  const random = normalizeToken(options.random, Math.random().toString(36).slice(2, 8));
  const dirName = `${timestamp}-${pid}-${random}`;
  return {
    runsRoot,
    outDir: path.join(runsRoot, dirName)
  };
}

module.exports = {
  createTransientTestBuildDir
};
