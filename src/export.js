/**
 * CSV / JSON export.
 *
 * Phase 1.6 (TODO): write a UTF-8-with-BOM CSV (via csv-writer) plus a JSON
 * sidecar and a run-summary JSON. Excel-safe escaping, stable column order,
 * auto-generated filenames.
 *
 * Until then, this module is a placeholder so the project structure is
 * complete and importable.
 */

/**
 * Export business records to CSV (+ JSON sidecar + run summary).
 *
 * @param {Array<object>} businesses
 * @param {object} [options]  { outputDir, query, location }
 * @returns {Promise<{ csvPath: string, jsonPath: string, summaryPath: string }>}
 */
async function exportToCsv(businesses, options = {}) {
  throw new Error('exportToCsv() not implemented yet — see Phase 1.6');
}

module.exports = { exportToCsv };
