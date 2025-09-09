function convertSheetToJson() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var rows = sheet.getDataRange().getValues();
  var header = rows.shift(); // Get headers and remove them from the data rows

  var jsonArray = [];
  for (var i = 0; i < rows.length; i++) {
    var obj = {};
    for (var j = 0; j < header.length; j++) {
      obj[header[j]] = rows[i][j];
    }
    jsonArray.push(obj);
  }

  var jsonString = JSON.stringify(jsonArray, null, 2); // 'null, 2' for pretty printing
  Logger.log(jsonString); // This will log the JSON string to the Apps Script console
  // You can also set it to a cell, e.g., sheet.getRange("A1").setValue(jsonString);
}

function exportSheetToNdjsonGzipChunks(config) {
  config = config || {};
  var sheetName = config.sheetName || 'Openings Normalized';
  var headerRow = config.headerRow || 1;                    // 1-based
  var dataStartRow = config.dataStartRow || (headerRow + 1);
  var chunkRows = config.chunkRows || 5000;                 // rows per output file
  var readBatchRows = config.readBatchRows || 1000;         // sheet read window
  var folderName = config.folderName || ('Openings_JSON_Export_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
  var includeManifest = config.includeManifest !== false;   // default true

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < dataStartRow) throw new Error('No data to export');

  var headers = sh.getRange(headerRow, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h || '').trim(); });
  var folder = DriveApp.createFolder(folderName);

  var files = [];
  var partIndex = 0;
  var currentLines = [];
  var currentCount = 0;
  var totalRows = 0;

  // Helper to flush currentLines to a gzipped NDJSON Drive file
  function flushPart_() {
    if (!currentLines.length) return;
    var ndjson = currentLines.join('\n') + '\n';
    var name = 'part-' + String(partIndex).padStart(4, '0') + '.ndjson.gz';
    var gzBlob = Utilities.gzip(Utilities.newBlob(ndjson, 'application/x-ndjson', name));
    gzBlob.setName(name); // ensure .gz name
    var file = folder.createFile(gzBlob);
    files.push({ name: name, id: file.getId(), rows: currentLines.length });
    partIndex++;
    currentLines = [];
    currentCount = 0;
  }

  // Stream out in read batches; rotate output every chunkRows
  for (var row = dataStartRow; row <= lastRow; row += readBatchRows) {
    var batchSize = Math.min(readBatchRows, (lastRow - row + 1));
    var values = sh.getRange(row, 1, batchSize, lastCol).getValues();

    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        var key = headers[c] || ('col' + (c + 1));
        obj[key] = r[c];
      }
      currentLines.push(JSON.stringify(obj));
      currentCount++;
      totalRows++;

      if (currentCount >= chunkRows) flushPart_();
    }
  }
  flushPart_();

  // Optional manifest to list produced files
  if (includeManifest) {
    var manifest = {
      sheet: sheetName,
      headerRow: headerRow,
      dataStartRow: dataStartRow,
      chunkRows: chunkRows,
      totalRows: totalRows,
      parts: files
    };
    var mf = folder.createFile(Utilities.newBlob(JSON.stringify(manifest, null, 2), 'application/json', 'manifest.json'));
    files.push({ name: 'manifest.json', id: mf.getId(), rows: 0 });
  }

  Logger.log('Exported ' + totalRows + ' rows into ' + files.length + ' file(s). Folder: ' + folder.getId());
  return { folderId: folder.getId(), files: files, totalRows: totalRows };
}
