/**
 * PGN to FEN Converter for Google Apps Script (Sheets-ready)
 *
 * This script loads chess.js dynamically and exposes helpers:
 * - pgnToFensGs(pgn, includeInitial)
 * - pgnTextToAllFensGs(pgnText, includeInitial)
 * - PGN_TO_FENS(pgnOrRange, includeInitial)  // Sheets custom function
 * - PGNS_TO_FENS_EXPLODED(range, includeInitial)  // Sheets custom function -> [id, ply, fen]
 */

/** @OnlyCurrentDoc */

var CHESS_CDN_URL = 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/dist/chess.min.js';
var CHESS_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
var CHESS_GLOBAL_FLAG = '__CHESS_LIB_LOADED__';

/**
 * Ensures chess.js is loaded into the execution context. Uses CacheService to avoid refetching.
 */
function ensureChessLoaded_() {
  if (globalThis[CHESS_GLOBAL_FLAG] === true && typeof globalThis.Chess === 'function') {
    return;
  }

  var cache = CacheService.getScriptCache();
  var cached = cache.get('chess_js_source');

  var source;
  if (cached) {
    source = cached;
  } else {
    var resp = UrlFetchApp.fetch(CHESS_CDN_URL, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Failed to fetch chess.js from CDN: ' + resp.getResponseCode());
    }
    source = resp.getContentText();
    cache.put('chess_js_source', source, CHESS_CACHE_TTL_SECONDS);
  }

  // Evaluate library in this context
  eval(source);
  if (typeof globalThis.Chess !== 'function') {
    throw new Error('chess.js did not load correctly.');
  }
  globalThis[CHESS_GLOBAL_FLAG] = true;
}

/**
 * Extracts initial FEN from PGN headers if present.
 */
function extractInitialFenFromHeaders_(pgn) {
  var fenMatch = pgn.match(/\n?\[FEN\s+"([^"]+)"\]/i);
  var setupMatch = pgn.match(/\n?\[SetUp\s+"([^"]+)"\]/i);
  if (fenMatch) {
    if (!setupMatch) return fenMatch[1];
    var setup = (setupMatch[1] || '').trim();
    if (setup === '1' || setup === 'true' || setup === 'TRUE') {
      return fenMatch[1];
    }
  }
  return null;
}

/**
 * Splits a text potentially containing multiple PGN games into an array of per-game PGN strings.
 */
function splitPgnGames_(pgnText) {
  if (!pgnText) return [];
  var text = String(pgnText).replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  var parts = text.split(/(?=^\[Event\s)/gmi);
  if (parts.length > 1) {
    return parts.map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
  }

  var resultRegex = /(1-0|0-1|1\/2-1\/2|\*)(?=\s*(?:\n|$))/g;
  var games = [];
  var startIndex = 0;
  var match;
  while ((match = resultRegex.exec(text)) !== null) {
    var endIndex = match.index + match[0].length;
    var candidate = text.substring(startIndex, endIndex).trim();
    if (candidate) games.push(candidate);
    startIndex = endIndex;
  }
  if (games.length === 0) {
    return [text];
  }
  var tail = text.substring(startIndex).trim();
  if (tail) games.push(tail);
  return games;
}

/**
 * Core: Convert a single PGN to its list of FENs (mainline only).
 */
function pgnToFensGs(pgn, includeInitial) {
  ensureChessLoaded_();
  var include = includeInitial === true || String(includeInitial).toLowerCase() === 'true';

  var initialFen = extractInitialFenFromHeaders_(pgn);

  var loader = new globalThis.Chess();
  var ok = loader.load_pgn(String(pgn), { sloppy: true });
  if (!ok) {
    throw new Error('Invalid PGN');
  }

  var moves = loader.history({ verbose: true });
  var board = initialFen ? new globalThis.Chess(initialFen) : new globalThis.Chess();

  var fens = [];
  if (include) {
    fens.push(board.fen());
  }
  for (var i = 0; i < moves.length; i++) {
    var moveObj = moves[i];
    board.move(moveObj);
    fens.push(board.fen());
  }
  return fens;
}

/**
 * Convert PGN text that may contain multiple games to an array of FEN arrays.
 */
function pgnTextToAllFensGs(pgnText, includeInitial) {
  var games = splitPgnGames_(pgnText);
  var result = [];
  for (var i = 0; i < games.length; i++) {
    result.push(pgnToFensGs(games[i], includeInitial));
  }
  return result;
}

/**
 * Sheets custom function: Convert a single PGN or a column/range of PGNs to FEN lists.
 * If a range is provided, each input cell becomes a block of FENs separated by a blank row.
 *
 * =PGN_TO_FENS(A2)  // vertical array of FENs
 * =PGN_TO_FENS(A2:A100, TRUE)  // multiple games stacked with blank rows between
 */
function PGN_TO_FENS(pgnOrRange, includeInitial) {
  var values;
  if (pgnOrRange && pgnOrRange.map && pgnOrRange[0] && pgnOrRange[0].map) {
    values = pgnOrRange;
  } else if (pgnOrRange && pgnOrRange.map) {
    values = [pgnOrRange];
  } else {
    values = [[pgnOrRange]];
  }

  var out = [];
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var pgn = values[r][c];
      if (pgn === null || pgn === undefined || String(pgn).trim() === '') continue;
      var fens = pgnToFensGs(String(pgn), includeInitial);
      for (var i = 0; i < fens.length; i++) {
        out.push([fens[i]]);
      }
      out.push(['']);
    }
  }
  if (out.length > 0 && out[out.length - 1][0] === '') out.pop();
  return out.length ? out : [['']];
}

/**
 * Sheets custom function: Explode PGNs from a range into rows of [id, ply, fen].
 * id is composed from row and column indices.
 *
 * =PGNS_TO_FENS_EXPLODED(A2:A, TRUE)
 */
function PGNS_TO_FENS_EXPLODED(range, includeInitial) {
  if (!range || !range.map) return [['id', 'ply', 'fen']];
  var out = [['id', 'ply', 'fen']];
  for (var r = 0; r < range.length; r++) {
    var row = range[r];
    for (var c = 0; c < row.length; c++) {
      var cell = row[c];
      if (cell === null || cell === undefined || String(cell).trim() === '') continue;
      var id = 'r' + (r + 1) + 'c' + (c + 1);
      var games = pgnTextToAllFensGs(String(cell), includeInitial);
      for (var gi = 0; gi < games.length; gi++) {
        var gameId = id + (games.length > 1 ? ('_g' + gi) : '');
        var fens = games[gi];
        for (var i = 0; i < fens.length; i++) {
          out.push([gameId, (i + 1), fens[i]]);
        }
      }
    }
  }
  return out;
}

