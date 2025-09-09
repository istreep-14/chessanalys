// ===== chess.js loader and PGN utilities (hardened) =====

var __CHESS_CTOR__ = null;

function ensureChessLoaded_() {
  if (__CHESS_CTOR__) return;

  var urls = [
    'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.13.4/chess.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js',
    'https://cdn.jsdelivr.net/npm/chess.js@0.13.4/chess.min.js'
  ];

  for (var i = 0; i < urls.length; i++) {
    try {
      var res = UrlFetchApp.fetch(urls[i], { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) continue;

      var code = res.getContentText();
      if (/\bexport\s/.test(code)) continue; // skip ESM builds

      // Strategy 1: sandboxed factory that returns the constructor
      try {
        var factory = new Function(
          'GLOBAL',
          '"use strict";' +
          'var window=GLOBAL,self=GLOBAL,global=GLOBAL;' +
          'var module={exports:{}};var exports=module.exports;' +
          code + ';' +
          'return GLOBAL.Chess || GLOBAL.chess || ' +
          '(module && module.exports && (module.exports.Chess || module.exports.default || module.exports));'
        );
        var result = factory({});
        if (typeof result === 'function') { __CHESS_CTOR__ = result; return; }
        if (result && typeof result.Chess === 'function') { __CHESS_CTOR__ = result.Chess; return; }
      } catch (e) {
        // fall through
      }

      // Strategy 2: plain eval, then read global
      try {
        eval(code);
        if (typeof Chess === 'function') { __CHESS_CTOR__ = Chess; return; }
        if (typeof chess === 'function') { __CHESS_CTOR__ = chess; return; }
      } catch (e) {
        // try next url
      }
    } catch (e) {
      // try next url
    }
  }

  throw new Error('Could not load a usable chess.js build from fallback URLs.');
}

function newChess_() {
  ensureChessLoaded_();
  return new __CHESS_CTOR__();
}

// Sanitize PGN for robust parsing
function sanitizePgn_(pgn) {
  pgn = String(pgn).replace(/\r/g, '').replace(/^\uFEFF/, '');
  pgn = pgn.replace(/^\s*\[[^\]]*\]\s*$/mg, '');       // headers
  pgn = pgn.replace(/\{[^}]*\}/g, '');                 // {...} comments
  for (var pass = 0; pass < 3; pass++) {               // (...) variations
    pgn = pgn.replace(/\([^()]*\)/g, '');
  }
  pgn = pgn.replace(/\u2026/g, '...');                 // ellipsis
  pgn = pgn.replace(/\$\d+/g, '');                     // NAGs
  pgn = pgn.replace(/\b(\d+)\s+(?=[^.\s])/g, '$1. ');  // "1 e4" -> "1. e4"
  pgn = pgn.replace(/([KQRBNOa-h][^()\s]*)[!?]+/g, '$1'); // strip annotations
  pgn = pgn.replace(/([KQRBNOa-h0-9=+#-]+)[,;]+/g, '$1'); // strip punctuation
  pgn = pgn.replace(/\s+/g, ' ').trim();               // collapse ws
  pgn = pgn.replace(/\s+(1-0|0-1|1\/2-1\/2|\*)\s*$/i, ''); // strip result
  return pgn;
}

// Fallback manual replay if chess.js load_pgn fails
function manualReplayFens_(pgn) {
  var tokens = pgn.split(/\s+/);
  var cleaned = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (/^\d+\.+$/.test(t) || /^\d+\.\.\.$/.test(t) || /^\d+$/.test(t)) continue;     // move numbers
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/i.test(t)) continue;                                 // results
    t = t.replace(/^\d+\.(\.\.)?/, '');                                                // embedded numbers
    t = t.replace(/[;,]+$/g, '');
    if (t) cleaned.push(t);
  }
  var game = newChess_();
  var fens = [];
  for (var j = 0; j < cleaned.length; j++) {
    var san = cleaned[j];
    var moved = game.move(san, { sloppy: true });
    if (!moved) {
      var retry = san.replace(/[!?]+$/g, '');
      if (retry !== san) moved = game.move(retry, { sloppy: true });
    }
    if (!moved) break;
    fens.push(game.fen());
  }
  return fens;
}

/**
 * Hardened: convert PGN to array of FENs (no throw on odd PGN).
 */
