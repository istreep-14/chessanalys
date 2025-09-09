// FEN statistics and backfill utilities for "Openings Normalized" sheet

/**
 * Ensure the target sheet has FEN and split columns. Appends any missing headers.
 * Returns metadata with column indices for quick access.
 */
function ensureFenHeaders_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Openings Normalized');
  if (!sheet) throw new Error('Sheet not found: Openings Normalized');

  var need = [
    'FEN','FEN_board','FEN_active','FEN_castle','FEN_ep','FEN_halfmove','FEN_fullmove',
    'FEN_r8','FEN_r7','FEN_r6','FEN_r5','FEN_r4','FEN_r3','FEN_r2','FEN_r1'
  ];

  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, need.length).setValues([need]);
    sheet.setFrozenRows(1);
  } else {
    var currentHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    for (var i = 0; i < need.length; i++) {
      if (currentHeaders.indexOf(need[i]) === -1) {
        sheet.insertColumnAfter(sheet.getLastColumn());
        sheet.getRange(1, sheet.getLastColumn()).setValue(need[i]);
        currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      }
    }
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  function col(name) { return headers.indexOf(name) + 1; }
  return {
    sheet: sheet,
    colPGN: col('PGN'),
    colFEN: col('FEN'),
    colBoard: col('FEN_board'),
    colActive: col('FEN_active'),
    colCastle: col('FEN_castle'),
    colEp: col('FEN_ep'),
    colHalf: col('FEN_halfmove'),
    colFull: col('FEN_fullmove'),
    colR8: col('FEN_r8')
  };
}

// Keep separate progress properties to avoid colliding with other scripts
var FEN_BF = { propRow: 'FEN_BF_NEXT_ROW', batchRows: 400 };

/**
 * Resume-safe backfill: computes FEN (final) and split columns from PGN.
 * Reads rows in batches and only writes FEN-related columns.
 */
function backfillFenStatsResume() {
  var meta = ensureFenHeaders_();
  var sheet = meta.sheet;
  if (meta.colPGN <= 0 || meta.colFEN <= 0 || meta.colBoard <= 0 || meta.colActive <= 0 || meta.colCastle <= 0 || meta.colEp <= 0 || meta.colHalf <= 0 || meta.colFull <= 0 || meta.colR8 <= 0) return;

  var props = PropertiesService.getScriptProperties();
  var startRow = parseInt(props.getProperty(FEN_BF.propRow) || '2', 10);
  var lastRow = sheet.getLastRow();
  if (startRow > lastRow) return;

  var endRow = Math.min(lastRow, startRow + FEN_BF.batchRows - 1);
  var numRows = endRow - startRow + 1;

  var pgns = sheet.getRange(startRow, meta.colPGN, numRows, 1).getValues();
  var fens = sheet.getRange(startRow, meta.colFEN, numRows, 1).getValues();

  var updFEN = new Array(numRows);
  var updBoard = new Array(numRows);
  var updActive = new Array(numRows);
  var updCastle = new Array(numRows);
  var updEp = new Array(numRows);
  var updHalf = new Array(numRows);
  var updFull = new Array(numRows);
  var updRanks = new Array(numRows);

  for (var i = 0; i < numRows; i++) {
    var pgn = (pgns[i][0] || '').toString();
    var fenCell = (fens[i][0] || '').toString();

    var fen = fenCell;
    if (!fen && pgn) {
      try { fen = pgnToFinalFen_(pgn); } catch (e) { fen = ''; }
    }
    updFEN[i] = [fen];

    var sp = splitFen_(fen);
    updBoard[i] = [sp.board];
    updActive[i] = [sp.active];
    updCastle[i] = [sp.castle];
    updEp[i] = [sp.ep];
    updHalf[i] = [sp.halfmove];
    updFull[i] = [sp.fullmove];
    updRanks[i] = [sp.ranks[0], sp.ranks[1], sp.ranks[2], sp.ranks[3], sp.ranks[4], sp.ranks[5], sp.ranks[6], sp.ranks[7]];
  }

  sheet.getRange(startRow, meta.colFEN, numRows, 1).setValues(updFEN);
  sheet.getRange(startRow, meta.colBoard, numRows, 1).setValues(updBoard);
  sheet.getRange(startRow, meta.colActive, numRows, 1).setValues(updActive);
  sheet.getRange(startRow, meta.colCastle, numRows, 1).setValues(updCastle);
  sheet.getRange(startRow, meta.colEp, numRows, 1).setValues(updEp);
  sheet.getRange(startRow, meta.colHalf, numRows, 1).setValues(updHalf);
  sheet.getRange(startRow, meta.colFull, numRows, 1).setValues(updFull);
  sheet.getRange(startRow, meta.colR8, numRows, 8).setValues(updRanks);

  PropertiesService.getScriptProperties().setProperty(FEN_BF.propRow, String(endRow + 1));
}

/**
 * Aggregate FEN statistics for each opening row.
 * Returns a map of Key -> { eco, name, pgn, fen, countsByActive, countsByCastle }.
 * Expects columns: ECO, Name, PGN, FEN, FEN_active, FEN_castle, Key.
 */
function computeFenStatsByOpening() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Openings Normalized');
  if (!sheet) throw new Error('Sheet not found: Openings Normalized');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return {};

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  function idx(name) { return headers.indexOf(name); }

  var colECO = idx('ECO');
  var colName = idx('Name');
  var colPGN = idx('PGN');
  var colFEN = idx('FEN');
  var colActive = idx('FEN_active');
  var colCastle = idx('FEN_castle');
  var colKey = idx('Key');

  if (colECO < 0 || colName < 0 || colPGN < 0 || colFEN < 0 || colActive < 0 || colCastle < 0 || colKey < 0) return {};

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var stats = {};

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var key = String(row[colKey] || '');
    if (!key) continue;

    var eco = String(row[colECO] || '');
    var name = String(row[colName] || '');
    var pgn = String(row[colPGN] || '');
    var fen = String(row[colFEN] || '');
    var active = String(row[colActive] || '');
    var castle = String(row[colCastle] || '');

    if (!stats[key]) {
      stats[key] = { eco: eco, name: name, pgn: pgn, fen: fen, countsByActive: {}, countsByCastle: {} };
    }
    var s = stats[key];
    s.countsByActive[active] = (s.countsByActive[active] || 0) + 1;
    s.countsByCastle[castle] = (s.countsByCastle[castle] || 0) + 1;
    if (!s.fen && fen) s.fen = fen;
  }

  return stats;
}

/**
 * Custom function wrapper to fetch JSON string of FEN stats by opening key.
 * Example: =FEN_STATS_JSON()
 */
function FEN_STATS_JSON() {
  var obj = computeFenStatsByOpening();
  return JSON.stringify(obj);
}