function pgnToFens(pgn) {
  if (Array.isArray(pgn)) {
    var parts = [];
    for (var r = 0; r < pgn.length; r++) {
      var row = pgn[r];
      for (var c = 0; c < row.length; c++) if (row[c] != null) parts.push(String(row[c]));
    }
    pgn = parts.join('\n');
  } else {
    pgn = String(pgn);
  }

  var cleaned = sanitizePgn_(pgn);

  try {
    var game = newChess_();
    if (game.load_pgn(cleaned, { sloppy: true })) {
      var moves = game.history({ verbose: true });
      var replay = newChess_();
      var fens = [];
      for (var i = 0; i < moves.length; i++) {
        replay.move(moves[i]);
        fens.push(replay.fen());
      }
      return fens;
    }
  } catch (e) {
    // fall through
  }

  return manualReplayFens_(cleaned);
}

function pgnToFinalFen_(pgn) {
  try {
    var fens = pgnToFens(pgn);
    return fens.length ? fens[fens.length - 1] : newChess_().fen();
  } catch (e) {
    try {
      var game = newChess_();
      if (game.load_pgn(String(pgn), { sloppy: true })) return game.fen();
    } catch (e2) {}
    return '';
  }
}

/**
 * Sheets custom function: returns a column of FENs.
 * Example: =PGN_TO_FENS(A1)
 */
function PGN_TO_FENS(pgn) {
  var fens = pgnToFens(pgn);
  var out = new Array(fens.length);
  for (var i = 0; i < fens.length; i++) out[i] = [fens[i]];
  return out;
}

/**
 * Sheets custom function: final position FEN for a PGN.
 * Example: =PGN_TO_FINAL_FEN(A1)
 */
function PGN_TO_FINAL_FEN(pgn) {
  try {
    var fens = pgnToFens(pgn);
    return fens.length ? fens[fens.length - 1] : newChess_().fen();
  } catch (e) {
    try {
      var game = newChess_();
      if (game.load_pgn(String(pgn), { sloppy: true })) return game.fen();
    } catch (e2) {}
    return '';
  }
}

/**
 * Optional: inspect chess.js URLs
 */
function DEBUG_fetchChess() {
  var urls = [
    'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.13.4/chess.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js',
    'https://cdn.jsdelivr.net/npm/chess.js@0.13.4/chess.min.js'
  ];
  var out = [];
  for (var i = 0; i < urls.length; i++) {
    try {
      var res = UrlFetchApp.fetch(urls[i], { muteHttpExceptions: true, followRedirects: true });
      var code = res.getContentText();
      out.push({
        url: urls[i],
        status: res.getResponseCode(),
        contentType: res.getHeaders()['Content-Type'] || '',
        size: code.length,
        hasExport: /\bexport\s/.test(code),
        head: code.slice(0, 120)
      });
    } catch (e) {
      out.push({ url: urls[i], error: String(e) });
    }
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function extractClockTimes_(pgn) {
  var times = [];
  var re = /\{\s*\[%clk\s+([^\]\}]*)\]\s*\}/g;
  var m;
  while ((m = re.exec(String(pgn))) !== null) times.push((m[1] || '').trim());
  return times;
}

/**
 * Sheets: one row per full move (move#, White SAN, White time, Black SAN, Black time).
 * Example: =PGN_TO_FULLMOVE_TABLE(A1)
 */
function PGN_TO_FULLMOVE_TABLE(pgn) {
  if (Array.isArray(pgn)) {
    var parts = [];
    for (var r = 0; r < pgn.length; r++) for (var c = 0; c < pgn[r].length; c++) if (pgn[r][c] != null) parts.push(String(pgn[r][c]));
    pgn = parts.join('\n');
  } else {
    pgn = String(pgn);
  }

  var times = extractClockTimes_(pgn);
  var game = newChess_();
  if (!game.load_pgn(pgn, { sloppy: true })) throw new Error('Invalid PGN');
  var moves = game.history({ verbose: true });

  var rows = [];
  for (var i = 0; i < moves.length; i += 2) {
    var moveNumber = Math.floor(i / 2) + 1;
    var whiteSan = moves[i] ? moves[i].san : '';
    var whiteTime = times[i] != null ? times[i] : '';
    var blackSan = moves[i + 1] ? moves[i + 1].san : '';
    var blackTime = times[i + 1] != null ? times[i + 1] : '';
    rows.push([moveNumber, whiteSan, whiteTime, blackSan, blackTime]);
  }
  return rows;
}

/**
 * Sheets: one row per half-move (SAN, time).
 * Example: =PGN_TO_MOVES_TIMES(A1)
 */
function PGN_TO_MOVES_TIMES(pgn) {
  if (Array.isArray(pgn)) {
    var parts = [];
    for (var r = 0; r < pgn.length; r++) for (var c = 0; c < pgn[r].length; c++) if (pgn[r][c] != null) parts.push(String(pgn[r][c]));
    pgn = parts.join('\n');
  } else {
    pgn = String(pgn);
  }

  var times = extractClockTimes_(pgn);
  var game = newChess_();
  if (!game.load_pgn(pgn, { sloppy: true })) throw new Error('Invalid PGN');
  var moves = game.history({ verbose: true });

  var rows = [];
  for (var i = 0; i < moves.length; i++) {
    var san = moves[i].san;
    var time = times[i] != null ? times[i] : '';
    rows.push([san, time]);
  }
  return rows;
}

// ===== FEN split helpers =====

function splitFen_(fen) {
  fen = String(fen || '').trim();
  if (!fen) {
    return {
      board: '', active: '', castle: '', ep: '', halfmove: '', fullmove: '',
      ranks: ['', '', '', '', '', '', '', '']
    };
  }
  var parts = fen.split(/\s+/);
  var board = parts[0] || '';
  var active = parts[1] || '';
  var castle = parts[2] || '';
  var ep = parts[3] || '';
  var halfmove = parts[4] || '';
  var fullmove = parts[5] || '';
  var ranks = board.split('/');
  while (ranks.length < 8) ranks.push('');
  if (ranks.length > 8) ranks = ranks.slice(0, 8);
  return { board: board, active: active, castle: castle, ep: ep, halfmove: halfmove, fullmove: fullmove, ranks: ranks };
}

// ===== incremental importer with FEN + FEN split columns (resume-safe, append-only) =====

var CONFIG = {
  baseUrl: 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/',
  files: ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'],
  targetSheetName: 'Openings Normalized',
  batchInputLines: 400,
  headerRow: [
    'Family','Variation','Subvariation','ECO','Name','PGN',
    'FEN','FEN_board','FEN_active','FEN_castle','FEN_ep','FEN_halfmove','FEN_fullmove',
    'FEN_r8','FEN_r7','FEN_r6','FEN_r5','FEN_r4','FEN_r3','FEN_r2','FEN_r1',
    'SourceFile','DataLine','Key'
  ],
  propFileIdx: 'CO_FILE_IDX',
  propDataIdx: 'CO_DATA_IDX'
};

function resumeImport() {
  var props = PropertiesService.getScriptProperties();
  var fileIdx = parseInt(props.getProperty(CONFIG.propFileIdx) || '0', 10);
  var dataIdx = parseInt(props.getProperty(CONFIG.propDataIdx) || '0', 10);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateTargetSheet_(ss);
  var existingKeySet = getExistingKeySet_(sheet);

  var remainingLines = CONFIG.batchInputLines;
  var rowsToAppend = [];

  for (; fileIdx < CONFIG.files.length && remainingLines > 0; fileIdx++) {
    var fileName = CONFIG.files[fileIdx];

    var dataLines;
    try {
      dataLines = fetchDataLines_(fileName).dataLines;
    } catch (e) {
      Logger.log('Fetch failed for ' + fileName + ': ' + e);
      // Do NOT advance progress; pause run so you can retry later
      PropertiesService.getScriptProperties().setProperty(CONFIG.propFileIdx, String(fileIdx));
      PropertiesService.getScriptProperties().setProperty(CONFIG.propDataIdx, String(dataIdx));
      return;
    }

    var i = (fileIdx === parseInt(props.getProperty(CONFIG.propFileIdx) || '0', 10)) ? dataIdx : 0;

    while (i < dataLines.length && remainingLines > 0) {
      var raw = dataLines[i];
      i++;
      remainingLines--;

      var parts = raw.split('\t');
      if (parts.length < 3) continue;

      var eco = (parts[0] || '').trim();
      var name = (parts[1] || '').trim();
      var pgn = (parts[2] || '').trim();
      if (!eco || !name || !pgn) continue;

      var parsed = parseName_(name);
      var family = parsed.family || '—';
      var variation = parsed.variation || '—';
      var subvars = (parsed.subvariations && parsed.subvariations.length) ? parsed.subvariations : ['—'];

      var fen = '';
      try { fen = pgnToFinalFen_(pgn); } catch (e) { fen = ''; }
      var sp = splitFen_(fen);

      for (var s = 0; s < subvars.length; s++) {
        var sv = subvars[s];
        var key = [eco, name, pgn, family, variation, sv].join('|');
        if (!existingKeySet.has(key)) {
          rowsToAppend.push([
            family, variation, sv, eco, name, pgn,
            fen, sp.board, sp.active, sp.castle, sp.ep, sp.halfmove, sp.fullmove,
            sp.ranks[0], sp.ranks[1], sp.ranks[2], sp.ranks[3], sp.ranks[4], sp.ranks[5], sp.ranks[6], sp.ranks[7],
            fileName, i, key
          ]);
          existingKeySet.add(key);
        }
      }
    }

    if (i < dataLines.length) {
      dataIdx = i;
      break;
    } else {
      dataIdx = 0;
    }
  }

  if (rowsToAppend.length) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToAppend.length, CONFIG.headerRow.length).setValues(rowsToAppend);
  }

  PropertiesService.getScriptProperties().setProperty(CONFIG.propFileIdx, String(fileIdx));
  PropertiesService.getScriptProperties().setProperty(CONFIG.propDataIdx, String(dataIdx));
}


function isComplete() {
  var props = PropertiesService.getScriptProperties();
  var fileIdx = parseInt(props.getProperty(CONFIG.propFileIdx) || '0', 10);
  var dataIdx = parseInt(props.getProperty(CONFIG.propDataIdx) || '0', 10);
  if (fileIdx >= CONFIG.files.length) return true;
  var dataLines = fetchDataLines_(CONFIG.files[fileIdx]).dataLines;
  return (fileIdx >= CONFIG.files.length) || (dataIdx >= dataLines.length && fileIdx === CONFIG.files.length - 1);
}

function resetProgress(clearSheet) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(CONFIG.propFileIdx);
  props.deleteProperty(CONFIG.propDataIdx);

  if (clearSheet) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.targetSheetName);
    if (sheet) {
      sheet.clear();
      sheet.getRange(1, 1, 1, CONFIG.headerRow.length).setValues([CONFIG.headerRow]);
      sheet.setFrozenRows(1);
    }
  }
}

/* Optional: auto-continue via triggers */
function createMinuteTrigger() {
  ScriptApp.newTrigger('resumeImport').timeBased().everyMinutes(1).create();
}

function deleteAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) ScriptApp.deleteTrigger(triggers[i]);
}

/* ---------- Helpers ---------- */

function getOrCreateTargetSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.targetSheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.targetSheetName);
    sheet.getRange(1, 1, 1, CONFIG.headerRow.length).setValues([CONFIG.headerRow]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, CONFIG.headerRow.length).setValues([CONFIG.headerRow]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  // Ensure columns exist (append-only; do not rewrite existing data)
  var firstRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), CONFIG.headerRow.length)).getValues()[0];

  // Ensure 'FEN' split columns exist; append any missing headers at the end
  var currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var need = CONFIG.headerRow;
  for (var i = 0; i < need.length; i++) {
    if (currentHeaders.indexOf(need[i]) === -1) {
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, sheet.getLastColumn()).setValue(need[i]);
      currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    }
  }

  sheet.setFrozenRows(1);
  return sheet;
}

function getExistingKeySet_(sheet) {
  var lastRow = sheet.getLastRow();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var keyColIndex = headers.indexOf('Key') + 1;
  var keys = new Set();
  if (lastRow <= 1 || keyColIndex <= 0) return keys;
  var values = sheet.getRange(2, keyColIndex, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var k = (values[i][0] || '').toString();
    if (k) keys.add(k);
  }
  return keys;
}

function fetchDataLines_(fileName) {
  var text = fetchRawTextWithFallbacks_(fileName);
  var lines = text.split(/\r?\n/).filter(function(line){ return line.length > 0; });
  var first = (lines[0] || '').replace(/^\uFEFF/, '');
  var hasHeader = first.toLowerCase().startsWith('eco\t');
  var startIdx = hasHeader ? 1 : 0;
  return { dataLines: lines.slice(startIdx) };
}

function fetchRawTextWithFallbacks_(fileName) {
  var bases = [
    (CONFIG.baseUrl || 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/'),
    'https://cdn.jsdelivr.net/gh/lichess-org/chess-openings@master/'
  ];
  var urls = [];
  for (var i = 0; i < bases.length; i++) urls.push(bases[i] + fileName);

  // 1) Try direct mirrors with small retries
  try {
    return tryUrls_(urls, 3);
  } catch (e) {
    // 2) GitHub API raw fallback (optionally authenticated)
    return githubApiFetch_(fileName);
  }
}

function tryUrls_(urls, retriesPerUrl) {
  var lastErr = 'All mirrors failed';
  for (var u = 0; u < urls.length; u++) {
    for (var a = 0; a < retriesPerUrl; a++) {
      try {
        var res = UrlFetchApp.fetch(urls[u], { muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) {
          var text = res.getContentText();
          if (text && text.length) return text;
        }
        lastErr = 'HTTP ' + code + ' for ' + urls[u];
      } catch (e) {
        lastErr = String(e);
      }
      Utilities.sleep(200 * (a + 1)); // backoff: 200ms, 400ms, 600ms
    }
  }
  throw new Error(lastErr);
}

function githubApiFetch_(path) {
  var url = 'https://api.github.com/repos/lichess-org/chess-openings/contents/' + encodeURIComponent(path) + '?ref=master';
  var headers = { 'Accept': 'application/vnd.github.v3.raw' };
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (token) headers['Authorization'] = 'token ' + token;

  var res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return res.getContentText();
  throw new Error('GitHub API HTTP ' + code + ' for ' + url);
}


function parseName_(name) {
  var idx = name.indexOf(':');
  if (idx === -1) return { family: name.trim(), variation: '', subvariations: [] };
  var family = name.slice(0, idx).trim();
  var tail = name.slice(idx + 1).trim();
  if (!tail) return { family: family, variation: '', subvariations: [] };
  var parts = tail.split(',').map(function(s){ return s.trim(); }).filter(function(x){ return !!x; });
  var variation = parts.length ? parts[0] : '';
  var subvariations = parts.length > 1 ? parts.slice(1) : [];
  return { family: family, variation: variation, subvariations: subvariations };
}

function makeKey_(row) {
  // Legacy (kept for reference). Not used; we build key directly in resumeImport()
  var family = row[0] || '';
  var variation = row[1] || '';
  var subvar = row[2] || '';
  var eco = row[3] || '';
  var name = row[4] || '';
  var pgn = row[5] || '';
  return [eco, name, pgn, family, variation, subvar].join('|');
}

// ===== resume-safe backfill for existing rows (fill missing FEN + splits only) =====

var BF = { propRow: 'BF_NEXT_ROW', batchRows: 400 };

function backfillFenResume() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.targetSheetName);
  if (!sheet) return;

  // Ensure headers exist
  getOrCreateTargetSheet_(ss);

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var colPGN = headers.indexOf('PGN') + 1;
  var colFEN = headers.indexOf('FEN') + 1;
  var colBoard = headers.indexOf('FEN_board') + 1;
  var colActive = headers.indexOf('FEN_active') + 1;
  var colCastle = headers.indexOf('FEN_castle') + 1;
  var colEp = headers.indexOf('FEN_ep') + 1;
  var colH = headers.indexOf('FEN_halfmove') + 1;
  var colF = headers.indexOf('FEN_fullmove') + 1;
  var colR8 = headers.indexOf('FEN_r8') + 1;

  if (colPGN <= 0 || colFEN <= 0 || colBoard <= 0 || colActive <= 0 || colCastle <= 0 || colEp <= 0 || colH <= 0 || colF <= 0 || colR8 <= 0) return;

  var props = PropertiesService.getScriptProperties();
  var startRow = parseInt(props.getProperty(BF.propRow) || '2', 10);
  var lastRow = sheet.getLastRow();
  if (startRow > lastRow) return;

  var endRow = Math.min(lastRow, startRow + BF.batchRows - 1);

  var numRows = endRow - startRow + 1;
  var pgns = sheet.getRange(startRow, colPGN, numRows, 1).getValues();
  var fens = sheet.getRange(startRow, colFEN, numRows, 1).getValues();

  var updFEN = new Array(numRows);
  var updBoard = new Array(numRows);
  var updActive = new Array(numRows);
  var updCastle = new Array(numRows);
  var updEp = new Array(numRows);
  var updH = new Array(numRows);
  var updF = new Array(numRows);
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
    updH[i] = [sp.halfmove];
    updF[i] = [sp.fullmove];
    updRanks[i] = [sp.ranks[0], sp.ranks[1], sp.ranks[2], sp.ranks[3], sp.ranks[4], sp.ranks[5], sp.ranks[6], sp.ranks[7]];
  }

  sheet.getRange(startRow, colFEN, numRows, 1).setValues(updFEN);
  sheet.getRange(startRow, colBoard, numRows, 1).setValues(updBoard);
  sheet.getRange(startRow, colActive, numRows, 1).setValues(updActive);
  sheet.getRange(startRow, colCastle, numRows, 1).setValues(updCastle);
  sheet.getRange(startRow, colEp, numRows, 1).setValues(updEp);
  sheet.getRange(startRow, colH, numRows, 1).setValues(updH);
  sheet.getRange(startRow, colF, numRows, 1).setValues(updF);
  sheet.getRange(startRow, colR8, numRows, 8).setValues(updRanks);

  PropertiesService.getScriptProperties().setProperty(BF.propRow, String(endRow + 1));
}

function resetBackfillProgress() {
  PropertiesService.getScriptProperties().deleteProperty(BF.propRow);
}
